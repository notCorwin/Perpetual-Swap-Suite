import Foundation

struct TakerVolume: Equatable, Sendable {
    let hour: Int64
    let sell: Double
    let buy: Double

    init?(_ values: [String]) {
        guard values.count >= 3, let hour = Int64(values[0]), hour >= 0, hour % hourMS == 0,
              let sell = Double(values[1]), let buy = Double(values[2]),
              sell.isFinite, buy.isFinite, sell >= 0, buy >= 0 else { return nil }
        self.hour = hour; self.sell = sell; self.buy = buy
    }

    var imbalance: Double? {
        let total = buy + sell
        guard total.isFinite, total > 0 else { return nil }
        return (buy - sell) / total * 100
    }
}

struct TakerVolumeResponse: Sendable {
    let id: String
    let requestedAt: ContinuousClock.Instant
    let volumes: [TakerVolume]
    var error: String?
}

// The OKX quota is per IP + instrument, so independent contracts need not
// wait for each other's network round trips or a slow/failed contract.
struct TakerVolumePoller: Sendable {
    let transport: any FilterHistoryTransport
    var concurrency = 16

    func refresh(_ instruments: [String], receive: @escaping @Sendable (TakerVolumeResponse) async -> Void) async {
        await withTaskGroup(of: Void.self) { group in
            var remaining = instruments.makeIterator()
            func enqueue(_ id: String) {
                group.addTask {
                    let requestedAt = ContinuousClock.now
                    do {
                        try Task.checkCancellation()
                        let rows = try await transport.fetch(path: "/rubik/stat/taker-volume-contract",
                            // Live polling needs only the forming hour and the
                            // most recently closed hour. Historical hydration
                            // has its own paginated loader.
                            parameters: ["instId": id, "period": "1H", "unit": "1", "limit": "2"])
                        try Task.checkCancellation()
                        await receive(.init(id: id, requestedAt: requestedAt, volumes: rows.compactMap(TakerVolume.init)))
                    } catch {
                        if !Task.isCancelled { await receive(.init(id: id, requestedAt: requestedAt, volumes: [], error: error.localizedDescription)) }
                    }
                }
            }
            for _ in 0..<max(1, concurrency) { if let id = remaining.next() { enqueue(id) } }
            for await _ in group {
                guard !Task.isCancelled else { group.cancelAll(); break }
                if let id = remaining.next() { enqueue(id) }
            }
        }
    }
}
