import WebKit

/// Small built-in WebKit content-rule lists. These are a starter set (a few dozen well-known ad and tracker
/// hosts plus common cookie-banner containers), not a full filter list like EasyList.
@MainActor
enum ContentBlocker {
    enum Kind: String, CaseIterable { case ads, trackers, cookieBanners }

    private(set) static var lists: [Kind: WKContentRuleList] = [:]

    static func load() async {
        for kind in Kind.allCases {
            do {
                if let list = try await WKContentRuleListStore.default().compileContentRuleList(
                    forIdentifier: "flecha.\(kind.rawValue).v1", encodedContentRuleList: json(for: kind)) {
                    lists[kind] = list
                }
            } catch {
                print("ContentBlocker: compile \(kind) failed: \(error)")
            }
        }
    }

    static func apply(_ s: SiteSettings, to ucc: WKUserContentController) {
        ucc.removeAllContentRuleLists()
        if s.blockAds, let l = lists[.ads] { ucc.add(l) }
        if s.blockTrackers, let l = lists[.trackers] { ucc.add(l) }
        if s.blockCookieBanners, let l = lists[.cookieBanners] { ucc.add(l) }
    }

    // MARK: rules

    private static let adHosts = [
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "2mdn.net", "adnxs.com", "taboola.com",
        "outbrain.com", "criteo.com", "criteo.net", "pubmatic.com", "rubiconproject.com", "openx.net", "adsrvr.org",
        "amazon-adsystem.com", "moatads.com", "adform.net", "smartadserver.com", "casalemedia.com", "advertising.com",
        "yieldmo.com", "sharethrough.com", "teads.tv", "media.net", "adcolony.com", "mgid.com", "revcontent.com",
    ]

    private static let trackerHosts = [
        "google-analytics.com", "googletagmanager.com", "googletagservices.com", "connect.facebook.net", "facebook.net",
        "hotjar.com", "segment.io", "segment.com", "mixpanel.com", "amplitude.com", "scorecardresearch.com",
        "quantserve.com", "clarity.ms", "fullstory.com", "bat.bing.com", "ads-twitter.com", "analytics.tiktok.com",
        "sc-static.net", "snap.licdn.com", "px.ads.linkedin.com", "chartbeat.com", "chartbeat.net", "parsely.com",
        "newrelic.com", "nr-data.net", "branch.io", "appsflyer.com", "adjust.com", "heap.io", "heapanalytics.com",
        "mouseflow.com", "crazyegg.com", "optimizely.com", "demdex.net", "omtrdc.net", "everesttech.net",
    ]

    private static let bannerSelectors = [
        "#onetrust-consent-sdk", "#onetrust-banner-sdk", ".onetrust-pc-dark-filter", "#CybotCookiebotDialog",
        "#CybotCookiebotDialogBodyUnderlay", ".cc-window", ".cc-banner", "#cookie-banner", ".cookie-banner",
        "#cookieConsent", ".cookie-consent", "#cookie-notice", ".cookie-notice", "#truste-consent-track",
        ".fc-consent-root", "#qc-cmp2-container", ".osano-cm-window", "#usercentrics-root", ".didomi-popup-container",
        "#didomi-host", ".evidon-banner", "#sp_message_container_", "[id^='sp_message_container']", ".truste_overlay",
        "#cmpbox", "#cmpbox2", ".cmp-container", "#gdpr-cookie-message", ".gdpr-banner", "#CookieBanner",
    ]

    private static func json(for kind: Kind) -> String {
        var rules: [[String: Any]] = []
        func hostRules(_ hosts: [String]) {
            for h in hosts {
                let escaped = h.replacingOccurrences(of: ".", with: "\\.")
                rules.append([
                    "trigger": ["url-filter": "^https?://([a-z0-9-]+\\.)*\(escaped)[:/]", "load-type": ["third-party"]],
                    "action": ["type": "block"],
                ])
            }
        }
        switch kind {
        case .ads: hostRules(adHosts)
        case .trackers: hostRules(trackerHosts)
        case .cookieBanners:
            rules.append([
                "trigger": ["url-filter": ".*"],
                "action": ["type": "css-display-none", "selector": bannerSelectors.joined(separator: ", ")],
            ])
        }
        let data = try! JSONSerialization.data(withJSONObject: rules)
        return String(data: data, encoding: .utf8)!
    }
}
