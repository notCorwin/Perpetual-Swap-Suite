import Foundation

actor BacktestService {
    private let market: MarketService
    private let store: ParquetMarketStore
    private let settingsStore: SettingsStore
    private let strategies: StrategyStore
    private let runtime: NodeStrategyRuntime
    private let engine = BacktestEngine()

    init(
        market: MarketService, store: ParquetMarketStore, settings: SettingsStore,
        strategies: StrategyStore, runtime: NodeStrategyRuntime
    ) {
        self.market = market
        self.store = store
        settingsStore = settings
        self.strategies = strategies
        self.runtime = runtime
    }

    func run(_ request: BacktestRequest) async throws -> BacktestReport {
        guard let instrument = await market.instrument(id: request.instrument) else { throw BacktestError.instrumentUnavailable }
        let settings = await settingsStore.current()
        let candles = try await store.candles(
            instrument: request.instrument, timeframe: .fiveMinutes,
            from: request.from, through: request.through
        )
        let strategyURL = try await strategies.fileURL(id: request.strategyID)
        let session = try runtime.session(strategyURL: strategyURL)
        try await session.initialize(settings: settings)
        defer { Task { await session.stop() } }
        return try await engine.run(
            request: request, instrument: instrument, settings: settings, candles: candles,
            execute: { event in try await session.evaluate(event) }
        )
    }
}
