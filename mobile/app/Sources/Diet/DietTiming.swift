import Foundation

/// Sampling only counts uninterrupted foreground time. A delayed timer must not turn sleep into browsing.
enum DietTiming {
    static func elapsed(since previous: TimeInterval?, now: TimeInterval, cadence: TimeInterval = 5) -> TimeInterval {
        guard let previous, now >= previous, now - previous <= cadence * 2 else { return 0 }
        return now - previous
    }

    static func watched(since previous: Double?, now: Double?, elapsed: TimeInterval) -> TimeInterval {
        guard elapsed > 0, let previous, let now, previous.isFinite, now.isFinite else { return 0 }
        let delta = now - previous
        // Pauses/buffering add nothing. A large jump is a seek, rather than time spent watching.
        guard delta >= 0, delta <= elapsed * 2 + 0.5 else { return 0 }
        return min(delta, elapsed * 2)
    }
}
