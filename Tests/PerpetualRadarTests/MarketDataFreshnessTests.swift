import Foundation
import XCTest
@testable import PerpetualRadar

@MainActor
final class MarketDataFreshnessTests: XCTestCase {
    private let id = "BTC-USDT-SWAP"
    private var hour: Int64 { Int64(Date().timeIntervalSince1970 * 1000) / hourMS * hourMS }
    private func url() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("Freshness-\(UUID())").appendingPathComponent("radar.sqlite3") }
    private func ticker(_ id: String, price: String, timestamp: Int64) -> [String: Any] {
        ["instId": id, "last": price, "volCcy24h": "1000", "bidPx": price, "askPx": price, "ts": String(timestamp)]
    }
    private func makeRadar(_ url: URL, ids: [String]? = nil) throws -> Radar {
        let ids = ids ?? [id], radar = try Radar(storeURL: url)
        try radar.initializeMarkets(instruments: ids.map { ["instId": $0, "state": "live", "instCategory": "1", "settleCcy": "USDT"] },
            tickers: ids.map { ticker($0, price: "100", timestamp: hour + 1) })
        radar.updateCandle(id, bar(hour, close: "100", volume: "10"))
        return radar
    }
    private func bar(_ ts: Int64, close: String, volume: String = "10", confirmed: Bool = false) -> [String] {
        [String(ts), "100", "200", "90", close, volume, volume, "1000", confirmed ? "1" : "0"]
    }
    private func row(_ radar: Radar, id: String? = nil) throws -> [String: Any] {
        try XCTUnwrap((radar.snapshot(rocPeriod: 9, marocPeriod: 9)["rows"] as? [[String: Any]])?.first { $0["instId"] as? String == (id ?? self.id) })
    }
    private func latest(_ radar: Radar) throws -> [String: Any] {
        try XCTUnwrap((radar.chartSnapshot(id)["bars"] as? [[String: Any]])?.last)
    }

    func testCurrentCandleRecoveryUpdatesAllReadingsAndRejectsOldOrRegressiveFrames() throws {
        let url = url(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let radar = try makeRadar(url), request = ContinuousClock.now
        try radar.updateHistoricalCandles(id, [bar(hour, close: "120", volume: "20")], requestedAt: request + .milliseconds(1))
        XCTAssertEqual(try latest(radar)["close"] as? Double, 120)
        let metrics = try XCTUnwrap(try row(radar)["filterMetrics"] as? [String: Any])
        XCTAssertEqual(metrics["liveClose"] as? Double, 120)
        try radar.updateHistoricalCandles(id, [bar(hour, close: "110", volume: "15")], requestedAt: request)
        radar.updateCandle(id, bar(hour, close: "105", volume: "12"), requestedAt: request + .milliseconds(2))
        XCTAssertEqual(try latest(radar)["close"] as? Double, 120)
        let closed = hour - hourMS
        radar.updateCandle(id, bar(closed, close: "115", confirmed: true))
        radar.updateCandle(id, bar(closed, close: "101"))
        XCTAssertEqual(try Store(url: url).candles(id, since: closed, through: closed)[closed]?.close, 115)
        XCTAssertEqual((radar.chartSnapshot(id)["bars"] as? [[String: Any]])?.first { $0["hour"] as? Int64 == closed }?["confirmed"] as? Bool, true)
    }

    func testPartialAndOutOfOrderTickersPreserveOtherMarketsAndUseTheLatestTrade() throws {
        let url = url(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let other = "ETH-USDT-SWAP", radar = try makeRadar(url, ids: [id, other])
        try radar.updateTickers([ticker(id, price: "150", timestamp: hour + 10)])
        try radar.updateTickers([ticker(id, price: "101", timestamp: hour + 2)])
        XCTAssertEqual(try row(radar)["lastPrice"] as? Double, 150)
        XCTAssertEqual(try row(radar)["price"] as? Double, 100)
        XCTAssertEqual(try row(radar, id: other)["turnover24hUSDT"] as? Double, 100_000)
        XCTAssertEqual(try latest(radar)["close"] as? Double, 100, "Latest trades do not fabricate candle OHLC or indicator inputs.")
        XCTAssertTrue(radar.advanceHourIfNeeded(now: hour + hourMS))
        try radar.updateTickers([ticker(id, price: "102", timestamp: hour + 3)])
        XCTAssertEqual(try row(radar)["lastPrice"] as? Double, 150)
    }

    func testOIUsesOneTimestampOrderedObservationAndNeverCarriesThePreviousHourIntoTheChart() throws {
        let url = url(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let radar = try makeRadar(url)
        radar.updateOI(["instId": id, "oi": "1", "oiUsd": "1200", "ts": String(hour + 1000)])
        try radar.updateOIHistory(id, [[String(hour), "1", "1", "1000"], [String(hour - hourMS), "0.8", "1", "1000"]], requestedAt: .now)
        XCTAssertEqual(try latest(radar)["oi"] as? Double, 1)
        XCTAssertEqual(try XCTUnwrap(row(radar)["oiChange"] as? Double), 25, accuracy: 0.000001)
        radar.updateOI(["instId": id, "oi": "1", "oiUsd": "NaN", "ts": String(hour + 2000)])
        XCTAssertEqual(try latest(radar)["oi"] as? Double, 1)
        XCTAssertTrue(radar.advanceHourIfNeeded(now: hour + hourMS))
        radar.updateCandle(id, bar(hour + hourMS, close: "100"))
        XCTAssertTrue(try latest(radar)["oi"] is NSNull)
        XCTAssertTrue((try row(radar)["filterMetrics"] as? [String: Any])?["oiUSD"] is NSNull)
    }

    func testConfirmedCorrectionsUpdateDiskEMAAndOtherCachedIndicatorsIncludingExternalWriters() throws {
        let url = url(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = try Store(url: url)
        try store.saveCandles(id, (1...1000).map { age in Candle(hour: hour - Int64(age) * hourMS, high: 200, low: 90, close: 100, quoteVolume: 100, baseVolume: 1, open: 100) })
        let radar = try makeRadar(url)
        let initial = try row(radar), initialMetrics = try XCTUnwrap(initial["filterMetrics"] as? [String: Any])
        XCTAssertEqual(initialMetrics["previousEMA200"] as? Double, 100)
        try store.save(id, Candle(hour: hour - hourMS, high: 200, low: 90, close: 150, quoteVolume: 150, baseVolume: 1, open: 100))
        let corrected = try row(radar), metrics = try XCTUnwrap(corrected["filterMetrics"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(metrics["previousEMA200"] as? Double), 100 + 50 * 2 / 201, accuracy: 0.000001)
        XCTAssertNotEqual(initial["rsi6"] as? Double, corrected["rsi6"] as? Double)
        XCTAssertEqual(try Store(url: url).candles(id, since: hour - hourMS, through: hour)[hour - hourMS]?.close, 150)
        XCTAssertEqual(try XCTUnwrap(try latest(radar)["ema"] as? Double), try XCTUnwrap(metrics["ema200"] as? Double), accuracy: 0.000001)
        let reopened = try makeRadar(url)
        XCTAssertEqual((try row(reopened)["filterMetrics"] as? [String: Any])?["previousEMA200"] as? Double, metrics["previousEMA200"] as? Double)
    }

    func testClosedQuotePersistenceKeepsTheNewestTimestamp() throws {
        let url = url(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = try Store(url: url)
        for (timestamp, turnover) in [(hour + 1, 100.0), (hour + 3, 300.0), (hour + 2, 200.0)] {
            try store.saveHourlyQuote(id, hour: hour, quote: .init(turnover: turnover, spread: 0.1, timestamp: timestamp))
        }
        XCTAssertEqual(try store.hourlyQuotes(id, since: hour, through: hour)[hour]?.turnover, 300)
    }

    func testFailedConfirmedCandleWritesKeepTheNewestMemoryValueAndRetryIdenticalObservations() throws {
        let url = url(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let radar = try makeRadar(url), store = try Store(url: url), closed = hour - hourMS
        try store.execute("CREATE TRIGGER reject_candle BEFORE INSERT ON candles BEGIN SELECT RAISE(ABORT,'temporary cache failure'); END")
        radar.updateCandle(id, bar(closed, close: "140", confirmed: true))
        XCTAssertNil(try store.candles(id, since: closed, through: closed)[closed])
        try store.execute("DROP TRIGGER reject_candle")
        radar.updateCandle(id, bar(closed, close: "140", confirmed: true))
        XCTAssertEqual(try store.candles(id, since: closed, through: closed)[closed]?.close, 140)
        XCTAssertEqual(radar.snapshot(rocPeriod: 9, marocPeriod: 9)["error"] as? String, "")
    }
}
