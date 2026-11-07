import SwiftUI

/// Launch arguments for checking web apps on a device without tapping (output: `[webapp]` lines on the console).
///   -webAppTest <url>      open the page, read its manifest, save it as a web app and open it full screen
///   -webAppShare <url>     open the page and show the share sheet (with "Save as Web App")
///   -webAppOpen <name>     open a saved web app by name ("first" for the first one)
///   -webAppPage <url>      just open the page in a new tab (the UI test taps the rest)
///   -webAppBlank 1         start on a new blank tab (the new tab page lists the saved web apps)
enum WebAppTesting {
    @MainActor private static var done = false

    @MainActor
    static func run(_ store: BrowserStore) async {
        guard !done else { return }
        done = true
        let d = UserDefaults.standard
        if let page = d.string(forKey: "webAppPage").flatMap(URL.init(string:)) { store.newTab(url: page); return }
        if d.bool(forKey: "webAppBlank") { store.newTab(); return }
        if let name = d.string(forKey: "webAppOpen") {
            guard let app = WebAppStore.shared.apps.first(where: { name == "first" || $0.name == name }) else {
                print("[webapp] test: no saved web app \(name)"); return
            }
            WebAppPresenter.shared.open(app, store: store)
            return
        }
        let share = d.string(forKey: "webAppShare")
        guard let raw = d.string(forKey: "webAppTest") ?? share, let url = URL(string: raw) else { return }
        let tab = store.newTab(url: url)
        print("[webapp] test: loading \(url.absoluteString)")
        for _ in 0..<60 {
            try? await Task.sleep(for: .milliseconds(500))
            if tab.hasWebView, !tab.isLoading, tab.progress >= 1 { break }
        }
        try? await Task.sleep(for: .seconds(1))
        if share != nil {
            if let u = tab.url { PageShare.present(u, store: store) }
            return
        }
        guard let webView = tab.webView, let draft = await WebAppManifestReader.draft(from: webView) else {
            print("[webapp] test: FAILED to read \(url.absoluteString)"); return
        }
        print("[webapp] test draft: name=\(draft.name) start=\(draft.start.absoluteString) scope=\(draft.scope) manifest=\(draft.hasManifest) icon=\(draft.icon.map { "\(Int($0.size.width * $0.scale))px" } ?? "none") theme=\(draft.themeColor ?? "-")")
        let app = WebApp(name: draft.name, startURL: draft.start.absoluteString, scope: draft.scope, themeColor: draft.themeColor,
                         spaceID: store.currentSpaceID, hasManifest: draft.hasManifest)
        WebAppStore.shared.add(app, icon: draft.icon)
        WebAppPresenter.shared.open(app, store: store)
    }
}
