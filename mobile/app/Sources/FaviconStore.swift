import SwiftUI
import UIKit
import CryptoKit
import Observation

/// Favicon cache keyed by site (host without "www."). Memory (NSCache) in front of a small disk cache in Caches/.
///
/// Cache policy:
/// - An icon the page declares itself is saved when the page loads (source "page"). Icons guessed from /favicon.ico are "guess".
/// - Fresh for 7 days. After that the old icon is still shown at once and refreshed in the background (stale-while-revalidate).
/// - A failed lookup is remembered for 24 hours so we do not hammer sites that have no icon.
/// - At most 3 lookups run at once, each deduplicated per site. Requests carry no cookies and go straight to the visited site.
/// - Capped at 300 sites; least recently used go first. Private tabs only ever use memory, which is emptied when Private ends.
@MainActor @Observable
final class FaviconStore {
    static let shared = FaviconStore()

    /// Bumped whenever an icon arrives, so views that asked for one redraw.
    private(set) var revision = 0

    struct Entry: Codable {
        var file: String?
        var fetchedAt: Date
        var lastUsed: Date
        var failedAt: Date?
        var source: String?   // "page" or "guess"
    }

    static let freshFor: TimeInterval = 7 * 86_400
    static let pageIconRecheck: TimeInterval = 86_400
    static let retryFailedAfter: TimeInterval = 86_400
    static let maxEntries = 300
    static let maxPixels: CGFloat = 64
    static let maxConcurrent = 3

    @ObservationIgnored private let memory = NSCache<NSString, UIImage>()
    @ObservationIgnored private let privateMemory = NSCache<NSString, UIImage>()
    @ObservationIgnored private var index: [String: Entry] = [:]
    @ObservationIgnored private var inflight = Set<String>()
    @ObservationIgnored private var queue: [String] = []
    @ObservationIgnored private var running = 0
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private let dir: URL
    @ObservationIgnored private let session: URLSession

    private init() {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("favicons")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        dir = base
        let cfg = URLSessionConfiguration.ephemeral   // no cookies, no shared credentials
        cfg.timeoutIntervalForRequest = 8
        cfg.httpShouldSetCookies = false
        session = URLSession(configuration: cfg)
        memory.countLimit = 200
        privateMemory.countLimit = 100
        if let data = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
           let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) { index = decoded }
    }

    static func key(_ host: String?) -> String? {
        guard let h = host?.lowercased(), !h.isEmpty else { return nil }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    // MARK: lookup

    /// The cached icon for a site, or nil (and a background lookup is started when it is worth trying).
    func image(for host: String?) -> UIImage? {
        _ = revision
        guard let key = Self.key(host) else { return nil }
        let ns = key as NSString
        if let img = memory.object(forKey: ns) ?? privateMemory.object(forKey: ns) {
            use(key)
            return img
        }
        if let e = index[key], let f = e.file, let img = UIImage(contentsOfFile: dir.appendingPathComponent(f).path) {
            memory.setObject(img, forKey: ns)
            use(key)
            return img
        }
        enqueue(key)
        return nil
    }

    /// True when this site's page-declared icon was saved within the last day, so the page need not be asked again.
    func hasRecentPageIcon(for host: String?) -> Bool {
        guard let key = Self.key(host), let e = index[key], e.file != nil, e.source == "page" else { return false }
        return Date.now.timeIntervalSince(e.fetchedAt) < Self.pageIconRecheck
    }

    private func use(_ key: String) {
        guard var e = index[key] else { return }
        e.lastUsed = .now
        index[key] = e
        scheduleSave()
        if Date.now.timeIntervalSince(e.fetchedAt) > Self.freshFor { enqueue(key) }   // show now, refresh quietly
    }

    // MARK: storing

    func store(_ image: UIImage, for host: String?, persist: Bool, source: String) {
        guard let key = Self.key(host) else { return }
        let small = Self.downscale(image)
        if persist {
            memory.setObject(small, forKey: key as NSString)
            let file = Self.fileName(key)
            if let data = small.pngData() { try? data.write(to: dir.appendingPathComponent(file), options: .atomic) }
            index[key] = Entry(file: file, fetchedAt: .now, lastUsed: .now, failedAt: nil, source: source)
            evictIfNeeded()
            scheduleSave()
        } else {
            privateMemory.setObject(small, forKey: key as NSString)
        }
        revision &+= 1
    }

    // MARK: background lookups

    private func enqueue(_ key: String) {
        // Local and bare hosts (localhost, 127.0.0.1, 192.168.x.x) have no public favicon to look up.
        guard key.contains("."), key.range(of: #"^\d+\.\d+\.\d+\.\d+$"#, options: .regularExpression) == nil else { return }
        guard !inflight.contains(key) else { return }
        if let e = index[key], let failed = e.failedAt, Date.now.timeIntervalSince(failed) < Self.retryFailedAfter { return }
        inflight.insert(key)
        queue.append(key)
        pump()
    }

    private func pump() {
        while running < Self.maxConcurrent, !queue.isEmpty {
            let key = queue.removeFirst()
            running += 1
            Task {
                await lookup(key)
                inflight.remove(key)
                running -= 1
                pump()
            }
        }
    }

    /// Ask the site itself for /favicon.ico (no third-party service sees which sites you visited).
    private func lookup(_ key: String) async {
        for host in [key, "www.\(key)"] {
            guard let url = URL(string: "https://\(host)/favicon.ico"),
                  let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
                  data.count < 512_000, let img = UIImage(data: data) else { continue }
            let hadPageIcon = index[key]?.source == "page" && index[key]?.file != nil
            if hadPageIcon { index[key]?.fetchedAt = .now; scheduleSave(); return }   // keep the better icon, just mark it checked
            store(img, for: key, persist: true, source: "guess")
            return
        }
        var e = index[key] ?? Entry(file: nil, fetchedAt: .distantPast, lastUsed: .now, failedAt: nil, source: nil)
        e.failedAt = .now
        index[key] = e
        scheduleSave()
    }

    // MARK: housekeeping

    private func evictIfNeeded() {
        guard index.count > Self.maxEntries else { return }
        for (key, e) in index.sorted(by: { $0.value.lastUsed < $1.value.lastUsed }).prefix(index.count - Self.maxEntries) {
            if let f = e.file { try? FileManager.default.removeItem(at: dir.appendingPathComponent(f)) }
            memory.removeObject(forKey: key as NSString)
            index[key] = nil
        }
    }

    func clearAll() {
        memory.removeAllObjects()
        index = [:]
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        revision &+= 1
    }

    func clearPrivate() {
        privateMemory.removeAllObjects()
        revision &+= 1
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let data = try? JSONEncoder().encode(index) else { return }
            try? data.write(to: dir.appendingPathComponent("index.json"), options: .atomic)
        }
    }

    private static func fileName(_ key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined() + ".png"
    }

    /// Icons are drawn at 20 to 30 pt, so 64 px on the long side is plenty and keeps the cache tiny.
    private static func downscale(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height) * image.scale
        guard longest > maxPixels else { return image }
        let ratio = maxPixels / longest
        let size = CGSize(width: image.size.width * image.scale * ratio, height: image.size.height * image.scale * ratio)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}
