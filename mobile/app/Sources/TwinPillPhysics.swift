import Foundation

// EXPERIMENT (top bar style `.twinPills`): the PURE model behind the two gliding pills. Foundation only (no UIKit, no
// SwiftUI) so `Tools/physics-check.swift` can compile and test it on the command line:
//   swiftc Sources/TwinPillPhysics.swift Tools/physics-check.swift -o <out> && <out>
// Delete together with TwinPills.swift when the experiment goes (see the note on `TopStyle` in Models.swift).

/// Every tunable number of the twin-pill style, in one place. Lengths in points, times in seconds.
enum TwinPillConstants {
    // Geometry (iPhone 17 Pro, 402 pt wide: island x = 138.5 ... 263.5, centre y = safeTop * 0.52 = 32.3).
    /// The hardware Dynamic Island, treated as a centred, fixed obstacle. Measured on iPhone 17 Pro screenshots: 376 x 110 px
    /// at 3x (125.33 x 36.67 pt, x = 138.33 ... 263.67). With this width a docked pill sits exactly `gap` from the island and
    /// every resting edge (wall, island side) lands on a whole device pixel.
    static let islandWidth = 376.0 / 3.0
    static let islandHeight = 110.0 / 3.0
    /// Space between a pill pressed against the island and the island.
    /// Negative on purpose: a docked pill TOUCHES the island (tucked 0.5 pt under it so no hairline seam can show; the
    /// island is black too). The visible gap between pills and island only exists while a pill is away from it.
    static let gap = -0.5
    /// Space between a pill pressed against a screen edge and that edge.
    static let wallInset = 14.0
    /// Pill heights equal the island's height.
    static let pillHeight = islandHeight
    /// Widths. The left pill holds "HH:mm" (about 42 pt of text), the right one a wifi glyph and a battery (about 56 pt).
    /// The brief said "about 76 / about 104"; the right pill is narrower on purpose: at 104 pt it would have only 12.5 pt of
    /// travel between the island and the wall (116.5 pt of room on a 402 pt screen), which does not read as gliding.
    static let leftWidth = 76.0
    static let rightWidth = 88.0

    // Dynamics.
    /// Acceleration at full tilt (gravity.x = 1). 20 degrees of roll (sin = 0.34) gives about 900 pt/s^2.
    /// (Owner, 31 Oct: faster, almost no friction, bouncier; was 1500 / drag 1.6 / friction 30 / restitution 0.55.)
    static let accelScale = 2600.0
    /// Gravity inputs below this are ignored (a phone lying almost flat or upright does not make the pills creep).
    static let deadzone = 0.03
    /// Linear drag, per second.
    static let drag = 0.35
    /// Constant (Coulomb) friction, pt/s^2: brings the pills to rest and makes a very small tilt hold them in place.
    static let friction = 8.0
    /// Speed kept after a hit: v_after = -restitution * v_before. High, so a shake rattles back and forth a few times.
    static let restitution = 0.78
    /// Fixed integration sub-step, and the longest frame time that is simulated (a longer frame is cut, never extrapolated).
    static let subStep = 1.0 / 240.0
    static let maxFrameDt = 0.1
    /// A hit slower than this is not a bounce but contact: the pill just stops (kills jitter against a wall under gravity).
    /// Must be at least accelScale * subStep / (1 - restitution) (here 49.2), or full tilt alone could make a pill resting
    /// on a wall bounce higher every step (Tools/physics-check.swift, check 3).
    static let restSpeed = 50.0

    // Feel.
    /// Haptic only above this impact speed; intensity = speed / hapticFullSpeed (clamped to 0...1).
    static let hapticMinSpeed = 80.0
    static let hapticFullSpeed = 900.0
    /// Fastest a released (thrown) pill may leave the finger, and fastest a shake can send it.
    static let maxThrowSpeed = 1600.0

    // Shake.
    /// Phone acceleration (without gravity, in g) that counts as a shake, and the speed a shake gives each pill.
    static let shakeThreshold = 1.4
    static let shakeSpeed = 1400.0
    /// One shake per this many seconds (a shake is several jerks).
    static let shakeCooldown = 0.25
}

enum TwinPillSide: Int, CaseIterable { case left = 0, right = 1 }

/// Where the pills may be, derived from the actual screen width. Pure functions of `screenWidth`.
struct TwinPillGeometry: Equatable {
    var screenWidth: Double

    var islandLeft: Double { (screenWidth - TwinPillConstants.islandWidth) / 2 }
    var islandRight: Double { (screenWidth + TwinPillConstants.islandWidth) / 2 }

    func width(of side: TwinPillSide) -> Double {
        side == .left ? TwinPillConstants.leftWidth : TwinPillConstants.rightWidth
    }

    /// Allowed range of a pill's CENTRE x. If the screen is so narrow that the range would be empty it collapses to a point.
    func range(of side: TwinPillSide) -> ClosedRange<Double> {
        let w = width(of: side), c = TwinPillConstants.self
        let lo: Double, hi: Double
        switch side {
        case .left:  lo = c.wallInset + w / 2;                 hi = islandLeft - c.gap - w / 2
        case .right: lo = islandRight + c.gap + w / 2;         hi = screenWidth - c.wallInset - w / 2
        }
        return lo <= hi ? lo...hi : ((lo + hi) / 2)...((lo + hi) / 2)
    }
}

/// One pill: centre position `x` and velocity `v` along x, allowed range `lo...hi`.
struct TwinPillBody: Equatable {
    var x: Double
    var v: Double
    var lo: Double
    var hi: Double
    /// True while a finger holds the pill: physics skips it.
    var held = false

    /// A hit on a limit. `wall` is -1 for the low limit (left end of the range), +1 for the high limit.
    struct Hit: Equatable { var wall: Int; var speed: Double; var speedAfter: Double }

    /// Advance by one sub-step `h` under constant acceleration `drive` (pt/s^2, positive = towards +x).
    /// Order: acceleration, linear drag, Coulomb friction (never through zero), move, then clamp / bounce.
    /// Semi-implicit Euler (velocity first), so kinetic energy gained in a step never exceeds the work done by `drive`.
    mutating func advance(h: Double, drive: Double) -> Hit? {
        if held { return nil }
        let c = TwinPillConstants.self
        var v = self.v + drive * h
        v *= max(0, 1 - c.drag * h)
        let f = c.friction * h
        if abs(v) <= f { v = 0 } else { v -= copysign(f, v) }
        var x = self.x + v * h
        var hit: Hit?
        if x >= hi {
            x = hi
            if v > 0 {
                if v < c.restSpeed { v = 0 } else { hit = Hit(wall: 1, speed: v, speedAfter: c.restitution * v); v = -c.restitution * v }
            }
        } else if x <= lo {
            x = lo
            if v < 0 {
                if -v < c.restSpeed { v = 0 } else { hit = Hit(wall: -1, speed: -v, speedAfter: c.restitution * -v); v = -c.restitution * v }
            }
        }
        self.x = x
        self.v = v
        return hit
    }
}

/// The two pills plus the geometry. Value type: easy to copy in tests.
struct TwinPillModel: Equatable {
    struct Impact: Equatable { var side: TwinPillSide; var wall: Int; var speed: Double; var speedAfter: Double }

    private(set) var geometry: TwinPillGeometry
    var left: TwinPillBody
    var right: TwinPillBody

    /// Starts parked against the island on both sides.
    init(screenWidth: Double) {
        geometry = TwinPillGeometry(screenWidth: screenWidth)
        let l = geometry.range(of: .left), r = geometry.range(of: .right)
        left = TwinPillBody(x: l.upperBound, v: 0, lo: l.lowerBound, hi: l.upperBound)
        right = TwinPillBody(x: r.lowerBound, v: 0, lo: r.lowerBound, hi: r.upperBound)
    }

    func body(_ side: TwinPillSide) -> TwinPillBody { side == .left ? left : right }

    /// Left edge of the island minus gap, right edge of the island plus gap: where the pills stop at the middle.
    var leftDock: Double { left.hi }
    var rightDock: Double { right.lo }

    /// New screen width (rotation never happens, but the window can resize on iPad / Stage Manager). Keeps positions in range.
    mutating func configure(screenWidth: Double) {
        guard geometry.screenWidth != screenWidth else { return }
        geometry.screenWidth = screenWidth
        for side in TwinPillSide.allCases {
            let r = geometry.range(of: side)
            update(side) { $0.lo = r.lowerBound; $0.hi = r.upperBound; $0.x = min(max($0.x, $0.lo), $0.hi) }
        }
    }

    /// Reduce Motion: both pills rest against the island (their middle limits) and stay there.
    mutating func park() {
        left.x = left.hi; left.v = 0; left.held = false
        right.x = right.lo; right.v = 0; right.held = false
    }

    /// Gravity input (-1...1, positive = right side of the phone lower) to acceleration in pt/s^2, with the dead zone.
    static func drive(forGravity g: Double) -> Double {
        let c = TwinPillConstants.self
        guard g.isFinite else { return 0 }
        let g = min(max(g, -1), 1)
        let a = abs(g)
        if a <= c.deadzone { return 0 }
        return (g < 0 ? -1 : 1) * (a - c.deadzone) / (1 - c.deadzone) * c.accelScale
    }

    /// One sub-step of both pills (`h` should be <= `subStep`). Returns the hits that happened.
    mutating func substep(h: Double, drive: Double) -> [Impact] {
        var hits: [Impact] = []
        if let hit = left.advance(h: h, drive: drive) {
            hits.append(Impact(side: .left, wall: hit.wall, speed: hit.speed, speedAfter: hit.speedAfter))
        }
        if let hit = right.advance(h: h, drive: drive) {
            hits.append(Impact(side: .right, wall: hit.wall, speed: hit.speed, speedAfter: hit.speedAfter))
        }
        return hits
    }

    /// Advance by one frame of `dt` seconds under gravity `g`. `dt` is clamped to `maxFrameDt`, then cut into fixed
    /// sub-steps, so a long hitch (or a bogus `dt`) can never tunnel a pill through the island or off the screen.
    @discardableResult
    mutating func step(dt: Double, gravity: Double) -> [Impact] {
        guard dt.isFinite, dt > 0 else { return [] }
        let c = TwinPillConstants.self
        let drive = Self.drive(forGravity: gravity)
        var remaining = min(dt, c.maxFrameDt)
        var hits: [Impact] = []
        while remaining > 1e-12 {
            let h = min(c.subStep, remaining)
            hits.append(contentsOf: substep(h: h, drive: drive))
            remaining -= h
        }
        return hits
    }

    /// A shake: both free pills fly off in the direction the phone was jerked from (they lag behind it), adding to
    /// what they were doing. `direction` is the sign of the phone's sideways acceleration; 0 sends them apart.
    mutating func shake(direction: Double, speed: Double = TwinPillConstants.shakeSpeed) {
        let m = TwinPillConstants.maxThrowSpeed
        for side in TwinPillSide.allCases {
            let dir = direction > 0 ? -1.0 : direction < 0 ? 1.0 : (side == .left ? -1.0 : 1.0)
            update(side) { b in
                guard !b.held, speed.isFinite else { return }
                b.v = min(max(b.v + dir * speed, -m), m)
            }
        }
    }

    // MARK: finger

    /// A finger holds `side` at centre `x` (clamped to the range). Physics skips a held pill.
    mutating func hold(_ side: TwinPillSide, at x: Double) {
        guard x.isFinite else { return }
        update(side) { $0.held = true; $0.v = 0; $0.x = min(max(x, $0.lo), $0.hi) }
    }

    /// The finger lifted: the pill keeps `velocity` (pt/s, clamped to `maxThrowSpeed`).
    mutating func release(_ side: TwinPillSide, velocity: Double) {
        let m = TwinPillConstants.maxThrowSpeed
        let v = velocity.isFinite ? min(max(velocity, -m), m) : 0
        update(side) { $0.held = false; $0.v = v }
    }

    private mutating func update(_ side: TwinPillSide, _ change: (inout TwinPillBody) -> Void) {
        if side == .left { change(&left) } else { change(&right) }
    }
}
