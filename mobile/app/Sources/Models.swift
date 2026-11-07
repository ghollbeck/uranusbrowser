import SwiftUI

// MARK: - Settings

struct SiteSettings: Codable, Equatable {
    var blockAds = true
    var blockCookieBanners = true
    var blockTrackers = true
    var anyBlocking: Bool { blockAds || blockCookieBanners || blockTrackers }
}

enum SearchEngine: String, CaseIterable, Codable, Identifiable {
    case google, duckDuckGo, bing, brave
    var id: String { rawValue }
    var title: String {
        switch self {
        case .google: "Google"
        case .duckDuckGo: "DuckDuckGo"
        case .bing: "Bing"
        case .brave: "Brave Search"
        }
    }
    private var base: String {
        switch self {
        case .google: "https://www.google.com/search"
        case .duckDuckGo: "https://duckduckgo.com/"
        case .bing: "https://www.bing.com/search"
        case .brave: "https://search.brave.com/search"
        }
    }
    func url(for query: String) -> URL {
        var c = URLComponents(string: base)!
        c.queryItems = [URLQueryItem(name: "q", value: query)]
        return c.url!
    }
}

enum ArchiveAfter: String, CaseIterable, Codable, Identifiable {
    case never, day, week, month
    var id: String { rawValue }
    var title: String {
        switch self {
        case .never: "Never"
        case .day: "After 1 day"
        case .week: "After 1 week"
        case .month: "After 1 month"
        }
    }
    var interval: TimeInterval? {
        switch self {
        case .never: nil
        case .day: 86_400
        case .week: 7 * 86_400
        case .month: 30 * 86_400
        }
    }
}

enum AppearanceMode: String, CaseIterable, Codable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// EXPERIMENT (top bar): `.blur` is the shipped behaviour and the default. `.pill` / `.pillFlowers` draw `IslandPill`
/// instead. To revert the experiment: delete this enum, `topStyle` below, `BrowserStore.topStyle*`, the Settings row,
/// `Sources/IslandPill.swift` and the `switch` in `BrowserPage`.
/// `.twinPills` (experimental, never the default) draws two gliding pills either side of the real island instead
/// (`Sources/TwinPills.swift`, `Sources/TwinPillPhysics.swift`, `Tools/physics-check.swift`; also remove its branch in
/// `BrowserPage` and `beginPillEditingFromSettings` in the Settings row).
enum TopStyle: String, CaseIterable, Codable, Identifiable {
    case blur, pill, pillFlowers, twinPills
    var id: String { rawValue }
    var title: String {
        switch self {
        case .blur: "Blur (current)"
        case .pill: "Black pill"
        case .pillFlowers: "Black pill + flowers"
        case .twinPills: "Twin pills (physics)"
        }
    }
}

struct AppSettings: Codable, Equatable {
    var searchEngine: SearchEngine = .google
    var autoOpenKeyboard = true
    var archiveAfter: ArchiveAfter = .day
    var appearance: AppearanceMode = .system
    var defaultSite = SiteSettings()
    var perSite: [String: SiteSettings] = [:]
    var topStyle: TopStyle = .pillFlowers   // the owner kept the flower pill (was .blur); .blur is still selectable in Settings
    /// EXPERIMENT: the hand-editable pill (width, height, flowers). See `IslandLayout` in IslandPill.swift.
    var island = IslandLayout.default
    /// Which of the A/B/C animation alternatives is active for each moment (Settings > Motion).
    var motion = MotionSettings()

    enum CodingKeys: String, CodingKey {
        case searchEngine, autoOpenKeyboard, archiveAfter, appearance, defaultSite, perSite, topStyle, island, motion
    }
}

/// Tolerant decoding: a state.json written by an older build (missing keys) or with a value this build does not know
/// must never make `readState()` fail, because that would drop the user's tabs. Every key falls back to its default.
/// (Lives in an extension so the memberwise / empty initialisers stay available.)
extension AppSettings {
    init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        searchEngine = (try? c.decodeIfPresent(SearchEngine.self, forKey: .searchEngine)) ?? searchEngine
        autoOpenKeyboard = (try? c.decodeIfPresent(Bool.self, forKey: .autoOpenKeyboard)) ?? autoOpenKeyboard
        archiveAfter = (try? c.decodeIfPresent(ArchiveAfter.self, forKey: .archiveAfter)) ?? archiveAfter
        appearance = (try? c.decodeIfPresent(AppearanceMode.self, forKey: .appearance)) ?? appearance
        defaultSite = (try? c.decodeIfPresent(SiteSettings.self, forKey: .defaultSite)) ?? defaultSite
        perSite = (try? c.decodeIfPresent([String: SiteSettings].self, forKey: .perSite)) ?? perSite
        topStyle = (try? c.decodeIfPresent(TopStyle.self, forKey: .topStyle)) ?? topStyle
        island = (try? c.decodeIfPresent(IslandLayout.self, forKey: .island)) ?? island
        motion = (try? c.decodeIfPresent(MotionSettings.self, forKey: .motion)) ?? motion
    }
}

// MARK: - Spaces

enum SpacePalette: String, CaseIterable, Codable, Identifiable {
    case dusk, ocean, ember, forest, graphite
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var colors: [Color] {
        switch self {
        case .dusk: [Color(hex: 0x2A1190), Color(hex: 0xB45CF2), Color(hex: 0xFF8FB1)]
        case .ocean: [Color(hex: 0x0A2F7A), Color(hex: 0x2F8FE6), Color(hex: 0x6FE0CF)]
        case .ember: [Color(hex: 0x7A1535), Color(hex: 0xEC5B3A), Color(hex: 0xFFB86B)]
        case .forest: [Color(hex: 0x0B3D31), Color(hex: 0x28A874), Color(hex: 0xC2E66B)]
        case .graphite: [Color(hex: 0x15151C), Color(hex: 0x3A3A4A), Color(hex: 0x8C8CA4)]
        }
    }
}

// MARK: - Persisted records

struct TabRecord: Codable {
    var id: UUID
    var url: String?
    var title: String
    var pinned: Bool
    var lastActive: Date
}

struct ArchivedTab: Codable, Identifiable {
    var id: UUID
    var url: String
    var title: String
    var archivedAt: Date
    var host: String { URL(string: url)?.host ?? url }
}

struct HistoryItem: Codable, Identifiable, Hashable {
    var url: String
    var title: String
    var date: Date
    var id: String { url }
    var host: String { URL(string: url)?.host ?? url }
}

struct SpaceRecord: Codable {
    var id: UUID
    var name: String
    var palette: SpacePalette
    var tabs: [TabRecord]
    var archive: [ArchivedTab]
    var history: [HistoryItem]
    var selectedTabID: UUID?
}

struct StateRecord: Codable {
    var spaces: [SpaceRecord]
    var currentSpaceID: UUID
    var settings: AppSettings
}

// MARK: - Small helpers

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension URL {
    /// Host without a leading "www.", used as the key for per-site settings.
    var siteKey: String? { host?.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression) }
}
