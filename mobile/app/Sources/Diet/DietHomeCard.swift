import SwiftUI

/// Today's Algorithm Diet on the new tab page: grade, time, and what it was made of. Tap for the full Diet.
struct DietHomeCard: View {
    @Environment(BrowserStore.self) private var store
    private var engine: DietEngine { .shared }

    var body: some View {
        if !store.isPrivate, DietTracker.shared.enabled {
            let s = engine.today
            Button { engine.isPresented = true } label: {
                VStack(alignment: .leading, spacing: Layout.tight) {
                    HStack(spacing: Layout.gap) {
                        if s.seconds > 0 {
                            GradeChip(grade: s.grade, size: 44)
                        } else {
                            Image(systemName: "fork.knife").font(.system(size: 20, weight: .semibold))
                                .frame(width: 44, height: 44).background(.white.opacity(0.18), in: .rect(cornerRadius: 13))
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Algorithm Diet · Today").font(.caption.weight(.semibold)).opacity(0.9)
                            Text(s.seconds > 0 ? s.grade.verdict : "Nothing yet").font(.title3.weight(.semibold))
                            Text(s.seconds > 0 ? "\(s.seconds.dietDuration) · \(s.visits) \(s.visits == 1 ? "page" : "pages")" + (s.watchSeconds >= 60 ? " · \(s.watchSeconds.dietDuration) video" : "")
                                               : "What you read and watch is scored here")
                                .font(.footnote).opacity(0.9).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).opacity(0.6)
                    }
                    if s.seconds > 0 { mix(s) }
                }
                .padding(Layout.sheetInset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Layout.cardRadius))
            .accessibilityLabel(s.seconds > 0 ? "Algorithm Diet today: grade \(s.grade.rawValue), \(s.seconds.dietDuration)" : "Algorithm Diet")
            .task {
                await engine.loadIfNeeded()
                engine.refreshToday()
            }
        }
    }

    /// The day's categories as one bar, the three biggest named under it.
    private func mix(_ s: DietStats) -> some View {
        let top = s.slices.sorted { $0.seconds > $1.seconds }
        return VStack(alignment: .leading, spacing: 6) {
            GeometryReader { geo in
                HStack(spacing: 2) {
                    ForEach(top) { sl in
                        Capsule().fill(sl.category.color).frame(width: max(3, (geo.size.width - CGFloat(top.count) * 2) * sl.share))
                    }
                }
            }
            .frame(height: 6)
            HStack(spacing: Layout.gap) {
                ForEach(top.prefix(3)) { sl in
                    HStack(spacing: 4) {
                        Circle().fill(sl.category.color).frame(width: 7, height: 7)
                        Text(sl.category.title).lineLimit(1)
                    }
                }
            }
            .font(.caption2).opacity(0.85)
        }
    }
}
