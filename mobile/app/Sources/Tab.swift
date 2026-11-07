import SwiftUI
import WebKit
import Observation

/// One browser tab. Owns at most one live `WKWebView`; background tabs keep only a snapshot and release the web view.
@MainActor @Observable
final class Tab: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
    let id: UUID
    var url: URL?
    var title: String
    var isPinned: Bool
    var lastActive: Date
    var snapshot: UIImage?
    var favicon: UIImage?
    var progress: Double = 0
    var isLoading = false
    var canGoBack = false
    var canGoForward = false
    var desktopMode = false
    var pageZoom: Double = 1.0
    /// Average colour of the page strip behind the status bar / behind the bottom bar, and the latter's brightness (0...1).
    var topTint: Color?
    var bottomTint: Color?
    var bottomLuma: Double?
    var topLuma: Double?

    @ObservationIgnored weak var store: BrowserStore?
    /// nil for private tabs.
    @ObservationIgnored let spaceID: UUID?
    @ObservationIgnored var webView: WKWebView?
    @ObservationIgnored var savedState: Data?
    @ObservationIgnored private var pendingConfiguration: WKWebViewConfiguration?
    @ObservationIgnored private var observers: [NSKeyValueObservation] = []
    @ObservationIgnored private var sampleTask: Task<Void, Never>?
    @ObservationIgnored private var loadSampler: Task<Void, Never>?
    @ObservationIgnored private var loadStart = Date()
    @ObservationIgnored private var lastLoggedLuma: Double = -1

    init(id: UUID = UUID(), url: URL?, title: String = "", pinned: Bool = false, lastActive: Date = .now,
         spaceID: UUID?, store: BrowserStore) {
        self.id = id
        self.url = url
        self.title = title
        self.isPinned = pinned
        self.lastActive = lastActive
        self.spaceID = spaceID
        self.store = store
        super.init()
        snapshot = store.loadSnapshot(for: id)
    }

    convenience init(record: TabRecord, spaceID: UUID?, store: BrowserStore) {
        self.init(id: record.id, url: record.url.flatMap(URL.init(string:)), title: record.title,
                  pinned: record.pinned, lastActive: record.lastActive, spaceID: spaceID, store: store)
    }

    var isBlank: Bool { url == nil }
    var displayTitle: String { title.isEmpty ? (url?.host ?? "New Tab") : title }
    var hasWebView: Bool { webView != nil }

    // MARK: web view lifecycle

    @discardableResult
    func ensureWebView() -> WKWebView {
        if let webView { return webView }
        let config = pendingConfiguration ?? store!.makeConfiguration(spaceID: spaceID)
        pendingConfiguration = nil
        let wv = WKWebView(frame: .zero, configuration: config)
        attach(wv)
        webView = wv
        if let savedState {
            wv.interactionState = savedState
            self.savedState = nil
        } else if let url {
            wv.load(URLRequest(url: url))
        }
        return wv
    }

    /// Used for `window.open` / `target=_blank`: WebKit hands us the configuration the new web view must use.
    func adopt(_ configuration: WKWebViewConfiguration) {
        pendingConfiguration = configuration
        ensureWebView()
    }

    private func attach(_ wv: WKWebView) {
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.isInspectable = true
        wv.pageZoom = pageZoom
        wv.scrollView.contentInsetAdjustmentBehavior = .automatic
        observers = [
            wv.observe(\.estimatedProgress) { [weak self] w, _ in Task { @MainActor in self?.progress = w.estimatedProgress } },
            wv.observe(\.isLoading) { [weak self] w, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.isLoading = w.isLoading
                    if w.isLoading { self.startLoadSampling() } else { self.loadSampler?.cancel() }
                }
            },
            wv.observe(\.canGoBack) { [weak self] w, _ in Task { @MainActor in self?.canGoBack = w.canGoBack } },
            wv.observe(\.canGoForward) { [weak self] w, _ in Task { @MainActor in self?.canGoForward = w.canGoForward } },
            wv.observe(\.title) { [weak self] w, _ in
                Task { @MainActor in if let t = w.title, !t.isEmpty { self?.title = t } }
            },
            wv.scrollView.observe(\.contentOffset) { [weak self] _, _ in Task { @MainActor in self?.scheduleColorSample() } },
            wv.observe(\.url) { [weak self] w, _ in
                Task { @MainActor in
                    guard let self, let u = w.url, u.scheme != "about" else { return }
                    self.url = u
                    self.store?.scheduleSave()
                    DietTracker.shared.pageChanged()
                }
            },
        ]
    }

    func releaseWebView() {
        observers.forEach { $0.invalidate() }
        observers = []
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
        isLoading = false
        progress = 0
    }

    /// Background tabs keep a snapshot and their back/forward state, and give the web view's memory back.
    func suspend() {
        Task {
            await captureSnapshot()
            savedState = webView?.interactionState as? Data
            releaseWebView()
        }
    }

    func load(_ u: URL) {
        url = u
        lastActive = .now
        if let webView { webView.load(URLRequest(url: u)) } else { ensureWebView() }
        store?.scheduleSave()
    }

    func reloadOrStop() {
        if isLoading { webView?.stopLoading() } else { webView?.reload() }
    }

    func setZoom(_ z: Double) {
        pageZoom = min(3.0, max(0.5, (z * 10).rounded() / 10))
        webView?.pageZoom = pageZoom
    }

    func setDesktopMode(_ on: Bool) {
        desktopMode = on
        webView?.reload()   // the content mode is applied per navigation in decidePolicyFor
    }

    // MARK: snapshot + favicon

    func captureSnapshot() async {
        guard let wv = webView, wv.bounds.width > 0 else { return }
        let cfg = WKSnapshotConfiguration()
        cfg.snapshotWidth = 520
        if let img = try? await wv.takeSnapshot(configuration: cfg) {
            snapshot = img
            store?.persistSnapshot(img, for: id)
        }
    }

    /// Saves the icon the page itself declares (falling back to /favicon.ico) into the shared favicon cache.
    /// Re-reads the page's average colours shortly after scrolling stops or a load finishes.
    /// While a page loads, re-read its colours every 150 ms (then every 300 ms), so the bars follow the page as soon as it
    /// paints instead of waiting for the load, the favicon and a delay (that was seconds on slow pages).
    private func startLoadSampling() {
        loadSampler?.cancel()
        loadStart = Date()
        lastLoggedLuma = -1
        loadSampler = Task { @MainActor [weak self] in
            var n = 0
            while let self, !Task.isCancelled, self.isLoading {
                await self.sampleColors()
                n += 1
                try? await Task.sleep(for: .milliseconds(n < 8 ? 150 : 300))
            }
        }
    }

    func scheduleColorSample() {
        sampleTask?.cancel()
        sampleTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await sampleColors()
        }
    }

    private func sampleColors() async {
        guard let wv = webView, wv.bounds.width > 0 else { return }
        let cfg = WKSnapshotConfiguration()
        cfg.snapshotWidth = 48
        guard let cg = (try? await wv.takeSnapshot(configuration: cfg))?.cgImage,
              let top = Self.average(of: cg, from: 0.0, to: 0.10),
              let bottom = Self.average(of: cg, from: 0.88, to: 1.0) else { return }
        withAnimation(.easeOut(duration: 0.25)) {
            topTint = top.color
            bottomTint = bottom.color
            bottomLuma = bottom.luma
            topLuma = top.luma
        }
        // Debug log: every time the sampled bottom colour really changes (so the timeline of the bar colour can be read from the console).
        let key = (bottom.luma * 100).rounded()
        if key != lastLoggedLuma {
            lastLoggedLuma = key
            print(String(format: "[tint] %@ +%.0f ms progress %.2f loading=%@ bottom luma %.2f",
                         url?.host ?? "?", Date().timeIntervalSince(loadStart) * 1000, progress, isLoading ? "yes" : "no", bottom.luma))
        }
    }

    /// Mean colour of a horizontal band of the image (fractions of its height), via a 1x1 downscale.
    private static func average(of image: CGImage, from a: CGFloat, to b: CGFloat) -> (color: Color, luma: Double)? {
        let h = CGFloat(image.height), w = CGFloat(image.width)
        guard let crop = image.cropping(to: CGRect(x: 0, y: h * a, width: w, height: max(1, h * (b - a))).integral) else { return nil }
        var px = [UInt8](repeating: 0, count: 4)
        let ok = px.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return true
        }
        guard ok else { return nil }
        let r = Double(px[0]) / 255, g = Double(px[1]) / 255, bl = Double(px[2]) / 255
        return (Color(red: r, green: g, blue: bl), 0.299 * r + 0.587 * g + 0.114 * bl)
    }

    private func refreshFavicon() async {
        guard let wv = webView, let key = url?.siteKey else { return }
        if FaviconStore.shared.hasRecentPageIcon(for: key) {
            favicon = FaviconStore.shared.image(for: key)   // checked within the last day; no network needed
            return
        }
        let js = "Array.from(document.querySelectorAll('link[rel~=\"icon\"],link[rel=\"apple-touch-icon\"]')).map(function(l){return l.href})"
        let result = try? await wv.evaluateJavaScript(js)
        var candidates = ((result as? [String]) ?? []).compactMap(URL.init(string:))
            .filter { $0.scheme?.hasPrefix("http") == true && !$0.path.lowercased().hasSuffix(".svg") }   // UIImage cannot draw SVG
        if let page = url, var c = URLComponents(url: page, resolvingAgainstBaseURL: false) {
            c.path = "/favicon.ico"; c.query = nil; c.fragment = nil
            if let guess = c.url { candidates.append(guess) }
        }
        for u in candidates {
            guard let (data, response) = try? await URLSession(configuration: .ephemeral).data(from: u),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
                  data.count < 512_000, let img = UIImage(data: data) else { continue }
            favicon = img
            FaviconStore.shared.store(img, for: key, persist: spaceID != nil, source: "page")
            return
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow, preferences); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if !["http", "https", "about", "blob", "data", "file"].contains(scheme) {
            UIApplication.shared.open(url)   // mailto:, tel:, app links
            decisionHandler(.cancel, preferences)
            return
        }
        if navigationAction.targetFrame?.isMainFrame ?? false {
            store?.applyBlocking(to: webView, url: url)
            preferences.preferredContentMode = desktopMode ? .desktop : .mobile
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let t = webView.title, !t.isEmpty { title = t }
        store?.recordVisit(self)
        DietTracker.shared.pageChanged()
        print(String(format: "[tint] %@ didFinish %.0f ms after load start", url?.host ?? "?", Date().timeIntervalSince(loadStart) * 1000))
        Task {
            await sampleColors()   // colours first: no favicon download, no delay in front of it
            await refreshFavicon()
            try? await Task.sleep(for: .milliseconds(600))
            await captureSnapshot()
            await sampleColors()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        guard ns.code != NSURLErrorCancelled, ns.code != 102 else { return }   // 102: frame load interrupted (downloads etc.)
        let failing = (ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? url?.absoluteString ?? ""
        let msg = ns.localizedDescription.replacingOccurrences(of: "<", with: "&lt;")
        let html = """
        <meta name=viewport content="width=device-width,initial-scale=1"><body style="font:17px -apple-system;margin:0;display:flex;\
        min-height:100vh;align-items:center;justify-content:center;background:#16161c;color:#ddd;text-align:center">\
        <div style="padding:32px"><h2 style="margin:0 0 8px">Can't open this page</h2><p style="opacity:.7">\(msg)</p>\
        <p><a href="\(failing)" style="color:#8b8bff">Try again</a></p></div></body>
        """
        webView.loadHTMLString(html, baseURL: URL(string: failing))
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let store else { return nil }
        let t = store.newTab(url: nil, configuration: configuration)
        return t.webView
    }

    func webViewDidClose(_ webView: WKWebView) { store?.close(self) }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        a.addAction(.init(title: "OK", style: .default) { _ in completionHandler() })
        if !presentAlert(a) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        a.addAction(.init(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(.init(title: "OK", style: .default) { _ in completionHandler(true) })
        if !presentAlert(a) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(.init(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(.init(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        if !presentAlert(a) { completionHandler(nil) }
    }

    private func presentAlert(_ alert: UIAlertController) -> Bool {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var vc = scene?.keyWindow?.rootViewController
        while let p = vc?.presentedViewController { vc = p }
        guard let vc else { return false }
        vc.present(alert, animated: true)
        return true
    }
}
