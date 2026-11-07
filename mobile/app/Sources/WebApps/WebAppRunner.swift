import SwiftUI
import UIKit
import WebKit
import Observation

/// Opens saved web apps full screen and keeps the last one alive, so switching back to the browser and returning keeps
/// its page (like a Home Screen web app in the background). The Algorithm Diet samples `active` while it is on screen.
@MainActor @Observable
final class WebAppPresenter {
    static let shared = WebAppPresenter()
    /// Set by Shortcuts / deep links / launch arguments; RootView opens it once the browser is ready.
    var pendingLaunch: UUID?
    /// The web app on screen right now (nil while it is closed or the app is in the background).
    private(set) var active: WebAppViewController?
    @ObservationIgnored private var kept: WebAppViewController?

    func open(_ app: WebApp, store: BrowserStore) {
        let hadCover = store.sheet != nil || DietEngine.shared.isPresented || store.showSwitcher
        store.sheet = nil
        store.showSwitcher = false
        DietEngine.shared.isPresented = false
        Task {
            if hadCover { try? await Task.sleep(for: .milliseconds(500)) }   // let the sheet finish going away first
            present(app, store: store)
        }
    }

    private func present(_ app: WebApp, store: BrowserStore) {
        guard let top = Self.topController() else { return }
        if let current = top as? WebAppViewController {
            if current.app.id == app.id { return }
            current.dismiss(animated: false) { [weak self] in self?.present(app, store: store) }
            return
        }
        let vc: WebAppViewController
        if let kept, kept.app.id == app.id {
            vc = kept
        } else {
            kept?.tearDown()
            vc = WebAppViewController(app: app, store: store)
            kept = vc
        }
        print("[webapp] open \(app.name) \(app.startURL)")
        top.present(vc, animated: true)
    }

    func close(_ vc: WebAppViewController) {
        vc.dismiss(animated: true)
    }

    /// Called when a web app is removed (or its Space deleted): its live page must not linger.
    func forget(_ id: UUID) {
        if kept?.app.id == id {
            kept?.presentingViewController?.dismiss(animated: true)
            kept?.tearDown()
            kept = nil
        }
    }

    fileprivate func didAppear(_ vc: WebAppViewController) {
        active = vc
        DietTracker.shared.reset()
        DietTracker.shared.pageChanged()
    }

    fileprivate func didDisappear(_ vc: WebAppViewController) {
        if active === vc { active = nil }
        DietTracker.shared.reset()
        DietTracker.shared.pageChanged()
    }

    static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive } ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var vc = scene?.keyWindow?.rootViewController
        while let p = vc?.presentedViewController, !p.isBeingDismissed { vc = p }
        return vc
    }
}

/// Full-screen host for one web app: the page below the status bar (painted with the site's theme colour), a small
/// draggable glass button for the menu, and a "Back to <app>" banner while a link has left the app's scope (logins).
final class WebAppViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let app: WebApp
    private weak var store: BrowserStore?
    let webView: WKWebView
    private let band = UIView()
    private let bubble = UIButton(configuration: .glass())
    private let banner = UIButton(configuration: .glass())
    private var observers: [NSKeyValueObservation] = []
    private var lastInScope: URL?
    private var bandIsDark = false
    /// Native bars for sites with a profile (YouTube, Instagram); nil keeps the generic look (band + floating button).
    private let chrome: ChromeModel?
    private var topBar: UIView?

    init(app: WebApp, store: BrowserStore) {
        self.app = app
        self.store = store
        // The Space it was saved from keeps its cookies and logins; if that Space is gone, the current one.
        let spaceID = app.spaceID.flatMap { id in store.spaces.contains { $0.id == id } ? id : nil } ?? store.currentSpaceID
        webView = WKWebView(frame: .zero, configuration: store.makeConfiguration(spaceID: spaceID))
        chrome = ChromeProfile.forHost(app.host).map(ChromeModel.init)
        super.init(nibName: nil, bundle: nil)
        // Over, not instead of, the browser: a .fullScreen presentation takes the SwiftUI root out of the window, and putting it
        // back re-runs its .task (launch work) when the web app closes.
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        guard let chrome else { return bandIsDark ? .lightContent : .darkContent }
        return chrome.top.map { $0.dark } ?? (traitCollection.userInterfaceStyle == .dark) ? .lightContent : .darkContent
    }
    override var prefersStatusBarHidden: Bool { false }

    override func viewDidLoad() {
        super.viewDidLoad()
        let theme = app.themeColor.flatMap(UIColor.init(css:))
        view.backgroundColor = theme ?? .systemBackground
        band.backgroundColor = theme ?? .systemBackground
        setBand(theme ?? .systemBackground)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.isOpaque = false
        webView.backgroundColor = .clear

        if let chrome {
            setUpChrome(chrome)
        } else {
            for v in [band, webView] as [UIView] {
                v.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(v)
            }
            NSLayoutConstraint.activate([
                band.topAnchor.constraint(equalTo: view.topAnchor),
                band.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                band.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                band.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            setUpBubble()
        }
        setUpBanner()
        observers = [
            webView.observe(\.url) { [weak self] w, _ in
                Task { @MainActor in
                    guard let self, let u = w.url else { return }
                    self.urlChanged(u)
                }
            },
            webView.observe(\.themeColor) { [weak self] w, _ in
                Task { @MainActor in
                    if let c = w.themeColor { self?.setBand(c) }
                    self?.scheduleBarColors()
                }
            },
            webView.observe(\.underPageBackgroundColor) { [weak self] _, _ in
                Task { @MainActor in self?.scheduleBarColors() }
            },
            webView.scrollView.observe(\.contentOffset) { [weak self] _, _ in
                Task { @MainActor in if self?.chrome != nil { self?.scheduleBarColors() } }
            },
            webView.observe(\.canGoBack) { [weak self] w, _ in
                Task { @MainActor in self?.chrome?.canGoBack = w.canGoBack }
            },
        ]
        if let start = app.start {
            store?.applyBlocking(to: webView, url: start)
            webView.load(URLRequest(url: start))
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        WebAppPresenter.shared.didAppear(self)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        WebAppPresenter.shared.didDisappear(self)
    }

    func tearDown() {
        observers.forEach { $0.invalidate() }
        observers = []
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
    }

    // MARK: native bars (YouTube, Instagram)

    private static let barHeight: CGFloat = 50

    private func setUpChrome(_ chrome: ChromeModel) {
        view.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: chrome.profile.userScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let top = UIHostingController(rootView: ChromeTopBar(model: chrome))
        let bottom = UIHostingController(rootView: ChromeBottomBar(model: chrome))
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        for h in [top, bottom] as [UIViewController] {
            addChild(h)
            h.view.translatesAutoresizingMaskIntoConstraints = false
            h.view.backgroundColor = .clear
            view.addSubview(h.view)
            h.didMove(toParent: self)
        }
        top.safeAreaRegions = []
        bottom.safeAreaRegions = []
        topBar = top.view
        NSLayoutConstraint.activate([
            top.view.topAnchor.constraint(equalTo: view.topAnchor),
            top.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            top.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            top.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Self.barHeight),
            bottom.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -Self.barHeight),
            bottom.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottom.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottom.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.topAnchor.constraint(equalTo: top.view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottom.view.topAnchor),
        ])
        chrome.menu = { [weak self] in self?.menuItems() ?? [] }
        chrome.onBack = { [weak self] in self?.webView.goBack() }
        chrome.onTab = { [weak self] tab in
            guard let self, let chrome = self.chrome else { return }
            if chrome.selected == tab.id, chrome.atRoot {
                self.webView.evaluateJavaScript("window.scrollTo({top: 0, behavior: 'smooth'})")   // like tapping the active tab in the real apps
                return
            }
            chrome.selected = tab.id
            self.navigate(click: tab.click, path: tab.path)
        }
        chrome.onAction = { [weak self] action in self?.navigate(click: action.click, path: action.path) }
        chrome.onSearch = { [weak self] query in
            guard let self, let path = self.chrome?.profile.search?(query), let start = self.app.start,
                  let url = URL(string: path, relativeTo: start)?.absoluteURL else { return }
            self.webView.load(URLRequest(url: url))
        }
    }

    private func navigate(click: String?, path: String) {
        Task {
            let how = try? await webView.callAsyncJavaScript(ChromeProfile.navigate, arguments: ["click": click ?? "", "path": path],
                                                             in: nil, contentWorld: .page)
            print("[webapp] tab \(path) via \(how as? String ?? "?")")
        }
    }

    private func updateChrome(for url: URL) {
        guard let chrome else { return }
        let tab = chrome.profile.tab(for: url)
        if let tab { chrome.selected = tab.id }
        chrome.atRoot = tab != nil
        chrome.immersive = chrome.profile.isImmersive(url)
        updateBarColors()
        scheduleBarColors(after: 600)   // single-page apps paint the new view a moment after the URL changes
    }

    /// The background the page really shows next to each bar: the first opaque, page-sized element (at least 90% wide,
    /// half the height, so thumbnails and cards don't count) under the middle of the top and bottom edge.
    private static let edgeColors = #"""
    (() => {
      const W = innerWidth, H = innerHeight;
      const opaque = c => {
        const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null;
        const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
        return p.length > 3 && p[3] < 0.5 ? null : [p[0], p[1], p[2]];
      };
      const at = y => {
        for (const e of document.elementsFromPoint(W / 2, y)) {
          const r = e.getBoundingClientRect();
          if (r.width < W * 0.9 || r.height < H * 0.5) continue;
          const c = opaque(getComputedStyle(e).backgroundColor); if (c) return c;
        }
        for (const e of [document.body, document.documentElement]) { const c = e && opaque(getComputedStyle(e).backgroundColor); if (c) return c; }
        return null;
      };
      return {top: at(4), bottom: at(H - 4)};
    })()
    """#

    /// The bars continue the page: its own background behind each bar (the site's theme colour if that can't be read).
    /// Video feeds (Shorts, Reels) are black edge to edge.
    private func updateBarColors() {
        guard let chrome else { return }
        if chrome.immersive {
            applyBarColors(top: .black, bottom: .black)
            return
        }
        Task {
            let edges = (try? await webView.evaluateJavaScript(Self.edgeColors)) as? [String: Any]
            let rgb = { (k: String) -> UIColor? in
                guard let c = edges?[k] as? [Double], c.count == 3 else { return nil }
                return UIColor(red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255, alpha: 1)
            }
            guard let chrome = self.chrome, !chrome.immersive else { return }
            let fallback = webView.themeColor ?? webView.underPageBackgroundColor ?? .systemBackground
            applyBarColors(top: rgb("top") ?? fallback, bottom: rgb("bottom") ?? rgb("top") ?? fallback)
        }
    }

    private func applyBarColors(top: UIColor, bottom: UIColor) {
        guard let chrome else { return }
        let t = BarTint(top, traits: traitCollection), b = BarTint(bottom, traits: traitCollection)
        if chrome.top != t { chrome.top = t }
        if chrome.bottom != b { chrome.bottom = b }
        view.backgroundColor = bottom
        setNeedsStatusBarAppearanceUpdate()
    }

    /// Re-read the colours once scrolling settles (a page can change background further down).
    private var colorTask: Task<Void, Never>?
    private func scheduleBarColors(after ms: Int = 300) {
        colorTask?.cancel()
        colorTask = Task {
            try? await Task.sleep(for: .milliseconds(ms))
            if !Task.isCancelled { updateBarColors() }
        }
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        updateBarColors()
        setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: theme band

    private func setBand(_ color: UIColor) {
        band.backgroundColor = color
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: traitCollection).getRed(&r, green: &g, blue: &b, alpha: &a)
        let dark = 0.299 * r + 0.587 * g + 0.114 * b < 0.55
        if dark != bandIsDark {
            bandIsDark = dark
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    // MARK: menu button

    private static let bubbleSize: CGFloat = 40
    private static let bubbleKey = "webapp.bubble"   // [side (0 left, 1 right), y as a fraction of the height]

    private func setUpBubble() {
        bubble.configuration?.image = UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
        bubble.configuration?.cornerStyle = .capsule
        bubble.configuration?.contentInsets = .zero
        bubble.accessibilityLabel = "\(app.name) menu"
        bubble.showsMenuAsPrimaryAction = true
        bubble.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.menuItems() ?? []) }])
        bubble.alpha = 0.85
        view.addSubview(bubble)
        bubble.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(dragBubble(_:))))
    }

    private func menuItems() -> [UIMenuElement] {
        let w = webView
        var items: [UIMenuElement] = []
        let nav = UIMenu(options: .displayInline, children: [
            UIAction(title: "Back", image: UIImage(systemName: "chevron.left"), attributes: w.canGoBack ? [] : .disabled) { _ in w.goBack() },
            UIAction(title: "Reload", image: UIImage(systemName: "arrow.clockwise")) { _ in w.reload() },
            UIAction(title: "Start Page", image: UIImage(systemName: "house")) { [weak self] _ in
                if let s = self?.app.start { w.load(URLRequest(url: s)) }
            },
        ])
        items.append(nav)
        var more: [UIMenuElement] = [
            UIAction(title: "Share", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in self?.share() },
            UIAction(title: "Open in Browser Tab", image: UIImage(systemName: "safari")) { [weak self] _ in self?.openInBrowser() },
        ]
        if WebAppHomeScreen.available {
            more.insert(UIAction(title: "Add to Home Screen", image: UIImage(systemName: "plus.square")) { [weak self] _ in
                guard let self else { return }
                WebAppHomeScreen.present(self.app, icon: WebAppStore.shared.icon(for: self.app), from: self, source: self.topBar ?? self.bubble)
            }, at: 0)
        }
        items.append(UIMenu(options: .displayInline, children: more))
        items.append(UIAction(title: "Close \(app.name)", image: UIImage(systemName: "xmark")) { [weak self] _ in
            guard let self else { return }
            WebAppPresenter.shared.close(self)
        })
        return items
    }

    private func share() {
        guard let u = webView.url else { return }
        let a = UIActivityViewController(activityItems: [u], applicationActivities: nil)
        a.popoverPresentationController?.sourceView = topBar ?? bubble
        present(a, animated: true)
    }

    private func openInBrowser() {
        guard let u = webView.url, let store else { return }
        if let id = app.spaceID, store.spaces.contains(where: { $0.id == id }), id != store.currentSpaceID || store.isPrivate { store.switchSpace(id) }
        store.newTab(url: u)
        WebAppPresenter.shared.close(self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if bubble.frame == .zero { placeBubble() }
        banner.frame.origin = CGPoint(x: (view.bounds.width - banner.frame.width) / 2, y: (topBar?.frame.maxY ?? view.safeAreaInsets.top) + 8)
    }

    private func placeBubble() {
        let s = Self.bubbleSize
        let pos = UserDefaults.standard.array(forKey: Self.bubbleKey) as? [Double] ?? [1, 0.72]
        let x = pos.first == 0 ? 8 : view.bounds.width - s - 8
        let minY = view.safeAreaInsets.top + 8, maxY = view.bounds.height - view.safeAreaInsets.bottom - s - 8
        let y = min(maxY, max(minY, view.bounds.height * CGFloat(pos.count > 1 ? pos[1] : 0.72)))
        bubble.frame = CGRect(x: x, y: y, width: s, height: s)
    }

    @objc private func dragBubble(_ g: UIPanGestureRecognizer) {
        let t = g.translation(in: view)
        bubble.center = CGPoint(x: bubble.center.x + t.x, y: bubble.center.y + t.y)
        g.setTranslation(.zero, in: view)
        guard g.state == .ended || g.state == .cancelled else { return }
        // Snap to the nearer side and remember where it was left.
        let side: Double = bubble.center.x < view.bounds.width / 2 ? 0 : 1
        UserDefaults.standard.set([side, Double(bubble.frame.minY / max(1, view.bounds.height))], forKey: Self.bubbleKey)
        UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0) { self.placeBubble() }
    }

    // MARK: out-of-scope banner

    private func setUpBanner() {
        banner.configuration?.cornerStyle = .capsule
        banner.configuration?.image = UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        banner.configuration?.imagePadding = 6
        banner.configuration?.title = "Back to \(app.name)"
        banner.addAction(UIAction { [weak self] _ in
            guard let self, let target = self.lastInScope ?? self.app.start else { return }
            self.webView.load(URLRequest(url: target))
        }, for: .primaryActionTriggered)
        banner.isHidden = true
        view.addSubview(banner)
    }

    private func urlChanged(_ u: URL) {
        guard ["http", "https"].contains(u.scheme ?? "") else { return }
        updateChrome(for: u)
        let inside = app.inScope(u)
        if inside { lastInScope = u }
        banner.isHidden = inside
        if !inside {
            banner.configuration?.subtitle = u.host
            banner.sizeToFit()
            view.setNeedsLayout()
        }
        DietTracker.shared.pageChanged()
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow, preferences); return }
        if !["http", "https", "about", "blob", "data"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)   // mailto:, tel:, app links
            decisionHandler(.cancel, preferences)
            return
        }
        if navigationAction.targetFrame?.isMainFrame ?? false {
            store?.applyBlocking(to: webView, url: url)
            preferences.preferredContentMode = .mobile
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DietTracker.shared.pageChanged()
        updateBarColors()
    }

    // MARK: WKUIDelegate

    /// Standalone web apps have no tabs: `target=_blank` and `window.open` load in the app itself.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url, u.absoluteString != "about:blank" { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        a.addAction(.init(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        a.addAction(.init(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(.init(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(.init(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(.init(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }
}

extension UIColor {
    /// `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` and a few names: what manifests and theme-color tags use.
    convenience init?(css raw: String) {
        let s = raw.trimmingCharacters(in: .whitespaces).lowercased()
        let names: [String: UInt32] = ["white": 0xffffff, "black": 0x000000, "red": 0xff0000, "blue": 0x0000ff, "green": 0x008000]
        var hex = s.hasPrefix("#") ? String(s.dropFirst()) : nil
        if let n = names[s] { hex = String(format: "%06x", n) }
        if var h = hex {
            if h.count == 3 || h.count == 4 { h = h.map { "\($0)\($0)" }.joined() }
            guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
            let (rgb, a) = h.count == 8 ? (v >> 8, Double(v & 0xff) / 255) : (v, 1)
            self.init(red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255, blue: Double(rgb & 0xff) / 255, alpha: a)
            return
        }
        guard s.hasPrefix("rgb"), let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")") else { return nil }
        let parts = s[s.index(after: open)..<close].split(whereSeparator: { ", /".contains($0) }).compactMap { Double($0.replacingOccurrences(of: "%", with: "")) }
        guard parts.count >= 3 else { return nil }
        self.init(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts.count > 3 ? min(1, parts[3]) : 1)
    }
}
