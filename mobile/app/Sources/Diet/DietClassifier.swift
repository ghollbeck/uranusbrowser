import Foundation

/// The Algorithm Diet classifier. Deterministic and fast (rules only); the on-device model is consulted separately for
/// what the rules can't place, and its answers come back in as `hints`.
///
/// For one visit:
///  1. Plumbing first: login, OAuth and redirect pages are kept but never counted.
///  2. Site: exact host + first path segment, then the host, then each parent domain, then known suffixes (.edu, .vercel.app).
///     A model hint for the host wins over "unknown".
///  3. URL shape: YouTube /shorts and TikTok are short-form, /watch is a video, Google /search is a search (its query is
///     the "title"), Reddit /r/<sub> takes the subreddit name as extra text.
///  4. Title: phrase cues per category. On "container" sites (YouTube, Reddit, X, search engines, unknown sites) a clear
///     title signal decides the category, so a YouTube lecture counts as learning and a Reddit war thread as news.
///  5. Nutrients: the category's base profile, then title and behaviour adjustments: learning cues add protein and
///     fiber, clickbait adds sugar, outrage adds salt, long focused sessions add fiber, long feed sessions and late-night
///     junk add fat. The Nutri-Score grade follows from bad minus good points.
struct DietClassifier: Sendable {
    /// host -> category from the on-device model (or the user).
    var hostHints: [String: DietCategory] = [:]
    /// "host|title" -> category from the on-device model, for videos and container pages.
    var titleHints: [String: DietCategory] = [:]
    var calendar = Calendar.current

    static func key(host: String, title: String) -> String { "\(host)|\(title.lowercased())" }

    func classify(_ v: DietVisit) -> DietLabel {
        let url = URL(string: v.url)
        let host = DietVisit.normalizedHost(url?.host ?? v.host)
        let path = (url?.path ?? "").lowercased()
        let (text, kind, extra) = Self.contentText(url: url, host: host, path: path, title: v.title)
        let lowered = (text + " " + extra + " " + (v.channel ?? "") + " " + (v.description ?? "")
                       + " " + String((v.excerpt ?? "").prefix(1200))).lowercased()

        // 1. plumbing
        if Self.isPlumbing(host: host, path: path, title: v.title) {
            return DietLabel(category: .plumbing, kind: .page, confidence: 0.95, method: .path, nutrients: .zero, topics: [])
        }

        // 2. site
        var category: DietCategory
        var confidence: Double
        var method: DietLabel.Method
        if let c = Self.siteCategory(host: host, path: path) {
            (category, confidence, method) = (c, 0.9, .domain)
        } else if let c = hostHints[host] {
            (category, confidence, method) = (c, 0.75, .model)
        } else {
            (category, confidence, method) = (.other, 0.2, .fallback)
        }

        // 3. URL shape
        if kind == .short { (category, confidence, method) = (.shortVideo, 0.95, .path) }

        // 4. title
        let cueScores = Self.cueScores(lowered)
        if kind != .short, let hint = titleHints[Self.key(host: host, title: v.title)] {
            (category, confidence, method) = (hint, 0.8, .model)
        } else if kind != .short, category.isContainer || category == .ai,
                  let (best, score) = cueScores.max(by: { $0.value < $1.value }),
                  score >= (category == .other || kind == .video || kind == .search ? 1 : 2) {
            // An AI chat about code is still an AI chat; only switch it for strong signals.
            if category != .ai || score >= 3 {
                category = best
                confidence = min(0.85, 0.45 + 0.12 * score)
                method = .title
            }
        }
        if category == .other, kind == .search { (category, confidence, method) = (.reference, 0.6, .path) }

        // 5. nutrients
        var n = category.nutrients
        if category == .other { confidence = min(confidence, 0.3) }
        let learn = (cueScores[.learning] ?? 0) + (cueScores[.research] ?? 0)
        if learn > 0, category != .plumbing {
            n.protein += min(3, learn)
            n.fiber += min(2, learn)
        }
        let bait = Self.count(Self.clickbait, in: lowered) + (Self.shouting(text) ? 1 : 0)
        if bait > 0 {
            n.sugar += Double(min(6, bait * 2))
            n.fat += Double(min(2, bait))
            if bait >= 2 { n.protein -= 1; n.fiber -= 1; n.vitamins -= 1 }
        }
        let outrage = Self.count(Self.outrage, in: lowered)
        if outrage > 0 { n.salt += Double(min(4, outrage * 2)) }
        let minutes = v.seconds / 60
        if minutes >= 10, [.learning, .research, .building, .culture, .work].contains(category) { n.fiber += 2 }
        if minutes >= 15, [.social, .shortVideo, .video, .streaming, .games, .shopping].contains(category) { n.fat += 2 }
        let hour = calendar.component(.hour, from: v.at)
        if hour < 5, n.sugar >= 5 { n.fat += 1 }
        if kind == .video, v.watchSeconds > 0, category.isLearning { n.fiber += 1 }

        return DietLabel(category: category, kind: kind, confidence: confidence, method: method, nutrients: n.clamped(),
                         topics: Self.topics(from: text, host: host))
    }

    // MARK: pieces (static so tests can poke at them)

    static func isPlumbing(host: String, path: String, title: String) -> Bool {
        if lookup(host: host, path: path) == .plumbing { return true }
        if plumbingHostPrefixes.contains(where: { host.hasPrefix($0) }) { return true }
        if plumbingPaths.contains(where: { path.contains($0) }) { return true }
        let t = title.lowercased()
        return ["sign in", "log in", "login", "anmelden", "redirecting", "verify your", "two-factor", "consent"]
            .contains { t == $0 || t.hasPrefix($0 + " ") || t.hasPrefix($0 + " -") || t.hasPrefix($0 + " –") }
    }

    static func siteCategory(host: String, path: String) -> DietCategory? {
        if let c = lookup(host: host, path: path) { return c }
        if let c = DietRules.hostPrefixes.first(where: { host.hasPrefix($0.0) })?.1 { return c }
        if host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil { return .building }
        return suffixes.first { host.hasSuffix($0.0) }?.1
    }

    /// Exact host + first path segment, exact host, then parent domains (docs.google.com -> google.com).
    static func lookup(host: String, path: String) -> DietCategory? {
        let first = path.split(separator: "/").first.map(String.init)
        var h = host
        while true {
            if let first, let c = DietRules.domains["\(h)/\(first)"] { return c }
            if let c = DietRules.domains[h] { return c }
            guard let dot = h.firstIndex(of: "."), h[h.index(after: dot)...].contains(".") else { return nil }
            h = String(h[h.index(after: dot)...])
        }
    }

    /// The text worth classifying, the kind of content, and extra text the URL gives away (search query, subreddit).
    static func contentText(url: URL?, host: String, path: String, title: String) -> (String, ContentKind, String) {
        let items = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
        // search forms send spaces as "+", which URLComponents leaves alone
        func q(_ name: String) -> String? { items.first { $0.name == name }?.value?.replacingOccurrences(of: "+", with: " ") }
        let clean = stripSiteSuffix(title, host: host)

        if host.hasSuffix("youtube.com") || host == "youtu.be" {
            if path.hasPrefix("/shorts") { return (clean, .short, "") }
            if path.hasPrefix("/watch") || host == "youtu.be" { return (clean, .video, "") }
            if path.hasPrefix("/results"), let s = q("search_query") { return (s, .search, "") }
            return (clean, .feed, "")
        }
        if host.hasSuffix("tiktok.com") || (host.hasSuffix("instagram.com") && path.hasPrefix("/reel")) {
            return (clean, .short, "")
        }
        let searchHosts = ["google.", "bing.com", "duckduckgo.com", "search.brave.com", "ecosia.org", "startpage.com", "kagi.com", "yahoo.com"]
        if searchHosts.contains(where: { host.hasPrefix($0) || host.contains("." + $0) || host == $0 }),
           let s = q("q") ?? q("p"), !s.isEmpty, !path.hasPrefix("/maps") {
            return (s, .search, "")
        }
        if host.hasSuffix("reddit.com") {
            let parts = path.split(separator: "/")
            let sub = parts.count >= 2 && parts[0] == "r" ? String(parts[1]) : ""
            return (clean, parts.count > 3 ? .page : .feed, sub)
        }
        if ["x.com", "twitter.com", "instagram.com", "facebook.com", "linkedin.com", "threads.net", "bsky.app"].contains(host) {
            return (clean, path.contains("/status/") || path.contains("/posts/") || path.contains("/p/") ? .page : .feed, "")
        }
        if host == "github.com" || host == "gitlab.com" {   // "owner/repo: description": the owner is not a topic
            return (clean.replacingOccurrences(of: #"[\w.-]+/(?=[\w.-])"#, with: "", options: .regularExpression), .page, "")
        }
        if host.hasSuffix("vimeo.com") || host.hasSuffix("twitch.tv") || host.hasSuffix("netflix.com") { return (clean, .video, "") }
        return (clean, .page, "")
    }

    /// "How X works - YouTube" -> "How X works"; "(3) Feed | LinkedIn" -> "Feed".
    static func stripSiteSuffix(_ title: String, host: String) -> String {
        var t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        t = t.replacingOccurrences(of: #"^\(\d+\+?\)\s*"#, with: "", options: .regularExpression)   // "(3) " unread counts
        let site = host.split(separator: ".").dropLast().last.map { String($0).lowercased() } ?? host
        for sep in [" - ", " | ", " – ", " — ", " · ", " :: "] {
            if let r = t.range(of: sep, options: .backwards) {
                let tail = t[r.upperBound...].lowercased().replacingOccurrences(of: " ", with: "")
                if tail.contains(site) || site.contains(tail) || tail.count <= 14 {
                    t = String(t[..<r.lowerBound])
                    break
                }
            }
        }
        return t
    }

    static func cueScores(_ lowered: String) -> [DietCategory: Double] {
        var out: [DietCategory: Double] = [:]
        for (c, cues) in compiledCues {
            var s = 0.0
            for cue in cues where matches(cue, in: lowered) { s += cue.contains(" ") ? 1.5 : 1 }
            if s > 0 { out[c] = s + (c == .learning ? 0.25 : 0) }   // ties go to learning ("swiftui tutorial")
        }
        return out
    }

    /// Up to 4 topic words or two-word phrases from the cleaned title (search queries count too).
    static func topics(from text: String, host: String) -> [String] {
        let words = text.lowercased()
            .replacingOccurrences(of: #"[^\p{L}\p{N}+#.\- ]"#, with: " ", options: .regularExpression)
            .split(separator: " ")
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".-")) }
        var picked: [String] = []
        var prev: String?
        for w in words {
            let hyphens = w.filter { $0 == "-" }.count
            let digits = w.filter(\.isNumber).count
            let ok = (3...18).contains(w.count) && !DietRules.stopwords.contains(w) && w.rangeOfCharacter(from: .letters) != nil
                && hyphens <= 1 && digits * 3 <= w.count && !host.contains(w)
            if ok {
                if let p = prev, picked.count < 4, !p.contains("-"), !w.contains("-"), !picked.contains("\(p) \(w)") {
                    if let i = picked.firstIndex(of: p) { picked[i] = "\(p) \(w)" } else { picked.append("\(p) \(w)") }
                    prev = nil
                    continue
                }
                if picked.count < 4, !picked.contains(w) { picked.append(w) }
                prev = w
            } else {
                prev = nil
            }
        }
        return picked
    }

    // MARK: helpers

    private static let plumbingHostPrefixes = DietRules.plumbingHostPrefixes
    private static let plumbingPaths = DietRules.plumbingPathFragments
    private static let suffixes = DietRules.suffixes
    private static let clickbait = DietRules.clickbaitCues
    private static let outrage = DietRules.outrageCues
    private static let compiledCues: [(DietCategory, [String])] = DietRules.titleCues.map { ($0.key, $0.value) }

    /// Whole-word match for single words, substring match for phrases and symbols.
    static func matches(_ cue: String, in text: String) -> Bool {
        guard let r = text.range(of: cue) else { return false }
        if cue.contains(" ") || cue.rangeOfCharacter(from: .letters) == nil || cue.count > 6 { return true }
        // single short word: require word boundaries on both sides (first hit is enough in practice)
        var search = r
        while true {
            let before = search.lowerBound == text.startIndex ? nil : text[text.index(before: search.lowerBound)]
            let after = search.upperBound == text.endIndex ? nil : text[search.upperBound]
            let isBoundary: (Character?) -> Bool = { c in c.map { !$0.isLetter && !$0.isNumber } ?? true }
            if isBoundary(before), isBoundary(after) { return true }
            guard let next = text.range(of: cue, range: search.upperBound..<text.endIndex) else { return false }
            search = next
        }
    }

    static func count(_ cues: [String], in text: String) -> Int { cues.reduce(0) { $0 + (matches($1, in: text) ? 1 : 0) } }

    /// MORE THAN HALF THE WORDS IN CAPITALS.
    static func shouting(_ text: String) -> Bool {
        let words = text.split(separator: " ").map(String.init).filter { $0.count >= 3 && $0.contains(where: \.isLetter) }
        guard words.count >= 3 else { return false }
        let caps = words.filter { $0 == $0.uppercased() && $0 != $0.lowercased() }.count
        return Double(caps) / Double(words.count) > 0.5
    }
}
