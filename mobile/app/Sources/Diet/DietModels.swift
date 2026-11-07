import Foundation

// Algorithm Diet: what you read and watch, sorted into categories and scored like food (Nutri-Score A-E).
// Pure value types, no UI and no I/O, so Tools/diet-check.swift can compile and test them on the Mac.

/// "Nutrients" of a piece of content, each 0...10.
/// Good: protein (you learn something), fiber (depth, focus), vitamins (creativity, culture, people).
/// Bad: sugar (quick-hit entertainment), salt (outrage, anxiety), fat (endless feeds, compulsive use).
struct Nutrients: Codable, Equatable, Sendable {
    var protein: Double
    var fiber: Double
    var vitamins: Double
    var sugar: Double
    var salt: Double
    var fat: Double

    static let zero = Nutrients(protein: 0, fiber: 0, vitamins: 0, sugar: 0, salt: 0, fat: 0)

    /// Nutri-Score style: bad points minus good points, -30 (healthiest) ... +30.
    var points: Double { (sugar + salt + fat) - (protein + fiber + vitamins) }
    /// 0 (junk) ... 100 (superfood), for the big score number.
    var health: Double { ((30 - points) / 60 * 100).clamped(0, 100) }
    var grade: NutriGrade { NutriGrade(points: points) }

    func clamped() -> Nutrients {
        Nutrients(protein: protein.clamped(0, 10), fiber: fiber.clamped(0, 10), vitamins: vitamins.clamped(0, 10),
                  sugar: sugar.clamped(0, 10), salt: salt.clamped(0, 10), fat: fat.clamped(0, 10))
    }

    static func + (a: Nutrients, b: Nutrients) -> Nutrients {
        Nutrients(protein: a.protein + b.protein, fiber: a.fiber + b.fiber, vitamins: a.vitamins + b.vitamins,
                  sugar: a.sugar + b.sugar, salt: a.salt + b.salt, fat: a.fat + b.fat)
    }

    static func * (a: Nutrients, k: Double) -> Nutrients {
        Nutrients(protein: a.protein * k, fiber: a.fiber * k, vitamins: a.vitamins * k,
                  sugar: a.sugar * k, salt: a.salt * k, fat: a.fat * k)
    }
}

enum NutriGrade: String, CaseIterable, Codable, Comparable, Sendable, Identifiable {
    case a = "A", b = "B", c = "C", d = "D", e = "E"
    var id: String { rawValue }

    init(points: Double) {
        switch points {
        case ...(-12): self = .a
        case ...(-4): self = .b
        case ...4: self = .c
        case ...12: self = .d
        default: self = .e
        }
    }

    var index: Int { Self.allCases.firstIndex(of: self)! }
    static func < (l: NutriGrade, r: NutriGrade) -> Bool { l.index < r.index }

    var verdict: String {
        switch self {
        case .a: "Superfood"
        case .b: "Wholesome"
        case .c: "Balanced"
        case .d: "Snacky"
        case .e: "Junk food"
        }
    }
}

/// Fixed category list. The raw values are what the on-device model is asked to answer with.
enum DietCategory: String, CaseIterable, Codable, Sendable, Identifiable {
    case learning, research, building, work, ai, communication, reference, news, culture, music, video, streaming
    case social, shortVideo, shopping, games, finance, lifestyle, adult, plumbing, other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .learning: "Learning"
        case .research: "Research & papers"
        case .building: "Building & code"
        case .work: "Work & productivity"
        case .ai: "AI assistants"
        case .communication: "Messages & calls"
        case .reference: "Search & reference"
        case .news: "News"
        case .culture: "Long reads & culture"
        case .music: "Music & audio"
        case .video: "Video"
        case .streaming: "Streaming & TV"
        case .social: "Social feeds"
        case .shortVideo: "Short-form video"
        case .shopping: "Shopping"
        case .games: "Games"
        case .finance: "Money"
        case .lifestyle: "Life, travel & health"
        case .adult: "Adult & gambling"
        case .plumbing: "Logins & redirects"
        case .other: "Uncategorised"
        }
    }

    /// One line for the on-device model's category list.
    var hint: String {
        switch self {
        case .learning: "courses, tutorials, documentation, wikis, explainers"
        case .research: "scientific papers, journals, academic sites, conferences"
        case .building: "code, GitHub, developer tools, hosting and cloud dashboards, localhost"
        case .work: "office documents, mail, calendars, project and admin tools"
        case .ai: "AI chat assistants"
        case .communication: "messengers, video calls, chat apps"
        case .reference: "search engines, maps, dictionaries, translators"
        case .news: "news sites and current events"
        case .culture: "blogs, essays, books, podcasts, art, long-form writing"
        case .music: "music and audio streaming"
        case .video: "video sites, entertainment videos"
        case .streaming: "TV shows and films"
        case .social: "social networks, forums, feeds"
        case .shortVideo: "TikTok, Reels, YouTube Shorts"
        case .shopping: "online shops, deals, marketplaces"
        case .games: "games and gaming"
        case .finance: "banking, investing, crypto, payments"
        case .lifestyle: "travel, food, health, housing, jobs, sport"
        case .adult: "adult content, gambling, betting"
        case .plumbing: "login pages, redirects, account and consent pages"
        case .other: "none of the above"
        }
    }

    var symbol: String {
        switch self {
        case .learning: "graduationcap.fill"
        case .research: "doc.text.magnifyingglass"
        case .building: "hammer.fill"
        case .work: "briefcase.fill"
        case .ai: "sparkles"
        case .communication: "bubble.left.and.bubble.right.fill"
        case .reference: "magnifyingglass"
        case .news: "newspaper.fill"
        case .culture: "book.fill"
        case .music: "music.note"
        case .video: "play.rectangle.fill"
        case .streaming: "tv.fill"
        case .social: "person.2.fill"
        case .shortVideo: "bolt.fill"
        case .shopping: "bag.fill"
        case .games: "gamecontroller.fill"
        case .finance: "chart.line.uptrend.xyaxis"
        case .lifestyle: "leaf.fill"
        case .adult: "exclamationmark.octagon.fill"
        case .plumbing: "key.fill"
        case .other: "questionmark.circle.fill"
        }
    }

    /// Category colour as 0xRRGGBB (the UI maps it to a Color).
    var hex: UInt32 {
        switch self {
        case .learning: 0x2FA36B
        case .research: 0x1E7F5C
        case .building: 0x5B5BF0
        case .work: 0x3B82F6
        case .ai: 0xB45CF2
        case .communication: 0x14B8A6
        case .reference: 0x64748B
        case .news: 0xF59E0B
        case .culture: 0x84CC16
        case .music: 0xEC4899
        case .video: 0xF97316
        case .streaming: 0xEF4444
        case .social: 0xE11D48
        case .shortVideo: 0xDC2626
        case .shopping: 0xD97706
        case .games: 0x8B5CF6
        case .finance: 0x0EA5E9
        case .lifestyle: 0x22C55E
        case .adult: 0x7F1D1D
        case .plumbing: 0x9CA3AF
        case .other: 0xA1A1AA
        }
    }

    /// Base nutrients before title and time adjustments.
    var nutrients: Nutrients {
        switch self {
        case .learning: Nutrients(protein: 8, fiber: 7, vitamins: 3, sugar: 1, salt: 0, fat: 0)
        case .research: Nutrients(protein: 9, fiber: 9, vitamins: 2, sugar: 0, salt: 0, fat: 0)
        case .building: Nutrients(protein: 6, fiber: 7, vitamins: 3, sugar: 0, salt: 0, fat: 0)
        case .work: Nutrients(protein: 3, fiber: 5, vitamins: 1, sugar: 0, salt: 1, fat: 0)
        case .ai: Nutrients(protein: 6, fiber: 4, vitamins: 2, sugar: 1, salt: 0, fat: 0)
        case .communication: Nutrients(protein: 1, fiber: 2, vitamins: 5, sugar: 1, salt: 1, fat: 1)
        case .reference: Nutrients(protein: 3, fiber: 1, vitamins: 1, sugar: 1, salt: 0, fat: 1)
        case .news: Nutrients(protein: 4, fiber: 3, vitamins: 1, sugar: 2, salt: 5, fat: 2)
        case .culture: Nutrients(protein: 5, fiber: 6, vitamins: 6, sugar: 2, salt: 0, fat: 0)
        case .music: Nutrients(protein: 0, fiber: 1, vitamins: 5, sugar: 3, salt: 0, fat: 1)
        case .video: Nutrients(protein: 2, fiber: 2, vitamins: 3, sugar: 6, salt: 1, fat: 4)
        case .streaming: Nutrients(protein: 0, fiber: 2, vitamins: 4, sugar: 7, salt: 0, fat: 4)
        case .social: Nutrients(protein: 1, fiber: 0, vitamins: 3, sugar: 5, salt: 4, fat: 6)
        case .shortVideo: Nutrients(protein: 0, fiber: 0, vitamins: 1, sugar: 9, salt: 3, fat: 9)
        case .shopping: Nutrients(protein: 0, fiber: 1, vitamins: 1, sugar: 5, salt: 1, fat: 4)
        case .games: Nutrients(protein: 1, fiber: 2, vitamins: 3, sugar: 7, salt: 0, fat: 5)
        case .finance: Nutrients(protein: 3, fiber: 3, vitamins: 0, sugar: 2, salt: 3, fat: 2)
        case .lifestyle: Nutrients(protein: 2, fiber: 2, vitamins: 3, sugar: 2, salt: 1, fat: 1)
        case .adult: Nutrients(protein: 0, fiber: 0, vitamins: 0, sugar: 10, salt: 4, fat: 10)
        case .plumbing: .zero
        case .other: Nutrients(protein: 2, fiber: 2, vitamins: 2, sugar: 3, salt: 2, fat: 2)
        }
    }

    /// Logins and redirects are not content: they are kept but never counted in the diet.
    var counts: Bool { self != .plumbing }
    /// Categories whose sites carry every kind of content, so the title decides (a YouTube lecture is learning).
    var isContainer: Bool { [.video, .social, .reference, .other, .culture].contains(self) }
    /// Categories that count as "learning" for chat questions like "what did I learn".
    var isLearning: Bool { [.learning, .research, .building, .culture, .ai].contains(self) }
}

enum ContentKind: String, Codable, Sendable {
    case page, video, short, search, feed
}

/// One visit to one page, live or imported.
struct DietVisit: Codable, Sendable, Identifiable, Hashable {
    var id: Int64
    var url: String
    var host: String
    var title: String
    var at: Date
    /// Time on the page (estimated for imports), and how much of it a video was playing.
    var seconds: Double
    var watchSeconds: Double = 0
    var description: String? = nil
    var channel: String? = nil
    /// A bounded excerpt of an article or visible video transcript, extracted only from the active page.
    var excerpt: String? = nil
    var source: String

    var isMeasured: Bool { source == "live" }
}

/// The classifier's verdict for one visit (or one unique host + title).
struct DietLabel: Codable, Sendable, Equatable {
    enum Method: String, Codable, Sendable { case domain, path, title, model, fallback }
    var category: DietCategory
    var kind: ContentKind
    var confidence: Double
    var method: Method
    var nutrients: Nutrients
    var topics: [String]
    var grade: NutriGrade { nutrients.grade }
}

extension Double {
    func clamped(_ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, self)) }
}

extension DietVisit {
    /// "youtube.com" from "m.youtube.com" or "www.youtube.com".
    static func normalizedHost(_ raw: String) -> String {
        var h = raw.lowercased()
        for p in ["www.", "m.", "mobile.", "amp."] where h.hasPrefix(p) { h.removeFirst(p.count) }
        return h
    }
}
