import SwiftUI

/// Element 12 (tab archived and restored) and element 5 (press feedback variants live in `MotionPressStyle`, Motion.swift).
/// Manual archiving (`BrowserStore.archive`), the Archive screen with its animated rows and the count pill live here.
/// The numbers (timings, offsets, segment ranges) come from `v12A`/`v12B`/`v12C` in design/animations.html. The design page
/// drives one progress value p (0 = tab in its list, 1 = archived) through render functions made of `seg()` windows; the same
/// functions are used here on an animated CGFloat, through `Animatable` modifiers that SwiftUI calls on every frame.

enum ArchiveMotion {
    /// One honest line per element where an alternative is limited or approximated (shown under the picker in Settings > Motion).
    static let notes: [MotionElement: String] = [
        .press: "B rebounds only about 1.5% with the spec's spring (the page text says 105%). C: the stack thumbnail fan-out is not wired yet (needs a hook in App.swift); the system glass adds its own touch response.",
        .archive: "Animates in Settings > Archive (restore, delete, Archive This Tab). Page menu > Archive Tab only swaps the page and toasts. C flies a restored row into the pill too, since the tab list is off screen.",
    ]
}

// MARK: - Manual archive (page menu, Archive screen)

extension BrowserStore {
    /// Pinned, blank and private tabs are never archived; the tab has to belong to the current Space.
    func canArchive(_ tab: Tab) -> Bool {
        !isPrivate && !tab.isPinned && tab.url != nil && currentSpace.tabs.contains { $0 === tab }
    }

    /// Moves the tab to the current Space's archive like `archiveInactive` does, then shows a neighbouring tab (or a blank one).
    func archive(_ tab: Tab) {
        guard canArchive(tab), let url = tab.url else { return }
        let space = currentSpace
        let wasSelected = selectedTab === tab
        let idx = space.tabs.firstIndex { $0 === tab }
        space.archive.removeAll { $0.id == tab.id }
        space.archive.insert(ArchivedTab(id: tab.id, url: url.absoluteString, title: tab.displayTitle, archivedAt: .now), at: 0)
        if space.archive.count > 500 { space.archive.removeLast(space.archive.count - 500) }
        tab.releaseWebView()
        space.tabs.removeAll { $0 === tab }
        if space.tabs.isEmpty {
            let blank = Tab(url: nil, spaceID: space.id, store: self)
            space.tabs = [blank]
            select(blank)
        } else if wasSelected {
            let next = idx.flatMap { space.tabs.indices.contains($0) ? space.tabs[$0] : nil } ?? space.tabs[space.tabs.count - 1]
            select(next)
        }
        scheduleSave()
        showToast("Archived")
    }
}

// MARK: - Render functions from the design page

/// A, B, C as on the design page; `reduced` is Reduce Motion: a short plain cross-fade, nothing moves or scales.
enum ArchiveStyle { case a, b, c, reduced }

enum ArchiveFx {
    static func seg(_ p: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat { min(1, max(0, (p - a) / (b - a))) }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }
    static func clamp(_ x: CGFloat) -> CGFloat { min(1, max(0, x)) }

    /// Share of one row pitch the rows below have already moved up (the gap closing).
    static func gap(_ s: ArchiveStyle, _ p: CGFloat) -> CGFloat {
        switch s {
        case .a: seg(p, 0.25, 1)
        case .b: seg(p, 0.4, 1)
        case .c: seg(p, 0.2, 0.85)
        case .reduced: 0
        }
    }

    /// Window of p in which the count rolls.
    static func rollWindow(_ s: ArchiveStyle) -> (CGFloat, CGFloat) {
        switch s {
        case .a: (0.5, 1)
        case .b: (0.6, 1)
        case .c: (0.75, 1)
        case .reduced: (0, 1)
        }
    }

    /// Pill scale: B pops by 12 percent, C pulses by 10 percent, A does not move the pill.
    static func pulse(_ s: ArchiveStyle, _ p: CGFloat) -> CGFloat {
        switch s {
        case .a, .reduced: 1
        case .b: 1 + 0.12 * sin(.pi * seg(p, 0.7, 1))
        case .c: 1 + 0.10 * sin(.pi * seg(p, 0.75, 1))
        }
    }

    /// C: the lid of the archive icon tilts.
    static func lid(_ s: ArchiveStyle, _ p: CGFloat) -> Double {
        s == .c ? Double(-16 * sin(.pi * seg(p, 0.7, 1))) : 0
    }
}

/// What a row in motion does. `p` follows the design page: leaving the list p goes 0 to 1, entering it p goes 1 to 0.
struct ArchiveRowFx: ViewModifier, Animatable {
    enum Role { case rest, mover, header, below }
    var role: Role
    var style: ArchiveStyle
    var p: CGFloat
    /// `.below`: distance the rows below travel (row height + gap, plus the day title when that leaves too).
    var pitch: CGFloat = 0
    /// C: from the row centre to the centre of the pill icon.
    var flight: CGSize = .zero
    /// A swiped row starts leaving from where the finger left it.
    var startX: CGFloat = 0
    /// C draws the flying row in an overlay; the copy in the list stays invisible.
    var flyer = false

    var animatableData: CGFloat {
        get { p }
        set { p = newValue }
    }

    func body(content: Content) -> some View {
        let t = transform
        content.scaleEffect(t.scale).offset(x: t.x, y: t.y).opacity(t.opacity)
    }

    private var transform: (scale: CGFloat, x: CGFloat, y: CGFloat, opacity: Double) {
        typealias F = ArchiveFx
        switch role {
        case .rest:
            return (1, 0, 0, 1)
        case .below:
            return (1, 0, -pitch * F.gap(style, p), 1)
        case .header:
            return (1, 0, 0, style == .reduced ? Double(1 - p) : Double(1 - F.seg(p, 0, 0.6)))
        case .mover:
            let swipe = startX * (1 - F.seg(p, 0, 0.35))
            switch style {
            case .a:
                return (1, F.lerp(0, 120, p) + swipe, 0, Double(1 - F.seg(p, 0.15, 0.85)))
            case .b:
                let a = F.seg(p, 0, 0.35), b = F.seg(p, 0.35, 1)
                return (1, -110 * a - 330 * b + swipe, 0, 1)
            case .c:
                guard flyer else { return (1, 0, 0, 0) }
                let d = F.clamp(p)
                let ex = 1 - (1 - d) * (1 - d), ey = d * d
                return (F.lerp(1, 0.16, d), flight.width * ex + swipe, flight.height * ey, Double(1 - F.seg(p, 0.8, 1)))
            case .reduced:
                return (1, 0, 0, Double(1 - p))
            }
        }
    }
}

enum ArchiveRunKind { case restore, delete, archive }

/// B: the accent action behind the row that slides away (Restore, Delete, or Archive when a row arrives).
struct ArchiveActionLayer: View, Animatable {
    var style: ArchiveStyle
    var kind: ArchiveRunKind
    var p: CGFloat

    var animatableData: CGFloat {
        get { p }
        set { p = newValue }
    }

    var body: some View {
        let a = ArchiveFx.seg(p, 0, 0.35)
        let o = style == .b ? a * (1 - ArchiveFx.seg(p, 0.55, 0.85)) : 0
        let shape = RoundedRectangle(cornerRadius: Layout.cardRadius, style: .continuous)
        shape
            .fill(kind == .delete
                  ? AnyShapeStyle(Color.red)
                  : AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accentEnd], startPoint: .leading, endPoint: .trailing)))
            .overlay(alignment: .trailing) {
                Image(systemName: kind == .delete ? "trash.fill" : kind == .restore ? "arrow.uturn.backward" : "archivebox.fill")
                    .font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                    .padding(.trailing, 22)
            }
            .opacity(Double(o))
            .allowsHitTesting(false)
    }
}

// MARK: - Count pill

/// Old number rolls out, the new one rolls in (up when the count grows, down when it falls). Reduce Motion: cross-fade.
private struct RollingCount: View {
    let from: Int
    let to: Int
    let k: CGFloat
    let style: ArchiveStyle

    var body: some View {
        let dir: CGFloat = to > from ? -1 : 1
        let travel: CGFloat = style == .reduced ? 0 : 18
        ZStack {
            Text("\(max(from, to))").hidden()
            Text("\(from)").offset(y: dir * travel * k).opacity(Double(1 - k))
            Text("\(to)").offset(y: -dir * travel * (1 - k)).opacity(Double(k))
        }
        .monospacedDigit()
        .frame(height: 18)
        .clipped()
    }
}

/// Icon, title and rolling count. Animatable so the roll and the lid tilt follow p on every frame.
struct ArchivePillFace: View, Animatable {
    var style: ArchiveStyle
    /// nil = at rest (shows `to`), true = a row is arriving (p goes 1 to 0), false = a row is leaving (p goes 0 to 1).
    var entering: Bool?
    var from: Int
    var to: Int
    var p: CGFloat
    @Binding var iconCenter: CGPoint

    var animatableData: CGFloat {
        get { p }
        set { p = newValue }
    }

    var body: some View {
        let w = ArchiveFx.rollWindow(style)
        let k: CGFloat = switch entering {
        case nil: 1
        case true?: 1 - ArchiveFx.seg(p, w.0, w.1)
        case false?: ArchiveFx.seg(p, w.0, w.1)
        }
        HStack(spacing: 8) {
            Image(systemName: "archivebox.fill")
                .rotationEffect(.degrees(ArchiveFx.lid(style, p)))
                .onGeometryChange(for: CGPoint.self) {
                    let f = $0.frame(in: .named("archive")); return CGPoint(x: f.midX, y: f.midY)
                } action: { iconCenter = $0 }
            Text("Archive")
            RollingCount(from: from, to: to, k: k, style: style)
        }
        .font(.system(size: 15, weight: .semibold))
        .padding(.horizontal, 20)
        .frame(height: Layout.control)
    }
}

private struct ArchivePillPulse: ViewModifier, Animatable {
    var style: ArchiveStyle
    var p: CGFloat
    var animatableData: CGFloat {
        get { p }
        set { p = newValue }
    }
    func body(content: Content) -> some View { content.scaleEffect(ArchiveFx.pulse(style, p)) }
}

// MARK: - Archive screen

struct ArchiveDayGroup: Identifiable {
    let title: String
    let items: [ArchivedTab]
    var id: String { title }
}

/// One archived tab as a card.
struct ArchiveRowCard: View {
    let item: ArchivedTab
    var body: some View {
        HStack(spacing: Layout.gap) {
            SiteIcon(host: item.host)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).lineLimit(1).foregroundStyle(.primary)
                Text(item.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Layout.sheetInset)
        .frame(maxWidth: .infinity)
        .frame(height: Layout.rowHeight)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: Layout.cardRadius, style: .continuous))
        .contentShape(.rect(cornerRadius: Layout.cardRadius, style: .continuous))
    }
}

/// The plain button style dims its label, which let the red swipe layer shine through the card. This only tints it.
private struct ArchiveRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.overlay {
            RoundedRectangle(cornerRadius: Layout.cardRadius, style: .continuous)
                .fill(Color.primary.opacity(configuration.isPressed ? 0.06 : 0))
                .allowsHitTesting(false)
        }
    }
}

private enum ArchiveLayout {
    static let rowGap = Layout.tight
    static let headerHeight: CGFloat = 34
    static let swipeWidth: CGFloat = 88
    static let fullSwipe: CGFloat = 190
    static var rowPitch: CGFloat { Layout.rowHeight + rowGap }
}

/// One row of the Archive screen: card, swipe-to-delete, the motion roles.
private struct ArchiveRowCell: View {
    let item: ArchivedTab
    let role: ArchiveRowFx.Role      // .rest, .mover or .below
    let style: ArchiveStyle
    let kind: ArchiveRunKind?
    let p: CGFloat
    let pitch: CGFloat
    let flight: CGSize
    let startX: CGFloat
    let editing: Bool
    let onRestore: (CGRect) -> Void
    let onDelete: (CGRect, CGFloat) -> Void
    let onFrame: (CGRect) -> Void

    @State private var frame = CGRect.zero
    @State private var dragX: CGFloat = 0
    @State private var horizontal = false
    @State private var base: CGFloat = 0
    /// True from the moment a horizontal swipe starts until just after it ends, so lifting the finger does not also tap the row.
    @State private var swiped = false

    var body: some View {
        let isMover = role == .mover
        HStack(spacing: ArchiveLayout.rowGap) {
            if editing {
                Button { onDelete(frame, 0) } label: {
                    Image(systemName: "minus.circle.fill")
                        .symbolRenderingMode(.palette).foregroundStyle(.white, .red)
                        .font(.system(size: 24))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Delete \(item.title)")
                .modifier(ArchiveRowFx(role: isMover ? .header : .rest, style: style, p: p))
                .transition(.opacity.combined(with: .move(edge: .leading)))
            }
            ZStack {
                if isMover, let kind {
                    ArchiveActionLayer(style: style, kind: kind, p: p)
                } else {
                    swipeLayer
                }
                Button {
                    if swiped { return }   // the finger that just swiped is lifting: not a tap
                    if dragX < -1 { withAnimation(Motion.smooth(0.25)) { dragX = 0 }; return }   // a row left open closes first
                    if !editing { onRestore(frame) }
                } label: { ArchiveRowCard(item: item) }
                    .buttonStyle(ArchiveRowButtonStyle())
                    .offset(x: isMover ? 0 : dragX)
                    .modifier(ArchiveRowFx(role: isMover ? .mover : .rest, style: style, p: p, flight: flight, startX: startX))
                    .simultaneousGesture(swipe)
                    .contextMenu {
                        Button { onRestore(frame) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                        Button(role: .destructive) { onDelete(frame, 0) } label: { Label("Delete", systemImage: "trash") }
                    }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("archive")) } action: { f in
                frame = f
                if isMover { onFrame(f) }
            }
        }
        .frame(height: Layout.rowHeight)
        .padding(.bottom, ArchiveLayout.rowGap)
        .modifier(ArchiveRowFx(role: role == .below ? .below : .rest, style: style, p: p, pitch: pitch))
        .onChange(of: editing) { _, on in if on { dragX = 0 } }
    }

    /// Red Delete button revealed under a row that is swiped to the left.
    private var swipeLayer: some View {
        RoundedRectangle(cornerRadius: Layout.cardRadius, style: .continuous)
            .fill(Color.red)
            .overlay(alignment: .trailing) {
                Button { onDelete(frame, dragX) } label: {
                    Text("Delete").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: ArchiveLayout.swipeWidth, height: Layout.rowHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .opacity(dragX < -1 ? 1 : 0)
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { g in
                guard !editing, role == .rest else { return }
                if !horizontal {
                    guard abs(g.translation.width) > abs(g.translation.height) * 1.4 else { return }
                    horizontal = true
                    swiped = true
                    base = dragX
                }
                dragX = min(0, max(-ArchiveLayout.fullSwipe - 40, base + g.translation.width))
            }
            .onEnded { _ in
                guard horizontal else { return }
                horizontal = false
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(250))
                    swiped = false
                }
                if dragX < -ArchiveLayout.fullSwipe {
                    onDelete(frame, dragX)
                } else {
                    withAnimation(Motion.smooth(0.25)) { dragX = dragX < -ArchiveLayout.swipeWidth * 0.5 ? -ArchiveLayout.swipeWidth : 0 }
                }
            }
    }
}

struct ArchiveScreen: View {
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Run {
        let token = UUID()
        var kind: ArchiveRunKind
        var item: ArchivedTab
        /// Index in the shown list (a row that leaves is kept on screen until its animation ends).
        var index: Int
        var startX: CGFloat
        var then: (() -> Void)?
    }

    @State private var query = ""
    @State private var editing = false
    @State private var run: Run?
    @State private var p: CGFloat = 0
    @State private var moverFrame = CGRect.zero
    @State private var pillIcon = CGPoint.zero

    private var style: ArchiveStyle {
        if reduceMotion { return .reduced }
        switch store.motion(.archive) {
        case .a: return .a
        case .b: return .b
        case .c: return .c
        }
    }

    private func filtered(_ all: [ArchivedTab]) -> [ArchivedTab] {
        guard !query.isEmpty else { return all }
        return all.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.url.localizedCaseInsensitiveContains(query) }
    }

    /// The archive as shown: a row that is leaving stays in place until its animation has finished.
    private var shown: [ArchivedTab] {
        var list = filtered(store.currentSpace.archive)
        if let r = run, r.kind != .archive, !list.contains(where: { $0.id == r.item.id }) {
            list.insert(r.item, at: min(r.index, list.count))
        }
        return list
    }

    private func groups(of items: [ArchivedTab]) -> [ArchiveDayGroup] {
        let cal = Calendar.current
        let dict = Dictionary(grouping: items) { cal.startOfDay(for: $0.archivedAt) }
        return dict.keys.sorted(by: >).map { day in
            let title = cal.isDateInToday(day) ? "Today" : cal.isDateInYesterday(day) ? "Yesterday"
                : day.formatted(date: .abbreviated, time: .omitted)
            return ArchiveDayGroup(title: title, items: dict[day]!)
        }
    }

    var body: some View {
        let list = shown
        let groups = groups(of: list)
        let roles = roles(for: groups)
        let count = store.currentSpace.archive.count
        ZStack(alignment: .topLeading) {
            Color(.systemGroupedBackground).ignoresSafeArea()
            ScrollView {
                LazyVStack(spacing: 0) {
                    archiveThisTab
                    if list.isEmpty {
                        ContentUnavailableView("Nothing archived", systemImage: "archivebox",
                            description: Text("Tabs you haven't opened for \(store.settings.archiveAfter == .never ? "a long while" : store.settings.archiveAfter.title.lowercased()) end up here."))
                            .padding(.top, 40)
                    }
                    ForEach(groups) { group in
                        Text(group.title)
                            .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: ArchiveLayout.headerHeight, maxHeight: ArchiveLayout.headerHeight, alignment: .bottomLeading)
                            .padding(.leading, Layout.sheetInset).padding(.bottom, 6)
                            .modifier(ArchiveRowFx(role: roles.headers[group.title] ?? .rest, style: style, p: p, pitch: roles.pitch))
                        ForEach(group.items) { item in
                            ArchiveRowCell(
                                item: item, role: roles.rows[item.id] ?? .rest, style: style,
                                kind: run?.item.id == item.id ? run?.kind : nil,
                                p: p, pitch: roles.pitch, flight: flight, startX: run?.startX ?? 0, editing: editing,
                                onRestore: { restore(item, frame: $0) },
                                onDelete: { delete(item, frame: $0, startX: $1) },
                                onFrame: { moverFrame = $0 })
                        }
                    }
                }
                .padding(.horizontal, Layout.sheetInset)
                .padding(.bottom, Layout.gap)
            }
            .allowsHitTesting(run?.kind != .restore)
            .safeAreaInset(edge: .bottom) {
                ArchivePillView(style: style, run: run.map { ($0.kind == .archive) }, count: count, p: p, iconCenter: $pillIcon)
                    .padding(.bottom, Layout.gap)
                    .frame(maxWidth: .infinity)
            }
            flyer
        }
        .coordinateSpace(name: "archive")
        .searchable(text: $query, prompt: "Search")
        .navigationTitle("Archive")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(editing ? "Done" : "Edit") { withAnimation(Motion.smooth(0.25)) { editing.toggle() } }
                    .disabled(list.isEmpty)
            }
        }
    }

    // MARK: roles

    private struct Roles {
        var rows: [UUID: ArchiveRowFx.Role] = [:]
        var headers: [String: ArchiveRowFx.Role] = [:]
        var pitch: CGFloat = ArchiveLayout.rowPitch
    }

    private func roles(for groups: [ArchiveDayGroup]) -> Roles {
        var r = Roles()
        guard let mover = run?.item.id else { return r }
        var passed = false
        for g in groups {
            let hasMover = g.items.contains { $0.id == mover }
            r.headers[g.title] = passed ? .below : (hasMover && g.items.count == 1 ? .header : .rest)
            if hasMover && g.items.count == 1 { r.pitch += ArchiveLayout.headerHeight + 6 }
            for it in g.items {
                if it.id == mover { r.rows[it.id] = .mover; passed = true } else { r.rows[it.id] = passed ? .below : .rest }
            }
        }
        return r
    }

    private var flight: CGSize {
        CGSize(width: pillIcon.x - moverFrame.midX, height: pillIcon.y - moverFrame.midY)
    }

    // MARK: Archive the tab that is open (shows the arrival of a row)

    @ViewBuilder private var archiveThisTab: some View {
        if let tab = store.selectedTab, store.canArchive(tab) {
            Button { archiveCurrent(tab) } label: {
                HStack(spacing: Layout.gap) {
                    IconTile(symbol: "archivebox", color: .purple)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Archive This Tab").foregroundStyle(.primary)
                        Text(tab.displayTitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Layout.sheetInset)
                .frame(height: Layout.rowHeight)
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: Layout.cardRadius, style: .continuous))
                .contentShape(.rect(cornerRadius: Layout.cardRadius, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.top, Layout.gap)
        }
    }

    // MARK: C: the row that flies to or from the pill

    @ViewBuilder private var flyer: some View {
        if style == .c, let r = run, moverFrame.width > 0 {
            let item = r.kind == .archive ? (store.currentSpace.archive.first { $0.id == r.item.id } ?? r.item) : r.item
            ArchiveRowCard(item: item)
                .frame(width: moverFrame.width, height: moverFrame.height)
                .modifier(ArchiveRowFx(role: .mover, style: .c, p: p, flight: flight, startX: r.startX, flyer: true))
                .position(x: moverFrame.midX, y: moverFrame.midY)
                .allowsHitTesting(false)
        }
    }

    // MARK: running an animation

    private func leaveAnimation() -> Animation {
        switch style {
        case .a: Motion.easeOut(0.34)
        case .b: Motion.spring(0.34, bounce: 0.3)
        case .c: Motion.spring(0.42, bounce: 0.16)
        case .reduced: Motion.easeInOut(0.15)
        }
    }

    private func enterAnimation() -> Animation {
        switch style {
        case .a: Motion.easeOut(0.3)
        case .b: Motion.spring(0.3, bounce: 0.1)
        case .c: Motion.spring(0.36, bounce: 0.1)
        case .reduced: Motion.easeInOut(0.15)
        }
    }

    private func settle(_ token: UUID) {
        guard run?.token == token else { return }
        let then = run?.then
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { run = nil; p = 0; moverFrame = .zero }
        then?()
    }

    /// Starts a row animation. `mutate` changes the model right away (so the data is never behind the picture);
    /// the row stays on screen until the animation has ended.
    private func begin(_ kind: ArchiveRunKind, item: ArchivedTab, index: Int, frame: CGRect?, startX: CGFloat,
                       then: (() -> Void)? = nil, mutate: () -> Void) {
        if let old = run { settle(old.token) }
        var t = Transaction()
        t.disablesAnimations = true
        let entering = kind == .archive
        var started: Run?
        withTransaction(t) {
            if let frame { moverFrame = frame }
            p = entering ? 1 : 0
            mutate()
            let r = Run(kind: kind, item: item, index: index, startX: startX, then: then)
            run = r
            started = r
        }
        guard let r = started else { return }
        let target: CGFloat = entering ? 0 : 1
        let anim = entering ? enterAnimation() : leaveAnimation()
        Task { @MainActor in
            // One layout pass with the row in its first pose, then the animation starts.
            try? await Task.sleep(for: .milliseconds(entering ? 40 : 1))
            guard run?.token == r.token else { return }
            withAnimation(anim, completionCriteria: .logicallyComplete) { p = target } completion: { settle(r.token) }
        }
    }

    private func restore(_ item: ArchivedTab, frame: CGRect) {
        guard URL(string: item.url) != nil, run?.kind != .restore else { return }
        let index = filtered(store.currentSpace.archive).firstIndex { $0.id == item.id } ?? 0
        begin(.restore, item: item, index: index, frame: frame, startX: 0, then: {
            store.sheet = nil
            store.showSwitcher = false
        }, mutate: { store.restore(item) })
    }

    private func delete(_ item: ArchivedTab, frame: CGRect, startX: CGFloat) {
        guard run?.kind != .restore else { return }
        let index = filtered(store.currentSpace.archive).firstIndex { $0.id == item.id } ?? 0
        begin(.delete, item: item, index: index, frame: frame, startX: startX, mutate: {
            store.currentSpace.archive.removeAll { $0.id == item.id }
            store.scheduleSave()
        })
    }

    private func archiveCurrent(_ tab: Tab) {
        guard run == nil, let url = tab.url else { return }
        let placeholder = ArchivedTab(id: tab.id, url: url.absoluteString, title: tab.displayTitle, archivedAt: .now)
        begin(.archive, item: placeholder, index: 0, frame: nil, startX: 0, mutate: { store.archive(tab) })
    }
}

/// The glass pill at the bottom with the Archive count. Pulses and rolls its number with each change.
private struct ArchivePillView: View {
    let style: ArchiveStyle
    /// nil = no row in motion, true = a row arrives, false = a row leaves.
    let run: Bool?
    let count: Int
    let p: CGFloat
    @Binding var iconCenter: CGPoint

    var body: some View {
        let from: Int = switch run {
        case nil: count
        case true?: count - 1
        case false?: count + 1
        }
        ArchivePillFace(style: style, entering: run, from: from, to: count, p: p, iconCenter: $iconCenter)
            .glassEffect(.regular, in: .capsule)
            .modifier(ArchivePillPulse(style: style, p: p))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Archive, \(count) tabs")
    }
}
