import SafariServices
import UIKit

/// Home Screen icons for saved web apps, through iOS's own "Add to Home Screen" sheet (as in Safari).
///
/// Only browsers with Apple's managed entitlement `com.apple.developer.web-browser` get that sheet. Builds that have it
/// are signed with `Sources/WebBrowser.entitlements` and compiled with `ANUS_WEB_BROWSER` (`ANUS_BROWSER_ENTITLEMENT=1
/// ./run.sh device`). A WebKit browser's icon is always a bookmark, and iOS opens bookmarks in the default browser: with
/// Uranus Browser as the default, the icon comes back here with `#anus-app=<id>` and opens the web app full screen, logged
/// in and tracked by the Algorithm Diet. (Safari-style standalone web apps would run in a container nobody can read.)
enum WebAppHomeScreen {
    static let marker = "anus-app"

    static var available: Bool {
        #if ANUS_WEB_BROWSER
        true
        #else
        false
        #endif
    }

    /// The bookmark's URL: the start page plus a fragment (never sent to the site) naming the saved app.
    static func link(for app: WebApp) -> URL? {
        guard let start = app.start, var c = URLComponents(url: start, resolvingAgainstBaseURL: false) else { return nil }
        c.fragment = "\(marker)=\(app.id.uuidString)"
        return c.url
    }

    static func appID(in url: URL) -> UUID? {
        guard let f = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment, f.hasPrefix(marker + "=") else { return nil }
        return UUID(uuidString: String(f.dropFirst(marker.count + 1)))
    }

    /// The same URL without our marker, for when the saved app is gone and the link opens as a normal page.
    static func stripped(_ url: URL) -> URL {
        guard appID(in: url) != nil, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.fragment = nil
        return c.url ?? url
    }

    @MainActor
    static func present(_ app: WebApp, icon: UIImage?, from vc: UIViewController, source: UIView?) {
        guard let link = link(for: app) else { return }
        let sheet = UIActivityViewController(activityItems: [WebAppBookmark(url: link, title: app.name, icon: icon)], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = source ?? vc.view
        vc.present(sheet, animated: true)
    }

    /// nil when iOS won't say (the check is rate-limited).
    @MainActor
    static func isDefaultBrowser() -> Bool? { try? UIApplication.shared.isDefault(.webBrowser) }
}

final class WebAppBookmark: NSObject, SFAddToHomeScreenActivityItem {
    let url: URL
    let title: String
    let iconItemProvider: NSItemProvider?

    init(url: URL, title: String, icon: UIImage?) {
        self.url = url
        self.title = title
        iconItemProvider = icon.map { NSItemProvider(object: $0) }
    }
}
