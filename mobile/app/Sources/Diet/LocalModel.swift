import Foundation
import CryptoKit
#if canImport(llama)
import llama
#endif

/// Underdog Woof 2B 1.1 (ConwayResearch, Apache-2.0): the small chat model Underdog itself runs on phones.
/// Everything runs locally:
///  - iPhone: the GGUF build through llama.cpp (Metal), `LlamaModel`. Download it once in the Diet screen (1.56 GB).
///  - Simulator: llama.cpp ships no Simulator slice, so `MacBridgeModel` talks to the same Woof 2B (MLX build) served
///    by `Tools/woof-bridge.sh` on this Mac's loopback address. Nothing leaves the machine in either case.
/// Without a model the Diet still works: rules classify, and the chat answers from the numbers.
protocol LocalModel: AnyObject, Sendable {
    var label: String { get }
    /// Streams the reply. `onToken` gets each new piece of text.
    func generate(system: String, user: String, maxTokens: Int, temperature: Float,
                  onToken: @escaping @Sendable (String) -> Void) async throws -> String
}

enum LocalModelError: LocalizedError {
    case missing, loadFailed, decodeFailed, bridgeDown, cancelled
    var errorDescription: String? {
        switch self {
        case .missing: "Woof 2B isn't downloaded yet."
        case .loadFailed: "Couldn't load Woof 2B on this device."
        case .decodeFailed: "Woof 2B stopped while thinking."
        case .bridgeDown: "The Mac bridge isn't running (Tools/woof-bridge.sh)."
        case .cancelled: "Stopped."
        }
    }
}

/// Detached inference threads cannot see their caller's Task.isCancelled.
private final class ModelCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        if stopped { throw CancellationError() }
    }
}

// MARK: - measurements

/// What the last model call cost on this device. Printed as `[diet] ...` lines (read them with
/// `xcrun devicectl device process launch --console ...`) and shown under the Diet's model card.
struct ModelRunStats: Sendable {
    var loadMs = 0.0, promptTokens = 0, promptMs = 0.0, genTokens = 0, genMs = 0.0, footprintMB = 0.0
    var promptRate: Double { promptMs > 0 ? Double(promptTokens) / promptMs * 1000 : 0 }
    var genRate: Double { genMs > 0 ? Double(genTokens) / genMs * 1000 : 0 }
    var summary: String {
        String(format: "%.0f tok/s writing · %.0f tok/s reading · %.0f MB", genRate, promptRate, footprintMB)
    }
}

@MainActor enum ModelLog {
    static var last: ModelRunStats?
    /// JSON classification answers: items asked, items that came back as a known category, replies that didn't parse.
    static var asked = 0, parsed = 0, badReplies = 0

    nonisolated static func line(_ s: String) { print("[diet] \(s)") }

    /// The app's memory as iOS counts it against the jetsam limit.
    nonisolated static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }
}

// MARK: - model file

enum WoofFile {
    static let name = "woof-2B-1.1-Q4_K_M.gguf"
    static let remote = URL(string: "https://huggingface.co/ConwayResearch/woof-2B-1.1-GGUF/resolve/main/woof-2B-1.1-Q4_K_M.gguf")!
    static let bytes: Int64 = 1_561_318_432
    static let sha256 = "e173464b652feab53855ab0038d5b8cf825429385274cae9a8ab060c634ba65f"

    static var local: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("models")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var url = dir.appendingPathComponent(name)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true   // 1.5 GB that can be downloaded again
        try? url.setResourceValues(values)
        return url
    }

    static var isPresent: Bool {
        ((try? FileManager.default.attributesOfItem(atPath: local.path)[.size] as? Int64) ?? nil) == bytes
    }

    /// Streams the file through SHA-256 (1.5 GB, so in 8 MB chunks).
    static func verify(_ url: URL) throws -> Bool {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined() == sha256
    }
}

/// Downloads Woof 2B with progress. Resumable across app launches only by starting again (URLSession resume data is
/// kept in memory while the app runs).
@MainActor @Observable
final class WoofDownloader: NSObject, URLSessionDownloadDelegate {
    enum State: Equatable { case idle, downloading, verifying, done, failed(String) }
    var state: State = WoofFile.isPresent ? .done : .idle
    var progress: Double = 0
    var received: Int64 = 0

    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var task: URLSessionDownloadTask?
    @ObservationIgnored private var resumeData: Data?

    func start() {
        guard state != .downloading, state != .verifying else { return }
        state = .downloading
        let s = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        session = s
        task = resumeData.map { s.downloadTask(withResumeData: $0) } ?? s.downloadTask(with: WoofFile.remote)
        resumeData = nil
        task?.resume()
    }

    func cancel() {
        task?.cancel { [weak self] data in Task { @MainActor in self?.resumeData = data } }
        state = .idle
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                                totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : WoofFile.bytes
        MainActor.assumeIsolated {
            if Int(progress * 10) != Int(Double(totalBytesWritten) / Double(total) * 10) {
                ModelLog.line("download \(totalBytesWritten >> 20) of \(total >> 20) MB")
            }
            received = totalBytesWritten
            progress = Double(totalBytesWritten) / Double(total)
        }
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temporary file is deleted when this returns, so move it first.
        let staged = WoofFile.local.deletingLastPathComponent().appendingPathComponent("woof.partial")
        try? FileManager.default.removeItem(at: staged)
        let moved = (try? FileManager.default.moveItem(at: location, to: staged)) != nil
        MainActor.assumeIsolated { state = moved ? .verifying : .failed("Couldn't save the download.") }
        guard moved else { return }
        Task.detached {
            let t0 = Date()
            let ok = (try? WoofFile.verify(staged)) ?? false
            ModelLog.line(String(format: "SHA-256 %@ in %.1f s", ok ? "matches" : "MISMATCH", Date().timeIntervalSince(t0)))
            var failure: String?
            if ok {
                do {
                    let destination = WoofFile.local
                    if FileManager.default.fileExists(atPath: destination.path) {
                        _ = try FileManager.default.replaceItemAt(destination, withItemAt: staged)
                    } else {
                        try FileManager.default.moveItem(at: staged, to: destination)
                    }
                } catch { failure = "Couldn't install Woof: \(error.localizedDescription)" }
            } else {
                try? FileManager.default.removeItem(at: staged)
            }
            let message = failure
            await MainActor.run {
                self.state = message.map { .failed($0) } ?? (ok ? .done : .failed("The download didn't match Woof's checksum."))
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        guard let error, (error as NSError).code != NSURLErrorCancelled else { return }
        ModelLog.line("download failed: \(error.localizedDescription)")
        MainActor.assumeIsolated { state = .failed(error.localizedDescription) }
    }
}

// MARK: - picking a model

enum LocalModels {
    /// The model to use right now, or nil (rules and number answers only).
    static func current() async -> LocalModel? {
        #if canImport(llama) && !targetEnvironment(simulator)
        if WoofFile.isPresent { return LlamaModel.shared }
        #endif
        #if targetEnvironment(simulator)
        if await MacBridgeModel.shared.isUp() { return MacBridgeModel.shared }
        #endif
        return nil
    }

    static var where_: String {
        #if targetEnvironment(simulator)
        "via this Mac (Simulator bridge)"
        #else
        "on this iPhone"
        #endif
    }
}

/// Woof's chat template is ChatML. An empty think block switches its reasoning off (the template's enable_thinking=false).
enum WoofPrompt {
    static func chatML(system: String, user: String) -> String {
        // History is untrusted: literal model control tokens must not create new chat roles.
        let safeUser = user.replacingOccurrences(of: "<|", with: "< |")
        return "<|im_start|>system\n\(system)<|im_end|>\n<|im_start|>user\n\(safeUser)<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    }

    static func stripThinking(_ text: String) -> String {
        var t = text
        if let r = t.range(of: "</think>", options: .backwards) { t = String(t[r.upperBound...]) }
        return t.replacingOccurrences(of: "<|im_end|>", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - llama.cpp (device)

#if canImport(llama) && !targetEnvironment(simulator)
final class LlamaModel: LocalModel, @unchecked Sendable {
    static let shared = LlamaModel()
    let label = "Underdog Woof 2B"

    private let lock = NSLock()
    private var model: OpaquePointer?
    private var ctx: OpaquePointer?
    private var vocab: OpaquePointer?
    private let nCtx: Int32 = 4096
    private let nBatch: Int32 = 512
    private var loadMs = 0.0

    private init() {}

    deinit {
        if let ctx { llama_free(ctx) }
        if let model { llama_model_free(model) }
    }

    private func loadIfNeeded() throws {
        if ctx != nil { return }
        guard WoofFile.isPresent else { throw LocalModelError.missing }
        let t0 = Date()
        llama_backend_init()
        var mp = llama_model_default_params()
        mp.n_gpu_layers = 99
        guard let m = llama_model_load_from_file(WoofFile.local.path, mp) else { throw LocalModelError.loadFailed }
        var cp = llama_context_default_params()
        cp.n_ctx = UInt32(nCtx)
        cp.n_batch = UInt32(nBatch)
        cp.n_ubatch = UInt32(nBatch)
        let threads = Int32(max(2, min(6, ProcessInfo.processInfo.activeProcessorCount - 2)))
        cp.n_threads = threads
        cp.n_threads_batch = threads
        guard let c = llama_init_from_model(m, cp) else { llama_model_free(m); throw LocalModelError.loadFailed }
        model = m
        ctx = c
        vocab = llama_model_get_vocab(m)
        loadMs = Date().timeIntervalSince(t0) * 1000
        ModelLog.line(String(format: "loaded Woof in %.0f ms, threads %d, footprint %.0f MB", loadMs, threads, ModelLog.footprintMB()))
        ModelLog.line("system: " + String(cString: llama_print_system_info()))
    }

    func generate(system: String, user: String, maxTokens: Int, temperature: Float,
                  onToken: @escaping @Sendable (String) -> Void) async throws -> String {
        let cancellation = ModelCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { cont in
                Thread.detachNewThread { [self] in
                    lock.lock()
                    defer { lock.unlock() }
                    do {
                        try cancellation.check()
                        cont.resume(returning: try run(prompt: WoofPrompt.chatML(system: system, user: user),
                                                      maxTokens: maxTokens, temperature: temperature,
                                                      cancellation: cancellation, onToken: onToken))
                    } catch {
                        cont.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            cancellation.cancel()
        }
    }

    private func run(prompt: String, maxTokens: Int, temperature: Float, cancellation: ModelCancellation,
                     onToken: (String) -> Void) throws -> String {
        try loadIfNeeded()
        guard let ctx, let vocab else { throw LocalModelError.loadFailed }
        llama_memory_clear(llama_get_memory(ctx), true)

        // tokenize (the template begins with BOS; special tokens like <|im_start|> must be parsed)
        let utf8 = Array(prompt.utf8CString)
        var tokens = [llama_token](repeating: 0, count: utf8.count + 8)
        var n = llama_tokenize(vocab, utf8, Int32(utf8.count - 1), &tokens, Int32(tokens.count), true, true)
        if n < 0 {
            tokens = [llama_token](repeating: 0, count: Int(-n))
            n = llama_tokenize(vocab, utf8, Int32(utf8.count - 1), &tokens, Int32(tokens.count), true, true)
        }
        tokens = Array(tokens.prefix(Int(max(0, n))))
        // keep the end of an over-long prompt (the question sits at the end)
        let budget = Int(nCtx) - maxTokens - 8
        if tokens.count > budget { tokens = [tokens[0]] + tokens.suffix(budget - 1) }

        var stats = ModelRunStats(loadMs: loadMs, promptTokens: tokens.count)
        loadMs = 0
        let tPrompt = Date()
        var i = 0
        while i < tokens.count {
            try cancellation.check()
            let end = min(i + Int(nBatch), tokens.count)
            var chunk = Array(tokens[i..<end])
            let rc = chunk.withUnsafeMutableBufferPointer { llama_decode(ctx, llama_batch_get_one($0.baseAddress, Int32($0.count))) }
            if rc != 0 { throw LocalModelError.decodeFailed }
            i = end
        }

        let sampler = llama_sampler_chain_init(llama_sampler_chain_default_params())
        defer { llama_sampler_free(sampler) }
        if temperature <= 0 {
            llama_sampler_chain_add(sampler, llama_sampler_init_greedy())
        } else {
            llama_sampler_chain_add(sampler, llama_sampler_init_top_k(20))
            llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.95, 1))
            llama_sampler_chain_add(sampler, llama_sampler_init_temp(temperature))
            llama_sampler_chain_add(sampler, llama_sampler_init_dist(UInt32.random(in: 1...UInt32.max)))
        }

        llama_synchronize(ctx)   // Metal runs the prompt asynchronously; wait so the timing is honest
        stats.promptMs = Date().timeIntervalSince(tPrompt) * 1000
        let tGen = Date()
        defer {
            stats.genMs = Date().timeIntervalSince(tGen) * 1000
            stats.footprintMB = ModelLog.footprintMB()
            let recorded = stats
            Task { @MainActor in ModelLog.last = recorded }
            ModelLog.line(String(format: "prompt %d tok %.0f ms (%.1f tok/s) · gen %d tok %.0f ms (%.1f tok/s) · footprint %.0f MB",
                                 stats.promptTokens, stats.promptMs, stats.promptRate, stats.genTokens, stats.genMs,
                                 stats.genRate, stats.footprintMB))
        }
        var output = ""
        var pending: [UInt8] = []
        var buf = [CChar](repeating: 0, count: 256)
        for _ in 0..<maxTokens {
            try cancellation.check()
            var tok = llama_sampler_sample(sampler, ctx, -1)
            if llama_vocab_is_eog(vocab, tok) { break }
            stats.genTokens += 1
            let len = llama_token_to_piece(vocab, tok, &buf, Int32(buf.count), 0, false)
            if len > 0 { pending += buf.prefix(Int(len)).map { UInt8(bitPattern: $0) } }
            if let piece = String(bytes: pending, encoding: .utf8) {   // wait for whole UTF-8 characters
                pending = []
                output += piece
                if output.hasSuffix("<|im_end|>") { break }
                onToken(piece)
            }
            let rc = llama_decode(ctx, llama_batch_get_one(&tok, 1))
            if rc != 0 { break }
        }
        return WoofPrompt.stripThinking(output)
    }
}
#endif

// MARK: - Mac bridge (Simulator)

/// OpenAI-style streaming client for mlx-lm's server on 127.0.0.1 (started by Tools/woof-bridge.sh).
final class MacBridgeModel: LocalModel, @unchecked Sendable {
    static let shared = MacBridgeModel()
    let label = "Underdog Woof 2B"
    let base = URL(string: "http://127.0.0.1:8799")!

    func isUp() async -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("v1/models"))
        req.timeoutInterval = 1.5
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    func generate(system: String, user: String, maxTokens: Int, temperature: Float,
                  onToken: @escaping @Sendable (String) -> Void) async throws -> String {
        var req = URLRequest(url: base.appendingPathComponent("v1/chat/completions"))
        req.httpMethod = "POST"
        req.timeoutInterval = 300
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "messages": [["role": "system", "content": system], ["role": "user", "content": user]],
            "max_tokens": maxTokens, "temperature": temperature, "top_p": 0.95, "stream": true,
            "chat_template_kwargs": ["enable_thinking": false],
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw LocalModelError.bridgeDown }
        var out = ""
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data: ") else { continue }
            let payload = line.dropFirst(6)
            if payload == "[DONE]" { break }
            guard let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let choice = (obj["choices"] as? [[String: Any]])?.first,
                  let piece = (choice["delta"] as? [String: Any])?["content"] as? String, !piece.isEmpty else { continue }
            out += piece
            onToken(piece)
        }
        return WoofPrompt.stripThinking(out)
    }
}
