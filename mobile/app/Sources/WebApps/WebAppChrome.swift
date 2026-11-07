import SwiftUI
import WebKit
import Observation

/// Native top and bottom bars for web apps of sites we know (YouTube, Instagram), so they feel like the real apps.
/// The site's own bars are hidden by an injected style/script; the tabs drive the site's own navigation (clicking its
/// hidden tab buttons keeps it a single-page app), with a plain load as fallback. Other sites keep the generic look.
struct ChromeProfile {
    struct Tab: Identifiable {
        var id: String
        var title: String
        var symbol: String
        var path: String
        /// Path prefixes that mark this tab selected ("/" only matches the root itself).
        var matches: [String]
        /// The site's own (hidden) control for this tab, clicked instead of loading `path`.
        var click: String?
    }

    struct Action: Identifiable {
        var id: String
        var symbol: String
        var path: String
        var click: String?
    }

    var id: String
    var hosts: [String]
    var wordmark: String
    var tabs: [Tab]
    var actions: [Action]
    var showsTabTitles: Bool
    /// Full-bleed video feeds: the bars turn black.
    var immersive: [String]
    var css: String
    /// The nearest full-width fixed/sticky ancestor of these is hidden (for sites with generated class names).
    var hideAround: [String]
    var search: ((String) -> String)?

    static func forHost(_ host: String) -> ChromeProfile? {
        let h = host.lowercased()
        return [youtube, instagram].first { p in p.hosts.contains { h == $0 || h.hasSuffix("." + $0) } }
    }

    func tab(for url: URL) -> Tab? {
        let path = url.path.isEmpty ? "/" : url.path
        return tabs.first { t in t.matches.contains { $0 == "/" ? path == "/" : path.hasPrefix($0) } }
    }

    func isImmersive(_ url: URL) -> Bool { immersive.contains { url.path.hasPrefix($0) } }

    static let youtube = ChromeProfile(
        id: "youtube", hosts: ["youtube.com"], wordmark: "YouTube",
        tabs: [
            Tab(id: "home", title: "Home", symbol: "house", path: "/", matches: ["/"], click: ".pivot-bar-item-tab.pivot-w2w"),
            Tab(id: "shorts", title: "Shorts", symbol: "play.square.stack", path: "/shorts", matches: ["/shorts"], click: ".pivot-bar-item-tab.pivot-shorts"),
            Tab(id: "subs", title: "Subscriptions", symbol: "play.rectangle.on.rectangle", path: "/feed/subscriptions", matches: ["/feed/subscriptions"], click: ".pivot-bar-item-tab.pivot-subs"),
            Tab(id: "you", title: "You", symbol: "person.crop.circle", path: "/feed/you", matches: ["/feed/you", "/feed/library", "/feed/history", "/feed/playlists"], click: ".pivot-bar-item-tab.pivot-you"),
        ],
        actions: [],
        showsTabTitles: true,
        immersive: ["/shorts"],
        // m.youtube.com: the fixed header (48 pt), the pivot bar, and the room the page keeps for them; the watch page's
        // sticky player sits right under where the header was.
        css: """
        ytm-mobile-topbar-renderer, #header-bar, .mobile-topbar-header-background, ytm-pivot-bar-renderer { display: none !important; }
        ytm-app { padding-top: 0 !important; padding-bottom: 0 !important; }
        .player-container.sticky-player { top: 0 !important; }
        """,
        hideAround: [],
        search: { "/results?search_query=" + ($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0) })

    static let instagram = ChromeProfile(
        id: "instagram", hosts: ["instagram.com"], wordmark: "Instagram",
        tabs: [
            Tab(id: "home", title: "Home", symbol: "house", path: "/", matches: ["/"], click: #"a[href="/"]:has(svg)"#),
            Tab(id: "reels", title: "Reels", symbol: "play.rectangle", path: "/reels/", matches: ["/reels", "/reel/"], click: #"a[href="/reels/"]"#),
            Tab(id: "direct", title: "Messages", symbol: "paperplane", path: "/direct/inbox/", matches: ["/direct"], click: #"a[href="/direct/inbox/"]"#),
            Tab(id: "search", title: "Search", symbol: "magnifyingglass", path: "/explore/", matches: ["/explore"], click: #"a[href="/explore/"]"#),
            Tab(id: "profile", title: "Profile", symbol: "person.crop.circle", path: "/accounts/edit/", matches: ["/accounts/edit"],
                click: #"a[href^="/"]:has(img[alt*="profile picture" i])"#),
        ],
        actions: [Action(id: "activity", symbol: "heart", path: "/accounts/activity/", click: #"a[href="/accounts/activity/"], a[href*="/notifications"]"#)],
        showsTabTitles: false,
        immersive: ["/reels", "/reel/"],
        css: "",
        // Instagram's class names are generated, so hide the fixed bars that hold its nav links and logo instead.
        hideAround: [#"a[href="/explore/"]"#, #"a[href="/reels/"]"#, #"a[href="/direct/inbox/"]"#, #"svg[aria-label="Instagram"]"#],
        search: nil)

    /// Runs at document start of every page (and once on the current one): adds the style, hides the fixed bars, and
    /// keeps doing so as the single-page app re-renders.
    var userScript: String {
        let cssJSON = (try? String(data: JSONEncoder().encode(css), encoding: .utf8)) ?? "\"\""
        let hideJSON = (try? String(data: JSONEncoder().encode(hideAround), encoding: .utf8)) ?? "[]"
        return """
        (() => {
          if (window.__anusChrome) { window.__anusChrome(); return; }
          const css = \(cssJSON), hide = \(hideJSON);
          const style = document.createElement('style');
          style.textContent = css;
          const hideFixed = () => {
            for (const sel of hide) for (const el of document.querySelectorAll(sel)) {
              for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
                const s = getComputedStyle(e);
                if ((s.position === 'fixed' || s.position === 'sticky') && e.getBoundingClientRect().width >= innerWidth * 0.8) {
                  e.style.setProperty('display', 'none', 'important'); break;
                }
              }
            }
          };
          const run = () => { if (css && !style.isConnected) (document.head || document.documentElement).appendChild(style); hideFixed(); };
          window.__anusChrome = run;
          let t;
          new MutationObserver(() => { clearTimeout(t); t = setTimeout(run, 120); }).observe(document.documentElement, {childList: true, subtree: true});
          document.addEventListener('DOMContentLoaded', run);
          run();
        })();
        """
    }

    /// Clicks the site's own control, else a same-origin link to the path, else loads it.
    static let navigate = """
    const el = click ? document.querySelector(click) : null;
    if (el) { el.click(); return 'click'; }
    const a = Array.from(document.querySelectorAll('a[href]')).find(a => {
      try { const u = new URL(a.href, location.href); return u.origin === location.origin && u.pathname === path; } catch (e) { return false; }
    });
    if (a) { a.click(); return 'link'; }
    location.assign(path);
    return 'load';
    """
}

/// A bar colour taken from the page, and whether its icons need to be light.
struct BarTint: Equatable {
    var color: Color
    var dark: Bool

    init(_ ui: UIColor, traits: UITraitCollection) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
        color = Color(red: r, green: g, blue: b)   // opaque: sites often use 0.98 alpha
        dark = 0.299 * r + 0.587 * g + 0.114 * b < 0.5
    }

    static let black = BarTint(.black, traits: .current)
}

/// State the bars draw from; the web app controller updates it and receives the taps.
@MainActor @Observable
final class ChromeModel {
    let profile: ChromeProfile
    var selected: String?
    var immersive = false
    var canGoBack = false
    /// On one of the tabs' own pages (no back button there, like the real apps).
    var atRoot = true
    var searching = false
    var query = ""
    /// The page's own colours (theme colour at the top, page background at the bottom), so it runs on into the bars.
    var top: BarTint?
    var bottom: BarTint?
    @ObservationIgnored var onTab: (ChromeProfile.Tab) -> Void = { _ in }
    @ObservationIgnored var onAction: (ChromeProfile.Action) -> Void = { _ in }
    @ObservationIgnored var onSearch: (String) -> Void = { _ in }
    @ObservationIgnored var onBack: () -> Void = {}
    @ObservationIgnored var menu: () -> [UIMenuElement] = { [] }

    init(profile: ChromeProfile) {
        self.profile = profile
        selected = profile.tabs.first?.id
    }
}

struct ChromeTopBar: View {
    let model: ChromeModel
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Layout.tight) {
            if model.searching {
                HStack(spacing: Layout.tight) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search \(model.profile.wordmark)", text: Binding(get: { model.query }, set: { model.query = $0 }))
                        .focused($focused)
                        .submitLabel(.search)
                        .onSubmit { model.onSearch(model.query); model.searching = false }
                }
                .padding(.horizontal, 12)
                .frame(height: 36)
                .background(.quaternary, in: .capsule)
                Button("Cancel") { model.searching = false }
                    .onAppear { focused = true }
            } else {
                if model.canGoBack, !model.atRoot {
                    Button(action: model.onBack) { Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).frame(width: 36, height: 36) }
                        .accessibilityLabel("Back")
                }
                wordmark
                Spacer(minLength: 0)
                ForEach(model.profile.actions) { a in
                    Button { model.onAction(a) } label: { icon(a.symbol) }
                        .accessibilityLabel(a.id)
                }
                if model.profile.search != nil {
                    Button { model.query = ""; model.searching = true } label: { icon("magnifyingglass") }
                        .accessibilityLabel("Search")
                }
                MenuButton(label: "\(model.profile.wordmark) menu", menu: model.menu)
                    .frame(width: 36, height: 36)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, Layout.sheetInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 6)
        .background(model.top.map { AnyShapeStyle($0.color) } ?? AnyShapeStyle(.bar))
        .environment(\.colorScheme, model.top.map { $0.dark ? .dark : .light } ?? colorScheme)
        .animation(.smooth(duration: 0.25), value: model.searching)
        .animation(.easeOut(duration: 0.25), value: model.top)
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private var wordmark: some View {
        switch model.profile.id {
        case "youtube":
            HStack(spacing: 4) {
                Image(systemName: "play.rectangle.fill").font(.system(size: 22)).foregroundStyle(.white, .red)
                Text("YouTube").font(.system(size: 20, weight: .bold)).tracking(-0.8)
            }
        case "instagram":
            Text("Instagram").font(.system(size: 26, weight: .semibold, design: .serif)).italic()
        default:
            Text(model.profile.wordmark).font(.headline)
        }
    }

    private func icon(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 19, weight: .regular)).frame(width: 36, height: 36).contentShape(Rectangle())
    }
}

struct ChromeBottomBar: View {
    let model: ChromeModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 0) {
            ForEach(model.profile.tabs) { t in
                let on = model.selected == t.id
                Button { model.onTab(t) } label: {
                    VStack(spacing: 3) {
                        Image(systemName: on && UIImage(systemName: "\(t.symbol).fill") != nil ? "\(t.symbol).fill" : t.symbol)
                            .font(.system(size: model.profile.showsTabTitles ? 20 : 23, weight: on ? .semibold : .regular))
                            .frame(height: 26)
                        if model.profile.showsTabTitles { Text(t.title).font(.system(size: 10, weight: on ? .semibold : .regular)) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.title)
                .accessibilityIdentifier("chrome-tab-\(t.id)")
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(.top, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(model.bottom.map { AnyShapeStyle($0.color) } ?? AnyShapeStyle(.bar))
        .overlay(alignment: .top) { Divider().opacity(model.bottom == nil ? 1 : 0) }   // seamless once it has the page's colour
        .environment(\.colorScheme, model.bottom.map { $0.dark ? .dark : .light } ?? colorScheme)
        .animation(.easeOut(duration: 0.25), value: model.bottom)
    }
}

/// A UIKit menu button (the same deferred menu as the generic web app button), usable from SwiftUI.
struct MenuButton: UIViewRepresentable {
    let label: String
    let menu: () -> [UIMenuElement]
    func makeUIView(context: Context) -> UIButton {
        let b = UIButton(type: .system)
        b.accessibilityLabel = label
        b.accessibilityIdentifier = "chrome-menu"
        b.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        b.tintColor = .label
        b.showsMenuAsPrimaryAction = true
        b.menu = UIMenu(children: [UIDeferredMenuElement.uncached { done in done(menu()) }])
        return b
    }
    func updateUIView(_ b: UIButton, context: Context) {}
}
