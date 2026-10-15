import Foundation

actor DataSyncService {
    private let store: ParquetMarketStore
    private let client: OKXClient
    private var state = DataSyncStatus()
    private var task: Task<Void, Never>?

    init(store: ParquetMarketStore, client: OKXClient = OKXClient()) {
        self.store = store
        self.client = client
    }

    func status() -> DataSyncStatus { state }

    func start(instruments: [String]) throws -> DataSyncStatus {
        guard task == nil else { throw DataSyncError.alreadyRunning }
        let unique = Array(Set(instruments.filter { !$0.isEmpty && $0 != "USDC-USDT-SWAP" })).sorted()
        guard !unique.isEmpty else { throw DataSyncError.noInstruments }
        state = .init(
            active: true, instruments: unique, completedInstruments: 0,
            currentInstrument: unique.first, downloadedCandles: 0, downloadedFundingRates: 0,
            startedAt: unixMilliseconds(), finishedAt: nil, error: nil
        )
        task = Task { await run(instruments: unique) }
        return state
    }

    func cancel() -> DataSyncStatus {
        task?.cancel()
        task = nil
        state.active = false
        state.finishedAt = unixMilliseconds()
        return state
    }

    private func run(instruments: [String]) async {
        do {
            for instrument in instruments {
                try Task.checkCancellation()
                state.currentInstrument = instrument
                let candles = try await allCandles(instrument: instrument)
                try await store.upsert(candles: candles)
                let funding = try await allFunding(instrument: instrument)
                try await store.upsert(funding: funding)
                state.completedInstruments += 1
            }
            state.active = false
            state.currentInstrument = nil
            state.finishedAt = unixMilliseconds()
            task = nil
        } catch is CancellationError {
            state.active = false
            state.currentInstrument = nil
            state.finishedAt = unixMilliseconds()
            task = nil
        } catch {
            state.active = false
            state.error = error.localizedDescription
            state.finishedAt = unixMilliseconds()
            task = nil
        }
    }

    private func allCandles(instrument: String) async throws -> [Candle] {
        var cursor: Int64?
        var oldest = Int64.max
        var values = [Candle]()
        while true {
            try Task.checkCancellation()
            let page = try await client.candles(instrument: instrument, after: cursor, limit: 300).filter(\.confirmed)
            guard !page.isEmpty, let next = page.first?.timestamp, next < oldest else { break }
            values.append(contentsOf: page)
            state.downloadedCandles += page.count
            oldest = next
            cursor = next
            if page.count < 300 { break }
        }
        return Array(Dictionary(grouping: values, by: \.timestamp).values.compactMap(\.last)).sorted { $0.timestamp < $1.timestamp }
    }

    private func allFunding(instrument: String) async throws -> [FundingPoint] {
        var cursor: Int64?
        var oldest = Int64.max
        var values = [FundingPoint]()
        while true {
            try Task.checkCancellation()
            let page = try await client.fundingHistory(instrument: instrument, after: cursor)
            guard !page.isEmpty, let next = page.first?.timestamp, next < oldest else { break }
            values.append(contentsOf: page)
            state.downloadedFundingRates += page.count
            oldest = next
            cursor = next
            if page.count < 400 { break }
        }
        return Array(Dictionary(grouping: values, by: \.timestamp).values.compactMap(\.last)).sorted { $0.timestamp < $1.timestamp }
    }
}

enum DataSyncError: LocalizedError {
    case alreadyRunning, noInstruments
    var errorDescription: String? {
        switch self {
        case .alreadyRunning: "A historical data sync is already running."
        case .noInstruments: "Select at least one contract to synchronize."
        }
    }
}
