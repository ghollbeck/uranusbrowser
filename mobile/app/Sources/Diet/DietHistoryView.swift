import SwiftUI

/// Inspect every recorded page/video, with the evidence and assumptions behind its score.
struct DietHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var category: DietCategory?
    @State private var limit = 100
    private let engine = DietEngine.shared

    private var matches: [DietStats.Item] {
        let interval = engine.range.interval()
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return engine.labeled.reversed().compactMap { visit, label in
            guard visit.at >= interval.start, visit.at < interval.end,
                  category == nil || label.category == category else { return nil }
            guard term.isEmpty || [visit.title, visit.host, visit.description ?? "", visit.excerpt ?? ""]
                .contains(where: { $0.localizedCaseInsensitiveContains(term) }) else { return nil }
            return DietStats.Item(visit: visit, label: label)
        }
    }

    var body: some View {
        let results = matches
        NavigationStack {
            List {
                Section {
                    Picker("Category", selection: $category) {
                        Text("All categories").tag(DietCategory?.none)
                        ForEach(DietCategory.allCases) { Text($0.title).tag(Optional($0)) }
                    }
                    Text("\(results.count.formatted()) visits · \(engine.range.title)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(results.prefix(limit)) { item in
                    NavigationLink {
                        DietVisitDetail(item: item)
                    } label: {
                        HStack(spacing: 12) {
                            GradeChip(grade: item.label.grade)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.visit.title.isEmpty ? item.visit.host : item.visit.title).lineLimit(2)
                                Text("\(item.visit.host) · \(item.visit.at.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text("\(item.visit.seconds.dietDuration) \(item.visit.isMeasured ? "measured" : "estimated") · \(item.label.category.title)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if results.count > limit { Button("Show 100 more") { limit += 100 } }
                if results.isEmpty { Text("No recorded pages match these filters.").foregroundStyle(.secondary) }
            }
            .navigationTitle("Pages & videos")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Title, site or topic")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onChange(of: query) { _, _ in limit = 100 }
            .onChange(of: category) { _, _ in limit = 100 }
        }
    }
}

private struct DietVisitDetail: View {
    var item: DietStats.Item

    var body: some View {
        let visit = item.visit
        let label = item.label
        List {
            Section("Content") {
                Text(visit.title.isEmpty ? visit.host : visit.title).font(.headline)
                if let url = URL(string: visit.url), ["http", "https"].contains(url.scheme ?? "") {
                    Link("Open recorded page", destination: url)
                }
                if let channel = visit.channel { LabeledContent("Channel", value: channel) }
                Text(visit.at.formatted(date: .complete, time: .shortened)).font(.caption)
            }
            Section("Consumption") {
                LabeledContent(visit.isMeasured ? "Measured browsing" : "Estimated browsing", value: visit.seconds.dietDuration)
                if visit.isMeasured { LabeledContent("Video playback", value: visit.watchSeconds.dietDuration) }
                Text(visit.isMeasured ? "Measured while this page was visible in the active browser. Playback follows the video's clock."
                     : "Estimated from desktop visit durations or the gap to the next visit in the same profile. This is not measured watch time.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Why this score?") {
                LabeledContent("Category", value: label.category.title)
                LabeledContent("Grade", value: label.grade.rawValue)
                LabeledContent("Evidence", value: label.method.rawValue.capitalized)
                Text("\(Int((label.confidence * 100).rounded()))% rule/model confidence is a heuristic, not a calibrated probability.")
                    .font(.caption).foregroundStyle(.secondary)
                Text(label.category.counts ? "Category sets the starting points. Content cues and session length adjust them; the period's score is weighted by browsing time."
                     : "Logins and redirects are preserved here and excluded from consumption totals.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let description = visit.description { Section("Description") { Text(description) } }
            if let excerpt = visit.excerpt { Section("Recorded excerpt") { Text(excerpt).textSelection(.enabled) } }
        }
        .navigationTitle("Recorded visit")
        .navigationBarTitleDisplayMode(.inline)
    }
}
