import SwiftUI
import UIKit
import CoreMotion
import Network

// EXPERIMENT (top bar style `.twinPills`, see `TopStyle`): the Dynamic Island stays the fixed middle piece and two pure-black
// pills slide on either side of it, pulled by the phone's tilt, bouncing softly off the screen edges and off the island.
// The left pill shows the time, the right one connectivity and battery. The system status bar is hidden while this style is
// on screen (the pills replace it). The physics live in `TwinPillPhysics.swift` (pure, tested by Tools/physics-check.swift).
//
// Layout: [wall 14] left pill [touches] ISLAND (125 pt, centred, drawn by the hardware, never by us) [touches] right pill [wall 14].
// Vertical centre = safeTop * 0.52 (the island's centre), height = the island's height.
//
// Input, in priority order: launch argument `-simTilt <-1...1>` or `-simTilt auto` (demos and screenshots), CoreMotion
// gravity.x (device), a floating "Tilt" slider (devices without motion hardware, i.e. the Simulator). Reduce Motion: the pills
// park against the island and ignore tilt. Dragging a pill with a finger and throwing it works too.
// Delete this file together with TwinPillPhysics.swift and Tools/physics-check.swift to remove the experiment.

// MARK: - Controller

/// Where the gravity input comes from.
enum TwinPillTiltSource: Equatable {
    case fixed(Double)     // -simTilt 0.8
    case auto              // -simTilt auto: slow sway, period 5 s, amplitude 0.7, flips direction every 15 s
    case motion            // CoreMotion
    case slider            // the on-screen slider

    /// `-simTilt <number>` or `-simTilt auto` from the launch arguments (read directly: negative numbers survive).
    static func fromLaunchArguments(_ args: [String] = ProcessInfo.processInfo.arguments) -> TwinPillTiltSource? {
        guard let i = args.firstIndex(of: "-simTilt"), i + 1 < args.count else { return nil }
        if args[i + 1] == "auto" { return .auto }
        return Double(args[i + 1]).map { .fixed(min(max($0, -1), 1)) }
    }
}

/// Owns the model and everything around it: tilt input, haptics, squash state. `TimelineView` ticks call `advance`; the
/// physics state is `@ObservationIgnored` so a tick never invalidates a view by itself.
@MainActor @Observable
final class TwinPillController {
    /// The slider's value (-1...1) and its Hold switch. Only used when there is no other source.
    var manualTilt = 0.0
    var holdTilt = false

    @ObservationIgnored private(set) var model = TwinPillModel(screenWidth: 402)
    @ObservationIgnored private var lastDate: Date?
    @ObservationIgnored private var startDate: Date?
    @ObservationIgnored private var filtered = 0.0           // low-passed gravity.x (or the other source), -1...1
    @ObservationIgnored private var squash: [SquashState] = [.none, .none]
    @ObservationIgnored private var lastHaptic = Date.distantPast
    @ObservationIgnored private let haptic = UIImpactFeedbackGenerator(style: .light)
    @ObservationIgnored private var grabOffset: [Double?] = [nil, nil]
    @ObservationIgnored private var motionRunning = false
    @ObservationIgnored private var lastShake = Date.distantPast

    private static let motionManager = CMMotionManager()
    let forcedSource: TwinPillTiltSource?
    /// False in the Simulator (and on any device without motion hardware): the slider appears.
    let motionAvailable = TwinPillController.motionManager.isDeviceMotionAvailable

    private struct SquashState { var at: TimeInterval; var peak: Double; var wall: Int
        static let none = SquashState(at: -1e9, peak: 0, wall: 1) }

    init() { forcedSource = TwinPillTiltSource.fromLaunchArguments() }

    var source: TwinPillTiltSource { forcedSource ?? (motionAvailable ? .motion : .slider) }
    var showsSlider: Bool { source == .slider }

    // MARK: lifecycle

    func resume() {
        lastDate = nil
        haptic.prepare()
        if source == .motion, !motionRunning {
            Self.motionManager.deviceMotionUpdateInterval = 1.0 / 60
            Self.motionManager.startDeviceMotionUpdates()
            motionRunning = true
        }
    }

    func pause() {
        lastDate = nil
        if motionRunning { Self.motionManager.stopDeviceMotionUpdates(); motionRunning = false }
    }

    // MARK: per frame

    private func targetGravity(at date: Date) -> Double {
        switch source {
        case .fixed(let g): return g
        case .auto:
            let t = date.timeIntervalSince(startDate ?? date)
            let flip: Double = Int(t / 15) % 2 == 0 ? 1 : -1
            return 0.7 * flip * sin(2 * .pi * t / 5)
        case .motion: return Self.motionManager.deviceMotion?.gravity.x ?? 0
        case .slider: return manualTilt
        }
    }

    /// Runs the physics up to `date`. Call once per frame (extra calls with the same date are no-ops).
    func advance(to date: Date, screenWidth: Double, reduceMotion: Bool) {
        model.configure(screenWidth: screenWidth)
        if startDate == nil { startDate = date }
        defer { lastDate = date }
        if reduceMotion { model.park(); return }
        guard let last = lastDate else { return }
        let dt = date.timeIntervalSince(last)
        guard dt > 0 else { return }
        // Low-pass: 0.15 per sample at 60 Hz, expressed per second so the display rate does not matter.
        let alpha = 1 - pow(0.7, min(dt, 0.1) * 60)   // quicker to follow the tilt (was 0.85)
        filtered += alpha * (targetGravity(at: date) - filtered)
        let now = date.timeIntervalSinceReferenceDate
        detectShake(at: date)
        for hit in model.step(dt: dt, gravity: filtered) { register(hit, at: now, date: date) }
    }

    /// A sharp sideways (or any) jerk of the phone throws both pills, which then rattle between the wall and the island.
    private func detectShake(at date: Date) {
        guard source == .motion, let a = Self.motionManager.deviceMotion?.userAcceleration else { return }
        let size = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
        guard size > TwinPillConstants.shakeThreshold, date.timeIntervalSince(lastShake) > TwinPillConstants.shakeCooldown else { return }
        lastShake = date
        model.shake(direction: abs(a.x) > 0.5 ? a.x : 0)
        haptic.impactOccurred(intensity: 0.8)
        haptic.prepare()
    }

    private func register(_ hit: TwinPillModel.Impact, at now: TimeInterval, date: Date) {
        let c = TwinPillConstants.self
        squash[hit.side.rawValue] = SquashState(at: now, peak: 0.03 + 0.05 * min(1, hit.speed / 600), wall: hit.wall)
        guard hit.speed > c.hapticMinSpeed, date.timeIntervalSince(lastHaptic) > 0.04 else { return }
        lastHaptic = date
        haptic.impactOccurred(intensity: min(1, max(0, hit.speed / c.hapticFullSpeed)))
        haptic.prepare()
    }

    /// What to draw for one pill: centre x, squash (scaleX, anchored on the side that hit), lean in degrees.
    struct Look { var x: Double; var scaleX: Double; var anchor: UnitPoint; var degrees: Double }

    func look(_ side: TwinPillSide, at date: Date) -> Look {
        let b = model.body(side)
        let s = squash[side.rawValue]
        let age = date.timeIntervalSinceReferenceDate - s.at
        var sx = 1.0
        if age >= 0, age < 0.4 {
            // 20 ms down to the peak, then a damped spring back (slight overshoot).
            let k = age < 0.02 ? age / 0.02 : exp(-(age - 0.02) / 0.06) * cos(2 * .pi * (age - 0.02) / 0.20)
            sx = 1 - s.peak * k
        }
        let lean = 3 * min(1, max(-1, b.v / 400))
        return Look(x: b.x, scaleX: sx, anchor: s.wall > 0 ? .trailing : .leading, degrees: lean)
    }

    // MARK: finger

    func drag(_ side: TwinPillSide, startX: Double, currentX: Double) {
        if grabOffset[side.rawValue] == nil { grabOffset[side.rawValue] = model.body(side).x - startX }
        model.hold(side, at: currentX + (grabOffset[side.rawValue] ?? 0))
    }

    func drop(_ side: TwinPillSide, velocity: Double) {
        grabOffset[side.rawValue] = nil
        model.release(side, velocity: velocity)
    }
}

// MARK: - Status (network + battery)

enum PillNetwork { case wifi, cellular, offline
    var symbol: String {
        switch self {
        case .wifi: "wifi"
        case .cellular: "antenna.radiowaves.left.and.right"
        case .offline: "wifi.slash"
        }
    }
    var label: String {
        switch self {
        case .wifi: "Wi-Fi"
        case .cellular: "Cellular"
        case .offline: "Offline"
        }
    }
}

/// Network path and battery. `start()` / `stop()` follow the view's lifetime.
@MainActor @Observable
final class PillStatusModel {
    var network = PillNetwork.wifi
    /// 0...1. The Simulator reports -1: shown as a full battery.
    var batteryLevel = 1.0
    var charging = false

    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var tokens: [NSObjectProtocol] = []

    func start() {
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let kind = Self.kind(of: path)
            Task { @MainActor in self?.network = kind }
        }
        m.start(queue: DispatchQueue(label: "dev.oprimo.flecha.twinpills.path"))
        monitor = m

        UIDevice.current.isBatteryMonitoringEnabled = true
        readBattery()
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
            tokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.readBattery() }
            })
        }
    }

    func stop() {
        monitor?.cancel(); monitor = nil
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
        tokens = []
        UIDevice.current.isBatteryMonitoringEnabled = false
    }

    private func readBattery() {
        let d = UIDevice.current
        batteryLevel = d.batteryLevel < 0 ? 1 : Double(d.batteryLevel)
        charging = d.batteryState == .charging || d.batteryState == .full
    }

    nonisolated private static func kind(of path: NWPath) -> PillNetwork {
        guard path.status == .satisfied else { return .offline }
        if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) { return .wifi }
        if path.usesInterfaceType(.cellular) { return .cellular }
        return .wifi
    }
}

// MARK: - The view

struct TwinPills: View {
    let safeTop: CGFloat
    @Environment(BrowserStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    @Environment(\.displayScale) private var scale
    @State private var controller = TwinPillController()
    @State private var status = PillStatusModel()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    /// Pills move whenever the app is active, also over the tab switcher.
    private var running: Bool { phase == .active }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = (TwinPillConstants.pillHeight * scale).rounded() / scale
            // Centre on the island's centre, snapped so the top edge lies on a device pixel.
            let cy = ((safeTop * 0.52 - h / 2) * scale).rounded() / scale + h / 2
            ZStack {
                TimelineView(.animation(minimumInterval: nil, paused: !running)) { ctx in
                    let _ = controller.advance(to: ctx.date, screenWidth: w, reduceMotion: reduceMotion)
                    ZStack {
                        pill(.left, height: h, y: cy, date: ctx.date) {
                            TimelineView(.everyMinute) { t in
                                Text(Self.timeFormatter.string(from: t.date))
                                    .font(.system(size: 16, weight: .semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(.white)
                                    .fixedSize()
                            }
                            .accessibilityLabel("Time")
                        }
                        pill(.right, height: h, y: cy, date: ctx.date) {
                            HStack(spacing: 8) {
                                Image(systemName: status.network.symbol)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 21)
                                PillBattery(level: status.batteryLevel, charging: status.charging)
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(status.network.label), battery \(Int((status.batteryLevel * 100).rounded())) percent")
                        }
                    }
                }
                if controller.showsSlider && !store.showSwitcher && !store.findActive {
                    TiltControl(controller: controller)
                        .padding(.horizontal, Layout.edge)
                        .position(x: w / 2, y: geo.size.height - (Layout.edge + Layout.control + Layout.gap) - 22)
                }
            }
        }
        .ignoresSafeArea()
        // The pills stay over the tab switcher too, so the system status bar stays hidden in this style.
        .statusBarHidden(true)
        .onChange(of: running, initial: true) { _, on in on ? controller.resume() : controller.pause() }
        .onAppear { status.start() }
        .onDisappear { controller.pause(); status.stop() }
    }

    /// One black capsule at the model's position. Pure #000000 and opaque, no stroke, no shadow.
    private func pill<Content: View>(_ side: TwinPillSide, height: CGFloat, y: CGFloat, date: Date,
                                     @ViewBuilder content: () -> Content) -> some View {
        let look = controller.look(side, at: date)
        let width = side == .left ? TwinPillConstants.leftWidth : TwinPillConstants.rightWidth
        return ZStack {
            Capsule().fill(Color.black)
            content()
        }
        .frame(width: width, height: height)
        .scaleEffect(x: look.scaleX, y: 1, anchor: look.anchor)
        .rotationEffect(.degrees(look.degrees))
        .contentShape(Capsule())
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { v in controller.drag(side, startX: v.startLocation.x, currentX: v.location.x) }
            .onEnded { v in controller.drop(side, velocity: v.velocity.width) },
                 including: reduceMotion ? .none : .all)
        .position(x: look.x, y: y)
    }
}

// MARK: - Battery glyph

/// Rounded-rect outline, inner fill proportional to the level, a nub, and a bolt while charging.
private struct PillBattery: View {
    let level: Double
    let charging: Bool

    private var fill: Color {
        if charging { return Color(red: 0.2, green: 0.78, blue: 0.35) }
        return level <= 0.2 ? Color(red: 1, green: 0.27, blue: 0.23) : .white
    }

    var body: some View {
        let w: CGFloat = 26, h: CGFloat = 13, inset: CGFloat = 2
        HStack(spacing: 1.5) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(.white.opacity(0.5), lineWidth: 1.2)
                RoundedRectangle(cornerRadius: 2.2, style: .continuous)
                    .fill(fill)
                    .frame(width: max(2.5, (w - 2 * inset) * min(1, max(0, level))), height: h - 2 * inset)
                    .padding(inset)
                if charging {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 8.5, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(width: w, height: h)
            Capsule().fill(.white.opacity(0.5)).frame(width: 1.8, height: 4.5)
        }
    }
}

// MARK: - Fallback slider

/// Floating glass slider for devices without motion hardware: -1 (left side down) ... +1 (right side down). It springs
/// back to 0 on release unless "Hold" is on.
private struct TiltControl: View {
    @Bindable var controller: TwinPillController

    var body: some View {
        HStack(spacing: 10) {
            Text("Tilt").font(.subheadline.weight(.semibold))
            Slider(value: $controller.manualTilt, in: -1...1) { editing in
                // Next run-loop turn: the slider commits its last drag value after this callback, which would undo the reset.
                if !editing { DispatchQueue.main.async { springBack() } }
            }
            Button { controller.holdTilt.toggle(); springBack() } label: {
                Text("Hold").font(.footnote.weight(.semibold))
                    .foregroundStyle(controller.holdTilt ? Color.white : Color.primary)
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(controller.holdTilt ? Theme.accent : Color.clear, in: .capsule)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .glassEffect(.regular, in: .capsule)
        .accessibilityLabel("Simulated tilt")
    }

    private func springBack() {
        guard !controller.holdTilt else { return }
        withAnimation(.spring(duration: 0.4, bounce: 0.2)) { controller.manualTilt = 0 }
    }
}

// MARK: - Store helper

extension BrowserStore {
    /// Settings > "Edit pill and flowers": the twin pills have no editor, so (like Blur) switch to the flower pill first.
    func beginPillEditingFromSettings() {
        if topStyle == .twinPills { topStyleOverride = nil; settings.topStyle = .blur }
        beginPillEditing()
    }
}
