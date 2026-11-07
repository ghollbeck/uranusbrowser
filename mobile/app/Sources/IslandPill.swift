import SwiftUI
import UIKit
import ObjectiveC

// MARK: - Layout data (persisted in AppSettings.island)

/// One flower on the pill. `x`, `y` are points from the pill's CENTRE (the island's centre), y down.
struct FlowerSpec: Codable, Equatable, Identifiable {
    var id: UUID
    var emoji: String
    var x: CGFloat
    var y: CGFloat
    var size: CGFloat
    var rotation: Double

    init(id: UUID = UUID(), emoji: String, x: CGFloat, y: CGFloat, size: CGFloat, rotation: Double) {
        self.id = id; self.emoji = emoji; self.x = x; self.y = y; self.size = size; self.rotation = rotation
    }

    enum CodingKeys: String, CodingKey { case id, emoji, x, y, size, rotation }

    /// Tolerant like `AppSettings`: a damaged or partial flower never makes the whole state file unreadable.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(UUID.self, forKey: .id)) ?? UUID()
        emoji = (try? c.decodeIfPresent(String.self, forKey: .emoji)) ?? "🌸"
        x = (try? c.decodeIfPresent(CGFloat.self, forKey: .x)) ?? 0
        y = (try? c.decodeIfPresent(CGFloat.self, forKey: .y)) ?? 0
        size = (try? c.decodeIfPresent(CGFloat.self, forKey: .size)) ?? 12
        rotation = (try? c.decodeIfPresent(Double.self, forKey: .rotation)) ?? 0
    }

    /// Slow sway parameters derived from the id, so they are stable per flower without being stored.
    var swayPeriod: Double { 5 + Double((Int(id.uuid.15) &* 7 &+ Int(id.uuid.14)) % 30) / 10 }
    var swayPhase: Double { Double(id.uuid.15 % 8) / 8 * 2 * .pi }
}

/// The editable shape of the pill. `width == nil` means the automatic "hug the status items" width.
struct IslandLayout: Codable, Equatable {
    var width: CGFloat?
    var height: CGFloat = 48
    var flowers: [FlowerSpec] = []

    enum CodingKeys: String, CodingKey { case width, height, flowers }

    init(width: CGFloat? = nil, height: CGFloat = 48, flowers: [FlowerSpec] = []) {
        self.width = width; self.height = height; self.flowers = flowers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        width = (try? c.decodeIfPresent(CGFloat.self, forKey: .width)) ?? nil
        height = (try? c.decodeIfPresent(CGFloat.self, forKey: .height)) ?? 48
        flowers = (try? c.decodeIfPresent([FlowerSpec].self, forKey: .flowers)) ?? IslandLayout.default.flowers
    }

    /// The owner's own layout (hand-placed in edit mode on 2026-10-29): a 339x49 pt pill with 12 flowers, some half outside it.
    /// Offsets are points from the pill's centre. Fixed ids keep the default identical across launches.
    static let `default` = IslandLayout(width: 339, height: 49, flowers: [
        FlowerSpec(id: fixedID(1), emoji: "🌷", x: -90, y: -11, size: 15, rotation: -18),
        FlowerSpec(id: fixedID(2), emoji: "🪻", x: -109, y: 14, size: 13, rotation: 8),
        FlowerSpec(id: fixedID(3), emoji: "🌼", x: 22, y: 28, size: 11, rotation: 12),
        FlowerSpec(id: fixedID(4), emoji: "🌻", x: 102, y: -19, size: 12, rotation: -8),
        FlowerSpec(id: fixedID(5), emoji: "🌸", x: 50, y: -24, size: 10, rotation: 10),
        FlowerSpec(id: fixedID(6), emoji: "🌺", x: 61, y: 18, size: 12, rotation: 14),
        FlowerSpec(id: fixedID(7), emoji: "🌼", x: -49, y: -28, size: 13, rotation: -15),
        FlowerSpec(id: fixedID(8), emoji: "🪻", x: 134, y: -17, size: 11, rotation: 10),
        FlowerSpec(id: fixedID(9), emoji: "🌺", x: 84, y: 21, size: 14, rotation: 0),
        FlowerSpec(id: fixedID(10), emoji: "🌺", x: -155, y: 9, size: 14, rotation: 0),
        FlowerSpec(id: fixedID(11), emoji: "🌻", x: 91, y: 4, size: 14, rotation: 15),
        FlowerSpec(id: fixedID(12), emoji: "🌷", x: -67, y: 20, size: 14, rotation: 10),
    ])

    private static func fixedID(_ n: Int) -> UUID { UUID(uuidString: String(format: "00000000-0000-0000-0000-%012ld", n))! }

    var json: String {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}

// MARK: - The pill

/// EXPERIMENT (top bar style, see `TopStyle`): one big pure-black pill drawn over the page that merges with the
/// hardware Dynamic Island. The clock and the status icons sit INSIDE it, on black. Replaces `TopBlur` while active.
/// Delete this file together with the pieces listed on `TopStyle` to revert.
///
/// Geometry (iPhone 17 Pro, 402 x 874 pt): the island is a ~125 x 36.7 pt capsule centred horizontally with its centre
/// at y = 32.3 pt (= top safe inset 62 * 0.52). The pill is `height` tall, its vertical centre is the island's centre,
/// and it is centred on x = screenWidth / 2 (the island's axis), so the left and right gaps are identical by construction.
/// Automatic width hugs the status items: half-width = max(distance axis -> clock's left-most pixel, distance axis ->
/// battery's right-most pixel) + `pad`. On this phone the battery side is the wider one, so it gets `pad` of black after
/// the battery and the clock side gets a little more.
///
/// Flowers are drawn in screen space ABOVE the pill (never clipped to it), so they may sit inside, half outside or fully
/// outside the pill. Their `x`, `y` are points from the pill's centre, unbounded in the file; on screen they are clamped to
/// the top strip (x within the screen, y from the top edge to `stripBelow` points under the pill).
///
/// Entering edit mode: long-press the pill (about 0.45 s), Settings > "Edit pill and flowers" (switches to the flower pill
/// when the style is Blur), or launch with `-editPill 1`. In edit mode the whole top strip is a canvas: drag the round
/// handles to resize (always symmetric about the axes), drag a flower anywhere in the strip, tap to select, double-tap or
/// cmd+click an empty spot to add one. Every change lands in `store.settings.island` and is saved.
struct IslandPill: View {
    let style: TopStyle
    let safeTop: CGFloat
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var scale
    @State private var resizeBase: (start: CGPoint, size: CGSize)?
    @State private var flowerBase: (start: CGPoint, id: UUID, x: CGFloat, y: CGFloat)?
    @State private var lastTick = 0

    static let defaultHeight: CGFloat = 48
    static let heightRange: ClosedRange<CGFloat> = 38...64
    static let minWidth: CGFloat = 200
    static let sideMargin: CGFloat = 16
    /// How far below the pill's bottom edge a flower may be dragged (the edit canvas reaches this far).
    static let stripBelow: CGFloat = 90
    /// How far below the pill the long-press zone reaches (the status bar strip itself never receives touches).
    static let grabBelow: CGFloat = 16
    /// Black left beyond the status item that sits farthest from the island axis.
    static let pad: CGFloat = 10
    /// iOS status bar on iPhone 17 Pro, measured on a 1206 x 2622 px screenshot (px / 3): the clock's left-most pixel is
    /// 52.33 pt from the left screen edge, the battery's right-most pixel is 35.33 pt from the right screen edge
    /// (x = 366.67 pt on a 402 pt screen). iOS places these; they are not ours to move.
    static let clockLeftInset: CGFloat = 52.33
    static let batteryRightInset: CGFloat = 35.33
    /// The hardware island (iPhone 17 Pro): flowers are kept out of its middle.
    static let islandSize = CGSize(width: 125, height: 36.7)

    struct Metrics { var centerY: CGFloat; var width: CGFloat; var height: CGFloat; var autoWidth: CGFloat }

    /// Pill frame geometry in points, snapped to whole device pixels so both sides render identically.
    /// - `centerY`: `safeTop * 0.52`, the island's vertical centre (snapped so a 48 pt pill's top lies on a pixel boundary).
    /// - `width`: the layout's width, or `2 * (max(dL, dR) + pad)` when nil; always centred on x = screenWidth / 2.
    static func metrics(screenWidth: CGFloat, safeTop: CGFloat, scale: CGFloat, layout: IslandLayout) -> Metrics {
        func snap(_ v: CGFloat) -> CGFloat { (v * scale).rounded() / scale }
        let cy = snap(safeTop * 0.52 - defaultHeight / 2) + defaultHeight / 2
        let axis = screenWidth / 2
        let dL = axis - clockLeftInset
        let dR = (screenWidth - batteryRightInset) - axis
        let auto = 2 * (max(dL, dR) + pad)
        let w = layout.width.map { min(max($0, minWidth), screenWidth - sideMargin) } ?? auto
        // An even number of pixels keeps both edges on a pixel boundary around the exact centre.
        let widthPx = 2 * (w * scale / 2).rounded()
        let h = snap(min(max(layout.height, heightRange.lowerBound), heightRange.upperBound))
        return Metrics(centerY: cy, width: min(widthPx / scale, screenWidth), height: h, autoWidth: auto)
    }

    /// Keeps a flower's centre on screen and inside the top strip, and out of the middle of the hardware island.
    /// Input and output are points from the pill's centre. Being inside the pill is NOT required.
    static func clampFlower(x: CGFloat, y: CGFloat, screenWidth: CGFloat, m: Metrics) -> CGPoint {
        var x = min(max(x, -screenWidth / 2), screenWidth / 2)
        var y = min(max(y, -m.centerY), m.height / 2 + stripBelow)
        let rx = islandSize.width / 2, ry = islandSize.height / 2
        if abs(x) < rx && abs(y) < ry {         // inside the island: push out through the nearest side
            if rx - abs(x) <= ry - abs(y) { x = (x < 0 ? -rx : rx) } else { y = (y < 0 ? -ry : ry) }
        }
        return CGPoint(x: x, y: y)
    }

    var body: some View {
        GeometryReader { geo in
            let layout = store.settings.island
            let editing = store.editingPill
            let m = Self.metrics(screenWidth: geo.size.width, safeTop: safeTop, scale: scale, layout: layout)
            let axis = geo.size.width / 2
            let strip = m.centerY + m.height / 2 + Self.stripBelow
            ZStack {
                if editing {
                    // The edit canvas: the whole top strip. Double-tap an empty spot to add a flower, tap to deselect.
                    Color.clear
                        .frame(width: geo.size.width, height: strip)
                        .contentShape(Rectangle())
                        .gesture(SpatialTapGesture(count: 2).onEnded {
                            addFlower(atScreen: $0.location, axis: axis, m: m, screenWidth: geo.size.width)
                        })
                        .onTapGesture { store.selectedFlower = nil }
                        .position(x: axis, y: strip / 2)
                }
                pill(m: m, editing: editing, screenWidth: geo.size.width)
                    .position(x: axis, y: m.centerY)
                if style == .pillFlowers {
                    // Above the pill, not clipped to it, and untouchable unless editing (the page keeps its touches).
                    ZStack {
                        ForEach(layout.flowers) { f in
                            let p = Self.clampFlower(x: f.x, y: f.y, screenWidth: geo.size.width, m: m)
                            flower(f, m: m, editing: editing, screenWidth: geo.size.width)
                                .position(x: axis + p.x, y: m.centerY + p.y)
                        }
                    }
                    .allowsHitTesting(editing)
                }
                if editing {
                    editChrome(layout: layout, m: m, axis: axis, screenWidth: geo.size.width)
                } else {
                    // Long-press the pill to edit. The touches keep going to the page (the recogniser never cancels them).
                    // iOS never delivers touches that start in the status bar strip (about y < 54), so the zone also
                    // reaches `grabBelow` under the pill, where the press is delivered.
                    PillLongPress(zone: CGRect(x: axis - m.width / 2, y: m.centerY - m.height / 2,
                                               width: m.width, height: m.height + Self.grabBelow)) {
                        store.beginPillEditing()
                    }
                    .frame(width: 0, height: 0)
                }
            }
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(store.editingPill)      // outside edit mode the page owns every touch
        .accessibilityHidden(!store.editingPill)
        // iOS keeps touches inside the status bar strip (about the top 54 pt) for its own "tap to scroll to top", so nothing
        // in the pill could be dragged. While editing the status bar is hidden and `FauxStatus` stands in for it.
        .statusBarHidden(store.editingPill)
        .onAppear { PillStatusBar.setLight(true) }
        .onDisappear { PillStatusBar.setLight(false) }
    }

    // MARK: pill and flowers

    /// The black capsule (never touchable itself: outside edit mode the page owns the touches, in edit mode the canvas does).
    private func pill(m: Metrics, editing: Bool, screenWidth: CGFloat) -> some View {
        ZStack {
            // Pure #000000, fully opaque, no stroke / shadow: any tint would show a seam against the hardware island.
            Capsule().fill(Color.black)
            if editing {
                FauxStatus(originX: screenWidth / 2 - m.width / 2, screenWidth: screenWidth, height: m.height)
                    .allowsHitTesting(false)
                Capsule().strokeBorder(.white.opacity(0.8), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    .allowsHitTesting(false)
            }
        }
        .frame(width: m.width, height: m.height)
        .allowsHitTesting(false)                  // the edit canvas behind it takes the touches
    }

    private func flower(_ f: FlowerSpec, m: Metrics, editing: Bool, screenWidth: CGFloat) -> some View {
        let selected = editing && store.selectedFlower == f.id
        return SwayingEmoji(spec: f, animate: !reduceMotion && !editing)
            .overlay {
                if selected {
                    Circle().stroke(.white, lineWidth: 1.5).frame(width: f.size * 1.9, height: f.size * 1.9)
                        .shadow(color: .black.opacity(0.5), radius: 1.5)   // visible on a light page too
                }
            }
            .frame(width: max(30, f.size * 1.6), height: max(30, f.size * 1.6))
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { v in
                    if flowerBase?.start != v.startLocation || flowerBase?.id != f.id {   // a new touch, never a stale one
                        flowerBase = (v.startLocation, f.id, f.x, f.y)
                        store.selectedFlower = f.id
                    }
                    guard let base = flowerBase else { return }
                    let p = Self.clampFlower(x: base.x + v.translation.width, y: base.y + v.translation.height,
                                             screenWidth: screenWidth, m: m)
                    store.updateFlower(f.id) { $0.x = p.x.rounded(); $0.y = p.y.rounded() }
                }
                .onEnded { _ in flowerBase = nil },
                     including: editing ? .all : .none)
    }

    /// `location` is in screen points (this view's space starts at the top-left of the screen).
    private func addFlower(atScreen location: CGPoint, axis: CGFloat, m: Metrics, screenWidth: CGFloat) {
        guard store.editingPill, style == .pillFlowers, location.y <= m.centerY + m.height / 2 + Self.stripBelow else { return }
        let p = Self.clampFlower(x: location.x - axis, y: location.y - m.centerY, screenWidth: screenWidth, m: m)
        store.addFlower(x: p.x.rounded(), y: p.y.rounded())
    }

    // MARK: edit chrome (handles and size label)

    private enum Edge { case left, right, top, bottom }

    @ViewBuilder
    private func editChrome(layout: IslandLayout, m: Metrics, axis: CGFloat, screenWidth: CGFloat) -> some View {
        let half = m.width / 2
        let vx = min(118, half - 30)            // top / bottom handles sit clear of the island and the clock
        // cmd+click on the strip adds a flower. SwiftUI's tap gestures cannot see modifier keys on iOS, so a UIKit
        // recogniser on the window reports the tap and its `modifierFlags`.
        CommandClick { p in
            addFlower(atScreen: p, axis: axis, m: m, screenWidth: screenWidth)
        }
        .frame(width: 0, height: 0)
        handle(.left, m: m, screenWidth: screenWidth).position(x: max(14, axis - half), y: m.centerY)
        handle(.right, m: m, screenWidth: screenWidth).position(x: min(screenWidth - 14, axis + half), y: m.centerY)
        handle(.top, m: m, screenWidth: screenWidth).position(x: axis - vx, y: m.centerY - m.height / 2)
        handle(.bottom, m: m, screenWidth: screenWidth).position(x: axis + vx, y: m.centerY + m.height / 2)
        // The bottom edge of the flower canvas (flowers cannot be dragged below it), with the size label under it
        // so nothing in the canvas is covered.
        let strip = m.centerY + m.height / 2 + Self.stripBelow
        Path { p in p.move(to: CGPoint(x: 16, y: strip)); p.addLine(to: CGPoint(x: screenWidth - 16, y: strip)) }
            .stroke(Theme.accent.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            .allowsHitTesting(false)
        Text("W \(Int(m.width.rounded())) x H \(Int(m.height.rounded())) pt\(layout.width == nil ? " (auto)" : "")")
            .font(.system(size: 12, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 10).frame(height: 22)
            .background(.black, in: .capsule)
            .position(x: axis, y: strip + 16)
            .allowsHitTesting(false)
    }

    private func handle(_ edge: Edge, m: Metrics, screenWidth: CGFloat) -> some View {
        Circle().fill(.white).frame(width: 20, height: 20)
            .overlay(Circle().stroke(Theme.accent, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.4), radius: 2, y: 1)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { v in
                    if resizeBase?.start != v.startLocation {                  // a new touch, never a stale one
                        resizeBase = (v.startLocation, CGSize(width: m.width, height: m.height))
                    }
                    guard let b = resizeBase?.size else { return }
                    switch edge {
                    case .left:   setWidth(b.width - 2 * v.translation.width, screenWidth: screenWidth)
                    case .right:  setWidth(b.width + 2 * v.translation.width, screenWidth: screenWidth)
                    case .top:    setHeight(b.height - 2 * v.translation.height)
                    case .bottom: setHeight(b.height + 2 * v.translation.height)
                    }
                }
                .onEnded { _ in resizeBase = nil })
    }

    private func setWidth(_ w: CGFloat, screenWidth: CGFloat) {
        let v = min(max(w.rounded(), Self.minWidth), screenWidth - Self.sideMargin)
        guard store.settings.island.width != v else { return }
        store.settings.island.width = v
        tick(Int(v / 2))
        store.scheduleSave()
    }

    private func setHeight(_ h: CGFloat) {
        let v = min(max(h.rounded(), Self.heightRange.lowerBound), Self.heightRange.upperBound)
        guard store.settings.island.height != v else { return }
        store.settings.island.height = v
        tick(Int(v / 2))
        store.scheduleSave()
    }

    private func tick(_ step: Int) {
        guard step != lastTick else { return }
        lastTick = step
        UISelectionFeedbackGenerator().selectionChanged()
    }
}

/// Edit-mode stand-in for the system status bar (hidden while editing): the clock and the three icons at the positions
/// iOS puts them on iPhone 17 Pro (measured from screenshots), so flowers can be placed around them.
private struct FauxStatus: View {
    let originX: CGFloat      // the pill's left edge in screen points
    let screenWidth: CGFloat
    let height: CGFloat

    private var time: String {
        let f = DateFormatter()
        f.dateFormat = "h:mm"
        return f.string(from: .now)
    }

    var body: some View {
        let y = height / 2
        ZStack {
            Text(time).font(.system(size: 17, weight: .semibold)).position(x: 74.5 - originX, y: y)
            Image(systemName: "cellularbars").font(.system(size: 14, weight: .semibold)).opacity(0.4)
                .position(x: screenWidth - 104.3 - originX, y: y)
            Image(systemName: "wifi").font(.system(size: 15, weight: .semibold))
                .position(x: screenWidth - 78.5 - originX, y: y)
            Image(systemName: "battery.100").font(.system(size: 19))
                .position(x: screenWidth - 48.8 - originX, y: y)
        }
        .foregroundStyle(.white)
    }
}

/// Reports a long press (about 0.45 s, little movement) that starts inside `zone` (screen points). Attached to the window
/// with `cancelsTouchesInView = false`, so it never takes touches away from the page.
private struct PillLongPress: UIViewRepresentable {
    let zone: CGRect
    let onLongPress: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Probe {
        let v = Probe()
        v.isUserInteractionEnabled = false
        v.coordinator = context.coordinator
        context.coordinator.zone = zone
        context.coordinator.onLongPress = onLongPress
        return v
    }
    func updateUIView(_ v: Probe, context: Context) {
        context.coordinator.zone = zone
        context.coordinator.onLongPress = onLongPress
    }
    static func dismantleUIView(_ v: Probe, coordinator: Coordinator) { coordinator.detach() }

    final class Probe: UIView {
        weak var coordinator: Coordinator?
        override func didMoveToWindow() { super.didMoveToWindow(); coordinator?.attach(to: window) }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var zone: CGRect = .zero
        var onLongPress: () -> Void = {}
        private weak var window: UIWindow?
        private lazy var recognizer: UILongPressGestureRecognizer = {
            let r = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
            r.minimumPressDuration = 0.45
            r.allowableMovement = 10
            return r
        }()

        func attach(to newWindow: UIWindow?) {
            guard let newWindow, newWindow !== window else { return }
            detach()
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            newWindow.addGestureRecognizer(recognizer)
            window = newWindow
        }
        func detach() { window?.removeGestureRecognizer(recognizer); window = nil }

        @objc private func pressed(_ r: UILongPressGestureRecognizer) {
            guard r.state == .began, zone.contains(r.location(in: nil)) else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            onLongPress()
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

/// Reports taps made with the command key held (Simulator with a hardware keyboard, iPad / Mac with a pointer).
private struct CommandClick: UIViewRepresentable {
    let onTap: (CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onTap) }
    func makeUIView(context: Context) -> Probe {
        let v = Probe()
        v.isUserInteractionEnabled = false
        v.coordinator = context.coordinator
        return v
    }
    func updateUIView(_ v: Probe, context: Context) { context.coordinator.onTap = onTap }
    static func dismantleUIView(_ v: Probe, coordinator: Coordinator) { coordinator.detach() }

    final class Probe: UIView {
        weak var coordinator: Coordinator?
        override func didMoveToWindow() { super.didMoveToWindow(); coordinator?.attach(to: window) }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onTap: (CGPoint) -> Void
        private weak var window: UIWindow?
        private lazy var recognizer = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))

        init(_ onTap: @escaping (CGPoint) -> Void) { self.onTap = onTap }

        func attach(to newWindow: UIWindow?) {
            guard let newWindow, newWindow !== window else { return }
            detach()
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            newWindow.addGestureRecognizer(recognizer)
            window = newWindow
        }
        func detach() { window?.removeGestureRecognizer(recognizer); window = nil }

        @objc private func tapped(_ r: UITapGestureRecognizer) {
            guard r.state == .ended, r.modifierFlags.contains(.command) else { return }
            onTap(r.location(in: nil))   // window coordinates = SwiftUI global space on a full-screen window
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

// MARK: - Store helpers (edit actions)

extension BrowserStore {
    static let flowerPalette = ["🌸", "🌼", "🌷", "🌺", "🌻", "🪻", "🌹", "💐"]

    var selectedFlowerIndex: Int? { settings.island.flowers.firstIndex { $0.id == selectedFlower } }

    func updateFlower(_ id: UUID, _ change: (inout FlowerSpec) -> Void) {
        guard let i = settings.island.flowers.firstIndex(where: { $0.id == id }) else { return }
        change(&settings.island.flowers[i])
        scheduleSave()
    }

    func addFlower(x: CGFloat, y: CGFloat) {
        let f = FlowerSpec(emoji: Self.flowerPalette.randomElement() ?? "🌸", x: x, y: y,
                           size: CGFloat(Int.random(in: 11...14)), rotation: Double(Int.random(in: -3...3) * 5))
        settings.island.flowers.append(f)
        selectedFlower = f.id
        scheduleSave()
    }

    /// "Add" button: drops a flower on whichever free spot beside the island is farthest from the existing flowers.
    func addFlowerAtFreeSpot() {
        var best = CGPoint(x: -80, y: 0), bestDistance: CGFloat = -1
        // Candidate spots: the black beside the island that the clock and the status icons leave free.
        for x in [CGFloat(-88), -80, -72, 70, 76] {
            for y in stride(from: CGFloat(-16), through: 16, by: 8) {
                let d = settings.island.flowers.map { hypot($0.x - x, $0.y - y) }.min() ?? 100
                if d > bestDistance { bestDistance = d; best = CGPoint(x: x, y: y) }
            }
        }
        addFlower(x: best.x, y: best.y)
    }

    func deleteSelectedFlower() {
        guard let i = selectedFlowerIndex else { return }
        settings.island.flowers.remove(at: i)
        selectedFlower = nil
        scheduleSave()
    }

    func cycleSelectedEmoji(_ step: Int) {
        guard let id = selectedFlower, let i = selectedFlowerIndex else { return }
        let list = Self.flowerPalette
        let now = list.firstIndex(of: settings.island.flowers[i].emoji) ?? 0
        updateFlower(id) { $0.emoji = list[(now + step + list.count) % list.count] }
    }

    func resetPillLayout() {
        settings.island = .default
        selectedFlower = nil
        scheduleSave()
    }

    /// Long-press on the pill, Settings row, or `-editPill 1`. From Blur it first switches to the flower pill, and only
    /// turns edit mode on once the pill view exists (flipping both in one transaction left the new pill view
    /// rendering as not editing while the edit bar was already up).
    func beginPillEditing() {
        sheet = nil
        showSwitcher = false
        selectedFlower = nil
        if topStyle == .blur {
            topStyleOverride = nil
            settings.topStyle = .pillFlowers
            scheduleSave()
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(450))
                withAnimation(.smooth) { editingPill = true }
            }
        } else {
            withAnimation(.smooth) { editingPill = true }
        }
    }

    func finishPillEditing() {
        editingPill = false
        selectedFlower = nil
        save()
        print("[Flecha] island layout:\n\(settings.island.json)")
    }
}

// MARK: - Edit bar (replaces the bottom bar while editing)

struct PillEditBar: View {
    @Environment(BrowserStore.self) private var store
    @State private var confirmReset = false
    @State private var copied = false

    var body: some View {
        let sel = store.selectedFlowerIndex.map { store.settings.island.flowers[$0] }
        let flowers = store.topStyle == .pillFlowers
        VStack(spacing: 4) {
            Text(flowers ? "Drag flowers anywhere, even outside the pill. Double-tap adds one."
                         : "Flowers are hidden in the Black pill style.")
                .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                .padding(.top, 2)
            HStack(spacing: 2) {
                button("plus", enabled: flowers) { store.addFlowerAtFreeSpot() }
                button("chevron.left", enabled: sel != nil) { store.cycleSelectedEmoji(-1) }
                Text(sel?.emoji ?? "–").font(.system(size: 24)).frame(maxWidth: .infinity, minHeight: Layout.control)
                button("chevron.right", enabled: sel != nil) { store.cycleSelectedEmoji(1) }
                button("textformat.size.smaller", enabled: sel != nil) { adjust { $0.size = max(9, $0.size - 1) } }
                button("textformat.size.larger", enabled: sel != nil) { adjust { $0.size = min(26, $0.size + 1) } }
                button("arrow.counterclockwise", enabled: sel != nil) { adjust { $0.rotation = Self.wrap($0.rotation - 15) } }
                button("arrow.clockwise", enabled: sel != nil) { adjust { $0.rotation = Self.wrap($0.rotation + 15) } }
            }
            HStack(spacing: 2) {
                label("Delete", enabled: sel != nil) { store.deleteSelectedFlower() }
                label("Reset", enabled: true) { confirmReset = true }
                label(copied ? "Copied" : "Copy", enabled: true) {
                    UIPasteboard.general.string = store.settings.island.json
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                }
                Button { withAnimation(.smooth) { store.finishPillEditing() } } label: {
                    Text("Done").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: Layout.control)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .glassEffect(.regular, in: .rect(cornerRadius: Layout.cardRadius + 6))
        .padding(.horizontal, Layout.edge)
        .padding(.bottom, Layout.barBottomPadding)
        .confirmationDialog("Reset pill and flowers?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset to default layout", role: .destructive) { store.resetPillLayout() }
        } message: { Text("Width, height and all flowers go back to the built-in layout.") }
    }

    private func adjust(_ change: (inout FlowerSpec) -> Void) {
        guard let id = store.selectedFlower else { return }
        store.updateFlower(id, change)
    }

    private static func wrap(_ degrees: Double) -> Double {
        var d = degrees.truncatingRemainder(dividingBy: 360)
        if d > 180 { d -= 360 } else if d <= -180 { d += 360 }
        return d
    }

    private func button(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 17, weight: .semibold))
                .frame(maxWidth: .infinity, minHeight: Layout.control)
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.3)
    }

    private func label(_ title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.body).frame(maxWidth: .infinity, minHeight: Layout.control)
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.3)
    }
}

// MARK: - Status bar

/// The clock and status icons follow the app appearance (dark text in Light mode), which would be black on the black pill.
/// SwiftUI has no status-bar-style API besides `preferredColorScheme`, which would also turn the web page and the whole
/// app dark. So while the pill is on screen the root hosting controller reports `.lightContent` (wraps its own getter,
/// restores the original behaviour when the pill goes away).
enum PillStatusBar {
    private static var light = false
    private static var patched: Set<ObjectIdentifier> = []

    @MainActor static func setLight(_ on: Bool) {
        light = on
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let root = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController else { return }
        patch(type(of: root))
        root.setNeedsStatusBarAppearanceUpdate()
    }

    private static func patch(_ cls: AnyClass) {
        guard patched.insert(ObjectIdentifier(cls)).inserted else { return }
        let sel = #selector(getter: UIViewController.preferredStatusBarStyle)
        guard let method = class_getInstanceMethod(cls, sel) else { return }
        typealias Getter = @convention(c) (AnyObject, Selector) -> Int
        let original = unsafeBitCast(method_getImplementation(method), to: Getter.self)
        let block: @convention(block) (AnyObject) -> Int = { vc in
            light ? UIStatusBarStyle.lightContent.rawValue : original(vc, sel)
        }
        class_replaceMethod(cls, sel, imp_implementationWithBlock(block), method_getTypeEncoding(method))
    }
}

// MARK: - One flower

/// One emoji with a very slow +-4 degree sway (sine = ease in-out, 5 to 8 s per half cycle). Static when Reduce Motion
/// is on, and while editing.
private struct SwayingEmoji: View {
    let spec: FlowerSpec
    let animate: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animate)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let sway = animate ? 4 * sin(t * .pi / spec.swayPeriod + spec.swayPhase) : 0
            Text(spec.emoji)
                .font(.system(size: spec.size))
                .rotationEffect(.degrees(spec.rotation + sway))
        }
    }
}
