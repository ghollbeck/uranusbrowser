import SwiftUI

extension NutriGrade {
    var color: Color {
        switch self {
        case .a: Color(hex: 0x038141)
        case .b: Color(hex: 0x85BB2F)
        case .c: Color(hex: 0xFECB02)
        case .d: Color(hex: 0xEE8100)
        case .e: Color(hex: 0xE63E11)
        }
    }
    /// Text on top of the grade colour.
    var ink: Color { self == .c || self == .b ? .black.opacity(0.78) : .white }
}

extension DietCategory {
    var color: Color { Color(hex: hex) }
}

/// Small A-E chip.
struct GradeChip: View {
    var grade: NutriGrade
    var size: CGFloat = 24
    var body: some View {
        Text(grade.rawValue)
            .font(.system(size: size * 0.6, weight: .heavy, design: .rounded))
            .foregroundStyle(grade.ink)
            .frame(width: size, height: size)
            .background(grade.color, in: .rect(cornerRadius: size * 0.3))
    }
}

/// The A-E scale with the current grade lifted out of it. On appear a highlight runs from A to the grade.
struct DietScoreStrip: View {
    var grade: NutriGrade
    @State private var shown = 0

    var body: some View {
        HStack(spacing: 0) {
            ForEach(NutriGrade.allCases) { g in
                let on = g.index == shown
                Text(g.rawValue)
                    .font(.system(size: on ? 30 : 18, weight: .heavy, design: .rounded))
                    .foregroundStyle(g.ink.opacity(on ? 1 : 0.75))
                    .frame(maxWidth: .infinity)
                    .frame(height: on ? 54 : 38)
                    .background(g.color.opacity(on ? 1 : 0.55), in: .rect(cornerRadius: on ? 14 : 4))
                    .overlay { if on { RoundedRectangle(cornerRadius: 14).stroke(.white, lineWidth: 3) } }
                    .shadow(color: on ? g.color.opacity(0.55) : .clear, radius: 10, y: 3)
                    .zIndex(on ? 1 : 0)
                    .scaleEffect(on ? 1.08 : 1)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(.primary.opacity(0.06), in: .rect(cornerRadius: 18))
        .frame(height: 62)
        .task(id: grade) {
            for i in 0...grade.index {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.62)) { shown = i }
                try? await Task.sleep(for: .milliseconds(140))
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Diet score \(grade.rawValue), \(grade.verdict)")
    }
}

/// The classification progress bar: a spring-driven fill in the score colours, a shimmer sweeping through it and a
/// glowing head at its leading edge.
struct DietProgressBar: View {
    var fraction: Double
    var height: CGFloat = 16

    var body: some View {
        GeometryReader { geo in
            let w = max(height, geo.size.width * fraction.clamped(0, 1))
            ZStack(alignment: .leading) {
                Capsule().fill(.primary.opacity(0.08))
                Capsule()
                    .fill(LinearGradient(colors: [NutriGrade.e.color, NutriGrade.d.color, NutriGrade.c.color,
                                                  NutriGrade.b.color, NutriGrade.a.color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: geo.size.width)
                    .mask(alignment: .leading) { Capsule().frame(width: w) }
                    .overlay(alignment: .leading) {
                        TimelineView(.animation) { ctx in
                            let t = ctx.date.timeIntervalSinceReferenceDate
                            let phase = CGFloat(t.truncatingRemainder(dividingBy: 1.6) / 1.6)
                            LinearGradient(colors: [.white.opacity(0), .white.opacity(0.55), .white.opacity(0)],
                                           startPoint: .leading, endPoint: .trailing)
                                .frame(width: 90)
                                .offset(x: -90 + (w + 90) * phase)
                        }
                        .frame(width: w, alignment: .leading)
                        .clipShape(Capsule())
                    }
                    .shadow(color: NutriGrade.b.color.opacity(0.45), radius: 8)
                Circle()
                    .fill(.white)
                    .frame(width: height * 0.7, height: height * 0.7)
                    .blur(radius: 3)
                    .shadow(color: .white, radius: 6)
                    .offset(x: w - height * 0.85)
                    .opacity(fraction > 0.01 && fraction < 0.999 ? 1 : 0)
            }
            .animation(.spring(response: 0.55, dampingFraction: 0.82), value: fraction)
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityValue("\(Int(fraction * 100)) percent")
    }
}

/// A-E counters that bounce when they go up.
struct GradeBuckets: View {
    var counts: [NutriGrade: Int]
    var body: some View {
        HStack(spacing: 8) {
            ForEach(NutriGrade.allCases) { g in
                let n = counts[g] ?? 0
                VStack(spacing: 4) {
                    GradeChip(grade: g, size: 26)
                    Text(n.formatted(.number.notation(.compactName)))
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .contentTransition(.numericText(value: Double(n)))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(g.color.opacity(0.12), in: .rect(cornerRadius: 12))
                .keyframeAnimator(initialValue: 1.0, trigger: n) { view, s in view.scaleEffect(s) } keyframes: { _ in
                    SpringKeyframe(1.12, duration: 0.12)
                    SpringKeyframe(1.0, duration: 0.3, spring: .bouncy)
                }
                .animation(.smooth(duration: 0.25), value: n)
            }
        }
    }
}

/// Donut of time by category, drawn in on appear, with the health score in the middle.
struct DietPlate: View {
    var slices: [DietStats.Slice]
    var health: Double
    var grade: NutriGrade
    var lineWidth: CGFloat = 22
    @State private var drawn: CGFloat = 0

    var body: some View {
        ZStack {
            Circle().stroke(.primary.opacity(0.07), lineWidth: lineWidth)
            ForEach(Array(arcs.enumerated()), id: \.offset) { _, arc in
                Circle()
                    .trim(from: arc.0 * drawn, to: max(arc.0 * drawn, arc.1 * drawn - 0.004))
                    .stroke(arc.2, style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 0) {
                Text("\(Int(health.rounded()))")
                    .font(.system(size: 44, weight: .heavy, design: .rounded))
                    .contentTransition(.numericText(value: health))
                Text("health").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(lineWidth / 2)
        .onAppear { withAnimation(.easeOut(duration: 1.1)) { drawn = 1 } }
        .animation(.smooth(duration: 0.6), value: health)
    }

    private var arcs: [(CGFloat, CGFloat, Color)] {
        var start: CGFloat = 0
        return slices.filter { $0.share > 0.004 }.map { s in
            defer { start += CGFloat(s.share) }
            return (start, start + CGFloat(s.share), s.category.color)
        }
    }
}

/// Wrapping row of chips.
struct DietFlow: SwiftUI.Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + size.width > w { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            row = max(row, size.height)
        }
        return CGSize(width: min(w, widest), height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

/// Card used throughout the Diet screens (matches the Settings cards: radius 22, translucent fill).
struct DietCard<Content: View>: View {
    var title: String?
    var subtitle: String?
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: Layout.gap) {
            if let title {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                }
            }
            content
        }
        .padding(Layout.sheetInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: .rect(cornerRadius: Layout.cardRadius))
    }
}
