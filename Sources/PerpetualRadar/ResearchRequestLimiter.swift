import Foundation

// All Research transports share admission and cooldowns. Recheck after every
// sleep: reserving future slots lets delayed tasks send a burst when they wake.
actor ResearchRequestLimiter {
    static let shared = ResearchRequestLimiter()
    private let interval: Duration
    private let initialBackoff: Double
    private let maximumBackoff: Double
    private let jitter: Double
    private var nextRequest: [String: ContinuousClock.Instant] = [:]
    private var cooldown: [String: ContinuousClock.Instant] = [:]

    init(interval: Duration = .milliseconds(500), initialBackoff: Double = 2, maximumBackoff: Double = 60, jitter: Double = 0.25) {
        self.interval = interval; self.initialBackoff = initialBackoff
        self.maximumBackoff = maximumBackoff; self.jitter = jitter
    }

    func wait(for url: URL) async throws {
        let host = url.host ?? "", key = host + (url.path.hasPrefix("/api/v5/") ? url.path : "/archives")
        while true {
            try Task.checkCancellation()
            let now = ContinuousClock.now
            let scheduled = max(nextRequest[key] ?? now, cooldown[host] ?? now)
            if scheduled > now {
                try await Task.sleep(until: scheduled, clock: .continuous)
            } else {
                // OKX's archive catalog allows 5 requests / 2 seconds per IP.
                // Leave headroom and serialize admission across transport instances.
                nextRequest[key] = now + interval
                return
            }
        }
    }

    func retrying(_ url: URL, response: HTTPURLResponse? = nil, attempt: Int) -> Double {
        let backoff = min(maximumBackoff, initialBackoff * pow(2, Double(min(attempt, 30))) + Double.random(in: 0...jitter))
        let delay = max(backoff, response.flatMap(Self.retryAfter) ?? 0)
        let host = url.host ?? "", now = ContinuousClock.now
        let deadline = max(cooldown[host] ?? now, now + .seconds(delay))
        cooldown[host] = deadline
        return researchSeconds(now.duration(to: deadline))
    }

    private static func retryAfter(_ response: HTTPURLResponse) -> Double? {
        guard let header = response.value(forHTTPHeaderField: "Retry-After")?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        if let seconds = Double(header), seconds.isFinite, seconds >= 0, seconds < Double(Int64.max / 1_000_000) { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        guard let date = formatter.date(from: header) else { return nil }
        let seconds = max(0, date.timeIntervalSinceNow)
        return seconds.isFinite && seconds < Double(Int64.max / 1_000_000) ? seconds : nil
    }
}

actor ResearchCatalogReporter {
    private let kind: String, total: Int, pending: Int
    private let progress: @Sendable (ResearchCatalogProgress) async -> Void
    private let started = ContinuousClock.now
    private var completed: Int, fetched = 0
    private var retryAt: Int64?

    init(kind: String, total: Int, completed: Int, pending: Int, progress: @escaping @Sendable (ResearchCatalogProgress) async -> Void) {
        self.kind = kind; self.total = total; self.completed = completed; self.pending = pending; self.progress = progress
    }

    func retrying(_ seconds: Double) async {
        retryAt = max(retryAt ?? 0, researchNow() + Int64(seconds * 1_000))
        await progress(.init(kind: kind, completed: completed, total: total,
                             message: "Temporary request failure or OKX rate limit · waiting to retry the current catalog page automatically.", waitingForResponse: true,
                             retryAt: retryAt))
    }

    func finished(dates: String) async {
        completed += 1; fetched += 1
        if fetched == pending || (retryAt ?? 0) <= researchNow() { retryAt = nil }
        let remaining = Double(pending - fetched) * researchSeconds(started.duration(to: .now)) / Double(fetched)
        await progress(.init(kind: kind, completed: completed, total: total,
                             message: "Checking \(kind) archive catalog · \(completed)/\(total) pages · checked \(dates)",
                             waitingForResponse: fetched < pending, remainingSeconds: remaining, retryAt: retryAt))
    }
}
