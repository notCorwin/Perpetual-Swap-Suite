import Foundation

actor MarketService {
    private let store: ParquetMarketStore
    private let settingsStore: SettingsStore
    private let client: OKXClient
    private var instruments = [String: Instrument]()
    private var markets = [MarketSummary]()
    private var forming = [String: Candle]()
    private var cache = [String: [Candle]]()
    private var status = "Starting"
    private var lastError: String?
    private var updatedAt: Int64 = 0

    init(store: ParquetMarketStore, settings: SettingsStore, client: OKXClient = OKXClient()) {
        self.store = store
        settingsStore = settings
        self.client = client
    }

    func refresh(selectedInstrument: String? = nil) async {
        do {
            status = "Refreshing markets"
            let settings = await settingsStore.current()
            let listed = try await client.instruments().filter {
                $0.state == "live" && settings.settlementCurrencies.contains($0.settlementCurrency) && $0.id != "USDC-USDT-SWAP"
            }
            instruments = Dictionary(uniqueKeysWithValues: listed.map { ($0.id, $0) })
            async let tickerTask = client.tickers()
            let openInterest = (try? await client.openInterest()) ?? [:]
            let tickers = try await tickerTask
            let ranked = listed.sorted {
                estimatedVolume(tickers[$0.id]) > estimatedVolume(tickers[$1.id])
            }
            let candidates = Array(ranked.prefix(60))
            let books = await loadBooks(for: candidates)
            markets = candidates.map { instrument in
                summary(
                    instrument: instrument, ticker: tickers[instrument.id],
                    openInterest: openInterest[instrument.id], book: books[instrument.id], settings: settings
                )
            }.sorted { left, right in
                if left.eligible != right.eligible { return left.eligible && !right.eligible }
                return (left.volume24hUSDT ?? 0) > (right.volume24hUSDT ?? 0)
            }
            let selected = selectedInstrument ?? settings.selectedInstrument
            if instruments[selected] != nil { try await refreshCandles(instrument: selected) }
            status = "Live"
            lastError = nil
            updatedAt = unixMilliseconds()
        } catch {
            status = "Degraded"
            lastError = error.localizedDescription
        }
    }

    func refreshCandles(instrument: String) async throws {
        let values = try await client.candles(instrument: instrument, limit: 300)
        let completed = values.filter(\.confirmed)
        forming[instrument] = values.last(where: { !$0.confirmed })
        try await store.upsert(candles: completed)
        cache[instrument] = try await store.candles(instrument: instrument, limit: 500)
    }

    func snapshot(instrument: String? = nil) async -> WorkspaceSnapshot {
        let settings = await settingsStore.current()
        let selected = instrument ?? settings.selectedInstrument
        let values = (try? await store.candles(
            instrument: selected, timeframe: settings.selectedTimeframe, limit: 500
        )) ?? []
        let live = formingCandle(instrument: selected, timeframe: settings.selectedTimeframe)
        let coverage = try? await store.coverage(instrument: selected)
        return .init(
            markets: markets, selectedInstrument: selected, candles: values,
            formingCandle: live, coverage: coverage, settings: settings,
            status: status, error: lastError, updatedAt: updatedAt
        )
    }

    func select(_ instrument: String) async throws -> WorkspaceSnapshot {
        _ = try await settingsStore.update { $0.selectedInstrument = instrument }
        try await refreshCandles(instrument: instrument)
        return await snapshot(instrument: instrument)
    }

    func updateSettings(_ settings: AppSettings) async throws -> WorkspaceSnapshot {
        _ = try await settingsStore.replace(with: settings)
        await refresh(selectedInstrument: settings.selectedInstrument)
        return await snapshot(instrument: settings.selectedInstrument)
    }

    func validateData() async throws -> ParquetMarketStore.ValidationReport { try await store.validate() }
    func query(_ sql: String) async throws -> [[String: AnyCodable]] { try await store.queryJSON(sql) }

    private func loadBooks(for instruments: [Instrument]) async -> [String: OrderBook] {
        await withTaskGroup(of: (String, OrderBook?).self, returning: [String: OrderBook].self) { group in
            for instrument in instruments {
                group.addTask {
                    (instrument.id, try? await self.client.orderBook(instrument: instrument.id))
                }
            }
            var result = [String: OrderBook]()
            for await (id, book) in group { if let book { result[id] = book } }
            return result
        }
    }

    private func estimatedVolume(_ ticker: OKXTicker?) -> Double {
        guard let ticker, let last = ticker.last, let volume = ticker.volumeBase24h else { return 0 }
        return last * volume
    }

    private func summary(
        instrument: Instrument, ticker: OKXTicker?, openInterest: Double?, book: OrderBook?, settings: AppSettings
    ) -> MarketSummary {
        let volume = estimatedVolume(ticker)
        let liquidity = book.map {
            LiquidityCalculator.reading(
                book: $0, instrument: instrument, depthRangePercent: settings.depthRangePercent,
                slippageNotionalUSDT: settings.slippageNotionalUSDT
            )
        } ?? .init(spreadPercent: nil, bidDepthUSDT: nil, askDepthUSDT: nil, buySlippagePercent: nil, sellSlippagePercent: nil)
        var missing = [String]()
        if liquidity.spreadPercent.map({ $0 >= settings.spreadLimitPercent }) ?? true { missing.append("Spread") }
        if liquidity.bidDepthUSDT.map({ $0 <= settings.minimumSideDepthUSDT }) ?? true { missing.append("Bid depth") }
        if liquidity.askDepthUSDT.map({ $0 <= settings.minimumSideDepthUSDT }) ?? true { missing.append("Ask depth") }
        if liquidity.buySlippagePercent.map({ $0 >= settings.slippageLimitPercent }) ?? true { missing.append("Buy slippage") }
        if liquidity.sellSlippagePercent.map({ $0 >= settings.slippageLimitPercent }) ?? true { missing.append("Sell slippage") }
        if volume <= settings.minimumVolume24hUSDT { missing.append("24h volume") }
        if (openInterest ?? 0) <= settings.minimumOpenInterestUSDT { missing.append("Open interest") }
        let change = ticker.flatMap { value -> Double? in
            guard let last = value.last, let open = value.open24h else { return nil }
            return signedRelativeChange(current: last, baseline: open)
        }
        return .init(
            instrument: instrument, last: ticker?.last, change24hPercent: change,
            volume24hUSDT: volume == 0 ? nil : volume, openInterestUSDT: openInterest,
            fundingRatePercent: nil, liquidity: liquidity, eligible: missing.isEmpty,
            missingRequirements: missing, updatedAt: ticker?.timestamp ?? unixMilliseconds()
        )
    }

    private func formingCandle(instrument: String, timeframe: Timeframe) -> Candle? {
        guard let live = forming[instrument] else { return nil }
        if timeframe == .fiveMinutes { return live }
        let bucket = live.timestamp / timeframe.milliseconds * timeframe.milliseconds
        let sources = (cache[instrument] ?? []).filter { $0.timestamp >= bucket && $0.timestamp < live.timestamp } + [live]
        guard let first = sources.first else { return nil }
        return Candle(
            instrument: instrument, timestamp: bucket, open: first.open,
            high: sources.map(\.high).max() ?? live.high, low: sources.map(\.low).min() ?? live.low,
            close: live.close, volumeContracts: sources.reduce(0) { $0 + $1.volumeContracts },
            volumeBase: sources.compactMap(\.volumeBase).reduce(0, +),
            volumeQuote: sources.compactMap(\.volumeQuote).reduce(0, +), confirmed: false
        )
    }
}
