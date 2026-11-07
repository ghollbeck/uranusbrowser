// Checks the Algorithm Diet classifier on the Mac, without the app or the model.
//   swiftc -O -parse-as-library Sources/Diet/{DietModels,DietRules,DietClassifier,DietStats}.swift Tools/diet-check.swift -o /tmp/diet-check
//   /tmp/diet-check                    golden cases only
//   /tmp/diet-check history.json       plus a report on an export from Tools/export-history.py (nothing is written)
import Foundation

@main
struct DietCheck {
    static var failures = 0

    static func expect(_ url: String, _ title: String, _ category: DietCategory, grade: NutriGrade? = nil,
                       seconds: Double = 60, hour: Int = 14, line: Int = #line) {
        var c = DateComponents(); c.year = 2026; c.month = 10; c.day = 20; c.hour = hour
        let at = Calendar.current.date(from: c)!
        let v = DietVisit(id: 0, url: url, host: URL(string: url)?.host ?? "", title: title, at: at, seconds: seconds, source: "test")
        let l = DietClassifier().classify(v)
        var ok = l.category == category
        if let grade, l.grade != grade { ok = false }
        if !ok {
            failures += 1
            print("FAIL line \(line): \(url) \"\(title)\" -> \(l.category.rawValue) \(l.grade.rawValue) (\(l.method.rawValue)); "
                  + "want \(category.rawValue)\(grade.map { " " + $0.rawValue } ?? "")")
        }
    }

    static func golden() {
        expect("https://accounts.google.com/v3/signin/identifier", "Sign in - Google Accounts", .plumbing)
        expect("https://github.com/login/oauth/authorize?client_id=x", "Authorize", .plumbing)
        expect("https://www.youtube.com/watch?v=aircAruvnKk", "But what is a neural network? | Deep learning chapter 1 - YouTube", .learning, grade: .a)
        expect("https://www.youtube.com/watch?v=1", "MIT 6.006 Lecture 1: Algorithms and Computation - YouTube", .learning, grade: .a)
        expect("https://www.youtube.com/watch?v=2", "I Survived 100 Days in Minecraft Hardcore - YouTube", .games)
        expect("https://www.youtube.com/watch?v=3", "SHOCKING PRANK GONE WRONG!!! - YouTube", .video, grade: .e)
        expect("https://www.youtube.com/shorts/abc", "funny cat #shorts - YouTube", .shortVideo, grade: .e)
        expect("https://www.youtube.com/watch?v=4", "Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams - YouTube", .music)
        expect("https://www.youtube.com/watch?v=5", "Some random title without cues - YouTube", .video, grade: .c)
        expect("https://www.tiktok.com/@x/video/1", "TikTok", .shortVideo, grade: .e)
        expect("https://www.instagram.com/reel/abc/", "Instagram", .shortVideo)
        expect("https://www.instagram.com/", "Instagram", .social, grade: .d)
        expect("https://x.com/home", "Home / X", .social)
        expect("https://www.reddit.com/r/MachineLearning/comments/1/some_title/", "[D] Fine-tuning tips for small LLMs : r/MachineLearning", .learning)
        expect("https://arxiv.org/abs/1706.03762", "[1706.03762] Attention Is All You Need", .research, grade: .a)
        expect("https://openreview.net/forum?id=1", "Some paper | OpenReview", .research)
        expect("https://github.com/ggml-org/llama.cpp", "GitHub - ggml-org/llama.cpp: LLM inference in C/C++", .building, grade: .a)
        expect("http://localhost:5173/", "Vite App", .building)
        expect("http://127.0.0.1:8000/docs", "FastAPI - Swagger UI", .building)
        expect("https://abc.supabase.co/rest/v1", "", .building)
        expect("https://docs.google.com/document/d/1/edit", "Plan - Google Docs", .work, grade: .b)
        expect("https://chatgpt.com/c/1", "Swift concurrency help", .ai, grade: .b)
        expect("https://www.google.com/search?q=swiftui+tutorial+navigationstack", "swiftui tutorial navigationstack - Google Search", .learning)
        expect("https://www.google.com/search?q=weather+zurich", "weather zurich - Google Search", .reference)
        expect("https://www.nytimes.com/2026/10/20/world/war.html", "War Crisis Deepens as Leaders Slam Attack", .news, grade: .d)
        expect("https://www.netflix.com/watch/1", "Netflix", .streaming, grade: .d)
        expect("https://www.amazon.de/dp/1", "Amazon.de: USB-C cable", .shopping)
        expect("https://open.spotify.com/playlist/1", "Spotify – Focus", .music)
        expect("https://en.wikipedia.org/wiki/Nutri-Score", "Nutri-Score - Wikipedia", .learning, grade: .a)
        expect("https://www.pornhub.com/", "x", .adult, grade: .e)
        expect("https://t.co/abc", "", .plumbing)
        expect("https://paulgraham.com/greatwork.html", "How to Do Great Work", .culture, grade: .a)
        expect("https://somerandomblog.example/post", "Introduction to linear algebra for beginners", .learning)
        expect("https://www.linkedin.com/feed/", "(5) Feed | LinkedIn", .social, seconds: 1200)
        expect("https://www.ethz.ch/en.html", "Homepage | ETH Zurich", .learning)

        // pieces
        precondition(DietClassifier.stripSiteSuffix("How X works - YouTube", host: "youtube.com") == "How X works")
        precondition(DietClassifier.stripSiteSuffix("(3) Feed | LinkedIn", host: "linkedin.com") == "Feed")
        precondition(DietClassifier.topics(from: "Attention Is All You Need", host: "arxiv.org").contains("attention"))
        precondition(NutriGrade(points: -20) == .a && NutriGrade(points: 0) == .c && NutriGrade(points: 20) == .e)
        let n = DietCategory.learning.nutrients
        precondition(n.grade == .a && DietCategory.shortVideo.nutrients.grade == .e)
        for c in DietCategory.allCases where c.counts {
            print(String(format: "  %-22@ base %@  points %+.0f", c.title as NSString, c.nutrients.grade.rawValue, c.nutrients.points))
        }
    }

    static func report(_ path: String) throws {
        let t0 = Date()
        let visits = try DietImport.visits(from: Data(contentsOf: URL(fileURLWithPath: path)))
        let classifier = DietClassifier()
        var cache: [String: DietLabel] = [:]
        var labeled: [(DietVisit, DietLabel)] = []
        labeled.reserveCapacity(visits.count)
        for (i, var v) in visits.enumerated() {
            v.id = Int64(i + 1)
            let k = DietClassifier.key(host: v.host, title: v.title) + "|" + (URL(string: v.url)?.path.prefix(12) ?? "")
            let l: DietLabel
            if let c = cache[k], v.seconds < 600 { l = c } else { l = classifier.classify(v); cache[k] = l }
            labeled.append((v, l))
        }
        let dt = Date().timeIntervalSince(t0)
        print("\n\(visits.count) visits, \(cache.count) unique keys, classified in \(String(format: "%.2f", dt)) s")

        var byMethod: [DietLabel.Method: Int] = [:]
        var unknownHosts: [String: (Int, String)] = [:]
        for (v, l) in labeled {
            byMethod[l.method, default: 0] += 1
            if l.category == .other { unknownHosts[v.host, default: (0, v.title)].0 += 1 }
        }
        print("methods:", byMethod.sorted { $0.value > $1.value }.map { "\($0.key.rawValue) \($0.value)" }.joined(separator: ", "))
        let all = DateInterval(start: .distantPast, end: .distantFuture)
        let s = DietStats.compute(labeled, in: all)
        print(String(format: "counted %d visits, %@ tracked, grade %@ (health %.0f)", s.visits, s.seconds.dietDuration as NSString,
                     s.grade.rawValue, s.health))
        for sl in s.slices {
            print(String(format: "  %-22@ %8@ %5.1f%%  %@", sl.category.title as NSString, sl.seconds.dietDuration as NSString,
                         sl.share * 100, sl.nutrients.grade.rawValue))
        }
        print("grades by time:", NutriGrade.allCases.map { "\($0.rawValue) \((s.gradeSeconds[$0] ?? 0).dietDuration)" }.joined(separator: "  "))
        print("swaps:", s.swaps.map { "halve \($0.cut.rawValue) -> \($0.to.rawValue)" }.joined(separator: ", "))
        print("top topics:", s.topics.prefix(15).map(\.0).joined(separator: ", "))
        print("\nunknown hosts (\(unknownHosts.count)) -> on-device model:")
        for (h, v) in unknownHosts.sorted(by: { $0.value.0 > $1.value.0 }).prefix(25) { print("  \(v.0)\t\(h)\t\(v.1.prefix(60))") }
        print("\nsample videos:")
        for (v, l) in labeled.filter({ $0.1.kind == .video }).suffix(15) {
            print("  \(l.category.rawValue.padding(toLength: 10, withPad: " ", startingAt: 0)) \(l.grade.rawValue) \(v.title.prefix(70))")
        }
        let last30 = DateInterval(start: visits.last!.at.addingTimeInterval(-30 * 86_400), end: visits.last!.at.addingTimeInterval(1))
        let m = DietStats.compute(labeled, in: last30)
        print(String(format: "\nlast 30 days: %@, grade %@, %d days", m.seconds.dietDuration as NSString, m.grade.rawValue, m.days.count))
    }

    static func main() throws {
        golden()
        if CommandLine.arguments.count > 1 { try report(CommandLine.arguments[1]) }
        if failures > 0 { print("\n\(failures) golden case(s) failed"); exit(1) }
        print("\nall golden cases pass")
    }
}
