import SwiftUI
import Observation

@MainActor @Observable
final class DietChatSession {
    struct Source: Identifiable, Equatable {
        var number: Int
        var title: String
        var url: URL
        var id: Int { number }
    }
    struct Message: Identifiable, Equatable {
        enum Role { case user, assistant }
        let id = UUID()
        var role: Role
        var text: String
        var sources: [Source] = []
        var streaming = false
    }

    var messages: [Message] = []
    var busy = false
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var activeRequest: UUID?

    func ask(_ question: String, engine: DietEngine) {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !busy else { return }
        messages.append(Message(role: .user, text: q))
        messages.append(Message(role: .assistant, text: "", streaming: true))
        let index = messages.count - 1
        let request = UUID()
        activeRequest = request
        busy = true
        let items = engine.labeled
        task = Task {
            let plan = DietChatContext.plan(for: q)
            let (notes, stats) = await Task.detached { DietChatContext.notes(for: plan, items: items) }.value
            guard !Task.isCancelled, activeRequest == request else { return }
            let pages = DietChatContext.relevantPages(plan, items: items, limit: 12)
            messages[index].sources = pages.enumerated().compactMap { i, page in
                guard let url = URL(string: page.0.url), ["https", "http"].contains(url.scheme ?? "") else { return nil }
                return Source(number: i + 1, title: DietClassifier.stripSiteSuffix(page.0.title, host: page.0.host), url: url)
            }
            if let model = await LocalModels.current() {
                let user = "Notes:\n\(notes)\n\nQuestion: \(q)"
                do {
                    let final = try await model.generate(system: DietChatContext.system, user: user, maxTokens: 420, temperature: 0.4) { piece in
                        Task { @MainActor in
                            guard self.activeRequest == request, self.messages[index].streaming else { return }
                            self.messages[index].text += piece
                        }
                    }
                    guard !Task.isCancelled, activeRequest == request else { return }
                    try? await Task.sleep(for: .milliseconds(50))
                    guard !Task.isCancelled, activeRequest == request else { return }
                    messages[index].text = final.isEmpty ? DietChatContext.fallbackAnswer(q, plan: plan, stats: stats, pages: pages) : final
                    ModelLog.line("chat: \(final.count) characters, \(pages.count) source pages")
                } catch {
                    guard !Task.isCancelled, activeRequest == request else { return }
                    ModelLog.line("chat failed: \(error.localizedDescription)")
                    messages[index].text = DietChatContext.fallbackAnswer(q, plan: plan, stats: stats, pages: pages)
                }
            } else {
                messages[index].text = DietChatContext.fallbackAnswer(q, plan: plan, stats: stats, pages: pages)
            }
            guard !Task.isCancelled, activeRequest == request else { return }
            messages[index].streaming = false
            busy = false
            activeRequest = nil
        }
    }

    func stop() {
        task?.cancel()
        activeRequest = nil
        busy = false
        if let i = messages.indices.last {
            messages[i].streaming = false
            if messages[i].text.isEmpty { messages[i].text = "Stopped." }
        }
    }
}
