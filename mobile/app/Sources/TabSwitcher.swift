import SwiftUI
import UIKit

/// Tuning for the swipe-up-to-close gesture on a card. Recognition (axis, bias, flick) is fixed; the release distance,
/// follow, fly-off and the neighbours' glide depend on the pick for element 2 (see `SwitcherAnim` / `SwipeFX`).
private enum SwipeToClose {
    /// Finger travel (pt) before the drag is recognised at all; the axis is decided on that first sample.
    static let minimumDistance: CGFloat = 10
    /// The drag only engages when |dy| > |dx| * this, so horizontal scrolling of the carousel is never hijacked.
    static let verticalBias: CGFloat = 1.5
    /// ...or when the system's predicted end translation is at least this far up (a flick)...
    static let flickPredicted: CGFloat = 240
    /// ...provided the finger actually travelled at least this far up (ignores a twitch with high velocity).
    static let flickMinTravel: CGFloat = 24
    /// Where a flown-off card ends up (the page uses 820 pt).
    static let flyTarget: CGFloat = -820

    /// Upward travel follows the finger 1:1; downward travel is rubber-banded (saturates near 60 pt).
    static func resisted(_ dy: CGFloat) -> CGFloat {
        dy <= 0 ? dy : dy / (1 + dy / 60)
    }
}

/// How the card follows the finger (element 2): shrink, fade and, for C, a tilt toward the drag direction.
private struct SwipeFX {
    let style: SwitcherStyle

    private var shrink: CGFloat {
        if style.reduce { return 0 }
        switch style.swipe { case .a: return 0.05; case .b: return 0.10; case .c: return 0.16 }
    }
    private var travel: CGFloat { switch style.swipe { case .a: 420; case .b: 360; case .c: 380 } }
    private var fade: (CGFloat, CGFloat) { switch style.swipe { case .a: (140, 520); case .b: (100, 380); case .c: (160, 560) } }
    private var tiltDegrees: CGFloat { (!style.reduce && style.swipe == .c) ? 10 : 0 }

    func scale(_ dy: CGFloat) -> CGFloat { 1 - shrink * Mix.clamp(-dy / travel) }
    func opacity(_ dy: CGFloat) -> CGFloat { 1 - Mix.seg(-dy, fade.0, fade.1) }
    func rotation(_ dy: CGFloat, direction: CGFloat) -> Double { Double(direction * tiltDegrees * Mix.clamp(-dy / travel)) }
}

private enum CloseHow { case fly, fade }

/// Layout numbers of the switcher.
private struct Metrics {
    let W: CGFloat          // screen width
    let H: CGFloat          // height below the status bar (the bottom bar ignores the bottom safe area)
    let top: CGFloat        // top safe area
    var cardW: CGFloat { W * 0.74 }
    var cardH: CGFloat { min(H * 0.58, cardW * 1.85) }
    var pitch: CGFloat { cardW * 0.84 }                 // centre to centre (cards overlap by 16%)
    var inset: CGFloat { (W - cardW) / 2 }
    var screenH: CGFloat { H + top }
    var collapsedSlot: CGFloat { cardW * 0.16 }         // card width + spacing = 0: the slot of a closing card
}

/// Card-stack tab switcher (reference 07): overlapping page cards, title above, Spaces / + / settings at the bottom.
/// Floating bars use one equal inset (`Layout.edge`) from the left, right and bottom physical screen edges.
struct TabSwitcher: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.switcherModel) private var model
    let initialFocus: UUID?

    @State private var focusedID: UUID?
    /// The card currently being swiped (raised above its neighbours while it moves).
    @State private var draggingID: UUID?
    /// Cards whose slot is collapsing (closed with a swipe, the X or the menu); removed from the store when done.
    @State private var closing: [UUID: CloseHow] = [:]
    @State private var push: CGFloat = 0
    @State private var pushIndex = -1
    /// A Space or Private change that is being animated, and its progress (1 = settled).
    @State private var look: LookInfo?
    @State private var lookP: CGFloat = 1
    @State private var seen = Seen()

    /// What the screen showed the last time nothing was changing (the "from" of the next Space / Private change).
    private struct Seen {
        var name = ""
        var palette = SpacePalette.dusk
        var isPrivate = false
        var tabs: [Tab] = []
        var focusID: UUID?
    }
    private struct Sig: Equatable { var space: UUID; var priv: Bool; var tabs: [UUID] }
    private var sig: Sig { Sig(space: store.currentSpaceID, priv: store.isPrivate, tabs: store.orderedTabs.map(\.id)) }

    init(initialFocus: UUID? = nil) {
        self.initialFocus = initialFocus
        _focusedID = State(initialValue: initialFocus)
    }

    var body: some View {
        let style = store.switcherStyle(reduce: reduceMotion)
        GeometryReader { geo in
            let m = Metrics(W: geo.size.width, H: geo.size.height, top: geo.safeAreaInsets.top)
            EnvProgress(value: lookP, key: \.switcherLookP, content: content(m, style))
                .environment(\.switcherLook, look?.statics ?? LookStatic())
        }
        // The bottom bar is measured from the physical bottom edge (the home indicator sits inside its inset).
        .ignoresSafeArea(.container, edges: .bottom)
        .onAppear {
            if focusedID == nil { focusedID = store.selectedTab?.id }
            model.focusID = focusedID
            seen = snapshot()
        }
        .onChange(of: sig) { old, new in lookChanged(old, new) }
        .onChange(of: focusedID) { _, id in
            model.focusID = id ?? store.selectedTab?.id
            if let id, seen.tabs.contains(where: { $0.id == id }) { seen.focusID = id }
        }
    }

    private func content(_ m: Metrics, _ style: SwitcherStyle) -> some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            SwitcherBackdrop(info: look, W: m.W, H: m.screenH, top: m.top, style: style)
                .modifier(SwitcherPart(kind: .backdrop, style: style))
            VStack(spacing: 0) {
                topBar(style).modifier(SwitcherPart(kind: .topBar, style: style)).zIndex(2)
                carousel(m, style).zIndex(1)
                bottomBar.modifier(SwitcherPart(kind: .bottomBar, style: style)).zIndex(2)
            }
        }
    }

    // MARK: carousel

    private func carousel(_ m: Metrics, _ style: SwitcherStyle) -> some View {
        let tabs = store.orderedTabs
        let focusID = focusedID ?? store.selectedTab?.id
        let focusIndex = tabs.firstIndex { $0.id == focusID } ?? 0
        let fx = CarouselFX(variant: style.carousel, reduce: style.reduce)
        // The vignette (Private, C) spans the whole screen; this is how far the carousel's centre is from the screen's centre.
        let barsTop = m.top + Layout.gap + Layout.control
        let barsBottom = Layout.barHeight
        let vignetteShift = m.screenH / 2 - (barsTop + (m.screenH - barsBottom)) / 2
        return ZStack(alignment: .center) {   // the scroll view centres its row of cards vertically; the ghost does the same
            if let look, !look.fromTabs.isEmpty { ghost(look, m, style, fx) }
            ScrollView(.horizontal) {
                LazyHStack(spacing: -m.cardW * 0.16) {
                    ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                        liveCard(tab, index: index, count: tabs.count, focusIndex: focusIndex, m: m, style: style, fx: fx)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $focusedID)
            .contentMargins(.horizontal, m.inset, for: .scrollContent)
            .scrollIndicators(.hidden)
            // A card swiped up travels over the top bar instead of being cut off at the scroll view's edge.
            .scrollClipDisabled()
        }
        .modifier(RowPrivateEffect(style: style))
        .modifier(SwitcherPart(kind: .carousel, style: style))
        .overlay { SwitcherVignette(W: m.W, H: m.screenH, style: style).offset(y: vignetteShift) }
        .frame(maxHeight: .infinity)
    }

    private func liveCard(_ tab: Tab, index: Int, count: Int, focusIndex: Int, m: Metrics, style: SwitcherStyle, fx: CarouselFX) -> some View {
        let rel = index - focusIndex
        let how = closing[tab.id]
        // The centred card that is being swiped or closed keeps the centre-card look (no tilt, scale or dim) while its
        // slot collapses and the neighbours glide in. Otherwise its position-driven look (the cover-flow tilt of 3C)
        // changes as the layout moves under it and the card turns to the left at the end of the close.
        let frozen = rel == 0 && (how != nil || draggingID == tab.id)
        return TabCard(
            tab: tab, width: m.cardW, height: m.cardH, isSelected: tab === store.selectedTab,
            isFocused: focusedID == tab.id || (focusedID == nil && tab === store.selectedTab),
            carousel: fx, viewportW: m.W, pitch: m.pitch,
            fixedPos: frozen ? 0 : nil,
            fading: how == .fade,
            onDragging: { setDragging(tab, $0) },
            onClose: { closeTab(tab, how: .fade) },
            onSwipeClose: { closeTab(tab, how: .fly) }
        )
        // Anchored at the slot's left edge: as the slot collapses to close the gap, a centred card would slide sideways with it
        // (visible as a turn to the left at the end of a swipe-close). Anchored, it keeps its place and only the neighbours move.
        .frame(width: how == nil ? m.cardW : m.collapsedSlot, alignment: .leading)
        .id(tab.id)
        .modifier(PushEffect(g: index == pushIndex ? push : 0, amount: (style.swipe == .c && !style.reduce) ? -12 : 0))
        .modifier(CardOpenEffect(rel: rel, pitch: m.pitch, style: style))
        .modifier(CardLookEffect(layer: .live, slot: min(4, max(0, rel + 1)), travel: slideTravel(.live, m, liveCount: count, liveIndex: focusIndex), style: style))
        .zIndex(draggingID == tab.id ? 1000 : Double(100 - min(abs(rel), 99)))
        .modifier(CarouselScrollEffect(fx: fx, viewportW: m.W, pitch: m.pitch, frozen: frozen))
    }

    /// The cards of the previous Space / Private look, drawn once more (no scrolling, not touchable) so they can leave.
    private func ghost(_ info: LookInfo, _ m: Metrics, _ style: SwitcherStyle, _ fx: CarouselFX) -> some View {
        let tabs = info.fromTabs
        let idx = tabs.firstIndex { $0.id == info.fromFocusID } ?? 0
        return HStack(spacing: -m.cardW * 0.16) {
            ForEach(Array(tabs.enumerated()), id: \.element.id) { i, tab in
                let rel = i - idx
                TabCard(tab: tab, width: m.cardW, height: m.cardH, isSelected: i == idx, isFocused: false,
                        layer: .ghost, carousel: fx, viewportW: m.W, pitch: m.pitch, fixedPos: CGFloat(rel))
                    .modifier(CardLookEffect(layer: .ghost, slot: min(4, max(0, rel + 1)), travel: slideTravel(.ghost, m, ghostCount: tabs.count, ghostIndex: idx), style: style))
                    .modifier(CarouselFixedEffect(fx: fx, pos: CGFloat(rel)))
                    .zIndex(Double(100 - min(abs(rel), 99)))
            }
        }
        .offset(x: m.inset - CGFloat(idx) * m.pitch)
        .frame(width: m.W, alignment: .leading)
        .allowsHitTesting(false)
    }

    // MARK: Space / Private change (elements 8 and 9)

    /// How far a card set slides in B of the Space change: a full screen width, plus the cards that stick out on the
    /// side it moves toward, so none is left on screen.
    private func slideTravel(_ layer: LookLayer, _ m: Metrics, ghostCount: Int = 0, ghostIndex: Int = 0, liveCount: Int = 0, liveIndex: Int = 0) -> CGFloat {
        let forward = (look?.dir ?? 1) >= 0
        let sticking: Int
        switch (layer, forward) {
        case (.ghost, true): sticking = ghostCount - 1 - ghostIndex
        case (.ghost, false): sticking = ghostIndex
        case (.live, true): sticking = liveIndex
        case (.live, false): sticking = liveCount - 1 - liveIndex
        }
        return m.W / 2 + m.cardW / 2 + 12 + CGFloat(max(0, sticking)) * m.pitch
    }

    private func snapshot() -> Seen {
        Seen(name: store.isPrivate ? "Private" : store.currentSpace.name, palette: store.palette, isPrivate: store.isPrivate,
             tabs: store.orderedTabs, focusID: focusedID ?? store.selectedTab?.id)
    }

    private func lookChanged(_ old: Sig, _ new: Sig) {
        defer { seen = snapshot() }
        if old.space != new.space {
            let from = store.spaces.firstIndex { $0.id == old.space } ?? 0
            let to = store.spaces.firstIndex { $0.id == new.space } ?? 0
            beginLook(.space, dir: to >= from ? 1 : -1, entering: false)
        } else if old.priv != new.priv {
            beginLook(.priv, dir: 1, entering: new.priv)
        }
    }

    private func beginLook(_ kind: LookKind, dir: CGFloat, entering: Bool) {
        let style = store.switcherStyle(reduce: reduceMotion)
        let info = LookInfo(kind: kind, dir: dir, entering: entering, fromName: seen.name, fromPalette: seen.palette,
                            fromPrivate: seen.isPrivate, fromTabs: seen.tabs, fromFocusID: seen.focusID)
        let token = info.token
        var t = Transaction(animation: nil)
        t.disablesAnimations = true
        withTransaction(t) {
            look = info
            lookP = 0
            focusedID = store.selectedTab?.id
        }
        let anim = kind == .space ? SwitcherAnim.space(style) : SwitcherAnim.priv(style)
        Task { @MainActor in
            await Task.yield()          // draw the old look once at progress 0, then play
            guard look?.token == token else { return }
            withAnimation(anim, completionCriteria: .logicallyComplete) {
                lookP = 1
            } completion: {
                if look?.token == token { look = nil }
            }
        }
    }

    // MARK: closing

    private func setDragging(_ tab: Tab, _ on: Bool) {
        if on { draggingID = tab.id } else if draggingID == tab.id { draggingID = nil }
    }

    /// Closes a tab (X button, context menu or swipe) and keeps the carousel focus on a card that still exists.
    /// A card at or right of the centre first collapses its slot (the neighbours glide over with the variant's
    /// animation) and is removed from the store afterwards; anything else is removed straight away.
    private func closeTab(_ tab: Tab, how: CloseHow) {
        let style = store.switcherStyle(reduce: reduceMotion)
        let list = store.orderedTabs
        guard let index = list.firstIndex(where: { $0 === tab }), closing[tab.id] == nil else { return }
        let focusID = focusedID ?? store.selectedTab?.id
        let focusIndex = list.firstIndex { $0.id == focusID } ?? 0
        if list.count > 1, index >= focusIndex {
            withAnimation(SwitcherAnim.swipeGap(style)) {
                closing[tab.id] = how
                if style.swipe == .c, !style.reduce { pushIndex = index - 1; push = 1 }
            }
            let wait = max(SwitcherAnim.gapSeconds(style), SwitcherAnim.flySeconds(style) - SwitcherAnim.gapDelay(style)) + Motion.scaled(0.05)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(wait))
                finishClose(tab)
            }
        } else {
            let wait = how == .fly ? max(0, SwitcherAnim.flySeconds(style) - SwitcherAnim.gapDelay(style)) : 0
            Task { @MainActor in
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                withAnimation(SwitcherAnim.swipeGap(style)) { removeFromStore(tab) }
            }
        }
    }

    /// The slot is already gone, so removing the tab changes nothing visible: no animation.
    private func finishClose(_ tab: Tab) {
        guard closing[tab.id] != nil else { return }
        var t = Transaction(animation: nil)
        t.disablesAnimations = true
        withTransaction(t) {
            removeFromStore(tab)
            closing[tab.id] = nil
            push = 0
            pushIndex = -1
        }
    }

    private func removeFromStore(_ tab: Tab) {
        let before = store.orderedTabs
        let index = before.firstIndex { $0 === tab } ?? 0
        let wasFocused = focusedID == tab.id
        let wasSelected = store.selectedTab === tab
        let wasPrivate = store.isPrivate
        if draggingID == tab.id { draggingID = nil }
        store.close(tab)   // picks the next selected tab; makes a blank one if the Space would be empty
        let after = store.orderedTabs
        if wasPrivate != store.isPrivate {
            // The last private tab was closed: the store left Private mode and shows the Space's tabs.
            focusedID = store.selectedTab?.id
        } else if wasFocused {
            let neighbour = after.indices.contains(index) ? after[index] : after.last
            focusedID = ((wasSelected ? store.selectedTab : nil) ?? neighbour)?.id
        } else if !after.contains(where: { $0.id == focusedID }) {
            focusedID = store.selectedTab?.id
        }
    }

    // MARK: bars

    private func topBar(_ style: SwitcherStyle) -> some View {
        HStack {
            SpaceChip(info: look, style: style)
            Spacer()
            EyesButton(style: style)
        }
        // Same side inset on the left (Space chip) and right (private toggle); small gap below the status bar.
        .padding(.horizontal, Layout.edge)
        .padding(.top, Layout.gap)
    }

    private var bottomBar: some View {
        HStack {
            Button { store.sheet = .spaces } label: { GlassCircleLabel(symbol: "square.grid.2x2", size: Layout.barControl) }
            Spacer()
            Button { store.newBlankTabFromSwitcher() } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: Layout.barControl * 2, height: Layout.barControl)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .contentShape(Capsule())   // the whole glass shape is tappable, not just the glyph
            }
            Spacer()
            Button { store.sheet = .settings } label: { GlassCircleLabel(symbol: "gearshape", size: Layout.barControl) }
        }
        .buttonStyle(MotionPressStyle())
        // Equal inset from the left, right and (physical) bottom screen edges.
        .padding(.horizontal, Layout.edge)
        .padding(.top, Layout.gap)
        .padding(.bottom, Layout.edge)
    }
}

/// The nudge of the left neighbour while a card is tossed away (element 2, C).
private struct PushEffect: ViewModifier, Animatable {
    var g: CGFloat
    var amount: CGFloat
    var animatableData: CGFloat {
        get { g }
        set { g = newValue }
    }
    func body(content: Content) -> some View { content.offset(x: amount * sin(.pi * g)) }
}

// MARK: - Top bar: Space chip and private toggle

/// The Space chip: colour dot, name, chevron. While Private is on it reads "Private" with the graphite dot.
private struct SpaceChip: View {
    let info: LookInfo?
    let style: SwitcherStyle
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    var body: some View {
        let fx = LookFX.chip(ls: ls, q: q, isPrivate: store.isPrivate, style: style)
        let name0: String, name1: String, pal0: SpacePalette, pal1: SpacePalette
        if ls.kind == .space, let info {
            name0 = info.fromName; pal0 = info.fromPalette
            name1 = store.isPrivate ? "Private" : store.currentSpace.name; pal1 = store.palette
        } else {
            name0 = store.currentSpace.name; pal0 = store.currentSpace.palette
            name1 = "Private"; pal1 = .graphite
        }
        return Button { store.sheet = .spaces } label: {
            HStack(spacing: 8) {
                ZStack {
                    dot(pal0).opacity(fx.d0)
                    dot(pal1).opacity(fx.d1).scaleEffect(fx.d1Scale)
                }
                .frame(width: 16, height: 16)
                MixLayout(t: fx.t) {
                    label(name0).opacity(fx.n0).offset(y: fx.n0y)
                    newName(name1, fx)
                }
                Image(systemName: "chevron.down").font(.caption.weight(.bold)).opacity(fx.chevron)
            }
            .padding(.horizontal, Layout.sheetInset).frame(height: Layout.control)
            .glassEffect(.regular.interactive(), in: .capsule)
            .contentShape(Capsule())   // the whole glass shape is tappable, not just the glyph
            .scaleEffect(fx.chipScale)
        }
        .buttonStyle(.plain)
        .allowsHitTesting(!store.isPrivate)
        .accessibilityLabel(store.isPrivate ? "Private" : "Space \(store.currentSpace.name)")
    }

    private func label(_ s: String) -> some View {
        Text(s).font(.subheadline.weight(.semibold)).lineLimit(1).fixedSize()
    }

    /// C: the letters of the new name rise one by one.
    @ViewBuilder private func newName(_ s: String, _ fx: LookFX.ChipFX) -> some View {
        if fx.letters {
            HStack(spacing: 0) {
                ForEach(Array(s.enumerated()), id: \.offset) { i, ch in
                    let k = Mix.seg(fx.lettersQ, 0.25 + CGFloat(i) * 0.05, 0.65 + CGFloat(i) * 0.05)
                    Text(String(ch)).font(.subheadline.weight(.semibold)).opacity(k).offset(y: Mix.lerp(10, 0, k))
                }
            }
            .lineLimit(1).fixedSize()
        } else {
            label(s).opacity(fx.n1).offset(y: fx.n1y)
        }
    }

    private func dot(_ p: SpacePalette) -> some View {
        Circle().fill(LinearGradient(colors: [p.colors[1], p.colors[2]], startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

/// The private toggle: the white fill, the icon swap and the blink come from `LookFX.eyes`.
private struct EyesButton: View {
    let style: SwitcherStyle
    @Environment(BrowserStore.self) private var store
    @Environment(\.switcherLookP) private var q
    @Environment(\.switcherLook) private var ls

    var body: some View {
        let fx = LookFX.eyes(ls: ls, q: q, isPrivate: store.isPrivate, style: style)
        Button { store.setPrivate(!store.isPrivate) } label: {
            Circle().fill(.clear)
                .frame(width: Layout.control, height: Layout.control)
                .glassEffect(.regular.interactive(), in: .circle)
                .contentShape(Circle())   // the whole glass shape is tappable, not just the glyph
                .overlay {
                    ZStack {
                        Circle().fill(.white).opacity(fx.act)
                        Image(systemName: "eyes").opacity(fx.i0).scaleEffect(y: fx.blink)
                        Image(systemName: "eye.slash").foregroundStyle(Color(hex: 0x15151C)).opacity(fx.i1).scaleEffect(y: fx.blink)
                    }
                    .font(.system(size: 17, weight: .semibold))
                    .allowsHitTesting(false)
                }
                .contentShape(.circle)
                .scaleEffect(fx.scale)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Private mode")
        .accessibilityValue(store.isPrivate ? "On" : "Off")
    }
}

// MARK: - Card

/// Reference box for a card's last frame (written while scrolling, so it must not trigger a redraw).
private final class FrameBox { var rect = CGRect.zero }

struct TabCard: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.switcherModel) private var model
    let tab: Tab
    let width: CGFloat
    let height: CGFloat
    let isSelected: Bool
    /// The card centred in the carousel; only its X is shown so neighbours' buttons don't peek out from behind it.
    let isFocused: Bool
    /// `.ghost` = an old card shown while a Space / Private change plays: not touchable, position known (`fixedPos`).
    var layer: LookLayer = .live
    var carousel = CarouselFX(variant: .a, reduce: false)
    var viewportW: CGFloat = 0
    var pitch: CGFloat = 1
    var fixedPos: CGFloat?
    /// Closed with the X or the menu: shrinks and fades while its slot collapses.
    var fading = false
    /// Tells the switcher when this card is being swiped (true) or released (false).
    var onDragging: (Bool) -> Void = { _ in }
    /// X button / context menu: the switcher closes the tab and re-centres the carousel.
    var onClose: () -> Void = {}
    /// A swipe was committed and the card is flying off: the switcher closes the gap.
    var onSwipeClose: () -> Void = {}

    /// One corner radius for the snapshot clip and its outline.
    private static let cornerRadius: CGFloat = 30

    /// True while the card is being swiped up (the pan has begun).
    @State private var swiping = false
    @State private var dragY: CGFloat = 0
    @State private var tilt: CGFloat = 0
    @State private var isClosing = false
    @State private var haptic: UIImpactFeedbackGenerator?
    @State private var box = FrameBox()

    var body: some View {
        let style = store.switcherStyle(reduce: reduceMotion)
        let swipe = SwipeFX(style: style)
        let live = layer == .live
        VStack(spacing: Layout.gap) {
            // No horizontal padding: the favicon's left edge and the X button's right edge line up with the snapshot's edges.
            header(style)
            pageArea(style)
        }
        .frame(width: width)
        .contextMenu {
            Button(tab.isPinned ? "Unpin" : "Pin", systemImage: tab.isPinned ? "pin.slash" : "pin") { store.togglePin(tab) }
            Button("Close", systemImage: "xmark", role: .destructive) { onClose() }
        }
        // Swipe up to close. The pan only begins for a vertical-dominant drag, so the carousel's horizontal scroll,
        // tap-to-open and the X button keep working.
        .gesture(SwipeUpPan(
            enabled: live && !isClosing && !fading,
            onBegan: { beginSwipe() },
            onChanged: { moveSwipe($0) },
            onEnded: { endSwipe($0, velocity: $1, style) },
            onCancelled: { if !isClosing { springBack(style) } }
        ))
        .onDisappear { onDragging(false) }
        .scaleEffect(swipe.scale(dragY) * ((fading && !style.reduce) ? 0.9 : 1))
        .rotationEffect(.degrees(swipe.rotation(dragY, direction: tilt)))
        .opacity((style.reduce && isClosing) || fading ? 0 : swipe.opacity(dragY))
        .offset(y: dragY)
        .allowsHitTesting(live && !isClosing && !fading)
    }

    private func header(_ style: SwitcherStyle) -> some View {
        HStack(spacing: 8) {
            FaviconView(tab: tab, size: 20)
            Text(tab.displayTitle).font(.footnote.weight(.semibold)).lineLimit(1)
            Spacer(minLength: 0)
            if tab.isPinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.secondary) }
            Button { onClose() } label: {
                Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 28, height: 28)
                    .background(.thinMaterial, in: .circle)
            }
            .buttonStyle(.plain)
            .opacity(isFocused ? 1 : 0)
            .allowsHitTesting(isFocused)
            .animation(.easeOut(duration: 0.15), value: isFocused)
        }
        .modifier(CarouselCardPart(part: .titles, fx: carousel, viewportW: viewportW, pitch: pitch, fixedPos: fixedPos))
        .modifier(HeaderOpenFade(isFocused: isFocused && layer == .live, style: style))
    }

    private func pageArea(_ style: SwitcherStyle) -> some View {
        ZStack {
            if let s = tab.snapshot {
                Image(uiImage: s).resizable().scaledToFill().frame(width: width, height: height, alignment: .top).clipped()
            } else {
                Rectangle().fill(.thinMaterial)
                VStack(spacing: 8) {
                    Image(systemName: "plus.magnifyingglass").font(.title)
                    Text("New Tab").font(.footnote)
                }
                .foregroundStyle(.secondary)
            }
            // C of the carousel dims the side cards; Private (9) dims every card.
            Color.black.modifier(CarouselCardPart(part: .dim, fx: carousel, viewportW: viewportW, pitch: pitch, fixedPos: fixedPos))
                .allowsHitTesting(false)
            PrivateDim(layer: layer, style: style)
        }
        .frame(width: width, height: height)
        .clipShape(.rect(cornerRadius: Self.cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: Self.cornerRadius)
                .stroke(isSelected ? Theme.accent : .white.opacity(0.18), lineWidth: isSelected ? 2 : 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { r in
            box.rect = r
            if layer == .live { model.frames[tab.id] = r }
        }
        .onTapGesture {
            guard layer == .live else { return }
            model.closingRect = box.rect
            store.select(tab)
            store.showSwitcher = false
        }
    }

    private func beginSwipe() {
        guard !isClosing else { return }
        swiping = true
        tilt = 0
        onDragging(true)
        haptic = UIImpactFeedbackGenerator(style: .light)
        haptic?.prepare()
    }

    private func moveSwipe(_ translation: CGSize) {
        guard swiping, !isClosing else { return }
        if abs(translation.width) > 6 { tilt = translation.width > 0 ? 1 : -1 }   // C tilts toward the drag side
        dragY = SwipeToClose.resisted(translation.height)
    }

    private func endSwipe(_ translation: CGSize, velocity: CGSize, _ style: SwitcherStyle) {
        let wasSwiping = swiping
        swiping = false
        guard wasSwiping, !isClosing else { return }
        let up = -translation.height
        // Where the drag would come to rest (UIKit's normal deceleration, the same estimate SwiftUI's predictedEndTranslation makes).
        let predicted = -(translation.height + velocity.height * 0.5)
        if up > SwitcherAnim.commitDistance(style) || (up > SwipeToClose.flickMinTravel && predicted > SwipeToClose.flickPredicted) {
            commitClose(style, velocity: velocity.height)
        } else {
            springBack(style)
        }
    }

    private func springBack(_ style: SwitcherStyle) {
        swiping = false
        haptic = nil
        onDragging(false)
        withAnimation(SwitcherAnim.swipeBack(style)) { dragY = 0 }
    }

    /// Fly the card off the top (A ease-in, B and C a spring that keeps the release velocity), and let the switcher
    /// close the gap after a short delay so the neighbours glide while the card is still leaving.
    private func commitClose(_ style: SwitcherStyle, velocity: CGFloat) {
        haptic?.impactOccurred()
        haptic = nil
        if style.reduce {
            withAnimation(SwitcherAnim.swipeBack(style)) { isClosing = true }   // plain 0.15 s fade, no travel
        } else {
            isClosing = true
            let distance = SwipeToClose.flyTarget - dragY
            withAnimation(SwitcherAnim.swipeFly(style, velocity: velocity, distance: distance)) { dragY = SwipeToClose.flyTarget }
        }
        let delay = SwitcherAnim.gapDelay(style)
        Task { @MainActor in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            onSwipeClose()
        }
    }
}

/// Pan that begins only when the first movement is mostly vertical (|dy| > |dx| * `verticalBias`). A horizontal drag never
/// starts it, so the carousel's scroll view owns every horizontal drag. (A SwiftUI `DragGesture` on the card swallowed
/// the scroll view's pan, so the carousel could not be dragged at all.) Coordinates are in the window, so the card's own
/// offset and the carousel scrolling under the finger do not change the translation.
private struct SwipeUpPan: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var onBegan: () -> Void
    var onChanged: (CGSize) -> Void
    var onEnded: (_ translation: CGSize, _ velocity: CGSize) -> Void
    var onCancelled: () -> Void

    /// A pan that gives up on the first movement past the slop if it is not mostly vertical.
    final class VerticalPan: UIPanGestureRecognizer {
        private var start: CGPoint?
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            start = touches.first?.location(in: nil)
            super.touchesBegan(touches, with: event)
        }
        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            if state == .possible, let start, let p = touches.first?.location(in: nil) {
                let dx = p.x - start.x, dy = p.y - start.y
                if hypot(dx, dy) > SwipeToClose.minimumDistance {
                    if abs(dy) <= abs(dx) * SwipeToClose.verticalBias { state = .failed; return }
                }
            }
            super.touchesMoved(touches, with: event)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> VerticalPan {
        let pan = VerticalPan()
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        return pan
    }

    func updateUIGestureRecognizer(_ pan: VerticalPan, context: Context) {
        pan.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ pan: VerticalPan, context: Context) {
        let t = pan.translation(in: nil)
        let translation = CGSize(width: t.x, height: t.y)
        switch pan.state {
        case .began:
            onBegan()
            onChanged(translation)
        case .changed:
            onChanged(translation)
        case .ended:
            let v = pan.velocity(in: nil)
            onEnded(translation, CGSize(width: v.x, height: v.y))
        case .cancelled, .failed:
            onCancelled()
        default:
            break
        }
    }
}
