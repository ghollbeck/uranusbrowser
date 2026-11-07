import Foundation

// Command-line check of the pure twin-pill model (Sources/TwinPillPhysics.swift). Build and run:
//   swiftc Sources/TwinPillPhysics.swift Tools/physics-check.swift -o /tmp/physics-check && /tmp/physics-check
// Exit code 0 = all invariants hold, 1 = at least one failed.

struct SplitMix64 {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func range(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * unit() }
}

@main
struct PhysicsCheck {
    static var failures: [String] = []
    static var checks = 0

    static func expect(_ ok: Bool, _ what: @autoclosure () -> String) {
        checks += 1
        if !ok {
            failures.append(what())
            if failures.count <= 25 { print("  FAIL: \(failures.last!)") }
        }
    }

    static func main() {
        let c = TwinPillConstants.self
        var rng = SplitMix64(state: 20261029)
        let widths = [402.0, 393.0, 440.0, 430.0, 375.0]

        // 1. Positions stay inside the ranges and never touch the island, whatever dt and gravity are.
        var steps = 0
        for w in widths {
            var m = TwinPillModel(screenWidth: w)
            let g = TwinPillGeometry(screenWidth: w)
            for i in 0..<40_000 {
                let roll = rng.unit()
                let dt: Double =
                    roll < 0.55 ? rng.range(0, 0.03) :
                    roll < 0.80 ? rng.range(0, 0.5) :
                    roll < 0.90 ? rng.range(0.5, 100) :
                    roll < 0.94 ? 1e9 :
                    roll < 0.96 ? -rng.range(0, 5) :
                    roll < 0.97 ? Double.infinity :
                    roll < 0.98 ? Double.nan : 0
                let grav: Double = rng.unit() < 0.1 ? rng.range(-9, 9) : rng.range(-1, 1)
                if i % 997 == 0 {                       // sometimes throw a pill
                    m.release(rng.unit() < 0.5 ? .left : .right, velocity: rng.range(-5000, 5000))
                }
                m.step(dt: dt, gravity: i % 5003 == 0 ? Double.nan : grav)
                steps += 1
                for side in TwinPillSide.allCases {
                    let b = m.body(side), r = g.range(of: side), half = g.width(of: side) / 2
                    expect(b.x.isFinite && b.v.isFinite, "w=\(w) \(side): non-finite x=\(b.x) v=\(b.v)")
                    expect(b.x >= r.lowerBound && b.x <= r.upperBound, "w=\(w) \(side): x=\(b.x) outside \(r)")
                    expect(b.x - half >= (side == .left ? c.wallInset : g.islandRight + c.gap) - 1e-9, "w=\(w) \(side): left edge too far left")
                    expect(b.x + half <= (side == .left ? g.islandLeft - c.gap : w - c.wallInset) + 1e-9, "w=\(w) \(side): right edge too far right")
                }
                // Explicitly: the left pill never crosses the island's left edge, the right pill never its right edge.
                expect(m.left.x + c.leftWidth / 2 <= g.islandLeft - c.gap + 1e-9, "left pill touches the island")
                expect(m.right.x - c.rightWidth / 2 >= g.islandRight + c.gap - 1e-9, "right pill touches the island")
                expect(m.left.x + c.leftWidth / 2 < m.right.x - c.rightWidth / 2, "pills overlap each other")
            }
        }
        print("1. ranges / island / screen: \(steps) random frames on \(widths.count) screen widths (dt up to 1e9, +-inf, NaN, negative; gravity up to +-9)")

        // 2. Speed after a wall hit = restitution * speed before (single sub-steps, independent reconstruction of the free step).
        var hitsChecked = 0
        for _ in 0..<2000 {
            var body = TwinPillBody(x: 0, v: 0, lo: 52, hi: 92.5)
            body.x = rng.range(body.lo, body.hi)
            body.v = rng.range(-900, 900)
            var drive = TwinPillModel.drive(forGravity: rng.range(-1, 1))
            for _ in 0..<3000 {
                if rng.unit() < 0.01 { drive = TwinPillModel.drive(forGravity: rng.range(-1, 1)) }
                let h = c.subStep
                // Reconstruct the free step with the public constants.
                var v1 = (body.v + drive * h) * max(0, 1 - c.drag * h)
                let f = c.friction * h
                v1 = abs(v1) <= f ? 0 : v1 - copysign(f, v1)
                let x1 = body.x + v1 * h
                let before = body
                let hit = body.advance(h: h, drive: drive)
                if let hit {
                    hitsChecked += 1
                    let expectedSpeed = abs(v1)
                    expect(abs(hit.speed - expectedSpeed) < 1e-6, "hit speed \(hit.speed) vs reconstructed \(expectedSpeed)")
                    expect(abs(abs(body.v) - c.restitution * expectedSpeed) < 1e-6, "speed after \(abs(body.v)) != e * \(expectedSpeed)")
                    expect(abs(hit.speedAfter - c.restitution * hit.speed) < 1e-6, "reported speedAfter mismatch")
                    expect((hit.wall == 1 && x1 >= before.hi && body.v < 0 && body.x == body.hi) ||
                           (hit.wall == -1 && x1 <= before.lo && body.v > 0 && body.x == body.lo), "wall/sign mismatch")
                    expect(hit.speed >= c.restSpeed, "hit below restSpeed reported")
                }
            }
        }
        print("2. restitution: \(hitsChecked) hits, |v_after| = \(c.restitution) * |v_before| within 1e-6 on every one")

        // 3. Mechanical energy E = v^2/2 - drive * x never increases in a sub-step (gravity work is accounted for by the potential).
        var worst = -Double.infinity
        var energySteps = 0
        for _ in 0..<1500 {
            var body = TwinPillBody(x: 0, v: 0, lo: 52, hi: 92.5)
            body.x = rng.range(body.lo, body.hi)
            body.v = rng.range(-900, 900)
            var drive = TwinPillModel.drive(forGravity: rng.range(-1, 1))
            for _ in 0..<2000 {
                if rng.unit() < 0.02 { drive = TwinPillModel.drive(forGravity: rng.range(-1, 1)) }
                let h = rng.unit() < 0.7 ? c.subStep : rng.range(1e-5, c.subStep)
                let e0 = 0.5 * body.v * body.v - drive * body.x
                _ = body.advance(h: h, drive: drive)
                let e1 = 0.5 * body.v * body.v - drive * body.x
                worst = max(worst, e1 - e0)
                energySteps += 1
                expect(e1 - e0 <= 1e-9 * max(1, abs(e0)), "energy rose by \(e1 - e0) (E0=\(e0), drive=\(drive))")
            }
        }
        print("3. energy: \(energySteps) sub-steps, largest E_after - E_before = \(String(format: "%.3e", worst)) (must be <= 0 up to rounding)")

        // 4. At rest with g = 0 (and inside the dead zone, and under a tilt weaker than the friction) a pill stays at rest.
        var restOK = true
        for _ in 0..<500 {
            var m = TwinPillModel(screenWidth: 402)
            m.left.x = rng.range(m.left.lo, m.left.hi); m.right.x = rng.range(m.right.lo, m.right.hi)
            let l0 = m.left.x, r0 = m.right.x
            let weak = c.deadzone + (c.friction * 0.9 / c.accelScale) * (1 - c.deadzone)     // drive just below the friction
            let g = [0, rng.range(-c.deadzone, c.deadzone), weak, -weak][Int(rng.next() % 4)]
            for _ in 0..<2000 { m.step(dt: 1.0 / 60, gravity: g) }
            if m.left.x != l0 || m.right.x != r0 || m.left.v != 0 || m.right.v != 0 { restOK = false }
        }
        expect(restOK, "a pill at rest with g = 0 / weak tilt moved")
        print("4. rest: 500 runs x 2000 frames with g = 0, inside the dead zone and just under the friction: nothing moved")

        // 5. Constant tilt: the pills settle against a limit with zero velocity and stop reporting hits (no jitter).
        var settleOK = true
        var lateHits = 0
        var bounceCounts: [Int] = []
        var settleTimes: [Double] = []
        for g in [1.0, 0.8, 0.5, 0.35, 0.1, 0.06, -0.06, -0.1, -0.35, -0.5, -0.8, -1.0] {
            var m = TwinPillModel(screenWidth: 402)
            // start at the opposite end of the track so there is a long run-up
            m.left.x = g > 0 ? m.left.lo : m.left.hi
            m.right.x = g > 0 ? m.right.lo : m.right.hi
            var t = 0.0, hits = 0, lastHit = 0.0
            while t < 20 {
                let h = m.step(dt: 1.0 / 60, gravity: g)
                t += 1.0 / 60
                if !h.isEmpty { hits += h.count; lastHit = t }
                if t > 10 { lateHits += h.count }
            }
            let pinned: (TwinPillBody) -> Bool = { $0.v == 0 && ($0.x == $0.lo || $0.x == $0.hi) }
            if !(pinned(m.left) && pinned(m.right)) { settleOK = false; print("   not settled at g=\(g): \(m.left) \(m.right)") }
            bounceCounts.append(hits)
            settleTimes.append(lastHit)
        }
        expect(settleOK && lateHits == 0, "pills did not settle cleanly (late hits: \(lateHits))")
        print("5. settling: 12 constant tilts, all pills end pinned at a limit with v = 0, hits after 10 s: \(lateHits); hits per tilt (both pills) \(bounceCounts); last hit at \(settleTimes.map { String(format: "%.1f", $0) }) s")

        // 6. Mirror symmetry: mirroring position, velocity and gravity mirrors the whole motion exactly.
        var mirrorOK = true
        for _ in 0..<200 {
            var a = TwinPillBody(x: rng.range(52, 92.5), v: rng.range(-600, 600), lo: 52, hi: 92.5)
            var b = TwinPillBody(x: 52 + 92.5 - a.x, v: -a.v, lo: 52, hi: 92.5)
            var g = rng.range(-1, 1)
            for _ in 0..<1500 {
                if rng.unit() < 0.02 { g = rng.range(-1, 1) }
                _ = a.advance(h: c.subStep, drive: TwinPillModel.drive(forGravity: g))
                _ = b.advance(h: c.subStep, drive: TwinPillModel.drive(forGravity: -g))
                if abs(b.x - (52 + 92.5 - a.x)) > 1e-9 || abs(b.v + a.v) > 1e-9 { mirrorOK = false }
            }
        }
        expect(mirrorOK, "mirrored motion differs")
        print("6. mirror symmetry (x, v, g) -> (lo+hi-x, -v, -g): \(mirrorOK ? "exact" : "BROKEN")")

        // 7. Reduce Motion parking, finger hold / release, configure().
        var m = TwinPillModel(screenWidth: 402)
        m.left.x = m.left.lo; m.right.x = m.right.hi; m.left.v = 300; m.right.v = -300
        m.park()
        expect(m.left.x == m.left.hi && m.right.x == m.right.lo && m.left.v == 0 && m.right.v == 0, "park")
        m.hold(.left, at: -500)
        expect(m.left.x == m.left.lo && m.left.held, "hold clamps to the range")
        m.step(dt: 0.5, gravity: 1)
        expect(m.left.x == m.left.lo, "a held pill must not move")
        m.release(.left, velocity: 99_999)
        expect(m.left.v == c.maxThrowSpeed && !m.left.held, "release clamps the throw speed")
        m.configure(screenWidth: 320)
        expect(m.left.x >= m.left.lo && m.left.x <= m.left.hi && m.right.x >= m.right.lo && m.right.x <= m.right.hi, "configure keeps pills in range")
        print("7. park / hold / release / configure: ok")

        // 8. Shake: from rest on a flat phone, one shake rattles each pill between the wall and the island several times.
        do {
            var m = TwinPillModel(screenWidth: 402)
            m.shake(direction: 0)
            var hits: [TwinPillSide: Int] = [.left: 0, .right: 0]
            for _ in 0..<(60 * 6) { for hit in m.step(dt: 1.0 / 60, gravity: 0) { hits[hit.side, default: 0] += 1 } }
            expect(hits[.left]! >= 3 && hits[.right]! >= 3, "shake: only \(hits) bounces")
            expect(m.left.v == 0 && m.right.v == 0, "shake: pills still moving after 6 s")
            print("8. shake: bounces left \(hits[.left]!), right \(hits[.right]!), at rest after 6 s")
        }

        // Geometry numbers the screenshots are measured against (402 pt screen).
        let g = TwinPillGeometry(screenWidth: 402)
        print(String(format: "   geometry @402: island %.1f ... %.1f; left centre %.1f ... %.1f (travel %.1f); right centre %.1f ... %.1f (travel %.1f)",
                     g.islandLeft, g.islandRight, g.range(of: .left).lowerBound, g.range(of: .left).upperBound,
                     g.range(of: .left).upperBound - g.range(of: .left).lowerBound,
                     g.range(of: .right).lowerBound, g.range(of: .right).upperBound,
                     g.range(of: .right).upperBound - g.range(of: .right).lowerBound))

        if failures.isEmpty {
            print("PASS: \(checks) assertions, 0 failures")
        } else {
            print("FAIL: \(failures.count) of \(checks) assertions failed")
            exit(1)
        }
    }
}
