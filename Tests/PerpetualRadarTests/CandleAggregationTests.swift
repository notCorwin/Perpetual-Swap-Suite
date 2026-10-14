import XCTest
@testable import PerpetualRadar

final class CandleAggregationTests: XCTestCase {
    private func bar(_ timestamp: Int64, open: Double, high: Double, low: Double, close: Double,
                     base: Double, quote: Double, confirmed: Bool = true) -> Candle {
        Candle(hour: timestamp, high: high, low: low, close: close, quoteVolume: quote,
               baseVolume: base, open: open, confirmed: confirmed)
    }

    func testFifteenMinuteAggregationUsesNaturalBoundariesAndOHLCVSources() throws {
        let start = Int64(100) * hourMS
        let source = Dictionary(uniqueKeysWithValues: [
            bar(start, open: 100, high: 105, low: 99, close: 102, base: 1, quote: 101),
            bar(start + fiveMinuteMS, open: 102, high: 108, low: 101, close: 107, base: 2, quote: 210),
            bar(start + 2 * fiveMinuteMS, open: 107, high: 109, low: 103, close: 104, base: 3, quote: 315),
        ].map { ($0.hour, $0) })
        let result = try XCTUnwrap(aggregateFiveMinuteCandles(source, timeframe: .fifteenMinutes)[start])
        XCTAssertEqual(result.open, 100)
        XCTAssertEqual(result.high, 109)
        XCTAssertEqual(result.low, 99)
        XCTAssertEqual(result.close, 104)
        XCTAssertEqual(result.baseVolume, 6)
        XCTAssertEqual(result.quoteVolume, 626)
        XCTAssertTrue(result.confirmed)
    }

    func testHourlyAggregationRequiresAllTwelveConfirmedSourceCandles() throws {
        let start = Int64(100) * hourMS
        var source = Dictionary(uniqueKeysWithValues: (0..<12).map { index in
            let timestamp = start + Int64(index) * fiveMinuteMS
            let value = Double(index + 1)
            let candle = bar(timestamp, open: value, high: value + 2, low: value - 0.5,
                             close: value + 1, base: 1, quote: 10, confirmed: index != 11)
            return (timestamp, candle)
        })
        let live = try XCTUnwrap(aggregateFiveMinuteCandle(source, startingAt: start, timeframe: .oneHour, allowIncomplete: true))
        XCTAssertFalse(live.confirmed)
        XCTAssertEqual(live.open, 1)
        XCTAssertEqual(live.close, 13)
        XCTAssertNil(aggregateFiveMinuteCandle(source, startingAt: start, timeframe: .oneHour))
        source[start + 11 * fiveMinuteMS] = bar(start + 11 * fiveMinuteMS, open: 12, high: 14, low: 11.5, close: 13, base: 1, quote: 10)
        XCTAssertTrue(try XCTUnwrap(aggregateFiveMinuteCandle(source, startingAt: start, timeframe: .oneHour)).confirmed)
    }

    func testOnlyLatestContiguousBucketMayBePartial() throws {
        let start = Int64(100) * hourMS
        let first = bar(start, open: 1, high: 2, low: 1, close: 2, base: 1, quote: 2)
        let third = bar(start + 2 * fiveMinuteMS, open: 2, high: 3, low: 2, close: 3, base: 1, quote: 3, confirmed: false)
        let gap = [first.hour: first, third.hour: third]
        XCTAssertNil(aggregateFiveMinuteCandle(gap, startingAt: start, timeframe: .fifteenMinutes, allowIncomplete: true))
        let contiguous = [first.hour: first]
        let live = try XCTUnwrap(aggregateFiveMinuteCandle(contiguous, startingAt: start, timeframe: .fifteenMinutes, allowIncomplete: true))
        XCTAssertFalse(live.confirmed)
    }

    func testStorePersistsSourceAndRebuildsCorrectedAggregates() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CandleAggregation-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try Store(url: directory.appendingPathComponent("radar.sqlite3"))
        let id = "BTC-USDT-SWAP", start = Int64(100) * hourMS
        var bars = (0..<12).map { index in
            let timestamp = start + Int64(index) * fiveMinuteMS
            return bar(timestamp, open: 100 + Double(index), high: 102 + Double(index), low: 99 + Double(index),
                       close: 101 + Double(index), base: 1, quote: 100)
        }
        try store.ingestFiveMinuteCandles(id, bars)
        XCTAssertEqual(try store.candles(id, since: start, through: start, timeframe: .fifteenMinutes)[start]?.close, 103)
        XCTAssertEqual(try store.candles(id, since: start, through: start)[start]?.close, 112)
        bars[1] = bar(start + fiveMinuteMS, open: 101, high: 150, low: 100, close: 149, base: 2, quote: 200)
        try store.ingestFiveMinuteCandles(id, [bars[1]])
        let fifteen = try XCTUnwrap(store.candles(id, since: start, through: start, timeframe: .fifteenMinutes)[start])
        let hourly = try XCTUnwrap(store.candles(id, since: start, through: start)[start])
        XCTAssertEqual(fifteen.high, 150)
        XCTAssertEqual(fifteen.baseVolume, 4)
        XCTAssertEqual(hourly.high, 150)
        XCTAssertEqual(hourly.baseVolume, 13)
    }

    @MainActor
    func testRadarSnapshotsExposeFiveFifteenAndHourlyViewsFromFiveMinuteUpdates() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("RadarTimeframes-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let radar = try Radar(storeURL: directory.appendingPathComponent("radar.sqlite3"))
        let id = "BTC-USDT-SWAP"
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        let start = now / hourMS * hourMS
        let currentFiveMinuteIndex = Int((now - start) / fiveMinuteMS)
        try radar.initializeMarkets(
            instruments: [["instId": id, "state": "live", "instCategory": "1", "settleCcy": "USDT"]],
            tickers: [["instId": id, "last": "120", "volCcy24h": "1000", "bidPx": "119", "askPx": "121", "ts": String(now)]])
        for index in 0...currentFiveMinuteIndex {
            let timestamp = start + Int64(index) * fiveMinuteMS
            let close = 101 + index
            _ = radar.updateFiveMinuteCandle(id, [String(timestamp), String(100 + index), String(103 + index), String(99 + index), String(close), "1", "1", "100", index == currentFiveMinuteIndex ? "0" : "1"])
        }
        func row(_ timeframe: CandleTimeframe) throws -> [String: Any] {
            let snapshot = radar.snapshot(rocPeriod: 9, marocPeriod: 9, timeframe: timeframe)
            XCTAssertEqual(snapshot["timeframe"] as? String, timeframe.rawValue)
            return try XCTUnwrap((snapshot["rows"] as? [[String: Any]])?.first)
        }
        XCTAssertEqual(try row(.fiveMinutes)["price"] as? Double, Double(101 + currentFiveMinuteIndex))
        XCTAssertEqual(try row(.fifteenMinutes)["price"] as? Double, Double(101 + currentFiveMinuteIndex))
        XCTAssertEqual(try row(.oneHour)["price"] as? Double, Double(101 + currentFiveMinuteIndex))
        let fifteenBars = radar.chartSnapshot(id, timeframe: .fifteenMinutes)["bars"] as? [[String: Any]]
        XCTAssertEqual(fifteenBars?.count, currentFiveMinuteIndex / 3 + 1)
        XCTAssertEqual(fifteenBars?.last?["confirmed"] as? Bool, false)
        let hourlyBars = radar.chartSnapshot(id, timeframe: .oneHour)["bars"] as? [[String: Any]]
        XCTAssertEqual(hourlyBars?.last?["confirmed"] as? Bool, false)
    }
}
