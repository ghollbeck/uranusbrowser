import SwiftUI

// MARK: - Which animation the owner picked for each moment
//
// The twelve moments and their three alternatives (A calm, B snappy, C expressive) come from design/animations.html.
// Picks are stored in AppSettings.motion and can be changed live in Settings > Motion. A view asks the store for its
// variant (`store.motion(.switcher)`) and animates accordingly. Missing pick = A.

enum MotionElement: Int, CaseIterable, Identifiable {
    case switcher = 1, cardClose, carousel, sheet, press, newTab, loadLine, space, privateToggle, toast, findBar, archive
    var id: Int { rawValue }

    var title: String {
        switch self {
        case .switcher: "Open and close the tab switcher"
        case .cardClose: "Swipe a card up to close it"
        case .carousel: "Carousel between cards"
        case .sheet: "Present and dismiss a sheet"
        case .press: "Press feedback on glass buttons"
        case .newTab: "New tab from the plus button"
        case .loadLine: "Page-load progress"
        case .space: "Switching Space"
        case .privateToggle: "Private mode toggle"
        case .toast: "Toast confirmation"
        case .findBar: "Find bar replacing the bottom bar"
        case .archive: "Tab archived and restored"
        }
    }

    /// Where to see it in the app.
    var hint: String {
        switch self {
        case .switcher: "Tap the tab thumbnail"
        case .cardClose: "In the switcher, swipe a card up"
        case .carousel: "In the switcher, drag the cards sideways"
        case .sheet: "Open the page menu (chevron) or search (+)"
        case .press: "Press the bottom-bar buttons"
        case .newTab: "Switcher > +, then the search sheet"
        case .loadLine: "Open any page and watch the bar"
        case .space: "Switcher > Space chip > pick another Space"
        case .privateToggle: "Switcher > eyes button"
        case .toast: "Page menu > copy link"
        case .findBar: "Page menu > Find on Page"
        case .archive: "Page menu > Archive tab, or restore from Archive"
        }
    }
}

enum MotionVariant: String, Codable, CaseIterable, Identifiable {
    case a, b, c
    var id: String { rawValue }
    var letter: String { rawValue.uppercased() }
    var title: String {
        switch self {
        case .a: "A  Calm"
        case .b: "B  Snappy"
        case .c: "C  Expressive"
        }
    }
}

struct MotionSettings: Codable, Equatable {
    /// Keyed by the element's number as a string ("1" ... "12").
    var picks: [String: MotionVariant] = [:]
    /// Multiplies every duration by 4 so details are visible (same as the design page's slow motion).
    var slowMotion = false

    /// The owner's choices from the design page (2026-10-29): 1C 2A 3C 4C 5A 6C 7C 8C 9C 10A 11B 12B.
    /// A moment without an explicit pick uses these, so a fresh install (and "Reset") shows exactly this set.
    static let ownerPicks: [MotionElement: MotionVariant] = [
        .switcher: .c, .cardClose: .a, .carousel: .c, .sheet: .c, .press: .a, .newTab: .c,
        .loadLine: .c, .space: .c, .privateToggle: .c, .toast: .a, .findBar: .b, .archive: .b,
    ]

    func variant(_ e: MotionElement) -> MotionVariant { picks[String(e.rawValue)] ?? Self.ownerPicks[e] ?? .a }
    mutating func set(_ v: MotionVariant, for e: MotionElement) { picks[String(e.rawValue)] = v }
    mutating func setAll(_ v: MotionVariant) { MotionElement.allCases.forEach { set(v, for: $0) } }

    enum CodingKeys: String, CodingKey { case picks, slowMotion }
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        picks = (try? c.decodeIfPresent([String: MotionVariant].self, forKey: .picks)) ?? [:]
        slowMotion = (try? c.decodeIfPresent(Bool.self, forKey: .slowMotion)) ?? false
    }
}

// MARK: - Animation helpers (SwiftUI terms from the design page, all scaled by the slow-motion switch)

@MainActor
enum Motion {
    /// 4 while "Slow motion" is on, else 1. Set by `BrowserStore.applyMotionScale()`.
    static var timeScale: Double = 1

    static func smooth(_ d: Double) -> Animation { .smooth(duration: d * timeScale) }
    static func snappy(_ d: Double, extraBounce: Double = 0.15) -> Animation { .snappy(duration: d * timeScale, extraBounce: extraBounce) }
    static func spring(_ d: Double, bounce: Double) -> Animation { .spring(duration: d * timeScale, bounce: bounce) }
    /// cubic-bezier(.22, .8, .2, 1): fast start, long soft landing.
    static func easeOut(_ d: Double) -> Animation { .timingCurve(0.22, 0.8, 0.2, 1, duration: d * timeScale) }
    /// cubic-bezier(.4, 0, .2, 1): standard in-out.
    static func easeInOut(_ d: Double) -> Animation { .timingCurve(0.4, 0, 0.2, 1, duration: d * timeScale) }
    static func scaled(_ seconds: Double) -> Double { seconds * timeScale }
}

extension BrowserStore {
    func motion(_ e: MotionElement) -> MotionVariant { settings.motion.variant(e) }
    func applyMotionScale() { Motion.timeScale = settings.motion.slowMotion ? 4 : 1 }
}

// MARK: - Press feedback (element 5). Used by every glass button in the bars.

/// A: quiet dip. B: springy squash. C: liquid lens (grows, light spot under the finger, violet glow, neighbours nudge away).
/// Numbers come from `v5A`/`v5B`/`v5C` in design/animations.html. Reduce Motion: only a short opacity change.
///
/// Two optional hooks for views that are not mine (see ArchiveMotion.notes):
/// - `\.motionLensPress` is 0...1 while a Liquid-lens (C) button is held, 0 for every other variant. A label can read it
///   to react (the stack thumbnail fans its two cards out with it).
/// - `MotionPressStyle(spot: false)` turns the light spot and glow off for a label that is not a glass shape.
struct MotionPressStyle: ButtonStyle {
    /// Light spot (all variants) and violet glow (C) for glass controls. Off = scale / nudge only.
    var spot = true

    func makeBody(configuration: Configuration) -> some View {
        MotionPressBody(label: configuration.label, isPressed: configuration.isPressed, spot: spot)
    }
}

private struct MotionLensPressKey: EnvironmentKey { static let defaultValue: CGFloat = 0 }

extension EnvironmentValues {
    /// 0 at rest, 1 while a "Liquid lens" (C) press is held. Always 0 for A and B and with Reduce Motion.
    var motionLensPress: CGFloat {
        get { self[MotionLensPressKey.self] }
        set { self[MotionLensPressKey.self] = newValue }
    }
}

/// Who is pressed right now, so the other buttons of the same bar can nudge away (variant C). One shared instance,
/// because the bars are built in other files and cannot be given an environment object from here.
@MainActor @Observable
final class MotionPressBoard {
    static let shared = MotionPressBoard()
    private(set) var pressedID: UUID?
    private(set) var pressedMid: CGPoint = .zero
    func begin(_ id: UUID, mid: CGPoint) { pressedID = id; pressedMid = mid }
    func end(_ id: UUID) { if pressedID == id { pressedID = nil } }
}

private struct MotionPressBody<Label: View>: View {
    let label: Label
    let isPressed: Bool
    let spot: Bool

    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var id = UUID()
    @State private var size = CGSize(width: 44, height: 44)
    @State private var mid = CGPoint.zero
    @State private var finger = UnitPoint.center

    var body: some View {
        if reduceMotion {
            label
                .opacity(isPressed ? 0.72 : 1)
                .animation(Motion.easeInOut(0.15), value: isPressed)
        } else {
            lively
        }
    }

    private var lively: some View {
        let v = store.motion(.press)
        let p: CGFloat = isPressed ? 1 : 0
        let radius = cornerRadius
        let scale: CGFloat
        let light: Double
        let tin: Animation
        let tout: Animation
        switch v {
        case .a:   // quiet dip: ease-out 140 ms down, 240 ms up, cubic-bezier(.2,.8,.3,1), no bounce
            scale = 1 - 0.04 * p; light = 0.25
            tin = .timingCurve(0.2, 0.8, 0.3, 1, duration: Motion.scaled(0.14))
            tout = .timingCurve(0.2, 0.8, 0.3, 1, duration: Motion.scaled(0.24))
        case .b:   // springy squash
            scale = 1 - 0.12 * p; light = 0.2
            tin = Motion.spring(0.16, bounce: 0)
            tout = Motion.spring(0.3, bounce: 0.45)
        case .c:   // liquid lens
            scale = 1 + 0.10 * p; light = 0.8
            tin = Motion.spring(0.24, bounce: 0.3)
            tout = Motion.spring(0.4, bounce: 0.4)
        }
        let anim = isPressed ? tin : tout
        let nudge = v == .c ? nudgeTarget : 0
        let board = MotionPressBoard.shared

        return label
            .environment(\.motionLensPress, v == .c ? p : 0)
            .overlay {
                if spot {
                    lightSpot(radius: radius)
                        .opacity(light * p)
                        .allowsHitTesting(false)
                }
            }
            .background {
                if spot && v == .c {
                    glow(radius: radius)
                        .opacity(0.65 * p)
                        .allowsHitTesting(false)
                }
            }
            .background {
                // Where the finger went down (a SwiftUI DragGesture here would swallow the Button's tap).
                TouchLocator { p in
                    finger = UnitPoint(x: min(1, max(0, p.x / max(size.width, 1))), y: min(1, max(0, p.y / max(size.height, 1))))
                }
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .onGeometryChange(for: CGPoint.self) { let f = $0.frame(in: .global); return CGPoint(x: f.midX, y: f.midY) } action: { mid = $0 }
            .scaleEffect(scale)
            .animation(anim, value: isPressed)
            .offset(x: nudge)
            .animation(board.pressedID == nil ? tout : tin, value: nudge)
            .zIndex(isPressed ? 1 : 0)
            .onChange(of: isPressed) { _, now in
                if now { board.begin(id, mid: mid) } else { board.end(id) }
            }
            .onDisappear { board.end(id) }
    }

    /// C: neighbours in the same bar move 5 pt away from the pressed button.
    private var nudgeTarget: CGFloat {
        let board = MotionPressBoard.shared
        guard let pid = board.pressedID, pid != id, abs(board.pressedMid.y - mid.y) < 40 else { return 0 }
        return mid.x > board.pressedMid.x ? 5 : -5
    }

    /// Circles and capsules: half the short side. Anything bigger gets the card radius.
    private var cornerRadius: CGFloat {
        let s = min(size.width, size.height)
        return s <= 64 ? s / 2 : Layout.cardRadius
    }

    /// `radial-gradient(circle at finger, white .7, transparent 62%)` from the design page, clipped to the control.
    private func lightSpot(radius: CGFloat) -> some View {
        let cx = finger.x * size.width, cy = finger.y * size.height
        let far = max(hypot(cx, cy), hypot(size.width - cx, cy), hypot(cx, size.height - cy), hypot(size.width - cx, size.height - cy))
        return RadialGradient(colors: [.white.opacity(0.7), .white.opacity(0)], center: finger,
                              startRadius: 0, endRadius: max(1, far * 0.62))
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// `box-shadow: 0 0 26px violet`: a blurred copy of the shape, cut out inside the control so the glass is not tinted.
    private func glow(radius: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Color(red: 180 / 255, green: 92 / 255, blue: 242 / 255))
            .blur(radius: 13)
            .mask {
                Rectangle().padding(-80)
                    .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).blendMode(.destinationOut) }
                    .compositingGroup()
            }
    }
}

/// Reports touch-down and drag locations inside its bounds without taking part in hit testing: a long-press recogniser
/// that sits on the window, never cancels touches and recognises together with everything else.
private struct TouchLocator: UIViewRepresentable {
    var onTouch: (CGPoint) -> Void

    func makeUIView(context: Context) -> TouchLocatorView {
        let v = TouchLocatorView()
        v.onTouch = onTouch
        return v
    }
    func updateUIView(_ v: TouchLocatorView, context: Context) { v.onTouch = onTouch }
}

private final class TouchLocatorView: UIView, UIGestureRecognizerDelegate {
    var onTouch: ((CGPoint) -> Void)?
    private var recognizer: UILongPressGestureRecognizer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if let r = recognizer { r.view?.removeGestureRecognizer(r); recognizer = nil }
        guard let window else { return }
        let r = UILongPressGestureRecognizer(target: self, action: #selector(handle(_:)))
        r.minimumPressDuration = 0
        r.allowableMovement = .greatestFiniteMagnitude
        r.cancelsTouchesInView = false
        r.delaysTouchesBegan = false
        r.delaysTouchesEnded = false
        r.delegate = self
        window.addGestureRecognizer(r)
        recognizer = r
    }

    @objc private func handle(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began || g.state == .changed else { return }
        onTouch?(g.location(in: self))
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        bounds.insetBy(dx: -4, dy: -4).contains(touch.location(in: self))
    }
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
