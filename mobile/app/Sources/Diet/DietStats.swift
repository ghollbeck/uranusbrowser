import Foundation

/// Reading exported history (Tools/export-history.py) and summing a period up. Pure: no UI, no database.
enum DietImport {
    struct File: Decodable {
        struct Row: Decodable {
            var url: String
            var title: String?
            var visitedAt: Double
            var seconds: Double?
            var profile: String?
        }
        var version: Int?
        var source: String?
        var visits: [Row]
    }

    /// Chromium's visit_duration is 0 for many visits and hours for tabs left open, so: a known duration is capped at
    /// 30 min; an unknown one is the gap to the next visit (5 s ... 5 min), or 30 s for the last one.
    static func visits(from data: Data, source: String = "import") throws -> [DietVisit] {
        let file = try JSONDecoder().decode(File.self, from: data)
        if let version = file.version, version != 1 {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Unsupported history export version."))
        }
        let rows = file.visits.filter {
            guard let url = URL(string: $0.url), let host = url.host, !host.isEmpty else { return false }
            return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && $0.visitedAt.isFinite
        }.sorted { $0.visitedAt < $1.visitedAt }
        // Profiles are independent timelines; a visit in one must not shorten another profile's estimate.
        var nextByProfile: [String: Double] = [:]
        var estimates = [Double](repeating: 30, count: rows.count)
        for i in rows.indices.reversed() {
            let profile = rows[i].profile ?? ""
            if let next = nextByProfile[profile] { estimates[i] = (next - rows[i].visitedAt).clamped(5, 300) }
            nextByProfile[profile] = rows[i].visitedAt
        }
        var out: [DietVisit] = []
        out.reserveCapacity(rows.count)
        for (i, r) in rows.enumerated() {
            let known = r.seconds ?? 0
            let seconds: Double
            if known > 0 {
                seconds = min(known, 1800)
            } else {
                seconds = estimates[i]
            }
            let host = DietVisit.normalizedHost(URL(string: r.url)?.host ?? "")
            out.append(DietVisit(id: 0, url: r.url, host: host, title: r.title ?? "", at: Date(timeIntervalSince1970: r.visitedAt),
                                 seconds: seconds, source: r.profile.map { "\(source):\($0)" } ?? source))
        }
        return out
    }
}

struct DietStats: Sendable {
    struct Slice: Identifiable, Sendable {
        var category: DietCategory
        var seconds: Double
        var share: Double
        var nutrients: Nutrients
        var id: String { category.rawValue }
    }
    struct Site: Identifiable, Sendable {
        var host: String
        var seconds: Double
        var visits: Int
        var nutrients: Nutrients
        var category: DietCategory
        var id: String { host }
    }
    struct Day: Identifiable, Sendable {
        var day: Date
        var seconds: Double
        var nutrients: Nutrients
        var id: Date { day }
    }
    struct Item: Identifiable, Sendable {
        var visit: DietVisit
        var label: DietLabel
        var id: Int64 { visit.id }
    }
    struct Swap: Identifiable, Sendable {
        var cut: DietCategory
        var cutSeconds: Double
        var from: NutriGrade
        var to: NutriGrade
        var newHealth: Double
        var id: String { cut.rawValue }
    }

    var interval: DateInterval
    var seconds: Double = 0
    var measuredSeconds: Double = 0
    var estimatedSeconds: Double = 0
    var watchSeconds: Double = 0
    var visits = 0
    /// Time-weighted average nutrients of everything counted.
    var nutrients = Nutrients.zero
    var slices: [Slice] = []
    var sites: [Site] = []
    var days: [Day] = []
    var topics: [(String, Double)] = []
    var gradeSeconds: [NutriGrade: Double] = [:]
    /// Visits per grade (for the classification counters).
    var gradeCounts: [NutriGrade: Int] = [:]
    var swaps: [Swap] = []

    var grade: NutriGrade { nutrients.grade }
    var health: Double { nutrients.health }

    /// Sums `items` inside `interval`. Logins and redirects are skipped.
    static func compute(_ items: [(DietVisit, DietLabel)], in interval: DateInterval, calendar: Calendar = .current) -> DietStats {
        var s = DietStats(interval: interval)
        var bySlice: [DietCategory: (Double, Nutrients)] = [:]
        var bySite: [String: (Double, Int, Nutrients, [DietCategory: Double])] = [:]
        var byDay: [Date: (Double, Nutrients)] = [:]
        var byTopic: [String: Double] = [:]
        var topicDays = Set<String>()
        var total = Nutrients.zero

        for (v, l) in items where v.at >= interval.start && v.at < interval.end && l.category.counts {
            s.visits += 1
            s.gradeCounts[l.grade, default: 0] += 1
            let w = v.seconds.isFinite ? max(v.seconds, 0) : 0
            guard w > 0 else { continue }
            s.seconds += w
            if v.isMeasured { s.measuredSeconds += w } else { s.estimatedSeconds += w }
            if v.isMeasured, v.watchSeconds.isFinite { s.watchSeconds += max(0, v.watchSeconds) }
            total = total + l.nutrients * w
            let sl = bySlice[l.category] ?? (0, .zero)
            bySlice[l.category] = (sl.0 + w, sl.1 + l.nutrients * w)
            var site = bySite[v.host] ?? (0, 0, .zero, [:])
            site.0 += w; site.1 += 1; site.2 = site.2 + l.nutrients * w; site.3[l.category, default: 0] += w
            bySite[v.host] = site
            let d = calendar.startOfDay(for: v.at)
            let dd = byDay[d] ?? (0, .zero)
            byDay[d] = (dd.0 + w, dd.1 + l.nutrients * w)
            s.gradeSeconds[l.grade, default: 0] += w
            if l.category.isLearning || l.kind == .search || l.kind == .video {
                for t in l.topics where topicDays.insert("\(t)|\(d.timeIntervalSince1970)").inserted {
                    byTopic[t, default: 0] += 1   // days a topic came up, so one tab left open all day counts once
                }
            }
        }
        guard s.seconds > 0 else { return s }
        s.nutrients = total * (1 / s.seconds)
        s.slices = bySlice.map { c, v in Slice(category: c, seconds: v.0, share: v.0 / s.seconds, nutrients: v.1 * (1 / v.0)) }
            .sorted { $0.seconds > $1.seconds }
        s.sites = bySite.map { h, v in
            Site(host: h, seconds: v.0, visits: v.1, nutrients: v.2 * (1 / v.0), category: v.3.max { $0.value < $1.value }!.key)
        }.sorted { $0.seconds > $1.seconds }
        s.days = byDay.map { Day(day: $0.key, seconds: $0.value.0, nutrients: $0.value.1 * (1 / $0.value.0)) }.sorted { $0.day < $1.day }
        s.topics = byTopic.sorted { $0.value > $1.value }.prefix(24).map { ($0.key, $0.value) }
        s.swaps = swaps(s, bySlice: bySlice)
        return s
    }

    /// "Halve your time on X and swap it for learning": the three junkiest slices and the grade you'd get.
    private static func swaps(_ s: DietStats, bySlice: [DietCategory: (Double, Nutrients)]) -> [Swap] {
        let total = bySlice.values.reduce(Nutrients.zero) { $0 + $1.1 }
        let learning = DietCategory.learning.nutrients
        return s.slices
            .filter { $0.nutrients.points > 0 && $0.share >= 0.03 }
            .sorted { $0.nutrients.points * $0.seconds > $1.nutrients.points * $1.seconds }
            .prefix(3)
            .map { slice in
                let cut = slice.seconds / 2
                let swapped = total + slice.nutrients * (-cut) + learning * cut
                let n = swapped * (1 / s.seconds)
                return Swap(cut: slice.category, cutSeconds: cut, from: s.grade, to: n.grade, newHealth: n.health)
            }
    }
}

extension TimeInterval {
    /// "2h 05m", "14m", "40s".
    var dietDuration: String {
        let s = Int(self.rounded())
        if s >= 3600 { return String(format: "%dh %02dm", s / 3600, (s % 3600) / 60) }
        if s >= 60 { return "\(s / 60)m" }
        return "\(s)s"
    }
}
