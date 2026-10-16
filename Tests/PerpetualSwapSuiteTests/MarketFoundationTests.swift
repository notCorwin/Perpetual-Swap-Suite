import Foundation
import Testing
@testable import PerpetualSwapSuite

@Test func signedRelativeChangeUsesBaseline() {
    #expect(signedRelativeChange(current: 110, baseline: 100) == 10)
    #expect(signedRelativeChange(current: 90, baseline: 100) == -10)
}

@Test func liquidityUsesConfiguredBandAndOrderSize() {
    let instrument = Instrument(
        id: "TEST-USDT-SWAP", baseCurrency: "TEST", quoteCurrency: "USDT", settlementCurrency: "USDT",
        contractValue: 1, contractValueCurrency: "TEST", tickSize: 0.01, lotSize: 1, listedAt: nil, state: "live"
    )
    let book = OrderBook(
        instrument: instrument.id, timestamp: 0,
        bids: [.init(price: 99.9, sizeContracts: 1_100), .init(price: 99, sizeContracts: 10_000)],
        asks: [.init(price: 100.1, sizeContracts: 1_100), .init(price: 101, sizeContracts: 10_000)]
    )
    let reading = LiquidityCalculator.reading(book: book, instrument: instrument, depthRangePercent: 0.5, slippageNotionalUSDT: 100_000)
    #expect(reading.spreadPercent != nil)
    #expect(reading.bidDepthUSDT! > 100_000)
    #expect(reading.askDepthUSDT! > 100_000)
    #expect(reading.buySlippagePercent! > 0)
    #expect(reading.sellSlippagePercent! > 0)
}

@Test func settingsPersistWithoutSQLite() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = try AppPaths(root: root)
    let store = try SettingsStore(url: paths.settings)
    _ = try await store.update { $0.leverage = 7 }
    let reopened = try SettingsStore(url: paths.settings)
    #expect(await reopened.current().leverage == 7)
}

@Test func completedCandlesRoundTripThroughParquet() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = try AppPaths(root: root)
    let store = try ParquetMarketStore(paths: paths)
    let candles = [
        Candle(instrument: "BTC-USDT-SWAP", timestamp: 1_704_067_200_000, open: 100, high: 102, low: 99, close: 101, volumeContracts: 12, volumeBase: 1.2, volumeQuote: 121, confirmed: true),
        Candle(instrument: "BTC-USDT-SWAP", timestamp: 1_704_067_500_000, open: 101, high: 103, low: 100, close: 102, volumeContracts: 13, volumeBase: 1.3, volumeQuote: 132, confirmed: true),
    ]
    try await store.upsert(candles: candles)
    try await store.upsert(candles: [candles[1]])
    let loaded = try await store.candles(instrument: "BTC-USDT-SWAP")
    #expect(loaded == candles)
    let coverage = try await store.coverage(instrument: "BTC-USDT-SWAP")
    #expect(coverage.candleCount == 2)
    #expect(coverage.gaps == 0)
}
