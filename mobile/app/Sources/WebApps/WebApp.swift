import SwiftUI
import WebKit
import Observation
import AppIntents

/// A website saved as an app ("Save as Web App" in the Share sheet). It runs full screen inside Uranus Browser, in the
/// cookie/storage container of the Space it was saved from, so logins carry over and the Algorithm Diet sees it.
/// (A real iOS Home Screen web app runs in Safari's own container, which no other app can read.)
struct WebApp: Codable, Identifiable, Hashable, Sendable {
    var id = UUID()
    var name: String
    var startURL: String
    /// URL prefix that counts as "inside the app"; navigations outside it show a banner with a way back.
    var scope: String
    var themeColor: String?
    var spaceID: UUID?
    var hasManifest: Bool
    var added = Date()

    var start: URL? { URL(string: startURL) }
    var host: String { start?.host ?? "" }

    func inScope(_ url: URL) -> Bool {
        guard let scopeURL = URL(string: scope), url.scheme == scopeURL.scheme, url.host == scopeURL.host else { return false }
        return url.path.hasPrefix(scopeURL.path.isEmpty ? "/" : scopeURL.path)
    }
}

/// Saved web apps (`Application Support/webapps/apps.json`) and their icons (`webapps/icons/<id>.png`).
@MainActor @Observable
final class WebAppStore {
    static let shared = WebAppStore()
    private(set) var apps: [WebApp] = []
    @ObservationIgnored private var icons: [UUID: UIImage] = [:]

    init() { apps = Self.read() }

    func add(_ app: WebApp, icon: UIImage?) {
        // Saving the same site again (same Space) replaces it, icon file included.
        apps.filter { $0.startURL == app.startURL && $0.spaceID == app.spaceID }.forEach { old in
            apps.removeAll { $0.id == old.id }
            icons[old.id] = nil
            try? FileManager.default.removeItem(at: Self.iconURL(old.id))
        }
        apps.append(app)
        if let icon = icon.map(Self.homeScreenSized), let data = icon.pngData() {
            try? data.write(to: Self.iconURL(app.id), options: .atomic)
            icons[app.id] = icon
        }
        save()
    }

    /// Manifests often only list 512 or 1024 px icons; 192 px is plenty for a 60 pt tile at 3x.
    private static func homeScreenSized(_ image: UIImage) -> UIImage {
        let side: CGFloat = 192
        guard image.size.width * image.scale > side * 1.2 else { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
    }

    func rename(_ app: WebApp, to name: String) {
        guard let i = apps.firstIndex(where: { $0.id == app.id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        apps[i].name = trimmed
        save()
    }

    func remove(_ app: WebApp) {
        apps.removeAll { $0.id == app.id }
        icons[app.id] = nil
        try? FileManager.default.removeItem(at: Self.iconURL(app.id))
        save()
    }

    func app(id: UUID) -> WebApp? { apps.first { $0.id == id } }

    func icon(for app: WebApp) -> UIImage? {
        if let i = icons[app.id] { return i }
        guard let i = UIImage(contentsOfFile: Self.iconURL(app.id).path) else { return nil }
        icons[app.id] = i
        return i
    }

    // MARK: persistence

    private static var directory: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("webapps/icons")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d.deletingLastPathComponent()
    }
    private static var listURL: URL { directory.appendingPathComponent("apps.json") }
    private static func iconURL(_ id: UUID) -> URL { directory.appendingPathComponent("icons/\(id.uuidString).png") }

    /// Also used by the App Intents query, which may run before the store is created.
    nonisolated static func read() -> [WebApp] {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("webapps/apps.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([WebApp].self, from: data)) ?? []
    }

    private func save() {
        if let data = try? JSONEncoder().encode(apps) { try? data.write(to: Self.listURL, options: .atomic) }
        BrowserShortcuts.updateAppShortcutParameters()   // Shortcuts and Spotlight list each saved app
    }
}

// MARK: - Reading a page's web app manifest

/// What "Save as Web App" found on the page: the manifest if there is one, else the page's own title/icons.
struct WebAppDraft {
    var name: String
    var start: URL
    var scope: String
    var themeColor: String?
    var hasManifest: Bool
    var icon: UIImage?
}

enum WebAppManifestReader {
    /// Collects the manifest link, touch icons, title and theme colour. Runs in the page; the manifest itself is fetched
    /// from the page too (same cookies, e.g. for sites behind a login), with a plain request as fallback.
    private static let probe = #"""
    const abs = h => { try { return new URL(h, location.href).href } catch (e) { return null } };
    const meta = n => { const e = document.querySelector(`meta[name="${n}"]`); return e ? e.content : null; };
    const link = document.querySelector('link[rel~="manifest"]');
    const manifestURL = link ? abs(link.getAttribute('href')) : null;
    let manifest = null;
    if (manifestURL) {
      try {
        const r = await fetch(manifestURL, {credentials: link.crossOrigin === 'use-credentials' ? 'include' : 'same-origin'});
        if (r.ok) manifest = await r.text();
      } catch (e) {}
    }
    const touch = Array.from(document.querySelectorAll('link[rel~="apple-touch-icon"],link[rel~="apple-touch-icon-precomposed"]'))
      .map(l => ({src: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') || ''}));
    const icons = Array.from(document.querySelectorAll('link[rel~="icon"]'))
      .map(l => ({src: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') || '', type: l.type || ''}));
    return {url: location.href, title: document.title || null, manifestURL, manifest,
            appTitle: meta('apple-mobile-web-app-title') || meta('application-name'),
            themeColor: meta('theme-color'), touch, icons};
    """#

    struct IconCandidate { var url: URL; var size: Int }

    @MainActor
    static func draft(from webView: WKWebView) async -> WebAppDraft? {
        guard let pageURL = webView.url, ["http", "https"].contains(pageURL.scheme ?? "") else { return nil }
        let raw = (try? await webView.callAsyncJavaScript(probe, contentWorld: .defaultClient)) as? [String: Any] ?? [:]
        let page = (raw["url"] as? String).flatMap(URL.init(string:)) ?? pageURL
        var manifestText = raw["manifest"] as? String
        let manifestURL = (raw["manifestURL"] as? String).flatMap(URL.init(string:))
        if manifestText == nil, let manifestURL {
            manifestText = try? await String(data: URLSession(configuration: .ephemeral).data(from: manifestURL).0, encoding: .utf8)
        }
        let manifest = manifestText.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        return await draft(page: page, title: raw["title"] as? String ?? webView.title, appTitle: raw["appTitle"] as? String,
                           metaTheme: raw["themeColor"] as? String, manifest: manifest, manifestURL: manifestURL,
                           touch: raw["touch"] as? [[String: Any]] ?? [], icons: raw["icons"] as? [[String: Any]] ?? [])
    }

    static func draft(page: URL, title: String?, appTitle: String?, metaTheme: String?, manifest: [String: Any]?, manifestURL: URL?,
                      touch: [[String: Any]], icons: [[String: Any]]) async -> WebAppDraft {
        let base = manifestURL ?? page
        // start_url and scope must stay on the page's origin (the manifest spec ignores them otherwise).
        let sameOrigin = { (u: URL) in u.scheme == page.scheme && u.host == page.host && u.port == page.port }
        let start = (manifest?["start_url"] as? String).flatMap { URL(string: $0, relativeTo: base)?.absoluteURL }.flatMap { sameOrigin($0) ? $0 : nil } ?? page
        var scope = (manifest?["scope"] as? String).flatMap { URL(string: $0, relativeTo: base)?.absoluteURL }.flatMap { sameOrigin($0) ? $0 : nil }
        if scope == nil {
            // Default scope: the start URL's directory; without a manifest, the whole site.
            var c = URLComponents(url: start, resolvingAgainstBaseURL: false)
            c?.path = manifest == nil ? "/" : (start.path.hasSuffix("/") ? start.path : (start.path as NSString).deletingLastPathComponent)
            if c?.path.isEmpty == true { c?.path = "/" }
            c?.query = nil; c?.fragment = nil
            scope = c?.url
        }
        let name = [manifest?["short_name"] as? String, manifest?["name"] as? String, appTitle, title, page.host]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? "Web App"

        var candidates: [IconCandidate] = []
        for i in manifest?["icons"] as? [[String: Any]] ?? [] {
            let purpose = (i["purpose"] as? String ?? "any").split(separator: " ")
            guard purpose.contains("any") || purpose.contains("maskable"),
                  let src = i["src"] as? String, let u = URL(string: src, relativeTo: base)?.absoluteURL,
                  !isSVG(u, type: i["type"] as? String) else { continue }
            candidates.append(IconCandidate(url: u, size: largestSize(i["sizes"] as? String) ?? 0))
        }
        for i in touch {
            guard let src = i["src"] as? String, let u = URL(string: src) else { continue }
            candidates.append(IconCandidate(url: u, size: largestSize(i["sizes"] as? String) ?? 180))
        }
        for i in icons {
            guard let src = i["src"] as? String, let u = URL(string: src), !isSVG(u, type: i["type"] as? String) else { continue }
            candidates.append(IconCandidate(url: u, size: largestSize(i["sizes"] as? String) ?? 32))
        }
        let icon = await bestIcon(candidates)
        return WebAppDraft(name: name, start: start, scope: scope?.absoluteString ?? start.absoluteString,
                           themeColor: manifest?["theme_color"] as? String ?? metaTheme,
                           hasManifest: manifest != nil, icon: icon)
    }

    /// The smallest icon of at least 180 px (the Home Screen size), else the biggest one that loads.
    static func bestIcon(_ candidates: [IconCandidate]) async -> UIImage? {
        let big = candidates.filter { $0.size >= 180 }.sorted { $0.size < $1.size }
        let small = candidates.filter { $0.size < 180 }.sorted { $0.size > $1.size }
        for c in big + small {
            guard let (data, response) = try? await URLSession(configuration: .ephemeral).data(from: c.url),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
                  data.count < 2_000_000, let image = UIImage(data: data), image.size.width >= 16 else { continue }
            return image
        }
        return nil
    }

    static func largestSize(_ sizes: String?) -> Int? {
        sizes?.lowercased().split(separator: " ").compactMap { Int($0.split(separator: "x").first ?? "") }.max()
    }

    private static func isSVG(_ url: URL, type: String?) -> Bool {
        type?.contains("svg") == true || url.path.lowercased().hasSuffix(".svg")   // UIImage cannot draw SVG
    }
}

// MARK: - Shortcuts / Spotlight / Home Screen

/// Each saved web app as a Shortcuts entity, so "Open <app> in Uranus Browser" can be put on the Home Screen from the Shortcuts app.
struct WebAppEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Web App"
    static var defaultQuery = WebAppQuery()
    var id: UUID
    var name: String
    var host: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(host)") }

    init(_ app: WebApp) { id = app.id; name = app.name; host = app.host }
}

struct WebAppQuery: EntityQuery {
    func entities(for identifiers: [UUID]) async throws -> [WebAppEntity] {
        WebAppStore.read().filter { identifiers.contains($0.id) }.map(WebAppEntity.init)
    }
    func suggestedEntities() async throws -> [WebAppEntity] { WebAppStore.read().map(WebAppEntity.init) }
}

struct OpenWebAppIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Web App"
    static var description = IntentDescription("Open a web app you saved in Uranus Browser, full screen. Algorithm Diet tracks it like any page.")
    static var openAppWhenRun = true

    @Parameter(title: "Web App") var app: WebAppEntity

    init() {}
    init(app: WebAppEntity) { self.app = app }

    @MainActor
    func perform() async throws -> some IntentResult {
        WebAppPresenter.shared.pendingLaunch = app.id
        return .result()
    }
}
