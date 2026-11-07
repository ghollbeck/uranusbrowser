import AppIntents
import Foundation
import Observation

/// A supported Shortcuts/Share Sheet route from a separate app; it grants no access to that app's private storage.
@MainActor @Observable
final class IncomingWebsites {
    static let shared = IncomingWebsites()
    var pending: [URL] = []

    func open(in store: BrowserStore) {
        let urls = pending
        pending = []
        guard !urls.isEmpty else { return }
        DietEngine.shared.isPresented = false
        store.showSwitcher = false
        store.sheet = nil
        for url in urls { store.commit(url.absoluteString, editing: false) }
    }
}

struct OpenWebsiteIntent: AppIntent {
    static var title: LocalizedStringResource = "Open in UrAnus Browser"
    static var description = IntentDescription("Open a shared website in UrAnus Browser. Algorithm Diet tracks it while you browse; it cannot read the app you shared it from.")
    static var openAppWhenRun = true

    @Parameter(title: "Website URL") var url: URL

    @MainActor
    func perform() async throws -> some IntentResult {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else {
            throw $url.needsValueError("Choose an HTTP or HTTPS website.")
        }
        IncomingWebsites.shared.pending.append(url)
        return .result()
    }
}

struct BrowserShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenWebsiteIntent(), phrases: ["Open a website in \(.applicationName)"],
                    shortTitle: "Open website", systemImageName: "globe")
        AppShortcut(intent: OpenWebAppIntent(), phrases: ["Open \(\.$app) in \(.applicationName)", "Open a web app in \(.applicationName)"],
                    shortTitle: "Open Web App", systemImageName: "apps.iphone")
    }
}
