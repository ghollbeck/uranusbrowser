import SwiftUI
import WebKit

/// Samples the visible non-private page (a browser tab or a saved web app). Time comes from uninterrupted foreground samples, never wall-clock gaps.
@MainActor
final class DietTracker {
    static let shared = DietTracker()
    private weak var store: BrowserStore?
    private var timer: Timer?
    private var current: DietVisit?
    /// The tab or web app the current visit belongs to.
    private var currentTab: UUID?
    private var lastVideoTime: Double?
    private var lastSample: TimeInterval?
    private var sampling = false
    private var generation = 0
    private let tick: TimeInterval = 5

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "diet.tracking") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "diet.tracking"); reset() }
    }

    func start(_ store: BrowserStore) {
        self.store = store
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { _ in
            Task { @MainActor in await DietTracker.shared.step() }
        }
    }

    /// Also invalidates any extraction already in flight when privacy, selection, app activity or data changes.
    func reset() {
        generation += 1
        current = nil
        currentTab = nil
        lastVideoTime = nil
        lastSample = nil
    }

    func pageChanged() {
        Task { await step() }
    }

    /// What is on screen: the selected browser tab, or a saved web app running full screen (Sources/WebApps).
    private struct Target {
        var key: UUID
        var webView: WKWebView?
        var url: URL
        var title: String
        var isWebApp: Bool
    }

    private func target() -> Target? {
        guard enabled, let store, UIApplication.shared.applicationState == .active, !DietEngine.shared.isPresented else { return nil }
        if let app = WebAppPresenter.shared.active {
            guard let url = app.webView.url, ["http", "https"].contains(url.scheme ?? "") else { return nil }
            return Target(key: app.app.id, webView: app.webView, url: url, title: app.webView.title ?? app.app.name, isWebApp: true)
        }
        guard !store.isPrivate, !store.showSwitcher, store.sheet == nil,
              let tab = store.selectedTab, tab.spaceID != nil, let url = tab.url,
              ["http", "https"].contains(url.scheme ?? "") else { return nil }
        return Target(key: tab.id, webView: tab.webView, url: url, title: tab.title, isWebApp: false)
    }

    private func step() async {
        guard !sampling else { return }
        guard let target = target() else { reset(); return }
        // Loading the DB first prevents opening the Diet later from overwriting freshly tracked visits.
        sampling = true
        defer { sampling = false }
        let token = generation
        await DietEngine.shared.loadIfNeeded()
        guard token == generation, self.target()?.key == target.key else { return }
        let page = await Self.readPage(target.webView)
        guard token == generation, let still = self.target(), still.key == target.key, still.url == target.url,
              page?.url == target.url.absoluteString else { reset(); return }
        let url = target.url
        let now = ProcessInfo.processInfo.systemUptime
        let contentURL = page?.contentURL ?? url.absoluteString
        if current?.url != contentURL || currentTab != target.key {
            currentTab = target.key
            lastVideoTime = page?.videoTime
            lastSample = now
            let fresh = DietVisit(id: 0, url: contentURL, host: DietVisit.normalizedHost(url.host ?? ""),
                                  title: page?.title ?? target.title, at: .now, seconds: 0,
                                  description: page?.description, channel: page?.channel, excerpt: page?.excerpt, source: "live")
            current = DietEngine.shared.db.insert([fresh]).first
            if let current {
                DietEngine.shared.liveVisit(current)
                if target.isWebApp { print("[webapp] diet new visit \(current.host) \"\(current.title)\"") }
            }
            return
        }
        guard var v = current else { return }
        let elapsed = DietTiming.elapsed(since: lastSample, now: now, cadence: tick)
        v.seconds += elapsed
        v.watchSeconds += DietTiming.watched(since: lastVideoTime, now: page?.videoTime, elapsed: elapsed)
        lastSample = now
        lastVideoTime = page?.videoTime
        if let title = page?.title, !title.isEmpty { v.title = title }
        if let description = page?.description { v.description = description }
        if let channel = page?.channel { v.channel = channel }
        if let excerpt = page?.excerpt { v.excerpt = excerpt }
        current = v
        DietEngine.shared.db.update(v)
        DietEngine.shared.liveVisit(v)
        if target.isWebApp { print(String(format: "[webapp] diet %@ %.0fs on screen, %.0fs watched", v.host, v.seconds, v.watchSeconds)) }
    }

    struct Page {
        var url: String
        var contentURL: String?
        var title: String?
        var description: String?
        var channel: String?
        var videoTime: Double?
        var excerpt: String?
    }

    /// Read visible article/transcript text, never form values or hidden nodes. No network requests.
    private static let probe = #"""
    (() => {
      const meta = n => { const e = document.querySelector(`meta[name="${n}"],meta[property="${n}"]`); return e ? e.content : null; };
      const visible = e => {
        if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return false;
        const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      };
      const videos = Array.from(document.querySelectorAll('video'));
      const video = videos.find(v => !v.paused) || videos.find(v => v.currentTime > 0);
      const ch = document.querySelector('#owner #channel-name a, ytm-slim-owner-renderer .slim-owner-channel-name, .slim-owner-channel-name, [itemprop="author"] [itemprop="name"]');
      const root = Array.from(document.querySelectorAll('article, [role="article"], ytd-transcript-renderer, ytm-transcript-renderer'))
        .filter(visible).sort((a,b) => Math.abs(a.getBoundingClientRect().top - innerHeight/3) - Math.abs(b.getBoundingClientRect().top - innerHeight/3))[0];
      const permalink = root && root.querySelector('a[href*="/p/"],a[href*="/reel/"],a[href*="/status/"]');
      let contentURL = null;
      if (permalink) { const link = new URL(permalink.href, location.href); if (link.origin === location.origin) contentURL = link.href; }
      let excerpt = null;
      if (root) {
        const parts = [];
        let length = 0;
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walk.nextNode() && length < 2400) {
          const node = walk.currentNode, parent = node.parentElement;
          if (!parent || !visible(parent) || parent.closest('script,style,nav,form,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]')) continue;
          const text = node.textContent.trim();
          if (text) { parts.push(text); length += text.length; }
        }
        excerpt = parts.join(' ').replace(/\s+/g, ' ').slice(0, 2400) || null;
      }
      return {url: location.href, contentURL, title: document.title || null,
              description: (meta('description') || meta('og:description') || '').slice(0, 500) || null,
              channel: ch ? (ch.textContent || ch.getAttribute('content') || '').trim().slice(0, 80) || null : null,
              videoTime: video && !video.seeking ? video.currentTime : null, excerpt};
    })()
    """#

    private static func readPage(_ webView: WKWebView?) async -> Page? {
        guard let webView, let result = try? await webView.evaluateJavaScript(probe) as? [String: Any],
              let url = result["url"] as? String else { return nil }
        return Page(url: url, contentURL: result["contentURL"] as? String, title: result["title"] as? String, description: result["description"] as? String,
                    channel: result["channel"] as? String, videoTime: result["videoTime"] as? Double,
                    excerpt: result["excerpt"] as? String)
    }
}
