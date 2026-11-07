import SwiftUI
import UIKit

@main
struct FlechaApp: App {
    @State private var store = BrowserStore()
    @State private var ready = false
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if ready { RootView() } else { Color(.systemBackground).ignoresSafeArea() }
            }
            .environment(store)
            .task {
                await ContentBlocker.load()   // rule lists must exist before the first page loads
                ready = true
                DietTracker.shared.start(store)
                if UserDefaults.standard.bool(forKey: "openDiet") { DietEngine.shared.isPresented = true }
                IncomingWebsites.shared.open(in: store)
                openPendingWebApp()
                await WebAppTesting.run(store)
            }
            .onOpenURL { store.handle(deepLink: $0) }
            .onChange(of: phase) { _, p in
                if p != .active { DietTracker.shared.reset() }
                if p == .background { store.save() }
                if p == .active { store.archiveInactive() }
                if p == .active, ready { IncomingWebsites.shared.open(in: store); openPendingWebApp() }
            }
            .onChange(of: WebAppPresenter.shared.pendingLaunch) { _, _ in if ready { openPendingWebApp() } }
            .onChange(of: IncomingWebsites.shared.pending) { _, _ in
                if ready { IncomingWebsites.shared.open(in: store) }
            }
            .onChange(of: store.isPrivate) { _, _ in DietTracker.shared.reset() }
            .onChange(of: store.selectedTab?.id) { _, _ in DietTracker.shared.reset() }
        }
    }

    /// Shortcuts' "Open Web App" (also from a Home Screen shortcut) lands here.
    private func openPendingWebApp() {
        guard let id = WebAppPresenter.shared.pendingLaunch else { return }
        WebAppPresenter.shared.pendingLaunch = nil
        if let app = WebAppStore.shared.app(id: id) { WebAppPresenter.shared.open(app, store: store) }
    }
}

struct RootView: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduce
    @State private var systemRecedeOn = false
    private var pm: PageMotionState { .shared }

    /// The system sheet only presents what `PageSheetHost` does not draw itself (variant A of the page menu / search, and every other sheet).
    private var systemSheet: Binding<AppSheet?> {
        Binding(
            get: {
                guard let s = store.sheet, !PageMotion.usesCustomSheet(s, store: store, reduce: reduce) else { return nil }
                return s
            },
            set: { new in
                if new == nil, let s = store.sheet, !PageMotion.usesCustomSheet(s, store: store, reduce: reduce) { store.sheet = nil }
            })
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()   // shows around the page while it recedes behind a sheet
            BrowserPage()
                .scaleEffect(PMath.lerp(1, pm.recedeScale, pm.recede), anchor: UnitPoint(x: 0.5, y: 0.4))
                .offset(y: CGFloat(pm.recedeY * pm.recede))
            SwitcherLayer()
            PageSheetHost()   // page menu / search sheet for variants B, C and Reduce Motion (element 4, 6)
            TopStyleOverlay()   // the chosen Dynamic Island style, over the page AND the tab switcher
        }
        .sheet(item: systemSheet) { sheet in
            switch sheet {
            case .search(let editing): SearchSheet(editing: editing)
            case .pageMenu: PageMenuSheet()
            case .siteSettings: SiteSettingsSheet()
            case .settings: SettingsSheet()
            case .spaces: SpacesSheet()
            case .saveWebApp: SaveWebAppSheet()
            }
        }
        .fullScreenCover(isPresented: Binding(get: { DietEngine.shared.isPresented },
                                              set: { DietEngine.shared.isPresented = $0 })) { DietView() }
        .preferredColorScheme(store.settings.appearance.scheme)
        .overlay { ToastLayer() }   // element 10
        .onChange(of: store.sheet) { _, new in
            if new == nil { pm.searchIsNewTab = false }
            systemRecede(new)
        }
    }

    /// Element 4 A keeps the system sheet (its own timing); the page behind still recedes to 96.5% as in the design.
    private func systemRecede(_ new: AppSheet?) {
        // Kept full-bleed like variant C (see PageSheetHost.pagePhase): no recede, so no black edges around the page.
        let wants = false
        if wants {
            systemRecedeOn = true
            pm.recedeScale = 0.965; pm.recedeY = 0
            withAnimation(Motion.smooth(0.34)) { pm.recede = 1 }
        } else if systemRecedeOn {
            systemRecedeOn = false
            withAnimation(Motion.smooth(0.28)) { pm.recede = 0 }
        }
    }
}

/// EXPERIMENT (top bar style): the black pill / flower pill / twin physics pills replace the blur. Drawn once at the root,
/// above the page and the tab switcher, so every style is visible in both. `.blur` draws nothing here (its blur is part of the page).
struct TopStyleOverlay: View {
    @Environment(BrowserStore.self) private var store

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                if store.topStyle == .twinPills {
                    // Two gliding pills either side of the real island (Sources/TwinPills.swift).
                    TwinPills(safeTop: geo.safeAreaInsets.top)
                } else if store.topStyle != .blur {
                    IslandPill(style: store.topStyle, safeTop: geo.safeAreaInsets.top)
                }
            }
        }
    }
}

/// The page itself plus the bottom bar (or the find bar while finding).
struct BrowserPage: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduce
    @State private var findP = 0.0                       // element 11: 0 = bottom bar, 1 = find bar
    @State private var findVariant: MotionVariant = .a   // fixed while the find bar is open, so closing mirrors opening
    // The page ignores the keyboard safe area (so the bottom bar does not jump when the search sheet opens the keyboard), which
    // can leave the find bar under the keyboard. These lift it by exactly the overlap, whatever the safe area did.
    @State private var kbTop: CGFloat = .greatestFiniteMagnitude   // global y of the keyboard's top edge, huge while hidden
    @State private var regionBottom: CGFloat = 0                    // global y of the bottom of the bar area
    @State private var riseLift: CGFloat = 0                        // element 11 C: the lift, set once and ridden with the spring
    private var pm: PageMotionState { .shared }
    private var ridesKeyboard: Bool { findVariant == .c && !reduce }
    private var findLift: CGFloat { ridesKeyboard ? riseLift : max(0, regionBottom - kbTop) }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                pageLayer(geo)
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    if store.editingPill {
                        PillEditBar()   // EXPERIMENT: replaces the bottom bar while the pill is being edited
                    } else {
                        FindSwap(p: findP, variant: findVariant, reduce: reduce, lift: findLift, rides: ridesKeyboard)   // bottom bar <-> find bar (element 11)
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { regionBottom = $0 }
            }
        }
        .background(Color(.systemBackground))
        .ignoresSafeArea(.keyboard)
        .onChange(of: store.findActive) { _, on in runFind(on) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { n in keyboardChanged(n) }
    }

    private func keyboardChanged(_ n: Notification) {
        guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let d = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let top: CGFloat = end.minY >= PMath.screen.height - 1 ? .greatestFiniteMagnitude : end.minY
        if ridesKeyboard {
            // C: the bar rises with the find bar's own spring, so only remember how far
            if top < .greatestFiniteMagnitude, store.findActive { riseLift = max(0, regionBottom - top) }
        } else if reduce || d == 0 {
            kbTop = top
        } else {
            withAnimation(.timingCurve(0.2, 0.9, 0.25, 1, duration: d)) { kbTop = top }
        }
    }

    /// The page, or the blank tab. Swapping to a blank tab from "+" is animated (element 6); every other tab change stays instant.
    @ViewBuilder
    private func pageLayer(_ geo: GeometryProxy) -> some View {
        let v = store.motion(.newTab)
        ZStack(alignment: .top) {
            if let tab = store.selectedTab {
                if tab.isBlank {
                    NewTabView().transition(.newTabIn(v, reduce: reduce))
                } else {
                    ZStack(alignment: .top) {
                        // Edge to edge: the page scrolls under the status bar / Dynamic Island and under the bottom bar.
                        WebContainer(tab: tab).id(tab.id).ignoresSafeArea()
                            .offset(y: findPageShift)
                        if store.topStyle == .blur {
                            TopBlur(height: geo.safeAreaInsets.top + 10, tint: tab.topTint, luma: tab.topLuma)
                                .ignoresSafeArea(edges: .top)
                        }
                    }
                    .transition(.newTabOut(v, reduce: reduce))
                }
            }
        }
        .animation(PageMotion.newTabAnimation(v, reduce: reduce), value: pm.newTabToken)
    }

    /// Element 11 C: the page scrolls up 90 pt to keep matches in view while the find bar rides the keyboard.
    private var findPageShift: CGFloat { (findVariant == .c && !reduce) ? CGFloat(-90 * findP) : 0 }

    private func runFind(_ on: Bool) {
        if on { findVariant = store.motion(.findBar) }
        let a: Animation
        if reduce {
            a = PMath.fade
        } else {
            switch findVariant {
            case .a: a = on ? Motion.smooth(0.3) : Motion.smooth(0.24)
            case .b: a = on ? Motion.snappy(0.34, extraBounce: 0.15) : Motion.snappy(0.28, extraBounce: 0)
            case .c: a = on ? Motion.spring(0.4, bounce: 0.1) : Motion.spring(0.34, bounce: 0)
            }
        }
        withAnimation(a, completionCriteria: .logicallyComplete) {
            findP = on ? 1 : 0
        } completion: {
            if !on, findP == 0 { riseLift = 0 }
        }
    }
}

/// Left and right controls are mirror-image glass circles, the "+" capsule (2 x 36 wide) is centred on the screen.
/// Insets come from `floatingBarInsets()`: `Layout.edge` from the left, right and bottom screen edges, `Layout.gap` above.
/// `find` carries the find-bar takeover (element 11), `driver` the page-load progress (element 7).
struct BottomBar: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduce
    var find = FindFX()
    @State private var driver = LoadDriver()
    private var pm: PageMotionState { .shared }

    private var tab: Tab? { store.selectedTab }
    private var loadVariant: MotionVariant { store.motion(.loadLine) }
    /// Element 7: B and C draw on the plus capsule; A (and Reduce Motion) draws the line above the bar.
    private var fancy: Bool { !reduce && loadVariant != .a }

    var body: some View {
        // Element 11 B: the thumbnail and the chevron slide out, the plus fades, while the find bar stretches from the capsule.
        let slide = find.variant == .b && !find.reduce && find.active
        let fp = find.p
        ZStack {
            HStack(spacing: 0) {
                Button { store.openSwitcher() } label: { thumb }
                    .buttonStyle(MotionPressStyle(spot: false))
                    .offset(x: slide ? CGFloat(-60 * fp) : 0)
                    .opacity(slide ? 1 - PMath.seg(fp, 0, 0.5) : 1)
                Spacer(minLength: 0)
                Button { store.sheet = .pageMenu } label: { GlassCircleLabel(symbol: "chevron.up", size: Layout.barControl) }
                    .buttonStyle(MotionPressStyle())
                    .accessibilityIdentifier("pageMenu")
                    .offset(x: slide ? CGFloat(60 * fp) : 0)
                    .opacity(slide ? 1 - PMath.seg(fp, 0, 0.5) : 1)
            }
            Button(action: plusTapped) { plusLabel }
                .buttonStyle(MotionPressStyle())
                .opacity(slide ? 1 - PMath.seg(fp, 0.15, 0.5) : 1)
        }
        .floatingBarInsets()
        .overlay(alignment: .top) { if !fancy { LoadLine(driver: driver) } }
        .onAppear { syncLoad() }
        .onChange(of: tab?.id) { _, _ in driver.reset(); syncLoad() }
        .onChange(of: tab?.isLoading) { _, _ in syncLoad() }
        .onChange(of: tab?.progress) { _, _ in syncLoad() }
        .onChange(of: loadVariant) { _, _ in syncLoad() }
        .onChange(of: reduce) { _, _ in syncLoad() }
    }

    private func syncLoad() {
        driver.sync(loading: tab?.isLoading == true, real: tab?.progress ?? 0, variant: loadVariant, reduce: reduce)
    }

    /// Variant C turns the plus into a stop cross while a page loads, so while it shows a cross the tap stops the load.
    private func plusTapped() {
        if fancy, loadVariant == .c, tab?.isLoading == true {
            tab?.webView?.stopLoading()
        } else {
            store.sheet = .search(editing: false)
        }
    }

    /// The tab-stack thumbnail; in element 6 C its front card bumps when the old page folds into it.
    private var thumb: some View {
        let sc = Motion.scaled(1)
        let t = tab
        let other = store.orderedTabs.first { $0 !== store.selectedTab }
        return TabStackThumb(tab: t, other: other)
            .keyframeAnimator(initialValue: 1.0, trigger: pm.thumbBump) { _, s in
                TabStackThumb(tab: t, other: other, frontScale: s)
            } keyframes: { _ in
                KeyframeTrack {
                    LinearKeyframe(1.0, duration: 0.21 * sc)
                    CubicKeyframe(1.3, duration: 0.095 * sc)
                    CubicKeyframe(1.0, duration: 0.095 * sc)
                }
            }
    }

    private var plusLabel: some View {
        ZStack {
            if fancy && loadVariant == .b {
                // B: the capsule itself fills with the accent gradient from the left
                Rectangle().fill(LoadStyle.gradient)
                    .scaleEffect(x: max(driver.progress, 0.001), anchor: .leading)
                    .opacity(0.9 * driver.opacity)
                    .clipShape(Capsule())
            }
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .rotationEffect(.degrees(fancy && loadVariant == .c ? 45 * driver.spin : 0))
        }
        .frame(width: Layout.barControl * 2, height: Layout.barControl)
        .glassEffect(.regular.interactive(), in: .capsule)
        .contentShape(Capsule())   // the whole glass shape is tappable, not just the glyph
        .shadow(color: .white.opacity(0.7 * driver.flash), radius: 22 * driver.flash)
        .overlay {
            if fancy && loadVariant == .c {
                // C: a ring traces the capsule outline, then a ripple and a small pulse mark the end
                ZStack {
                    CapsuleTrace().trim(from: 0, to: CGFloat(PMath.clamp(driver.progress)))
                        .stroke(LoadStyle.gradient, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .opacity(driver.opacity)
                    Capsule().stroke(Theme.accentEnd.opacity(0.9), lineWidth: 2)
                        .scaleEffect(PMath.lerp(1, 1.5, driver.ripple))
                        .opacity(driver.ripple > 0 ? 0.85 * (1 - driver.ripple) : 0)
                }
                .padding(-1.5)
                .allowsHitTesting(false)
            }
        }
        .scaleEffect(1 + 0.07 * driver.pulse)
    }
}

/// Two tilted cards behind the current page snapshot, like the tab button in the reference, drawn inside a
/// 44 pt glass circle (the mirror of the chevron circle on the right).
/// Arc-style tab button: exactly two page cards, the back one tilted left with the previous tab, the front one tilted right with this tab.
/// No glass circle around it. The 44 pt frame keeps its left edge on the same 24 pt inset as the chevron's right edge.
struct TabStackThumb: View {
    let tab: Tab?
    let other: Tab?
    var frontScale: CGFloat = 1   // element 6 C: the front card bumps when the old page folds into the stack
    @Environment(\.motionLensPress) private var lens   // element 5 C: 0...1 while the button is held, the cards fan out
    private let cardSize = CGSize(width: 22, height: 30)
    private let cardRadius: CGFloat = 5.5

    var body: some View {
        ZStack {
            card(other?.snapshot, dim: true)
                .rotationEffect(.degrees(-10 - 9 * lens))
                .offset(x: -3 - 3 * lens, y: 1)
            card(tab?.snapshot, dim: false)
                .scaleEffect(frontScale)
                .rotationEffect(.degrees(7 + 9 * lens))
                .offset(x: 3 + 3 * lens, y: 0)
        }
        .frame(width: Layout.barControl, height: Layout.barControl)
        .contentShape(Rectangle())
        .accessibilityLabel("Tabs")
    }

    private func card(_ snapshot: UIImage?, dim: Bool) -> some View {
        ZStack {
            if let s = snapshot {
                Image(uiImage: s).resizable().scaledToFill()
                    .frame(width: cardSize.width, height: cardSize.height, alignment: .top).clipped()
            } else {
                Rectangle().fill(.thinMaterial)
            }
            if dim { Color.black.opacity(0.18) }
        }
        .frame(width: cardSize.width, height: cardSize.height)
        .clipShape(.rect(cornerRadius: cardRadius))
        .overlay(RoundedRectangle(cornerRadius: cardRadius).stroke(.white.opacity(dim ? 0.25 : 0.45), lineWidth: 0.75))
        .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
    }
}

/// Search field and history list share the bottom bar's `Layout.edge` side inset, so their left and right edges line up
/// with the outer edges of the tab-stack circle and the chevron circle.
struct NewTabView: View {
    @Environment(BrowserStore.self) private var store

    var body: some View {
        ZStack {
            Backdrop(palette: store.palette)
            VStack(spacing: Layout.gap) {
                Spacer()
                VStack(spacing: Layout.gap) {
                    if store.isPrivate {
                        Image(systemName: "eyes").font(.system(size: 40))
                        Text("Private").font(.largeTitle.weight(.semibold))
                        Text("Tabs, cookies and history are discarded when you leave Private.")
                            .font(.subheadline).multilineTextAlignment(.center).opacity(0.85)
                    } else {
                        Text(store.currentSpace.name).font(.largeTitle.weight(.semibold))
                    }
                }
                .padding(.bottom, Layout.gap)
                Button { store.sheet = .search(editing: false) } label: {
                    HStack(spacing: Layout.tight) {
                        Image(systemName: "magnifyingglass").frame(width: Layout.glyph, height: Layout.glyph)
                        Text("Search or enter address")
                        Spacer(minLength: 0)
                    }
                    .font(.body)
                    .padding(.horizontal, Layout.capsuleInset(Layout.heroFieldHeight))
                    .frame(height: Layout.heroFieldHeight)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .contentShape(Capsule())   // the whole glass shape is tappable, not just the glyph
                }
                .buttonStyle(.plain)
                WebAppGrid()   // saved web apps (Sources/WebApps)
                DietHomeCard()   // today's Algorithm Diet (Sources/Diet)
                if !store.isPrivate, !store.currentSpace.history.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        // Fewer rows once web apps and the Diet card share the page.
                        ForEach(store.currentSpace.history.prefix(WebAppStore.shared.apps.isEmpty ? 3 : 2)) { h in
                            Button { store.commit(h.url, editing: true) } label: {
                                HStack(spacing: Layout.gap) {
                                    SiteIcon(host: h.host)
                                    Text(h.title.isEmpty ? h.host : h.title).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .sheetRow()
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .glassEffect(.regular, in: .rect(cornerRadius: Layout.cardRadius))
                }
                Spacer()
                Spacer()
            }
            .foregroundStyle(.white)
            .padding(.horizontal, Layout.edge)
        }
    }
}
