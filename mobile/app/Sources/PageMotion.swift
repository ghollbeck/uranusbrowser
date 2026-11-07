import SwiftUI
import UIKit

/// Motion for the page family: elements 4 (sheet), 6 (new tab), 7 (load line), 10 (toast), 11 (find bar).
/// Variant views and helpers for those live here; the call sites are in App.swift / SearchSheet.swift.
/// Numbers come from design/animations.html (v4A ... v11C). Everything "progress driven" in that page (a number p moved by a
/// bezier or a spring, with `seg(p, a, b)` windows) is done here with `Progressive`: SwiftUI animates p, the closure draws it.
/// Reduce Motion: every variant of these elements collapses to a plain ~0.15 s cross-fade.

/// Tells the custom sheet whether the scroll view inside it is scrolled to the top, so a downward drag anywhere on the sheet
/// can move/dismiss the sheet (like the system sheet) and otherwise scrolls the content.
@MainActor @Observable
final class SheetScrollProbe { var atTop = true }

private struct SheetScrollProbeKey: EnvironmentKey { static let defaultValue: SheetScrollProbe? = nil }
extension EnvironmentValues {
    var sheetScrollProbe: SheetScrollProbe? {
        get { self[SheetScrollProbeKey.self] }
        set { self[SheetScrollProbeKey.self] = newValue }
    }
}

private struct ReportsSheetScroll: ViewModifier {
    @Environment(\.sheetScrollProbe) private var probe
    func body(content: Content) -> some View {
        content.onScrollGeometryChange(for: Bool.self) { g in g.contentOffset.y + g.contentInsets.top <= 1 } action: { _, atTop in
            probe?.atTop = atTop
        }
    }
}
extension View {
    /// Put on the ScrollView inside a sheet that can be dragged from anywhere.
    func reportsSheetScroll() -> some View { modifier(ReportsSheetScroll()) }
}

enum PageMotion {
    /// One honest line per element where an alternative is limited or approximated (shown under the picker in Settings > Motion).
    static let notes: [MotionElement: String] = [
        .sheet: "A is the system sheet (iOS fixes its timing; only the page behind recedes). B and C are a custom glass sheet: drag it from the top handle. C grows from the button with its own spring (not the system zoom, which cannot follow Slow motion) and reveals the content as one soft wave, not row by row.",
        .newTab: "The old page is hidden behind the switcher, so mostly the blank tab's entrance and the sheet's timing show. A keeps the system sheet (it opens 0.1 s late); B and C use the custom sheet.",
        .loadLine: "The curves play on top of the real progress and never run behind it. C: while a page loads the plus is a stop cross and a tap stops the load.",
        .toast: "Shown at the top, not above the bar (it comes from sheets that cover the bottom), so rises become drops from the top edge. Every variant has the green check.",
        .findBar: "WebKit draws the match highlights, so their timing is not changed. C: the bar rises with the spring and the page moves up 90 pt; the keyboard keeps its own system motion.",
    ]

    /// True when the page menu / search sheet is drawn by `PageSheetHost` instead of the system `.sheet`.
    /// Variant A keeps the system sheet (its timing cannot be changed); B, C and Reduce Motion use the custom container.
    @MainActor
    static func usesCustomSheet(_ sheet: AppSheet, store: BrowserStore, reduce: Bool) -> Bool {
        switch sheet {
        case .search:
            let flow: MotionElement = PageMotionState.shared.searchIsNewTab ? .newTab : .sheet
            return reduce || store.motion(flow) != .a
        case .pageMenu:
            return reduce || store.motion(.sheet) != .a
        default:
            return false
        }
    }
}

// MARK: - Small helpers

enum PMath {
    static func clamp(_ x: Double, _ a: Double = 0, _ b: Double = 1) -> Double { min(b, max(a, x)) }
    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
    /// 0 before a, 1 after b, linear between (the design page's `seg`).
    static func seg(_ p: Double, _ a: Double, _ b: Double) -> Double { clamp((p - a) / (b - a)) }

    @MainActor static var window: UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
    }
    /// Full screen size in points (ignores the keyboard).
    @MainActor static var screen: CGSize { window?.bounds.size ?? CGSize(width: 402, height: 874) }
    @MainActor static var safeTop: CGFloat { window?.safeAreaInsets.top ?? 62 }

    /// The design page's ease-out cubic (`eo3`), scaled by slow motion.
    @MainActor static func easeOutCubic(_ d: Double) -> Animation { .timingCurve(0.215, 0.61, 0.355, 1, duration: Motion.scaled(d)) }
    /// cubic-bezier(.4, 0, 1, 1): ease-in, used for exits.
    @MainActor static func easeIn(_ d: Double, x1: Double = 0.4) -> Animation { .timingCurve(x1, 0, 1, 1, duration: Motion.scaled(d)) }
    /// The ~0.15 s cross-fade every variant collapses to under Reduce Motion.
    @MainActor static var fade: Animation { .easeInOut(duration: Motion.scaled(0.15)) }
}

/// A view modifier whose only input is the animated number `p`. SwiftUI interpolates p (with whatever animation is
/// running, spring or bezier) and calls `make` every frame, so `seg` windows, clamps and corner radii work like the design page.
struct Progressive: ViewModifier, Animatable {
    var p: Double
    let make: (AnyView, Double) -> AnyView
    var animatableData: Double {
        get { p }
        set { p = newValue }
    }
    func body(content: Content) -> some View { make(AnyView(content), p) }
}

extension View {
    func progressive<V: View>(_ p: Double, @ViewBuilder _ make: @escaping (AnyView, Double) -> V) -> some View {
        modifier(Progressive(p: p, make: { AnyView(make($0, $1)) }))
    }
}

extension AnyTransition {
    /// `t` runs from 1 (absent) to 0 (present): insertion animates 1 -> 0, removal 0 -> 1.
    static func progressive<V: View>(@ViewBuilder _ make: @escaping (AnyView, Double) -> V) -> AnyTransition {
        let m: (AnyView, Double) -> AnyView = { AnyView(make($0, $1)) }
        return .modifier(active: Progressive(p: 1, make: m), identity: Progressive(p: 0, make: m))
    }
}

// MARK: - Shared observable state (flags between the store, the page and the sheet host)

@MainActor @Observable
final class PageMotionState {
    static let shared = PageMotionState()

    /// Bumped when a blank tab is opened from "+" (element 6). The page layer animates the swap when this changes.
    var newTabToken = 0
    /// True from `presentSearchForNewTab()` until the sheet closes: that search sheet uses element 6's look, not element 4's.
    var searchIsNewTab = false
    /// Bumped to make the tab-stack thumbnail bump (element 6 C).
    var thumbBump = 0

    /// Page behind a custom sheet (element 4): 0 = normal, 1 = receded to `recedeScale` / `recedeY`. Animated by the host.
    var recede: Double = 0
    var recedeScale: Double = 1
    var recedeY: Double = 0
    /// Bottom bar fade while a sheet is up (element 4 B): 0 = visible, 1 = gone.
    var barFade: Double = 0
}

extension BrowserStore {
    /// First thing in `newBlankTabFromSwitcher()`: lets the page layer animate the swap to the blank tab (element 6).
    func beginNewTabFlow() {
        let pm = PageMotionState.shared
        pm.searchIsNewTab = false
        pm.newTabToken += 1
        if motion(.newTab) == .c, !UIAccessibility.isReduceMotionEnabled { pm.thumbBump += 1 }
    }

    /// The search sheet that opens on the blank tab (element 6). Variant A uses the system sheet, so its short delay is done
    /// here; B and C use the custom container, which delays inside its own animation.
    func presentSearchForNewTab() {
        PageMotionState.shared.searchIsNewTab = true
        if motion(.newTab) == .a, !UIAccessibility.isReduceMotionEnabled {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Motion.scaled(0.1)))   // sheet starts 25% into the 0.4 s move
                if self.sheet == nil { self.sheet = .search(editing: false) }
            }
        } else {
            sheet = .search(editing: false)
        }
    }
}

// MARK: - Element 4 / 6: the custom sheet container

/// How one presentation of the page menu / search sheet looks and moves. Fixed when the sheet opens.
struct SheetPresentation {
    enum Look { case fade, riseB4, growC4, riseB6, popC6 }
    enum Source { case chevron, plus }
    var look: Look = .fade
    var anim: Animation = .easeInOut(duration: 0.15)
    var out: Animation = .easeInOut(duration: 0.15)
    var scrim: Double = 0.28
    var source: Source = .plus

    @MainActor
    static func make(kind: AppSheet, newTab: Bool, variant: MotionVariant, reduce: Bool) -> SheetPresentation {
        var s = SheetPresentation()
        s.source = kind == .pageMenu ? .chevron : .plus
        if reduce {
            s.anim = PMath.fade
            s.out = PMath.fade
            return s
        }
        if !newTab {
            switch variant {
            case .a:
                s.look = .fade
                s.anim = Motion.smooth(0.34); s.out = Motion.smooth(0.28)
            case .b:
                s.look = .riseB4; s.scrim = 0.3
                s.anim = Motion.snappy(0.34, extraBounce: 0.15)
                s.out = Motion.spring(0.26, bounce: 0)
            case .c:
                s.look = .growC4; s.scrim = 0.32
                s.anim = Motion.spring(0.4, bounce: 0.2)
                s.out = Motion.spring(0.3, bounce: 0)
            }
        } else {
            switch variant {
            case .a:
                s.look = .fade
                s.anim = Motion.smooth(0.3); s.out = Motion.smooth(0.3)
            case .b:
                // sheet follows 20% later
                s.look = .riseB6; s.scrim = 0.25
                s.anim = Motion.snappy(0.272, extraBounce: 0.15).delay(Motion.scaled(0.068))
                s.out = Motion.snappy(0.28)
            case .c:
                // sheet starts 30% into the move
                s.look = .popC6; s.scrim = 0.25
                s.anim = Motion.spring(0.294, bounce: 0).delay(Motion.scaled(0.126))
                s.out = Motion.spring(0.34, bounce: 0)
            }
        }
        return s
    }
}

/// Where the sheet sits and how tall it is (detents, drag, keyboard).
struct SheetLayout {
    var detents: [CGFloat]
    var height: CGFloat
    var offY: CGFloat
    var bottomPad: CGFloat
    var side: CGFloat = 9          // measured on the system sheet: 8.7 pt from the sides and the bottom
    var keyboardUp: Bool

    @MainActor
    init(kind: AppSheet, availH: CGFloat, detent: Int, dy: CGFloat) {
        let screen = PMath.screen
        let kb = availH < screen.height - 100
        keyboardUp = kb
        bottomPad = kb ? 8 : 9
        let maxH = max(220, availH - bottomPad - PMath.safeTop)
        switch kind {
        case .pageMenu: detents = [min(screen.height * 0.5, maxH), maxH]           // .medium, .large
        case .search: detents = [min(screen.height * 0.7, maxH)]                    // .fraction(0.7)
        default: detents = [min(screen.height * 0.5, maxH)]
        }
        let h0 = detents[min(detent, detents.count - 1)]
        let raw = h0 - dy
        let lo = detents[0], hi = detents[detents.count - 1]
        if raw < lo { height = lo; offY = lo - raw }
        else if raw > hi { height = hi + (raw - hi) * 0.15; offY = 0 }
        else { height = raw; offY = 0 }
    }
}

/// Draws the page menu and the search sheet for variants B, C and Reduce Motion (variant A uses the system sheet).
/// Same content views, 38 pt glass corners, drag indicator, scrim, drag-to-dismiss from the top handle, keyboard handling.
struct PageSheetHost: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduce

    @State private var shown: AppSheet?
    @State private var pres = SheetPresentation()
    @State private var p: Double = 0
    @State private var dy: CGFloat = 0
    @State private var detent = 0
    @State private var freshlyMounted = false
    @State private var leaving = false
    @State private var token = 0
    @State private var availH: CGFloat = 0
    @State private var frozenAvail: CGFloat?   // while leaving: the sheet keeps its size when the keyboard goes away
    @State private var scrollProbe = SheetScrollProbe()
    @State private var dragDecision: DragDecision = .undecided

    private enum DragDecision { case undecided, sheet, ignore }

    private var pm: PageMotionState { .shared }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                if let kind = shown {
                    Color.black
                        .ignoresSafeArea()
                        .progressive(p) { c, p in c.opacity(pres.scrim * PMath.clamp(p)) }
                        .onTapGesture { store.sheet = nil }
                    sheetView(kind, avail: CGSize(width: geo.size.width, height: frozenAvail ?? geo.size.height))
                        .onAppear {
                            guard freshlyMounted else { return }
                            freshlyMounted = false
                            animateIn()
                        }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .ignoresSafeArea(.container)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { availH = $0 }
        .allowsHitTesting(shown != nil)
        .onChange(of: store.sheet) { _, new in sync(new) }
    }

    // MARK: pieces

    @ViewBuilder
    private func sheetView(_ kind: AppSheet, avail: CGSize) -> some View {
        let layout = SheetLayout(kind: kind, availH: avail.height, detent: detent, dy: dy)
        let screen = PMath.screen
        let source = pres.source == .chevron
            ? CGPoint(x: screen.width - Layout.edge - Layout.barControl / 2, y: screen.height - Layout.edge - Layout.barControl / 2)
            : CGPoint(x: screen.width / 2, y: screen.height - Layout.edge - Layout.barControl / 2)
        let center = CGPoint(x: screen.width / 2, y: avail.height - layout.bottomPad - layout.offY - layout.height / 2)
        content(kind, layout)
            .progressive(p) { c, p in chrome(c, p, layout, source: source, center: center) }
    }

    /// Everything inside the glass: the content view and the handle. Drag the handle, or any non-scrolled part of the sheet, to move it.
    private func content(_ kind: AppSheet, _ layout: SheetLayout) -> some View {
        ZStack(alignment: .top) {
            Group {
                switch kind {
                case .search(let editing): SearchSheet(editing: editing)
                case .pageMenu: PageMenuSheet()
                default: EmptyView()
                }
            }
            .id(kind.id)
            .transition(.opacity)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .environment(\.sheetScrollProbe, scrollProbe)
            // Drag from ANYWHERE on the sheet, not just the handle: a vertical drag moves the sheet when the content is not
            // scrolled (down: smaller / dismiss, up: taller); otherwise the inner scroll view keeps the gesture.
            .simultaneousGesture(
                DragGesture(minimumDistance: 8, coordinateSpace: .global)
                    .onChanged { v in
                        if dragDecision == .undecided {
                            let vertical = abs(v.translation.height) > abs(v.translation.width) * 1.2
                            let canExpand = layout.detents.count > 1 && detent < layout.detents.count - 1
                            let down = v.translation.height > 0
                            dragDecision = (vertical && scrollProbe.atTop && (down || canExpand)) ? .sheet : .ignore
                        }
                        if dragDecision == .sheet { dy = v.translation.height }
                    }
                    .onEnded { v in
                        defer { dragDecision = .undecided }
                        if dragDecision == .sheet { endDrag(v, layout) }
                    }
            )

            ZStack(alignment: .top) {
                Color.clear.frame(height: 28).contentShape(Rectangle())
                Capsule().fill(.secondary.opacity(0.5)).frame(width: 36, height: 5).padding(.top, 5)
            }
            .gesture(
                DragGesture(minimumDistance: 4, coordinateSpace: .global)
                    .onChanged { v in dy = v.translation.height }
                    .onEnded { v in endDrag(v, layout) }
            )
        }
    }

    /// The glass, the clip, the shadow and the variant's motion for one value of p.
    private func chrome(_ c: AnyView, _ p: Double, _ L: SheetLayout, source: CGPoint, center: CGPoint) -> some View {
        let look = pres.look
        let radius: Double = look == .growC4 ? PMath.lerp(150, 38, PMath.seg(p, 0, 0.8)) : Double(Layout.sheetRadius)

        // Content: variant C reveals it from the top with a soft front (stands in for the 50 ms per-row stagger).
        let q = PMath.seg(p, 0.3, 0.9)
        let inner: AnyView = look == .growC4
            ? AnyView(c.mask(LinearGradient(stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: PMath.clamp(q * 1.4 - 0.4)),
                    .init(color: .clear, location: PMath.clamp(q * 1.4)),
                    .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
                .offset(y: CGFloat(PMath.lerp(14, 0, q))))
            : c

        let glass = inner
            .frame(width: max(0, PMath.screen.width - 2 * L.side), height: L.height)   // fixed width: a long URL in the field must not widen the sheet
            .background { Color.clear.glassEffect(.regular, in: .rect(cornerRadius: radius)) }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .shadow(color: .black.opacity(0.22), radius: 22, y: 8)

        let hide = Double(L.height) + Double(L.bottomPad) + 20   // fully below the screen edge
        let framed: AnyView
        switch look {
        case .fade:
            framed = AnyView(glass.opacity(PMath.clamp(p)))
        case .riseB4, .riseB6:
            framed = AnyView(glass.offset(y: CGFloat(PMath.lerp(hide, 0, p))))
        case .growC4:
            let s = PMath.lerp(0.12, 1, max(0, p))
            framed = AnyView(glass
                .scaleEffect(s)
                .offset(x: CGFloat((1 - s) * (source.x - center.x)), y: CGFloat((1 - s) * (source.y - center.y)))
                .opacity(PMath.seg(p, 0, 0.3)))
        case .popC6:
            let s = PMath.lerp(0.7, 1, p)
            framed = AnyView(glass
                .scaleEffect(s, anchor: .bottom)
                .offset(y: CGFloat(PMath.lerp(60, 0, p)))
                .opacity(PMath.seg(p, 0, 0.5)))
        }
        return framed
            .padding(.horizontal, L.side)
            .padding(.bottom, L.bottomPad)
            .offset(y: L.offY)
    }

    // MARK: present / dismiss

    private func sync(_ new: AppSheet?) {
        guard let new, PageMotion.usesCustomSheet(new, store: store, reduce: reduce) else {
            if shown != nil, !leaving { dismiss() }
            return
        }
        if shown == nil {
            present(new)
        } else if leaving {
            // opened again while the old one was still leaving
            token += 1
            leaving = false
            frozenAvail = nil
            shown = new
            animateIn()
        } else if shown?.id != new.id {
            withAnimation(Motion.smooth(0.25)) { shown = new; detent = 0; dy = 0 }
        } else {
            shown = new
        }
    }

    private func present(_ new: AppSheet) {
        let newTab = PageMotionState.shared.searchIsNewTab && new.id == "search"
        let variant = store.motion(newTab ? .newTab : .sheet)
        pres = SheetPresentation.make(kind: new, newTab: newTab, variant: variant, reduce: reduce)
        p = 0; dy = 0; detent = 0
        leaving = false
        frozenAvail = nil
        freshlyMounted = true
        shown = new
    }

    private func animateIn() {
        token += 1
        leaving = false
        withAnimation(pres.anim) { p = 1; dy = 0 }
        pagePhase(entering: true)
    }

    private func dismiss() {
        token += 1
        let t = token
        leaving = true
        frozenAvail = availH
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        pagePhase(entering: false)
        withAnimation(pres.out, completionCriteria: .logicallyComplete) {
            p = 0; dy = 0
        } completion: {
            if token == t { shown = nil; leaving = false; frozenAvail = nil; detent = 0; dy = 0 }
        }
    }

    /// What happens to the page behind (element 4 B fades the bottom bar, C lets the page recede).
    private func pagePhase(entering: Bool) {
        switch pres.look {
        case .riseB4:
            pm.recede = 0
            let a: Animation = entering ? Motion.easeOut(0.14) : Motion.easeOut(0.12).delay(Motion.scaled(0.12))
            withAnimation(a) { pm.barFade = entering ? 1 : 0 }
        case .growC4:
            // The page used to recede to 95%, which showed the black root behind it around the Dynamic Island and under the
            // bottom bar. The owner wants the background continuous, so the page stays full-bleed and only the scrim dims it.
            pm.recede = 0
        default:
            break
        }
    }

    private func endDrag(_ v: DragGesture.Value, _ L: SheetLayout) {
        let h0 = L.detents[min(detent, L.detents.count - 1)]
        let predicted = h0 - v.predictedEndTranslation.height
        if predicted < L.detents[0] * 0.62 {
            store.sheet = nil          // dismiss() animates the leftover drag away
            return
        }
        let target = L.detents.indices.min { abs(L.detents[$0] - predicted) < abs(L.detents[$1] - predicted) } ?? 0
        withAnimation(Motion.spring(0.3, bounce: 0.1)) { detent = target; dy = 0 }
    }
}

// MARK: - Element 6: the blank tab replaces the page

extension AnyTransition {
    /// The blank tab arriving (insertion). `t`: 1 absent ... 0 present.
    @MainActor
    static func newTabIn(_ v: MotionVariant, reduce: Bool) -> AnyTransition {
        let screen = PMath.screen
        let plus = CGPoint(x: screen.width / 2, y: screen.height - Layout.edge - Layout.barControl / 2)
        return .progressive { c, t in
            let p = 1 - t
            if reduce {
                c.opacity(PMath.clamp(p))
            } else {
                switch v {
                case .a:
                    c.offset(x: CGFloat(70 * (1 - p))).opacity(PMath.seg(p, 0, 0.7))
                case .b:
                    c.scaleEffect(PMath.lerp(0.9, 1, p)).opacity(PMath.seg(p, 0.05, 0.4))
                case .c:
                    // grows out of the plus capsule: scale .12 -> 1 around the capsule, corner 190 -> device corner
                    let s = PMath.lerp(0.12, 1, max(0, p))
                    c.mask(RoundedRectangle(cornerRadius: PMath.lerp(190, Layout.screenRadius, PMath.clamp(p)), style: .continuous).ignoresSafeArea())
                        .scaleEffect(s)
                        .offset(x: CGFloat((1 - s) * (plus.x - screen.width / 2)), y: CGFloat((1 - s) * (plus.y - screen.height / 2)))
                        .opacity(PMath.seg(p, 0, 0.25))
                }
            }
        }
    }

    /// The page leaving (removal). `t`: 1 absent ... 0 present.
    @MainActor
    static func newTabOut(_ v: MotionVariant, reduce: Bool) -> AnyTransition {
        let screen = PMath.screen
        let thumb = CGPoint(x: Layout.edge + Layout.barControl / 2, y: screen.height - Layout.edge - Layout.barControl / 2)
        return .progressive { c, t in
            let p = t
            if reduce {
                c.opacity(1 - PMath.clamp(p))
            } else {
                switch v {
                case .a:
                    c.offset(x: CGFloat(-70 * p)).opacity(1 - PMath.seg(p, 0, 0.8))
                case .b:
                    c.scaleEffect(PMath.lerp(1, 0.86, p)).offset(x: CGFloat(-120 * p)).opacity(1 - PMath.seg(p, 0.05, 0.5))
                case .c:
                    // folds into the tab-stack thumbnail
                    let d = PMath.clamp(p)
                    c.scaleEffect(PMath.lerp(1, 0.07, d))
                        .offset(x: CGFloat(d * (thumb.x - screen.width / 2)), y: CGFloat(d * (thumb.y - screen.height / 2)))
                        .opacity(1 - PMath.seg(p, 0.6, 0.95))
                }
            }
        }
    }
}

extension PageMotion {
    /// Animation for the swap page -> blank tab, picked when the new-tab token changes.
    @MainActor
    static func newTabAnimation(_ v: MotionVariant, reduce: Bool) -> Animation {
        if reduce { return PMath.fade }
        switch v {
        case .a: return Motion.smooth(0.4)
        case .b: return Motion.snappy(0.34, extraBounce: 0.15)
        case .c: return Motion.spring(0.42, bounce: 0.18)
        }
    }
}

// MARK: - Element 10: toast

struct CheckShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        // 24 pt grid from the design page: M5 12.5 l4.5 4.5 L19 7.5
        func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: r.minX + r.width * x / 24, y: r.minY + r.height * y / 24) }
        p.move(to: pt(5, 12.5))
        p.addLine(to: pt(9.5, 17))
        p.addLine(to: pt(19, 7.5))
        return p
    }
}

/// A rounded rect of `visible` width pinned to the leading edge (the toast pill while it unfolds).
struct UnfoldShape: Shape {
    var visible: CGFloat
    var animatableData: CGFloat {
        get { visible }
        set { visible = newValue }
    }
    func path(in r: CGRect) -> Path {
        let w = min(r.width, max(r.height, visible))
        return RoundedRectangle(cornerRadius: r.height / 2, style: .continuous)
            .path(in: CGRect(x: r.minX, y: r.minY, width: w, height: r.height))
    }
}

struct ToastLayer: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduce
    @State private var text: String?
    @State private var p: Double = 0
    @State private var variant: MotionVariant = .a
    @State private var freshlyMounted = false
    @State private var token = 0

    var body: some View {
        ZStack(alignment: .top) {
            if let text {
                ToastPill(text: text, p: p, variant: variant, reduce: reduce)
                    .padding(.top, Layout.gap)
                    .onAppear {
                        guard freshlyMounted else { return }
                        freshlyMounted = false
                        withAnimation(animIn) { p = 1 }
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
        .onChange(of: store.toast) { _, new in sync(new) }
    }

    private var animIn: Animation {
        if reduce { return PMath.fade }
        switch variant {
        case .a: return Motion.smooth(0.28)
        case .b: return Motion.snappy(0.3, extraBounce: 0.2)
        case .c: return Motion.spring(0.4, bounce: 0.2)
        }
    }
    private var animOut: Animation {
        if reduce { return PMath.fade }
        switch variant {
        case .a: return PMath.easeIn(0.22)
        case .b: return PMath.easeIn(0.19, x1: 0.5)
        case .c: return Motion.spring(0.3, bounce: 0)
        }
    }

    private func sync(_ new: String?) {
        token += 1
        let t = token
        if let new {
            if text == nil {
                variant = store.motion(.toast)
                p = 0
                freshlyMounted = true
            }
            text = new
            if !freshlyMounted && p < 1 { withAnimation(animIn) { p = 1 } }
        } else if text != nil {
            withAnimation(animOut, completionCriteria: .logicallyComplete) { p = 0 } completion: {
                if token == t { text = nil }
            }
        }
    }
}

/// "Link copied" and friends: a glass pill with a green check. Drawn from the progress p (Animatable), so the exit can
/// reverse the entrance. Placed at the top (the toast is raised from sheets, which cover the bottom), so the design
/// page's rise from the bar becomes a drop from the top edge.
struct ToastPill: View, Animatable {
    let text: String
    var p: Double
    let variant: MotionVariant
    let reduce: Bool
    @State private var naturalWidth: CGFloat = 150

    var animatableData: Double {
        get { p }
        set { p = newValue }
    }

    private var checkDraw: Double { (variant == .c && !reduce) ? PMath.seg(p, 0.1, 0.5) : 1 }
    private var textOpacity: Double { (variant == .c && !reduce) ? PMath.seg(p, 0.45, 0.9) : 1 }

    private var row: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(Color(hex: 0x34C98E))
                CheckShape().trim(from: 0, to: checkDraw)
                    .stroke(Color(hex: 0x05281B), style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                    .frame(width: 13, height: 13)
            }
            .frame(width: 22, height: 22)
            Text(text).font(.subheadline.weight(.semibold)).lineLimit(1).fixedSize().opacity(textOpacity)
        }
        .padding(.leading, 11)
        .padding(.trailing, 18)
        .frame(height: Layout.control)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { naturalWidth = $0 }
    }

    var body: some View {
        if reduce {
            row.glassEffect(.regular, in: .capsule).opacity(PMath.clamp(p))
        } else {
            switch variant {
            case .a:
                // soft fade-rise: 10 pt from 98%
                row.glassEffect(.regular, in: .capsule)
                    .scaleEffect(PMath.lerp(0.98, 1, p))
                    .offset(y: CGFloat(PMath.lerp(-10, 0, p)))
                    .opacity(PMath.clamp(p))
            case .b:
                // springy drop-in: 34 pt from 80%, opacity done by half way
                row.glassEffect(.regular, in: .capsule)
                    .scaleEffect(PMath.lerp(0.8, 1, p))
                    .offset(y: CGFloat(PMath.lerp(-34, 0, p)))
                    .opacity(PMath.seg(p, 0, 0.5))
            case .c:
                // pill that unfolds: a circle with a check that draws itself, then widens, then the text fades in
                let w = PMath.seg(p, 0.1, 0.8)
                let full = max(naturalWidth, Layout.control)
                let vis = Layout.control + (full - Layout.control) * CGFloat(w)
                let shape = UnfoldShape(visible: vis)
                row.glassEffect(.regular, in: shape)
                    .clipShape(shape)
                    .offset(x: (full - Layout.control) / 2 * CGFloat(1 - w))
                    .scaleEffect(PMath.lerp(0.6, 1, PMath.clamp(p)))
                    .offset(y: CGFloat(PMath.lerp(-24, 0, p)))
                    .opacity(PMath.seg(p, 0, 0.2))
            }
        }
    }
}

// MARK: - Element 7: page-load progress

/// Drives the displayed progress for the selected tab. The design page's curves (start jump, trickle, finish) are played on top
/// of the real `estimatedProgress`: the line shows whichever is further along, never goes backwards, and finishes when the load ends.
@MainActor @Observable
final class LoadDriver {
    var progress = 0.0     // 0...1, animated
    var opacity = 0.0      // line / fill / ring visibility
    var flash = 0.0        // B: glow flash on the plus capsule
    var ripple = 0.0       // C: finish ripple, 0 ... 1
    var spin = 0.0         // C: plus -> cross, 0 ... 1
    var pulse = 0.0        // C: small pulse at the end, 0 ... 1 ... 0

    private(set) var variant: MotionVariant = .a
    private(set) var reduce = false
    @ObservationIgnored private var running = false
    @ObservationIgnored private var floor = 0.0
    @ObservationIgnored private var task: Task<Void, Never>?

    private func jump(_ v: MotionVariant) -> (to: Double, dur: Double, trickleTo: Double, trickleDur: Double) {
        v == .b ? (0.55, 0.25, 0.9, 1.25) : (0.3, 0.2, 0.82, 1.3)
    }

    private func quietly(_ f: () -> Void) {
        var t = Transaction(animation: nil)
        t.disablesAnimations = true
        withTransaction(t, f)
    }

    func reset() {
        task?.cancel()
        running = false
        floor = 0
        quietly { progress = 0; opacity = 0; flash = 0; ripple = 0; spin = 0; pulse = 0 }
    }

    /// Call whenever the tab, its loading flag, its progress, the variant or Reduce Motion changes.
    func sync(loading: Bool, real: Double, variant: MotionVariant, reduce: Bool) {
        if variant != self.variant || reduce != self.reduce {
            if running { reset() }
            self.variant = variant
            self.reduce = reduce
        }
        if loading {
            if !running { start(real: real) } else { bump(to: real, anim: reduce ? PMath.fade : Motion.easeOut(0.25)) }
        } else if running {
            finish()
        }
    }

    private func bump(to x: Double, anim: Animation) {
        guard x > floor else { return }
        floor = x
        withAnimation(anim) { progress = x }
    }

    private func start(real: Double) {
        task?.cancel()
        running = true
        floor = 0
        quietly { progress = 0; flash = 0; ripple = 0; spin = 0; pulse = 0 }
        if reduce {
            withAnimation(PMath.fade) { opacity = 1 }
            bump(to: max(real, 0.1), anim: PMath.fade)
            return
        }
        let j = jump(variant)
        withAnimation(Motion.easeOut(0.1)) { opacity = 1 }
        bump(to: max(j.to, real), anim: PMath.easeOutCubic(j.dur))
        if variant == .c { withAnimation(Motion.easeOut(0.18)) { spin = 1 } }
        task = Task { @MainActor [self] in
            try? await Task.sleep(for: .seconds(Motion.scaled(j.dur)))
            guard !Task.isCancelled else { return }
            bump(to: j.trickleTo, anim: PMath.easeOutCubic(j.trickleDur))
        }
    }

    private func finish() {
        task?.cancel()
        running = false
        floor = 1
        if reduce {
            withAnimation(PMath.fade) { progress = 1 }
            task = Task { @MainActor [self] in
                try? await Task.sleep(for: .seconds(Motion.scaled(0.15)))
                guard !Task.isCancelled else { return }
                withAnimation(PMath.fade) { opacity = 0 }
                try? await Task.sleep(for: .seconds(Motion.scaled(0.15)))
                guard !Task.isCancelled else { return }
                quietly { progress = 0 }
                floor = 0
            }
            return
        }
        withAnimation(PMath.easeOutCubic(0.2)) { progress = 1 }
        task = Task { @MainActor [self] in
            switch variant {
            case .b:
                withAnimation(Motion.easeOut(0.15)) { flash = 1 }
                try? await Task.sleep(for: .seconds(Motion.scaled(0.15)))
                withAnimation(Motion.easeInOut(0.15)) { flash = 0 }
            case .c:
                withAnimation(Motion.easeInOut(0.2)) { spin = 0 }
                withAnimation(Motion.easeOut(0.3)) { ripple = 1 }
                withAnimation(Motion.easeOut(0.125)) { pulse = 1 }
                try? await Task.sleep(for: .seconds(Motion.scaled(0.125)))
                withAnimation(Motion.easeInOut(0.125)) { pulse = 0 }
            default:
                break
            }
            try? await Task.sleep(for: .seconds(Motion.scaled(0.075)))
            guard !Task.isCancelled else { return }
            withAnimation(Motion.easeInOut(0.3)) { opacity = 0 }
            try? await Task.sleep(for: .seconds(Motion.scaled(0.3)))
            guard !Task.isCancelled else { return }
            quietly { progress = 0; ripple = 0 }
            floor = 0
        }
    }
}

enum LoadStyle {
    static let gradient = LinearGradient(colors: [Theme.accent, Theme.accentEnd, Color(hex: 0xFF8FB1)], startPoint: .leading, endPoint: .trailing)
}

/// Element 7 A (also the Reduce Motion version): a 3 pt gradient line along the top of the bar, with a bright head.
struct LoadLine: View {
    let driver: LoadDriver
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let pr = driver.progress
            ZStack(alignment: .topLeading) {
                Capsule().fill(LoadStyle.gradient)
                    .frame(width: max(0.001, w * PMath.clamp(pr)), height: 3)
                if !driver.reduce {
                    Ellipse()
                        .fill(RadialGradient(colors: [.white.opacity(0.95), Color(hex: 0xFF8FB1).opacity(0)], center: .center, startRadius: 0, endRadius: 24))
                        .frame(width: 48, height: 16)
                        .position(x: w * PMath.clamp(pr), y: 1.5)
                        .opacity(1 - PMath.seg(pr, 0.97, 1))
                }
            }
            .opacity(driver.opacity)
        }
        .frame(height: 3)
        .allowsHitTesting(false)
    }
}

/// The SVG-style rounded rect outline: starts after the top-left corner and runs clockwise (so `trim` matches the design page).
struct CapsuleTrace: Shape {
    func path(in r: CGRect) -> Path {
        let rad = r.height / 2
        var p = Path()
        p.move(to: CGPoint(x: r.minX + rad, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - rad, y: r.minY))
        p.addArc(center: CGPoint(x: r.maxX - rad, y: r.midY), radius: rad, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: r.minX + rad, y: r.maxY))
        p.addArc(center: CGPoint(x: r.minX + rad, y: r.midY), radius: rad, startAngle: .degrees(90), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

// MARK: - Element 11: find bar replacing the bottom bar

/// The find bar's takeover, as the bottom bar sees it (element 11 B moves the stack thumbnail, the plus and the chevron).
struct FindFX {
    var p: Double = 0
    var variant: MotionVariant = .a
    var reduce = false
    var active: Bool { p > 0 }
}

/// A rounded rect centred in the bounds whose width goes from `minWidth` to the full width as `reveal` goes 0 -> 1.
struct FindRevealShape: Shape {
    var reveal: Double
    var minWidth: CGFloat
    var animatableData: Double {
        get { reveal }
        set { reveal = newValue }
    }
    func path(in r: CGRect) -> Path {
        // fully revealed: clip nothing (glass edges and press effects may reach past the bounds)
        if reveal >= 0.999 { return Path(r.insetBy(dx: -60, dy: -60)) }
        let w = min(r.width, max(minWidth, minWidth + (r.width - minWidth) * CGFloat(max(0, reveal))))
        return RoundedRectangle(cornerRadius: r.height / 2, style: .continuous)
            .path(in: CGRect(x: r.midX - w / 2, y: r.minY, width: w, height: r.height))
    }
}

/// Holds the bottom bar and the find bar and moves between them with one animated number (0 = bottom bar, 1 = find bar).
struct FindSwap: View, Animatable {
    @Environment(BrowserStore.self) private var store
    var p: Double
    let variant: MotionVariant
    let reduce: Bool
    /// How far the find bar sits too low because the keyboard covers the bottom of the page (see BrowserPage).
    var lift: CGFloat = 0
    /// Variant C: the lift is ridden with p (the bar rises with the spring) instead of following the keyboard.
    var rides = false

    var animatableData: Double {
        get { p }
        set { p = newValue }
    }

    private var pm: PageMotionState { .shared }

    var body: some View {
        let fx = FindFX(p: p, variant: variant, reduce: reduce)
        ZStack(alignment: .bottom) {
            if p < 0.999 {
                barLayer(fx)
            }
            if p > 0.001, let tab = store.selectedTab {
                findLayer(tab)
            }
        }
    }

    @ViewBuilder
    private func barLayer(_ fx: FindFX) -> some View {
        let bar = BottomBar(find: fx)
            .opacity(1 - pm.barFade)
            .allowsHitTesting(p < 0.05)
        if reduce {
            bar.opacity(1 - PMath.clamp(p))
        } else {
            switch variant {
            case .a: bar.opacity(1 - PMath.seg(p, 0, 0.45)).offset(y: CGFloat(12 * PMath.clamp(p)))
            case .b: bar.opacity(1 - PMath.seg(p, 0.4, 0.9))
            case .c: bar.opacity(1 - PMath.seg(p, 0, 0.5)).offset(y: CGFloat(80 * PMath.clamp(p)))
            }
        }
    }

    private var liftOffset: CGFloat { -(rides ? lift * CGFloat(p) : lift) }

    @ViewBuilder
    private func findLayer(_ tab: Tab) -> some View {
        findStyled(tab).offset(y: liftOffset)
    }

    @ViewBuilder
    private func findStyled(_ tab: Tab) -> some View {
        if reduce {
            FindBar(tab: tab).opacity(PMath.clamp(p)).allowsHitTesting(p > 0.6)
        } else {
            switch variant {
            case .a:
                FindBar(tab: tab)
                    .offset(y: CGFloat(PMath.lerp(12, 0, p)))
                    .opacity(PMath.seg(p, 0.25, 1))
                    .allowsHitTesting(p > 0.6)
            case .b:
                FindBar(tab: tab, reveal: min(p, 1.04), content: PMath.seg(p, 0.3, 0.8))
                    .opacity(PMath.seg(p, 0, 0.1))
                    .allowsHitTesting(p > 0.6)
            case .c:
                FindBar(tab: tab, reveal: PMath.seg(p, 0, 0.5), content: PMath.seg(p, 0.3, 0.7))
                    .opacity(PMath.seg(p, 0, 0.1))
                    .allowsHitTesting(p > 0.6)
            }
        }
    }
}
