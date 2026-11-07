import SwiftUI
import WebKit
import UIKit

/// Design tokens. OpenAI-style calm (neutral surfaces, one accent), iOS 26 glass for floating controls,
/// Arc-style gradient backdrops on the new-tab page, switcher and sheets only (never behind a page).
enum Theme {
    static let accent = Color(hex: 0x5B5BF0)
    static let accentEnd = Color(hex: 0xB45CF2)
    /// Translucent card used inside sheets (glass is kept for floating controls, not nested inside glass).
    static let card = Color.primary.opacity(0.07)
    /// Kept for source compatibility; the single source of truth is `Layout.cardRadius`.
    static var radiusCard: CGFloat { Layout.cardRadius }
}

/// One spacing and rounding system.
/// - Floating bottom controls: 44 pt high (radius 22), the SAME `edge` inset (24 pt) from the left, right and bottom
///   physical screen edges. This is a design choice; the rounding is not strictly concentric with the screen corner.
/// - Inside sheets, nested corners follow inner radius = outer radius - padding (`Layout.inner`).
/// Measured on iPhone 17 Pro (402x874 pt): display corner radius is about 62 pt (circular equivalent).
enum Layout {
    /// Display corner radius in points (iPhone 16/17 Pro class). Reference only: the bottom controls do not derive from it.
    static let screenRadius: CGFloat = 62
    /// Height of round and pill floating controls (their corner radius is half of this).
    static let control: CGFloat = 44
    /// Height of the controls in the bottom bars (page bar, switcher bar, find bar): smaller than `control`, glyphs 16 pt.
    static let barControl: CGFloat = 44   // owner: bigger bar buttons, same edge insets (was 36)
    /// Equal 24 pt inset from the left, right and BOTTOM physical screen edges for floating bottom controls (44 pt high,
    /// radius `control / 2`; not strictly concentric with the 62 pt screen corner, by choice).
    /// Measured from the physical screen edge, so bars ignore the bottom safe area (the home indicator sits inside this gap).
    static let edge: CGFloat = 24
    /// Space between sibling elements (tiles, rows, stacked cards).
    static let gap: CGFloat = 12
    /// Padding between a sheet's edge and its content.
    static let sheetInset: CGFloat = 16
    /// Nested-corner rule: inner radius = outer radius - the padding between them (never below `floor`).
    static func inner(_ outer: CGFloat, inset: CGFloat, floor: CGFloat = 8) -> CGFloat { max(outer - inset, floor) }
}

/// Derived metrics. Every number here follows from the base values above, so two like elements always measure the same.
extension Layout {
    // MARK: Sheets
    /// Assumed corner radius of a presented sheet (iOS 26 sheets, about 38 pt).
    static let sheetRadius: CGFloat = 38
    /// Space between a sheet's top edge (drag indicator) and its first element.
    static let sheetTop: CGFloat = 24
    /// Radius of cards, grouped rows, tiles and the blocking card inside a sheet: 38 - 16 = 22.
    static var cardRadius: CGFloat { inner(sheetRadius, inset: sheetInset) }
    /// Height of every row inside a card and of every list row.
    static let rowHeight: CGFloat = 54
    /// Height of the menu tiles (page menu).
    static let tileHeight: CGFloat = 76
    /// Side of coloured icon tiles and favicon-style letter tiles in rows.
    static let iconTile: CGFloat = 30
    /// Corner radius of an icon tile (same proportion for every size).
    static func iconRadius(_ size: CGFloat) -> CGFloat { size * 0.28 }
    /// Leading separator inset in a card: lines up with the row text (padding + icon tile + gap = 58).
    static var dividerInset: CGFloat { sheetInset + iconTile + gap }
    /// Small gap: tile to caption, glyph to text inside a field.
    static let tight: CGFloat = 8

    // MARK: Capsules and fields
    /// Height of text fields and the URL capsule inside sheets.
    static let fieldHeight: CGFloat = 54
    /// Height of the big glass search field on the new-tab page.
    static var heroFieldHeight: CGFloat { control + 12 }
    /// Side of the glyph slot at the start of a capsule field.
    static let glyph: CGFloat = 20
    /// Horizontal padding that centres the glyph slot on the capsule's end-cap arc centre: (height - glyph) / 2.
    static func capsuleInset(_ height: CGFloat) -> CGFloat { (height - glyph) / 2 }
    /// Inset of a 44 pt button inside a `fieldHeight` capsule (concentric with the cap): (54 - 44) / 2 = 5.
    static var fieldSlotInset: CGFloat { (fieldHeight - control) / 2 }
    /// Height of the +/- stepper inside a row.
    static let stepperHeight: CGFloat = 36

    // MARK: Floating bars
    /// Bottom safe-area inset of the window (the home indicator, 34 pt on iPhone 17 Pro; 0 without one).
    @MainActor static var homeIndicatorInset: CGFloat {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        return window?.safeAreaInsets.bottom ?? 0
    }
    /// Padding below a floating bar's controls so they sit exactly `edge` above the physical screen bottom.
    /// A bar placed in the bottom safe area already has `homeIndicatorInset` below it, so this is `edge - homeIndicatorInset`:
    /// 24 - 34 = -10 on a phone with a home indicator (negative on purpose: the controls reach 10 pt into the safe area),
    /// 24 on a phone without one.
    @MainActor static var barBottomPadding: CGFloat { edge - homeIndicatorInset }
    /// Height of the bottom bar measured from the physical screen bottom: gap + control + edge = 80 pt.
    static var barHeight: CGFloat { gap + barControl + edge }
}

/// Insets shared by the bottom bar and the find bar: controls `edge` (24) from the left and right screen edges,
/// `gap` above them, `edge` above the physical bottom (or `gap` above the keyboard while it is up, because the
/// keyboard replaces the bottom safe area). The `.bar` material still extends to the screen bottom.
struct FloatingBarInsets: ViewModifier {
    var keyboardUp = false
    @State private var reread = 0   // bumped on appear so the window's safe-area inset is read again after the first layout pass
    func body(content: Content) -> some View {
        let _ = reread
        content
            .padding(.horizontal, Layout.edge)
            .padding(.top, Layout.gap)
            .padding(.bottom, keyboardUp ? Layout.gap : Layout.barBottomPadding)
            .animation(.smooth(duration: 0.25), value: keyboardUp)
            .background { PageBlurBackground() }
            .environment(\.colorScheme, pageScheme ?? appScheme)   // light page -> light bar with dark icons, dark page -> dark bar
            .onAppear { reread += 1 }
    }

    /// Light or dark, from the average colour of the page strip under the bar (nil on the new-tab page).
    private var pageScheme: ColorScheme? {
        guard let tab = store.selectedTab, !tab.isBlank, let l = tab.bottomLuma else { return nil }
        return l > 0.55 ? .light : .dark
    }
    @Environment(BrowserStore.self) private var store
    @Environment(\.colorScheme) private var appScheme
}

/// The bar's background: a blur of the page scrolling underneath, mixed with the page's average colour, with a hard
/// straight top edge (no fade) marked by a hairline.
struct PageBlurBackground: View {
    @Environment(BrowserStore.self) private var store

    var body: some View {
        let tab = store.selectedTab
        let tint = (tab?.isBlank == false) ? tab?.bottomTint : nil
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            if let tint { Rectangle().fill(tint.opacity(0.32)) }
        }
        .overlay(alignment: .top) { Rectangle().fill(.primary.opacity(0.10)).frame(height: 0.5) }
        .ignoresSafeArea(edges: .bottom)
        .animation(.easeOut(duration: 0.3), value: tint)
    }
}

/// Light blur that lets the page run up behind the status bar and Dynamic Island and fades out toward the top edge.
/// Kept thin on purpose so the page stays visible; the clock and the status icons get a soft glow behind them
/// (dark under white text, light under dark text) instead of a heavy scrim.
struct TopBlur: View {
    let height: CGFloat
    let tint: Color?
    var luma: Double?
    @Environment(\.colorScheme) private var scheme

    /// Extra lift only when the page is the opposite brightness of the status text (small, the glows do most of the work).
    private var scrim: Color {
        guard let luma else { return .clear }
        if scheme == .dark, luma > 0.55 { return .black.opacity(0.12) }
        if scheme == .light, luma < 0.45 { return .white.opacity(0.12) }
        return .clear
    }
    private var glow: Color { scheme == .dark ? .black.opacity(0.26) : .white.opacity(0.5) }

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial).opacity(0.5)
            if let tint { Rectangle().fill(tint.opacity(0.12)) }
            Rectangle().fill(scrim)
        }
        .frame(height: height)
        .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.3),
                                     .init(color: .clear, location: 1)],
                             startPoint: .top, endPoint: .bottom))
        .overlay {
            // Clock on the left, signal / wifi / battery on the right (iPhone 17 Pro proportions), vertically centred in the status row.
            GeometryReader { g in
                let y = (height - 10) * 0.53
                Ellipse().fill(glow).frame(width: 96, height: 34).blur(radius: 16).position(x: g.size.width * 0.185, y: y)
                Ellipse().fill(glow).frame(width: 122, height: 34).blur(radius: 16).position(x: g.size.width * 0.81, y: y)
            }
        }
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.3), value: tint)
    }
}

extension View {
    /// Places a row of 44 pt floating controls with the shared `Layout.edge` / `Layout.gap` insets.
    func floatingBarInsets(keyboardUp: Bool = false) -> some View { modifier(FloatingBarInsets(keyboardUp: keyboardUp)) }
    /// Card surface with the shared nested radius (`Layout.cardRadius`).
    func cardBackground() -> some View { background(Theme.card, in: .rect(cornerRadius: Layout.cardRadius)) }
    /// One row inside a card: `sheetInset` horizontal padding, `rowHeight` tall.
    func sheetRow() -> some View { padding(.horizontal, Layout.sheetInset).frame(height: Layout.rowHeight) }
}

struct Backdrop: View {
    let palette: SpacePalette
    var body: some View {
        let c = palette.colors
        ZStack {
            LinearGradient(colors: [c[0], c[1], c[2]], startPoint: .topLeading, endPoint: .bottomTrailing)
            RadialGradient(colors: [.white.opacity(0.20), .clear], center: .topTrailing, startRadius: 0, endRadius: 460)
        }
        .ignoresSafeArea()
    }
}

/// Rounded-square coloured icon used in settings rows.
struct IconTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = Layout.iconTile
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color, in: .rect(cornerRadius: Layout.iconRadius(size)))
    }
}

struct LetterTile: View {
    let text: String
    var size: CGFloat = Layout.iconTile
    var body: some View {
        let seed = abs(text.hashValue % 360)
        Text(String(text.replacingOccurrences(of: "www.", with: "").prefix(1)).uppercased())
            .font(.system(size: size * 0.5, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(hue: Double(seed) / 360, saturation: 0.45, brightness: 0.62), in: .rect(cornerRadius: Layout.iconRadius(size)))
    }
}

struct FaviconView: View {
    let tab: Tab
    var size: CGFloat = 20
    var body: some View {
        if let f = tab.favicon {
            Image(uiImage: f).resizable().scaledToFit()
                .frame(width: size, height: size)
                .clipShape(.rect(cornerRadius: Layout.iconRadius(size)))
        } else {
            SiteIcon(host: tab.url?.host, size: size)   // restored and suspended tabs: from the cache
        }
    }
}

/// A site's cached favicon, or a coloured letter tile until one is available (the cache looks it up in the background).
struct SiteIcon: View {
    let host: String?
    var size: CGFloat = Layout.iconTile
    var body: some View {
        if let img = FaviconStore.shared.image(for: host) {
            Image(uiImage: img).resizable().scaledToFit()
                .frame(width: size, height: size)
                .clipShape(.rect(cornerRadius: Layout.iconRadius(size)))
        } else {
            LetterTile(text: host ?? "?", size: size)
        }
    }
}

/// Rounded, translucent group used for rows inside sheets. Always full width, so every card shares the same edges.
struct CardGroup<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .frame(maxWidth: .infinity)
            .cardBackground()
    }
}

/// Round glass control (44 pt by default) around any content. The bar's left and right controls both use it, so they mirror each other.
struct GlassCircle<Content: View>: View {
    var size: CGFloat = Layout.control
    @ViewBuilder var content: Content
    var body: some View {
        content
            .frame(width: size, height: size)
            .glassEffect(.regular.interactive(), in: .circle)
            .contentShape(Circle())   // the whole glass shape is tappable, not just the glyph
    }
}

struct GlassCircleLabel: View {
    let symbol: String
    var size: CGFloat = Layout.control
    var body: some View {
        GlassCircle(size: size) {
            Image(systemName: symbol).font(.system(size: size * 0.4, weight: .semibold))
        }
    }
}

/// Hosts a WKWebView that runs edge to edge (under the status bar and under the bottom bar). WebKit already insets the
/// content by the safe area; this adds the part of the bottom bar that is taller than the home indicator, so the end of a
/// page can be scrolled clear of the bar while the rest scrolls underneath it.
final class WebHostView: UIView {
    var barHeight: CGFloat = Layout.barHeight { didSet { applyInsets() } }
    weak var webView: WKWebView?

    override func layoutSubviews() {
        super.layoutSubviews()
        webView?.frame = bounds
        applyInsets()
    }
    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        applyInsets()
    }
    private func applyInsets() {
        guard let sv = webView?.scrollView else { return }
        let home = max(safeAreaInsets.bottom, window?.safeAreaInsets.bottom ?? 0)
        let extra = max(0, barHeight - home)
        if sv.contentInset.bottom != extra { sv.contentInset.bottom = extra }
        sv.verticalScrollIndicatorInsets.bottom = extra
    }
}

struct WebContainer: UIViewRepresentable {
    let tab: Tab
    func makeUIView(context: Context) -> WebHostView {
        let v = WebHostView()
        v.backgroundColor = .clear
        return v
    }
    func updateUIView(_ container: WebHostView, context: Context) {
        let wv = tab.ensureWebView()
        guard wv.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        wv.frame = container.bounds
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(wv)
        container.webView = wv
        container.setNeedsLayout()
    }
}
