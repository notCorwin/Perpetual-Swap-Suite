import Foundation
import Testing
@testable import PerpetualSwapSuite

@Test func tradingViewPathStartsWithNearestExtreme() {
    let lowFirst = Candle(instrument: "TEST", timestamp: 0, open: 100, high: 110, low: 99, close: 104, volumeContracts: 1, volumeBase: nil, volumeQuote: nil, confirmed: true)
    #expect(TradingViewPath.ticks(for: lowFirst).map(\.price) == [100, 99, 110, 104])
    let highFirst = Candle(instrument: "TEST", timestamp: 0, open: 100, high: 101, low: 90, close: 96, volumeContracts: 1, volumeBase: nil, volumeQuote: nil, confirmed: true)
    #expect(TradingViewPath.ticks(for: highFirst).map(\.price) == [100, 101, 90, 96])
}

@Test func marketEntryFillsOnNextTickAndDefaultTakeProfitClosesTrade() async throws {
    let instrument = Instrument(
        id: "TEST-USDT-SWAP", baseCurrency: "TEST", quoteCurrency: "USDT", settlementCurrency: "USDT",
        contractValue: 1, contractValueCurrency: "TEST", tickSize: 0.01, lotSize: 1, listedAt: nil, state: "live"
    )
    let candles = [
        Candle(instrument: instrument.id, timestamp: 0, open: 100, high: 100.4, low: 99.8, close: 100, volumeContracts: 10, volumeBase: nil, volumeQuote: nil, confirmed: true),
        Candle(instrument: instrument.id, timestamp: 300_000, open: 100, high: 102, low: 100, close: 101, volumeContracts: 10, volumeBase: nil, volumeQuote: nil, confirmed: true),
    ]
    let strategy = OneEntryStrategy()
    let request = BacktestRequest(
        strategyID: "test", instrument: instrument.id, timeframe: .fiveMinutes,
        from: 0, through: 600_000, execution: .init()
    )
    let report = try await BacktestEngine().run(
        request: request, instrument: instrument, settings: AppSettings(), candles: candles,
        funding: [.init(instrument: instrument.id, timestamp: 400_000, rate: 0.001)],
        execute: { event in await strategy.commands(for: event) }
    )
    #expect(report.totalTrades == 1)
    #expect(report.winningTrades == 1)
    let trade = try #require(report.trades.first)
    #expect(trade.entryAt >= 300_000)
    #expect(trade.exitReason == "Take profit")
    #expect(trade.fundingUSDT > 0)
}

@Test func nodeRuntimeLoadsAUserStrategy() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = try AppPaths(root: root)
    let store = try ParquetMarketStore(paths: paths)
    let strategyURL = paths.strategies.appendingPathComponent("runtime-test.mjs")
    try "export function onTick() { strategy.entry('test', strategy.long, { quantity: 2 }) }".write(to: strategyURL, atomically: true, encoding: .utf8)
    let session = try NodeStrategyRuntime(paths: paths, store: store).session(strategyURL: strategyURL)
    try await session.initialize(settings: AppSettings())
    let event = StrategyEvent(
        reason: .barClose, instrument: "TEST-USDT-SWAP", timeframe: .fiveMinutes,
        timestamp: 0, price: 100,
        bar: .init(timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 1, confirmed: true),
        position: nil,
        account: .init(balanceUSDT: 300, equityUSDT: 300, availableUSDT: 300, feesUSDT: 0, fundingUSDT: 0),
        settings: AppSettings()
    )
    let commands = try await session.evaluate(event)
    #expect(commands.count == 1)
    #expect(commands[0].action == .entry)
    #expect(commands[0].direction == .long)
    #expect(commands[0].quantity == 2)
    await session.stop()
}

private actor OneEntryStrategy {
    private var entered = false
    func commands(for event: StrategyEvent) -> [StrategyCommand] {
        guard event.bar.confirmed, !entered else { return [] }
        entered = true
        return [.init(
            action: .entry, id: "long", direction: .long, side: nil, type: nil,
            quantity: nil, marginUSDT: 300, leverage: 10, limitPrice: nil,
            stopPrice: nil, reduceOnly: nil, ocaGroup: nil
        )]
    }
}
