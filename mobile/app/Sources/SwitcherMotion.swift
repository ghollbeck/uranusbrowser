import SwiftUI
import UIKit

// MARK: - Switcher motion: elements 1 (open/close), 2 (swipe a card up), 3 (carousel), 8 (Space), 9 (private)
//
// Spec: design/animations.html. Every number below comes from the `v1A` ... `v9C` objects there. The design page
// drives each moment with one progress value p and writes styles from it; the same idea is used here: a progress
// value is animated with the variant's SwiftUI animation (spring / bezier from `Motion`, so Slow motion works) and
// small pure functions turn it into scale / offset / opacity.
//
// Reduce Motion: every variant collapses to a plain 0.15 s cross-fade (no scale, offset, rotation).

// MARK: - Math (the page's clamp / lerp / seg)

enum Mix {
    static func clamp(_ x: CGFloat, _ lo: CGFloat = 0, _ hi: CGFloat = 1) -> CGFloat { min(hi, max(lo, x)) }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }
    /// 0 before `a`, 1 after `b`, linear in between.
    static func seg(_ p: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat { clamp((p - a) / (b - a)) }
}

// MARK: - Variants in use

struct SwitcherStyle: Equatable {
    var open = MotionVariant.a
    var swipe = MotionVariant.a
    var carousel = MotionVariant.a
    var space = MotionVariant.a
    var priv = MotionVariant.a
    var reduce = false
}

extension BrowserStore {
    func switcherStyle(reduce: Bool) -> SwitcherStyle {
        SwitcherStyle(open: motion(.switcher), swipe: motion(.cardClose), carousel: motion(.carousel),
                      space: motion(.space), priv: motion(.privateToggle), reduce: reduce)
    }
}

// MARK: - Animations (all go through `Motion`, so the Slow motion switch scales them)

@MainActor
enum SwitcherAnim {
    private static func plain() -> Animation { Motion.easeOut(0.15) }

    // 1. Open / close
    static func present(_ s: SwitcherStyle) -> Animation {
        if s.reduce { return plain() }
        switch s.open {
        case .a: return Motion.easeOut(0.34)                    // .smooth(0.34), cubic-bezier(.22,.8,.2,1)
        case .b: return Motion.spring(0.3, bounce: 0.3)         // .snappy(0.3, extraBounce: 0.15)
        case .c: return Motion.spring(0.4, bounce: 0.22)
        }
    }
    static func dismiss(_ s: SwitcherStyle) -> Animation {
        if s.reduce { return plain() }
        switch s.open {
        case .a: return Motion.easeInOut(0.28)                  // cubic-bezier(.4,0,.2,1)
        case .b: return Motion.spring(0.26, bounce: 0.1)
        case .c: return Motion.spring(0.34, bounce: 0)
        }
    }

    // 2. Swipe a card up
    /// Release distance. The page uses 100 / 80 / 90 pt.
    static func commitDistance(_ s: SwitcherStyle) -> CGFloat {
        switch s.swipe { case .a: 100; case .b: 80; case .c: 90 }
    }
    static func swipeBack(_ s: SwitcherStyle) -> Animation {
        if s.reduce { return plain() }
        switch s.swipe {
        case .a: return Motion.easeOut(0.3)
        case .b: return Motion.spring(0.3, bounce: 0.35)
        case .c: return Motion.spring(0.38, bounce: 0.4)
        }
    }
    /// The neighbours closing the gap.
    static func swipeGap(_ s: SwitcherStyle) -> Animation {
        if s.reduce { return plain() }
        switch s.swipe {
        case .a: return Motion.smooth(0.4)
        case .b: return Motion.spring(0.3, bounce: 0.3)         // .snappy(0.3, extraBounce: 0.15)
        case .c: return Motion.spring(0.4, bounce: 0.28)
        }
    }
    static func gapSeconds(_ s: SwitcherStyle) -> Double {
        if s.reduce { return Motion.scaled(0.15) }
        switch s.swipe { case .a: return Motion.scaled(0.4 * 1.6); case .b: return Motion.scaled(0.3 * 1.6); case .c: return Motion.scaled(0.4 * 1.6) }
    }
    /// The page starts the gap this long after the release (60 / 30 / 0 ms).
    static func gapDelay(_ s: SwitcherStyle) -> Double {
        if s.reduce { return 0 }
        switch s.swipe { case .a: return Motion.scaled(0.06); case .b: return Motion.scaled(0.03); case .c: return 0 }
    }
    /// Fly-off: A is a 260 ms ease-in, B and C are springs that start with the finger's release velocity.
    static func swipeFly(_ s: SwitcherStyle, velocity: CGFloat, distance: CGFloat) -> Animation {
        if s.reduce { return plain() }
        switch s.swipe {
        case .a: return .timingCurve(0.32, 0, 0.67, 0, duration: Motion.scaled(0.26))
        case .b: return velocitySpring(0.26, bounce: 0, velocity: velocity, distance: distance)
        case .c: return velocitySpring(0.3, bounce: 0, velocity: velocity, distance: distance)
        }
    }
    static func flySeconds(_ s: SwitcherStyle) -> Double {
        if s.reduce { return Motion.scaled(0.15) }
        switch s.swipe { case .a: return Motion.scaled(0.26); case .b: return Motion.scaled(0.26 * 1.6); case .c: return Motion.scaled(0.3 * 1.6) }
    }
    /// `.spring(duration:bounce:)` that keeps the release velocity (SwiftUI's own spring cannot take one).
    private static func velocitySpring(_ d: Double, bounce: Double, velocity: CGFloat, distance: CGFloat) -> Animation {
        let w = 2 * Double.pi / Motion.scaled(d)
        let zeta = max(0.05, 1 - bounce)
        let v = distance == 0 ? 0 : max(-30, min(30, Double(velocity / distance)))
        return .interpolatingSpring(mass: 1, stiffness: w * w, damping: 2 * zeta * w, initialVelocity: v)
    }

    // 8 / 9. Look changes
    static func space(_ s: SwitcherStyle) -> Animation {
        if s.reduce { return plain() }
        switch s.space {
        case .a: return Motion.easeInOut(0.38)
        case .b: return Motion.spring(0.32, bounce: 0.28)       // .snappy(0.32, extraBounce: 0.13)
        case .c: return Motion.spring(0.4, bounce: 0.18)
        }
    }
    static func priv(_ s: SwitcherStyle) -> Animation {
        if s.reduce { return plain() }
        switch s.priv {
        case .a: return Motion.easeInOut(0.36)
        case .b: return Motion.spring(0.32, bounce: 0.35)
        case .c: return Motion.spring(0.4, bounce: 0.15)
        }
    }
    /// How long until a look change is visually done (seconds, slow-motion scaled), for the pause before the switcher closes.
    static func lookSeconds(_ s: SwitcherStyle, kind: LookKind) -> Double {
        if s.reduce { return Motion.scaled(0.15) }
        switch kind {
        case .space: switch s.space { case .a: return Motion.scaled(0.38); case .b: return Motion.scaled(0.45); case .c: return Motion.scaled(0.55) }
        case .priv, .none: switch s.priv { case .a: return Motion.scaled(0.36); case .b: return Motion.scaled(0.45); case .c: return Motion.scaled(0.55) }
        }
    }
}

// MARK: - Shared model and environment

/// Geometry the layer needs from the cards (not observable on purpose: it is read while animating, never drives a redraw).
final class SwitcherModel {
    var frames: [UUID: CGRect] = [:]       // global frame of each card's page area
    var focusID: UUID?                     // the centred card
    var closingRect: CGRect?               // the card tapped to leave the switcher
    var initialFocus: UUID?

    func rect(width W: CGFloat, height H: CGFloat, top: CGFloat, closing: Bool) -> CGRect {
        if closing, let r = closingRect, r.width > 1 { return r }
        if let id = focusID, let r = frames[id], r.width > 1 { return r }
        let cw = W * 0.74
        let ch = min((H - top) * 0.58, cw * 1.85)
        return CGRect(x: (W - cw) / 2, y: top + Layout.gap + Layout.control + 40, width: cw, height: ch)
    }
}

enum LookKind: Equatable { case none, space, priv }
enum LookLayer { case live, ghost }

/// The scalar facts about a running look change (cheap to compare, so the environment only changes at its start and end).
struct LookStatic: Equatable {
    var kind: LookKind = .none
    var dir: CGFloat = 1            // +1 forward through the Spaces, -1 backward
    var entering = false            // private: going into Private
    var fromPrivate = false         // Space: the old look was Private
}

/// What the switcher showed before a Space / Private change, so the old cards can leave while the new ones arrive.
struct LookInfo {
    var token = UUID()
    var kind: LookKind
    var dir: CGFloat
    var entering: Bool
    var fromName: String
    var fromPalette: SpacePalette
    var fromPrivate: Bool
    var fromTabs: [Tab]
    var fromFocusID: UUID?
    var statics: LookStatic { LookStatic(kind: kind, dir: dir, entering: entering, fromPrivate: fromPrivate) }
}

private struct OpenPKey: EnvironmentKey { static let defaultValue: CGFloat = 1 }
private struct LookPKey: EnvironmentKey { static let defaultValue: CGFloat = 1 }
private struct LookKey: EnvironmentKey { static let defaultValue = LookStatic() }
private struct ModelKey: EnvironmentKey { static var defaultValue: SwitcherModel { SwitcherModel() } }

extension EnvironmentValues {
    /// Element 1 progress: 0 = the page, 1 = the switcher.
    var switcherOpenP: CGFloat { get { self[OpenPKey.self] } set { self[OpenPKey.self] = newValue } }
    /// Elements 8 / 9 progress of the running look change (1 = settled).
    var switcherLookP: CGFloat { get { self[LookPKey.self] } set { self[LookPKey.self] = newValue } }
    var switcherLook: LookStatic { get { self[LookKey.self] } set { self[LookKey.self] = newValue } }
    var switcherModel: SwitcherModel { get { self[ModelKey.self] } set { self[ModelKey.self] = newValue } }
}

/// Publishes an animated number through the environment. Only the views that read the key are redrawn each frame.
struct EnvProgress<Content: View>: View, Animatable {
    var value: CGFloat
    let key: WritableKeyPath<EnvironmentValues, CGFloat>
    let content: Content
    var animatableData: CGFloat {
        get { value }
        set { value = newValue }
    }
    var body: some View { content.environment(key, value) }
}

// MARK: - Layer: hosts the switcher in RootView (element 1)

struct SwitcherLayer: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var mounted = false
    @State private var p: CGFloat = 0                    // 0 = page, 1 = switcher
    @State private var model = SwitcherModel()
    @State private var openedSpace: UUID?
    @State private var openedPrivate = false
    @State private var closeTask: Task<Void, Never>?

    private var style: SwitcherStyle { store.switcherStyle(reduce: reduceMotion) }

    var body: some View {
        ZStack {
            if mounted {
                SwitcherStage(p: p, initialFocus: model.initialFocus)
                    .environment(\.switcherModel, model)
                    .allowsHitTesting(store.showSwitcher)
                    .onAppear {
                        guard store.showSwitcher else { return }
                        withAnimation(SwitcherAnim.present(style)) { p = 1 }
                    }
            }
        }
        .onChange(of: store.showSwitcher) { _, show in
            if show { open() } else { close() }
        }
        // While the switcher stays open it animates a Space / Private change itself; remember what it shows now.
        .onChange(of: store.currentSpaceID) { _, id in if store.showSwitcher { openedSpace = id } }
        .onChange(of: store.isPrivate) { _, on in if store.showSwitcher { openedPrivate = on } }
    }

    private func open() {
        closeTask?.cancel()
        openedSpace = store.currentSpaceID
        openedPrivate = store.isPrivate
        model.closingRect = nil
        if mounted {
            withAnimation(SwitcherAnim.present(style)) { p = 1 }
        } else {
            model.initialFocus = store.selectedTab?.id
            model.focusID = model.initialFocus
            p = 0
            mounted = true          // the stage starts the animation in onAppear (it must be drawn once at p = 0)
        }
    }

    private func close() {
        closeTask?.cancel()
        // Picking a Space (or leaving Private) closes the switcher in the same instant it changes. Keep it on screen
        // until that change has played, so it can be seen.
        let kind: LookKind = store.currentSpaceID != openedSpace ? .space : (store.isPrivate != openedPrivate ? .priv : .none)
        let hold = kind == .none ? 0 : SwitcherAnim.lookSeconds(style, kind: kind) + Motion.scaled(0.1)
        let run = {
            withAnimation(SwitcherAnim.dismiss(style), completionCriteria: .logicallyComplete) {
                p = 0
            } completion: {
                if !store.showSwitcher { mounted = false }
            }
        }
        if hold == 0 { run() } else {
            closeTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(hold))
                if !Task.isCancelled, !store.showSwitcher { run() }
            }
        }
    }
}

/// Switcher plus the stand-in for the page. `p` is animatable, the switcher's parts read it from the environment.
struct SwitcherStage: View, Animatable {
    var p: CGFloat
    let initialFocus: UUID?
    var animatableData: CGFloat {
        get { p }
        set { p = newValue }
    }

    var body: some View {
        ZStack {
            TabSwitcher(initialFocus: initialFocus).environment(\.switcherOpenP, p)
            if p < 0.999 { PageStandIn(p: p) }
        }
    }
}

// MARK: - The page, as a picture, above the switcher

/// The page is a WKWebView and cannot be morphed, so a snapshot of it (or the new-tab page) stands in for it while the
/// switcher opens and closes. The real bottom bar is drawn again on top so it can fade like the page's.
struct PageStandIn: View {
    let p: CGFloat
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherModel) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let style = store.switcherStyle(reduce: reduceMotion)
        ZStack {
            GeometryReader { g in
                let W = g.size.width, H = g.size.height, top = g.safeAreaInsets.top
                let fx = PageFX(style: style, p: p, W: W, H: H,
                                rect: model.rect(width: W, height: H, top: top, closing: !store.showSwitcher))
                page(W: W, H: H, top: top, bottom: g.safeAreaInsets.bottom)
                    .clipShape(PageClip(bottomInset: fx.clipBottom, radius: fx.radius))
                    .scaleEffect(fx.scale, anchor: fx.anchor)
                    .offset(x: fx.dx, y: fx.dy)
                    .opacity(fx.opacity)
                    .frame(width: W, height: H, alignment: .topLeading)
                    .overlay(alignment: .bottom) { barBox(fx) }
            }
            .ignoresSafeArea()
        }
        .allowsHitTesting(false)
    }

    /// The real bottom bar (hit testing is off), placed in the safe area exactly like `BrowserPage` does.
    @ViewBuilder private func barBox(_ fx: PageFX) -> some View {
        if !store.findActive, !store.editingPill {
            BottomBar()
                .opacity(fx.barOpacity)
                .offset(y: fx.barY)
        }
    }

    @ViewBuilder private func page(W: CGFloat, H: CGFloat, top: CGFloat, bottom: CGFloat) -> some View {
        ZStack(alignment: .top) {
            if let tab = store.selectedTab {
                if tab.isBlank {
                    NewTabView().safeAreaPadding(.top, top).safeAreaPadding(.bottom, bottom)
                } else {
                    if let s = tab.snapshot {
                        Image(uiImage: s).resizable().scaledToFill()
                            .frame(width: W, height: H, alignment: .top).clipped()
                    } else {
                        Color(.systemBackground)
                    }
                    if store.topStyle == .blur {
                        TopBlur(height: top + 10, tint: tab.topTint, luma: tab.topLuma)
                    }
                }
            } else {
                Color(.systemBackground)
            }
        }
        .frame(width: W, height: H)
        .background(Color(.systemBackground))
    }
}

/// How the stand-in page and the real bar look at progress p (element 1).
struct PageFX {
    var scale: CGFloat = 1
    var anchor: UnitPoint = .center
    var dx: CGFloat = 0
    var dy: CGFloat = 0
    var opacity: CGFloat = 1
    var clipBottom: CGFloat = 0
    var radius: CGFloat = Layout.screenRadius
    var barOpacity: CGFloat = 1
    var barY: CGFloat = 0

    init(style: SwitcherStyle, p: CGFloat, W: CGFloat, H: CGFloat, rect: CGRect) {
        if style.reduce {
            opacity = 1 - Mix.clamp(p)
            barOpacity = opacity
            return
        }
        let end = max(0.3, rect.width / W)              // the card's width as a fraction of the screen: 0.74
        switch style.open {
        case .a:    // page shrinks to 93% and fades, bar fades fast
            scale = Mix.lerp(1, 0.93, p)
            opacity = 1 - Mix.seg(p, 0.1, 0.8)
            barOpacity = 1 - Mix.seg(p, 0, 0.35)
        case .b:    // page scales to card size with a little overshoot, bar slides away
            scale = Mix.lerp(1, end, p)
            opacity = 1 - Mix.seg(p, 0.55, 0.95)
            barOpacity = 1 - Mix.seg(p, 0, 0.3)
            barY = Mix.lerp(0, 16, Mix.clamp(p))
        case .c:    // page becomes the centre card: position, size and corner (62 to 30 pt)
            anchor = .topLeading
            scale = Mix.lerp(1, end, p)
            dx = rect.minX * p
            dy = rect.minY * p
            clipBottom = (H - rect.height / end) * p
            radius = Mix.lerp(Layout.screenRadius, 30 / end, p)
            opacity = 1 - Mix.seg(p, 0.9, 1)
            barOpacity = 1 - Mix.seg(p, 0, 0.25)
        }
    }
}

/// Rounded rectangle whose bottom edge can be pulled up (the page's `clip-path: inset(0 0 x 0 round r)`).
struct PageClip: Shape {
    var bottomInset: CGFloat
    var radius: CGFloat
    func path(in rect: CGRect) -> Path {
        var r = rect
        r.size.height = max(0, rect.height - bottomInset)
        return Path(roundedRect: r, cornerRadius: max(0, radius), style: .continuous)
    }
}

// MARK: - Element 1: how the switcher's own parts react while it opens or closes

struct SwitcherPart: ViewModifier {
    enum Kind { case backdrop, carousel, topBar, bottomBar }
    let kind: Kind
    let style: SwitcherStyle
    @Environment(\.switcherOpenP) private var p

    func body(content: Content) -> some View {
        let f = fx
        content.scaleEffect(f.scale).offset(y: f.y).opacity(f.opacity)
    }

    private var fx: (scale: CGFloat, y: CGFloat, opacity: CGFloat) {
        if style.reduce { return (1, 0, 1) }
        switch (style.open, kind) {
        case (.a, .carousel): return (Mix.lerp(1.07, 1, p), 0, Mix.seg(p, 0.2, 1))      // cards settle in from 107%
        case (.a, .topBar), (.a, .bottomBar): return (1, 0, Mix.seg(p, 0.3, 1))
        case (.b, .topBar): return (1, Mix.lerp(-24, 0, p), Mix.seg(p, 0, 0.6))
        case (.b, .bottomBar): return (1, Mix.lerp(24, 0, p), Mix.seg(p, 0, 0.6))
        case (.c, .topBar): return (1, Mix.lerp(-30, 0, p), Mix.seg(p, 0.4, 1))
        case (.c, .bottomBar): return (1, Mix.lerp(30, 0, p), Mix.seg(p, 0.4, 1))
        case (.c, .backdrop): return (Mix.lerp(1.15, 1, Mix.clamp(p)), 0, 1)             // backdrop settles from 115%
        default: return (1, 0, 1)
        }
    }
}

/// A card while the switcher opens: B slides the side cards out from behind the centre card, C raises them with depth.
struct CardOpenEffect: ViewModifier {
    let rel: Int            // index distance from the centre card
    let pitch: CGFloat      // distance between card centres
    let style: SwitcherStyle
    @Environment(\.switcherOpenP) private var p

    func body(content: Content) -> some View {
        let f = fx
        content
            .scaleEffect(f.scale)
            .rotation3DEffect(.degrees(f.ry), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
            .offset(x: f.dx)
            .opacity(f.opacity)
    }

    private var fx: (scale: CGFloat, ry: Double, dx: CGFloat, opacity: CGFloat) {
        if style.reduce || rel == 0 || p >= 1 { return (1, 0, 0, 1) }
        let r = CGFloat(rel)
        switch style.open {
        case .a: return (1, 0, 0, 1)
        case .b:
            let e = max(0, p)
            return (Mix.lerp(0.85, 1, e), 0, r * pitch * (Mix.lerp(0.45, 1, e) - 1), Mix.seg(p, 0, 0.5))
        case .c:
            let e = max(0, (p - 0.15) / 0.85)
            return (Mix.lerp(0.78, 1, e), Double(-r * Mix.lerp(35, 0, Mix.clamp(e))),
                    r * pitch * (Mix.lerp(0.35, 1, e) - 1), Mix.seg(p, 0.1, 0.6))
        }
    }
}

/// The title row of the centre card (C fades it in during the morph).
struct HeaderOpenFade: ViewModifier {
    let isFocused: Bool
    let style: SwitcherStyle
    @Environment(\.switcherOpenP) private var p
    func body(content: Content) -> some View {
        content.opacity(style.open == .c && !style.reduce && isFocused ? Mix.seg(p, 0.5, 1) : 1)
    }
}

// MARK: - Element 3: carousel

struct CarouselFX: Equatable {
    var variant: MotionVariant
    var reduce: Bool

    struct Values {
        var scale: CGFloat = 1
        var dx: CGFloat = 0
        var dy: CGFloat = 0
        var opacity: CGFloat = 1
        var ry: Double = 0
        var anchorX: CGFloat = 0.5
        var titles: CGFloat = 1       // opacity of the title row
        var dim: CGFloat = 0          // black over the page area
    }

    /// `pos` = distance from the centre in card pitches (0 = centred card, 1 = the next one).
    func values(pos: CGFloat) -> Values {
        var v = Values()
        let a = min(abs(pos), 1.6)
        if reduce {
            v.opacity = 1 - 0.3 * a
            return v
        }
        switch variant {
        case .a:    // flat and quiet: 93% and 70%
            v.scale = 1 - 0.07 * a
            v.opacity = 1 - 0.3 * a
        case .b:    // lively: 90%, 14 pt lower, titles fade on the sides
            v.scale = 1 - 0.1 * a
            v.dy = 14 * a
            v.opacity = 1 - 0.16 * a
            v.titles = Mix.clamp(1 - 0.6 * a)
        case .c:    // cover flow: tilt up to 28 degrees around the inner edge, overlap 30 pt, dim by 50%
            v.anchorX = 0.5 - 0.5 * Mix.clamp(pos, -1, 1)
            v.dx = -30 * pos
            v.scale = 1 - 0.1 * min(a, 1)
            v.ry = Double(Mix.clamp(-pos * 28, -42, 42))
            v.opacity = 1 - 0.15 * a
            v.dim = 0.5 * Mix.clamp(a)
        }
        return v
    }
}

/// Element 3 on the cards of the live scroll view: reads each card's position in the scroll view while it moves.
struct CarouselScrollEffect: ViewModifier {
    let fx: CarouselFX
    let viewportW: CGFloat
    let pitch: CGFloat
    /// True while this (centred) card is being swiped up or closed: it keeps the centre look instead of following the layout.
    var frozen = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if frozen {
            content.modifier(CarouselFixedEffect(fx: fx, pos: 0))
        } else {
            scrolling(content)
        }
    }

    private func scrolling(_ content: Content) -> some View {
        let fx = fx, vw = viewportW, pitch = pitch
        return content.visualEffect { c, proxy in
            let pos = (proxy.frame(in: .global).midX - vw / 2) / pitch
            let v = fx.values(pos: pos)
            let anchor = UnitPoint(x: v.anchorX, y: 0.5)
            return c.scaleEffect(v.scale, anchor: anchor)
                .rotation3DEffect(.degrees(v.ry), axis: (x: 0, y: 1, z: 0), anchor: anchor, perspective: 0.5)
                .offset(x: v.dx, y: v.dy)
                .opacity(v.opacity)
        }
    }
}

/// The same look for a card that is not in the scroll view (the ghost of the old cards): its position is known.
struct CarouselFixedEffect: ViewModifier {
    let fx: CarouselFX
    let pos: CGFloat
    func body(content: Content) -> some View {
        let v = fx.values(pos: pos)
        let anchor = UnitPoint(x: v.anchorX, y: 0.5)
        content
            .scaleEffect(v.scale, anchor: anchor)
            .rotation3DEffect(.degrees(v.ry), axis: (x: 0, y: 1, z: 0), anchor: anchor, perspective: 0.5)
            .offset(x: v.dx, y: v.dy)
            .opacity(v.opacity)
    }
}

/// Title row and dim of a card, driven by the carousel position (B fades titles on the sides, C dims the sides).
struct CarouselCardPart: ViewModifier {
    enum Part { case titles, dim }
    let part: Part
    let fx: CarouselFX
    let viewportW: CGFloat
    let pitch: CGFloat
    let fixedPos: CGFloat?

    func body(content: Content) -> some View {
        if let pos = fixedPos {
            content.opacity(value(fx.values(pos: pos)))
        } else {
            let fx = fx, vw = viewportW, pitch = pitch, part = part
            content.visualEffect { c, proxy in
                let pos = (proxy.frame(in: .global).midX - vw / 2) / pitch
                let v = fx.values(pos: pos)
                return c.opacity(part == .titles ? v.titles : v.dim)
            }
        }
    }
    private func value(_ v: CarouselFX.Values) -> CGFloat { part == .titles ? v.titles : v.dim }
}

// MARK: - Elements 8 and 9: a Space or Private change

/// Facts and numbers for the cards, backdrop, chip and eyes button while the look changes. Space changes run with
/// the Space pick's variant, Private changes with the Private pick's variant (`q` is the 0...1 progress of the change).
enum LookFX {
    struct CardFX { var x: CGFloat = 0, y: CGFloat = 0, scale: CGFloat = 1, opacity: CGFloat = 1 }

    /// How private the look is: 0 normal, 1 Private. During a Private change it follows the animation.
    static func privAmount(_ ls: LookStatic, q: CGFloat, isPrivate: Bool, layer: LookLayer) -> CGFloat {
        switch ls.kind {
        case .priv: return ls.entering ? q : 1 - q
        case .space: return layer == .ghost ? (ls.fromPrivate ? 1 : 0) : (isPrivate ? 1 : 0)
        case .none: return isPrivate ? 1 : 0
        }
    }

    static func card(layer: LookLayer, slot: Int, ls: LookStatic, q: CGFloat, travel: CGFloat, style: SwitcherStyle) -> CardFX {
        var f = CardFX()
        let live = layer == .live
        switch ls.kind {
        case .none: return f
        case .priv:
            let t = Mix.clamp(q)        // progress toward the new look, whichever way Private is going
            f.opacity = live ? t : 1 - t
        case .space:
            if style.reduce { f.opacity = live ? Mix.clamp(q) : 1 - Mix.clamp(q); return f }
            let i = CGFloat(slot)
            switch style.space {
            case .a:    // old cards ease to 97% and fade, new ones ease in from 103%
                if live { f.opacity = Mix.clamp(q); f.scale = Mix.lerp(1.03, 1, q) }
                else { f.opacity = 1 - Mix.clamp(q); f.scale = Mix.lerp(1, 0.97, q) }
            case .b:    // card sets slide a full screen width (a little more with many tabs, so no card is left behind)
                f.x = live ? travel * (1 - q) * ls.dir : -travel * q * ls.dir
            case .c:    // old cards fall away one by one, new ones rise with a stagger
                if live {
                    let k = max(0, (q - 0.25 - i * 0.09) / 0.6)
                    f.y = Mix.lerp(40, 0, min(k, 1)); f.scale = Mix.lerp(0.78, 1, k)
                    f.opacity = Mix.seg(q, 0.2 + i * 0.09, 0.6 + i * 0.09)
                } else {
                    let k = Mix.seg(q, i * 0.08, 0.55 + i * 0.08)
                    f.y = Mix.lerp(0, 20, k); f.scale = Mix.lerp(1, 0.88, k); f.opacity = 1 - k
                }
            }
        }
        return f
    }

    /// Dim over the page area of every card (9: A 40%, B 45%, C 25%).
    static func privDim(_ pa: CGFloat, style: SwitcherStyle) -> CGFloat {
        if style.reduce { return 0.4 * Mix.clamp(pa) }
        switch style.priv {
        case .a: return 0.4 * Mix.clamp(pa)
        case .b: return 0.45 * Mix.clamp(pa)
        case .c: return 0.25 * Mix.clamp(pa)
        }
    }

    /// The whole card row: B nudges down to 97%, C turns grey and shrinks to 94%.
    static func row(_ pa: CGFloat, style: SwitcherStyle) -> (scale: CGFloat, gray: CGFloat) {
        if style.reduce { return (1, 0) }
        switch style.priv {
        case .a: return (1, 0)
        case .b: return (Mix.lerp(1, 0.97, pa), 0)
        case .c: return (Mix.lerp(1, 0.94, pa), Mix.clamp(pa))
        }
    }

    // MARK: Backdrop

    enum Reveal { case all, left(CGFloat), circle(CGPoint, CGFloat) }
    struct BackdropFX {
        var base: SpacePalette
        var top: SpacePalette?
        var topOpacity: CGFloat = 1
        var reveal: Reveal = .all
        var vignette: CGFloat = 0
    }

    @MainActor static func backdrop(ls: LookStatic, info: LookInfo?, q: CGFloat, store: BrowserStore, style: SwitcherStyle,
                         W: CGFloat, chip: CGPoint, eyes: CGPoint) -> BackdropFX {
        let current = store.palette
        switch ls.kind {
        case .space:
            guard let info else { return BackdropFX(base: current) }
            let old = info.fromPalette
            if style.reduce { return BackdropFX(base: old, top: current, topOpacity: Mix.clamp(q)) }
            switch style.space {
            case .a: return BackdropFX(base: old, top: current, topOpacity: Mix.clamp(q))
            case .b:
                // New backdrop wipes in from the left (right on the way back).
                if ls.dir >= 0 { return BackdropFX(base: old, top: current, reveal: .left(Mix.clamp(q) * W)) }
                return BackdropFX(base: current, top: old, reveal: .left(Mix.clamp(1 - q) * W))
            case .c:
                return BackdropFX(base: old, top: current, reveal: .circle(chip, Mix.lerp(0, 900, Mix.clamp(q))))
            }
        case .priv, .none:
            let pa = privAmount(ls, q: q, isPrivate: store.isPrivate, layer: .live)
            let normal = store.currentSpace.palette
            if ls.kind == .none { return BackdropFX(base: current, vignette: vignette(pa, style)) }
            if style.reduce { return BackdropFX(base: normal, top: .graphite, topOpacity: Mix.clamp(pa)) }
            switch style.priv {
            case .a: return BackdropFX(base: normal, top: .graphite, topOpacity: Mix.clamp(pa))
            case .b: return BackdropFX(base: normal, top: .graphite, topOpacity: Mix.seg(pa, 0, 0.75))
            case .c:
                return BackdropFX(base: normal, top: .graphite, reveal: .circle(eyes, Mix.lerp(0, 1000, Mix.clamp(pa))),
                                  vignette: vignette(pa, style))
            }
        }
    }

    static func vignette(_ pa: CGFloat, _ style: SwitcherStyle) -> CGFloat {
        (!style.reduce && style.priv == .c) ? 0.9 * Mix.seg(pa, 0.2, 1) : 0
    }

    // MARK: Chip (Space name and dot) and eyes button

    struct ChipFX {
        var n0: CGFloat = 1, n1: CGFloat = 0        // old / new name opacity
        var n0y: CGFloat = 0, n1y: CGFloat = 0
        var d0: CGFloat = 1, d1: CGFloat = 0        // old / new dot opacity
        var d1Scale: CGFloat = 1
        var chipScale: CGFloat = 1
        var letters = false                         // C: the new name's letters rise one by one
        var chevron: CGFloat = 1
        var t: CGFloat = 0                          // 0 = old name's width, 1 = new name's width
        var lettersQ: CGFloat = 1
    }

    static func chip(ls: LookStatic, q: CGFloat, isPrivate: Bool, style: SwitcherStyle) -> ChipFX {
        var f = ChipFX()
        if ls.kind == .space {
            let q = q
            f.t = Mix.clamp(q)
            f.chevron = 1
            if style.reduce { f.n0 = 1 - Mix.clamp(q); f.n1 = Mix.clamp(q); f.d0 = f.n0; f.d1 = f.n1; return f }
            switch style.space {
            case .a:
                f.n0 = 1 - q; f.n1 = q; f.d0 = 1 - q; f.d1 = q
            case .b:
                f.n0y = -14 * q * ls.dir; f.n0 = 1 - Mix.seg(q, 0, 0.6)
                f.n1y = 14 * (1 - q) * ls.dir; f.n1 = Mix.seg(q, 0.3, 1)
                f.d0 = 1 - Mix.seg(q, 0.2, 0.7); f.d1 = Mix.seg(q, 0.2, 0.7)
            case .c:
                f.n0 = 1 - Mix.seg(q, 0, 0.3); f.n1 = 1; f.letters = true; f.lettersQ = q
                f.d1Scale = Mix.lerp(0.2, 1, max(0, q)); f.d1 = Mix.seg(q, 0.1, 0.4); f.d0 = 1 - Mix.seg(q, 0.1, 0.4)
                f.chipScale = 1 + 0.08 * sin(.pi * Mix.clamp(q))
            }
            return f
        }
        let pa = privAmount(ls, q: q, isPrivate: isPrivate, layer: .live)
        f.t = Mix.clamp(pa)
        f.chevron = 1 - Mix.clamp(pa)
        if style.reduce { f.n0 = 1 - Mix.clamp(pa); f.n1 = Mix.clamp(pa); f.d0 = f.n0; f.d1 = f.n1; return f }
        switch style.priv {
        case .a:
            f.n0 = 1 - pa; f.n1 = pa; f.d0 = 1 - pa; f.d1 = pa
        case .b:
            f.n0 = 1 - Mix.seg(pa, 0, 0.5); f.n1 = Mix.seg(pa, 0.2, 0.7)
            f.d0 = 1 - Mix.seg(pa, 0, 0.5); f.d1 = Mix.seg(pa, 0, 0.5)
        case .c:
            f.n0 = 1 - Mix.seg(pa, 0.1, 0.4); f.n1 = Mix.seg(pa, 0.3, 0.7)
            f.d0 = 1 - Mix.seg(pa, 0.1, 0.4); f.d1 = Mix.seg(pa, 0.1, 0.4)
        }
        return f
    }

    struct EyesFX {
        var act: CGFloat = 0        // white fill
        var i0: CGFloat = 1         // eyes icon
        var i1: CGFloat = 0         // crossed eye icon
        var blink: CGFloat = 1      // vertical scale of the icons
        var scale: CGFloat = 1
    }

    static func eyes(ls: LookStatic, q: CGFloat, isPrivate: Bool, style: SwitcherStyle) -> EyesFX {
        var f = EyesFX()
        let pa = privAmount(ls, q: q, isPrivate: isPrivate, layer: .live)
        if style.reduce { f.act = Mix.clamp(pa); f.i0 = 1 - f.act; f.i1 = f.act; return f }
        switch style.priv {
        case .a:
            f.act = pa; f.i0 = 1 - pa; f.i1 = pa
        case .b:
            f.act = Mix.seg(pa, 0, 0.5); f.i0 = 1 - Mix.seg(pa, 0.2, 0.5); f.i1 = Mix.seg(pa, 0.2, 0.5)
            f.scale = 1 + 0.16 * sin(.pi * Mix.clamp(pa))
        case .c:
            f.blink = 1 - 0.92 * sin(.pi * Mix.seg(pa, 0, 0.55))
            f.i0 = 1 - Mix.seg(pa, 0.22, 0.3); f.i1 = Mix.seg(pa, 0.22, 0.3); f.act = Mix.seg(pa, 0.2, 0.5)
        }
        return f
    }
}

/// Per-card motion for a Space / Private change (element 8 / 9), for the new cards (live) and the old ones (ghost).
struct CardLookEffect: ViewModifier {
    let layer: LookLayer
    let slot: Int
    let travel: CGFloat
    let style: SwitcherStyle
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    func body(content: Content) -> some View {
        let f = LookFX.card(layer: layer, slot: slot, ls: ls, q: q, travel: travel, style: style)
        content.scaleEffect(f.scale).offset(x: f.x, y: f.y).opacity(f.opacity)
    }
}

/// The card row as a whole (9: B nudges to 97%, C turns grey and shrinks to 94%).
struct RowPrivateEffect: ViewModifier {
    let style: SwitcherStyle
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    func body(content: Content) -> some View {
        let pa = LookFX.privAmount(ls, q: q, isPrivate: store.isPrivate, layer: .live)
        let r = LookFX.row(pa, style: style)
        content.scaleEffect(r.scale).grayscale(r.gray)
    }
}

/// Black over a card's page area: the Private dim.
struct PrivateDim: View {
    let layer: LookLayer
    let style: SwitcherStyle
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    var body: some View {
        let pa = LookFX.privAmount(ls, q: q, isPrivate: store.isPrivate, layer: layer)
        Color.black.opacity(LookFX.privDim(pa, style: style)).allowsHitTesting(false)
    }
}

/// Backdrop of the switcher: the Space gradient, the Private gradient that spreads over it, and C's vignette.
struct SwitcherBackdrop: View {
    let info: LookInfo?
    let W: CGFloat
    let H: CGFloat
    let top: CGFloat
    let style: SwitcherStyle
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    var body: some View {
        let chip = CGPoint(x: Layout.edge + 36, y: top + Layout.gap + Layout.control / 2)
        let eyes = CGPoint(x: W - Layout.edge - Layout.control / 2, y: top + Layout.gap + Layout.control / 2)
        let fx = LookFX.backdrop(ls: ls, info: info, q: q, store: store, style: style, W: W, chip: chip, eyes: eyes)
        ZStack {
            Backdrop(palette: fx.base)
            if let t = fx.top {
                Backdrop(palette: t).opacity(fx.topOpacity).clipShape(RevealShape(reveal: fx.reveal))
            }
        }
        .compositingGroup()
        .opacity(0.55)
        .ignoresSafeArea()
    }
}

struct RevealShape: Shape {
    let reveal: LookFX.Reveal
    func path(in rect: CGRect) -> Path {
        switch reveal {
        case .all: return Path(rect)
        case .left(let w): return Path(CGRect(x: rect.minX, y: rect.minY, width: max(0, w), height: rect.height))
        case .circle(let c, let r):
            return Path(ellipseIn: CGRect(x: rect.minX + c.x - r, y: rect.minY + c.y - r, width: 2 * r, height: 2 * r))
        }
    }
}

/// C's vignette over the cards (the page: transparent to 38%, black 70% at the corners).
struct SwitcherVignette: View {
    let W: CGFloat
    let H: CGFloat
    let style: SwitcherStyle
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    var body: some View {
        let pa = LookFX.privAmount(ls, q: q, isPrivate: store.isPrivate, layer: .live)
        RadialGradient(stops: [.init(color: .clear, location: 0.38), .init(color: .black.opacity(0.7), location: 1)],
                       center: .center, startRadius: 0, endRadius: hypot(W, H) / 2)
            .opacity(LookFX.vignette(pa, style))
            .frame(width: W, height: H)
            .allowsHitTesting(false)
    }
}

/// A layout whose width slides from the first subview's width to the second's (the Space name changing length).
struct MixLayout: SwiftUI.Layout {
    var t: CGFloat
    var animatableData: CGFloat {
        get { t }
        set { t = newValue }
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let a = subviews[0].sizeThatFits(.unspecified), b = subviews[1].sizeThatFits(.unspecified)
        return CGSize(width: Mix.lerp(a.width, b.width, Mix.clamp(t)), height: max(a.height, b.height))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for s in subviews { s.place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: .unspecified) }
    }
}

// MARK: - Notes shown under the pickers in Settings > Motion

enum SwitcherMotion {
    /// One honest line per element where an alternative is limited or approximated (shown under the picker in Settings > Motion).
    static let notes: [MotionElement: String] = [
        .switcher: "The page is a web view and cannot morph, so a snapshot of it stands in: it shrinks (A, B) or is moved and clipped into the centre card (C, approximated). Tilt perspective is per card.",
        .cardClose: "Release distance is 100, 80 or 90 pt as in the page. Neighbour size and dim come from the carousel pick; the stagger of far cards is not reproduced.",
        .carousel: "Dragging uses the system scroll physics, so the finger-driven settle spring and overshoot cannot be changed; only how cards react while moving (scale, drop, tilt, dim) follows the pick.",
        .space: "The switcher stays open a moment after you pick a Space so the change can be seen. B's wipe direction follows the order of Spaces.",
        .privateToggle: "Private tabs are other cards, so the card set cross-fades instead of the same cards dimming. The eyes button shows a crossed eye while Private is on."
    ]
}
