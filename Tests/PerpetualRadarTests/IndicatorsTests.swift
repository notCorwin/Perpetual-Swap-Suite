import XCTest
@testable import PerpetualRadar

final class IndicatorsTests: XCTestCase {
    func testCompletedHistoryHoursUsesListingHourAndCapsLookback() {
        let hour = Int64(200) * hourMS
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour - 36 * hourMS - hourMS / 2, limit: 96), 37)
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour - hourMS + hourMS / 2, limit: 96), 1)
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour + hourMS / 2, limit: 96), 0)
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour + hourMS, limit: 96), 0)
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour - 96 * hourMS, limit: 96), 96)
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour - 150 * hourMS, limit: 96), 96)
        XCTAssertEqual(completedHistoryHours(at: hour, since: nil, limit: 96), 96)
        XCTAssertEqual(completedHistoryHours(at: hour, since: -1, limit: 96), 96)
        XCTAssertEqual(completedHistoryHours(at: 10 * hourMS, since: 0, limit: 96), 10)
        XCTAssertEqual(completedHistoryHours(at: hour, since: hour - 36 * hourMS - hourMS / 2, limit: 14), 14)
    }

    func testStandardIndicatorsUseTheirOwnMinimumHistoryBelow48Hours() throws {
        let hour = Int64(200) * hourMS
        func bars(count: Int) -> [Int64: Candle] {
            Dictionary(uniqueKeysWithValues: (0..<count).map { age in
                let ts = hour - Int64(age) * hourMS
                return (ts, Candle(hour: ts, high: 200, low: 1, close: Double(100 - age), quoteVolume: 100, baseVolume: 1))
            })
        }
        let youngMarket = bars(count: 38)
        XCTAssertNotNil(rocMaroc(youngMarket, hour, 9, 9).0)
        XCTAssertNotNil(rocMaroc(youngMarket, hour, 9, 9).1)
        XCTAssertEqual(vwap14(youngMarket, hour), 100)
        for period in [6, 12, 24] {
            XCTAssertEqual(rsi(youngMarket, hour, period), 100)
            XCTAssertEqual(rsi(bars(count: period + 1), hour, period), 100)
            XCTAssertNil(rsi(bars(count: period), hour, period))
        }
        let (upper, middle, lower) = logBB(youngMarket, hour)
        XCTAssertNotNil(upper)
        XCTAssertNotNil(middle)
        XCTAssertNotNil(lower)
        XCTAssertNotNil(logBBBandWidth(upper, middle, lower))
        XCTAssertEqual(try XCTUnwrap(rocMaroc(bars(count: 10), hour, 9, 9).0), (100.0 / 91 - 1) * 100, accuracy: 0.000001)
        XCTAssertNil(rocMaroc(bars(count: 9), hour, 9, 9).0)
        XCTAssertNotNil(rocMaroc(bars(count: 18), hour, 9, 9).1)
        XCTAssertNil(rocMaroc(bars(count: 17), hour, 9, 9).1)
        XCTAssertEqual(vwap14(bars(count: 14), hour), 100)
        XCTAssertNil(vwap14(bars(count: 13), hour))
        XCTAssertNotNil(logBB(bars(count: 20), hour).0)
        XCTAssertNil(logBB(bars(count: 19), hour).0)
    }

    func testPercentageChangesUseAbsolutePreviousValueAndPercentageUnits() throws {
        for (current, previous, expected) in [
            (120.0, 100.0, 20.0), (100, 120, -100.0 / 6),
            (80, 100, -20), (100, 80, 25),
            (200, 100, 100), (100, 200, -50), (100, 100, 0),
            (-80, -100, 20), (-120, -100, -20),
            (0, -100, 100), (0, 100, -100),
            (100, -100, 200), (-100, 100, -200),
        ] {
            XCTAssertEqual(try XCTUnwrap(percentChange(current, previous)), expected, accuracy: 0.000001)
        }
    }

    func testPercentageChangesHandleEveryZeroBaselineBranch() {
        XCTAssertEqual(percentChange(0, 0), 0)
        XCTAssertEqual(percentChange(0, -0.0), 0)
        XCTAssertEqual(percentChange(100, 0), .infinity)
        XCTAssertEqual(percentChange(-100, 0), -.infinity)
        XCTAssertEqual(percentChange(100, -0.0), .infinity)
        XCTAssertEqual(percentChange(-100, -0.0), -.infinity)
    }

    func testPercentageChangesKeepMissingAndNonfiniteInputsUnavailable() {
        XCTAssertNil(percentChange(nil, 100))
        XCTAssertNil(percentChange(100, nil))
        XCTAssertNil(percentChange(.nan, 100))
        XCTAssertNil(percentChange(100, .nan))
        XCTAssertNil(percentChange(.infinity, 100))
        XCTAssertNil(percentChange(100, -.infinity))
        XCTAssertNil(percentChange(nil, 0))
        XCTAssertNil(percentChange(.nan, 0))
    }

    func testPercentageChangesAvoidOverflowInFiniteDifferences() {
        XCTAssertEqual(percentChange(.greatestFiniteMagnitude, -.greatestFiniteMagnitude), 200)
        XCTAssertEqual(percentChange(-.greatestFiniteMagnitude, .greatestFiniteMagnitude), -200)
        XCTAssertEqual(percentChange(.greatestFiniteMagnitude, .leastNormalMagnitude), .infinity)
        XCTAssertEqual(percentChange(.leastNormalMagnitude, .greatestFiniteMagnitude), -100)
    }

    func testPercentageSnapshotsPreserveZeroAndInfinitiesAcrossJSON() throws {
        let snapshot = [
            "priceChange": percentageSnapshot(percentChange(80, 100)),
            "oiChange": percentageSnapshot(percentChange(1, 0)),
            "rocChange": percentageSnapshot(percentChange(-1, 0)),
            "marocChange": percentageSnapshot(percentChange(0, 0)),
            "missing": percentageSnapshot(nil),
            "invalid": percentageSnapshot(.nan),
        ]
        XCTAssertTrue(JSONSerialization.isValidJSONObject(snapshot))
        let data = try JSONSerialization.data(withJSONObject: snapshot)
        let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(result["priceChange"] as? Double, -20)
        XCTAssertEqual(result["oiChange"] as? String, "Infinity")
        XCTAssertEqual(result["rocChange"] as? String, "-Infinity")
        XCTAssertEqual(result["marocChange"] as? Double, 0)
        XCTAssertTrue(result["missing"] is NSNull)
        XCTAssertTrue(result["invalid"] is NSNull)
    }

    func testROCAndMAROCUseTheSameSignedAndZeroBaselineFormula() throws {
        let hour = Int64(200) * hourMS
        func bars(_ closes: [Double]) -> [Int64: Candle] {
            Dictionary(uniqueKeysWithValues: closes.enumerated().map { age, close in
                let ts = hour - Int64(age) * hourMS
                return (ts, Candle(hour: ts, high: 200, low: -200, close: close, quoteVolume: 100, baseVolume: 1))
            })
        }
        for (current, previous, expected) in [
            (80.0, 100.0, -20.0), (-80, -100, 20), (-120, -100, -20),
            (0, 0, 0), (100, 0, Double.infinity), (-100, 0, -Double.infinity),
        ] {
            let (roc, maroc) = rocMaroc(bars([current, previous]), hour, 1, 1)
            XCTAssertEqual(roc, expected)
            XCTAssertEqual(maroc, expected)
        }
        let (roc, maroc) = rocMaroc(bars([-80, -100, -200]), hour, 1, 2)
        XCTAssertEqual(try XCTUnwrap(roc), 20, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(maroc), 35, accuracy: 0.000001)
        let (infiniteROC, undefinedMean) = rocMaroc(bars([1, -1, 0, 0]), hour, 2, 2)
        XCTAssertEqual(infiniteROC, .infinity)
        XCTAssertNil(undefinedMean)
    }

    func testSwap24hTurnoverUsesBaseVolumeAndLastUSDTPrice() {
        XCTAssertEqual(usdtTurnover24h(["volCcy24h": "1000000", "last": "10"]), 10_000_000)
        XCTAssertEqual(usdtTurnover24h(["volCcy24h": "999999", "last": "10"]), 9_999_990)
        XCTAssertNil(usdtTurnover24h(["volCcy24h": "NaN", "last": "10"]))
        XCTAssertNil(usdtTurnover24h(["volCcy24h": "1000000", "last": "0"]))
    }

    func testSpreadPercentageUsesMidpointAndRejectsInvalidQuotes() {
        let tight = spreadPercent(["bidPx": "99.925", "askPx": "100.075"])
        let wide = spreadPercent(["bidPx": "99.9", "askPx": "100.1"])
        XCTAssertEqual(tight!, 0.15, accuracy: 0.000001)
        XCTAssertEqual(wide!, 0.2, accuracy: 0.000001)
        XCTAssertNil(spreadPercent(["bidPx": "0", "askPx": "100"]))
        XCTAssertNil(spreadPercent(["bidPx": "101", "askPx": "100"]))
    }

    func testHourlyIndicatorsAndMissingData() {
        let hour = Int64(200) * hourMS
        var bars: [Int64: Candle] = [:]
        for age in 0...200 {
            let ts = hour - Int64(age) * hourMS
            bars[ts] = Candle(hour: ts, high: 210, low: 90, close: Double(200 - age), quoteVolume: 100, baseVolume: 1)
        }
        XCTAssertEqual(recentExtremesBreaks(bars, hour).highBreakout, .none)
        XCTAssertEqual(rocMaroc(bars, hour, 9, 9).0!, (200.0 / 191.0 - 1) * 100, accuracy: 0.000001)
        var expectedMAROC = 0.0
        for age in 0..<9 {
            let current = Double(200 - age)
            let previous = Double(191 - age)
            expectedMAROC += (current / previous - 1) * 100 / 9
        }
        XCTAssertEqual(rocMaroc(bars, hour, 9, 9).1!, expectedMAROC, accuracy: 0.000001)
        XCTAssertEqual(vwap14(bars, hour), 100)
        XCTAssertEqual(rsi(bars, hour, 6), 100)
        let geometricMean = exp((181...200).map { log(Double($0)) }.reduce(0, +) / 20)
        XCTAssertEqual(logBB(bars, hour).1!, geometricMean, accuracy: 0.000001)
        bars.removeValue(forKey: hour - 7 * hourMS)
        XCTAssertEqual(recentExtremesBreaks(bars, hour).highBreakout, .loading)
        XCTAssertNil(vwap14(bars, hour))
        XCTAssertNil(logBB(bars, hour).0)
        XCTAssertNil(rocMaroc(bars, hour, 9, 9).1)
    }

    func testLogBBRemainsPositiveForWidePriceRanges() throws {
        let hour = Int64(20) * hourMS
        var bars: [Int64: Candle] = [:]
        for age in 0..<20 {
            let ts = hour - Int64(age) * hourMS
            bars[ts] = Candle(hour: ts, high: 100, low: 1, close: age.isMultiple(of: 2) ? 1 : 100,
                              quoteVolume: 100, baseVolume: 1)
        }
        let (upper, middle, lower) = logBB(bars, hour)
        XCTAssertEqual(try XCTUnwrap(upper), 1_000, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(middle), 10, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(lower), 0.1, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(logBBBandWidth(upper, middle, lower)), 9_999, accuracy: 0.000001)
        bars.removeValue(forKey: hour - 19 * hourMS)
        XCTAssertNil(logBB(bars, hour).0)
        let missing = logBB(bars, hour)
        XCTAssertNil(logBBBandWidth(missing.0, missing.1, missing.2))
        bars[hour - 19 * hourMS] = Candle(hour: hour - 19 * hourMS, high: 100, low: 0,
                                         close: 0, quoteVolume: 100, baseVolume: 1)
        XCTAssertNil(logBB(bars, hour).0)
    }

    func testLogBBBandWidthIsScaleIndependentAndZeroForFlatPrices() throws {
        let hour = Int64(20) * hourMS
        func width(scale: Double, flat: Bool = false) throws -> Double {
            var bars: [Int64: Candle] = [:]
            for age in 0..<20 {
                let ts = hour - Int64(age) * hourMS
                let price = (flat ? 10 : age.isMultiple(of: 2) ? 1 : 100) * scale
                bars[ts] = Candle(hour: ts, high: price, low: price, close: price,
                                  quoteVolume: 100, baseVolume: 1)
            }
            let (upper, middle, lower) = logBB(bars, hour)
            return try XCTUnwrap(logBBBandWidth(upper, middle, lower))
        }
        XCTAssertEqual(try width(scale: 0.001), try width(scale: 1_000), accuracy: 0.000001)
        XCTAssertEqual(try width(scale: 1, flat: true), 0, accuracy: 0.000001)
        XCTAssertNil(logBBBandWidth(nil, 10, 5))
        XCTAssertNil(logBBBandWidth(15, nil, 5))
        XCTAssertNil(logBBBandWidth(15, 10, nil))
        XCTAssertNil(logBBBandWidth(15, 0, 5))
        XCTAssertNil(logBBBandWidth(.infinity, 10, 5))
        XCTAssertNil(logBBBandWidth(15, .nan, 5))
        XCTAssertNil(logBBBandWidth(1e308, 1e-308, 1))
    }

    func testCandleValidationAndPermanentHistory() throws {
        let hour: Int64 = 200 * hourMS
        let values = [String(hour), "100", "110", "90", "100", "10", "2", "200", "1"]
        let bar = try XCTUnwrap(Candle(values))
        XCTAssertEqual(bar.open, 100)
        XCTAssertNil(Candle([String(hour), "100", "110", "90", "120", "10", "2", "200", "1"]))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try Store(url: url)
        try store.save("BTC-USDT-SWAP", bar)
        let olderHour = hour - 300 * hourMS
        try store.save("BTC-USDT-SWAP", Candle(hour: olderHour, high: 110, low: 90, close: 100, quoteVolume: 200, baseVolume: 2, open: 99))
        try store.saveChartStat("BTC-USDT-SWAP", hour: hour, oi: 1_000, oiUSD: 2_000_000)
        try store.saveChartStat("BTC-USDT-SWAP", hour: hour, sell: 20, buy: 30)
        try store.saveChartStat("BTC-USDT-SWAP", hour: hour - hourMS, oi: 800)
        try store.saveChartStat("ETH-USDT-SWAP", hour: hour - hourMS, oi: 600)
        try store.saveChartStat("BTC-USDT-SWAP", hour: hour - 94 * hourMS, oi: 500)
        try store.saveChartStat("BTC-USDT-SWAP", hour: hour - 95 * hourMS, oi: 400)
        let loaded = try store.load(hour: hour + hourMS, ids: ["BTC-USDT-SWAP"])
        XCTAssertEqual(loaded.candles["BTC-USDT-SWAP"]?[hour]?.baseVolume, 2)
        XCTAssertEqual(loaded.candles["BTC-USDT-SWAP"]?[hour]?.open, 100)
        let stat = try store.chartStats("BTC-USDT-SWAP", since: hour)
        XCTAssertEqual(stat[hour]?.oi, 1_000)
        XCTAssertEqual(stat[hour]?.oiUSD, 2_000_000)
        XCTAssertEqual(stat[hour]?.sell, 20)
        XCTAssertEqual(stat[hour]?.buy, 30)
        XCTAssertEqual(try store.openInterest(hour: hour - hourMS), ["BTC-USDT-SWAP": 800, "ETH-USDT-SWAP": 600])
        let reopened = try Store(url: url)
        let history = try reopened.chartStats("BTC-USDT-SWAP", since: 0)
        XCTAssertEqual(history[hour - 94 * hourMS]?.oi, 500)
        XCTAssertEqual(history[hour - 95 * hourMS]?.oi, 400)
        XCTAssertEqual(try reopened.load(hour: olderHour + hourMS, ids: ["BTC-USDT-SWAP"]).candles["BTC-USDT-SWAP"]?[olderHour]?.open, 99)
    }

    func testCachedCandleBackfillsOpenWithoutLosingHistory() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let old = try Store(url: url)
            try old.execute("INSERT INTO candles (inst_id,hour,high,low,close,volume,base_volume) VALUES (?,?,?,?,?,?,?)", ["BTC-USDT-SWAP", Int64(0), 110.0, 90.0, 100.0, 200.0, 2.0])
        }
        let store = try Store(url: url)
        let cached = try store.load(hour: hourMS, ids: ["BTC-USDT-SWAP"])
        XCTAssertEqual(cached.candles["BTC-USDT-SWAP"]?[0]?.close, 100)
        XCTAssertNil(cached.candles["BTC-USDT-SWAP"]?[0]?.open)
        XCTAssertNil(try store.oldestCandleHour("BTC-USDT-SWAP"))
        try store.save("BTC-USDT-SWAP", Candle(hour: 0, high: 110, low: 90, close: 100, quoteVolume: 200, baseVolume: 2, open: 99))
        XCTAssertEqual(try store.load(hour: hourMS, ids: ["BTC-USDT-SWAP"]).candles["BTC-USDT-SWAP"]?[0]?.open, 99)
        XCTAssertEqual(try store.oldestCandleHour("BTC-USDT-SWAP"), 0)
    }

    func testCandleBatchRollsBackOnWriteFailure() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try Store(url: url)
        try store.execute("CREATE TRIGGER reject_second BEFORE INSERT ON candles WHEN NEW.hour = \(hourMS) BEGIN SELECT RAISE(ABORT, 'rejected'); END")
        let first = Candle(hour: 0, high: 110, low: 90, close: 100, quoteVolume: 200, baseVolume: 2, open: 99)
        let second = Candle(hour: hourMS, high: 110, low: 90, close: 100, quoteVolume: 200, baseVolume: 2, open: 99)
        XCTAssertThrowsError(try store.saveCandles("BTC-USDT-SWAP", [first, second]))
        XCTAssertTrue(try store.load(hour: hourMS, ids: ["BTC-USDT-SWAP"]).candles.isEmpty)
    }

    func testHistoricalPageAndBoundedIndicatorWindow() throws {
        let id = "BTC-USDT-SWAP"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try Store(url: url)
        let end = Int64(400) * hourMS
        let rows: [Any] = [
            [String(end - hourMS), "100", "110", "90", "100", "1", "2", "200", "1"],
            [String(end), "100", "110", "90", "100", "1", "2", "200", "0"],
            [String(end + hourMS), "100", "110", "90", "100", "1", "2", "200", "1"],
        ]
        XCTAssertEqual(historicalPage(rows, before: end).map(\.hour), [end - hourMS])
        XCTAssertTrue(historicalPage([], before: end).isEmpty)
        try store.saveCandles(id, (0...400).map { index in
            Candle(hour: Int64(index) * hourMS, high: 110, low: 90, close: 100 + Double(index % 5), quoteVolume: 200, baseVolume: 2, open: 100)
        })
        let window = try store.candles(id, since: 50 * hourMS, through: end)
        XCTAssertEqual(window.count, 351)
        XCTAssertNotNil(rsi(window, end - 95 * hourMS, 24))
        XCTAssertEqual(try store.oldestCandleHour(id), 0)
        try store.saveChartStat(id, hour: end, oi: 12)
        XCTAssertTrue(try store.chartStats(id, since: 0, through: end - hourMS).isEmpty)
    }

    func testHistoricalBoundaryUsesOldestSavedCandleOnlyAfterExhaustion() throws {
        let id = "BTC-USDT-SWAP"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try Store(url: url)
        let latest = Int64(500) * hourMS
        let olderLocal = Int64(10) * hourMS
        try store.save(id, Candle(hour: olderLocal, high: 110, low: 90, close: 100, quoteVolume: 200, baseVolume: 2, open: 99))
        let oldest = try store.oldestCandleHour(id)
        XCTAssertEqual(boundedHistoryEnd(0, oldest: oldest, exhausted: true, latest: latest), olderLocal + 95 * hourMS)
        XCTAssertEqual(boundedHistoryEnd(0, oldest: oldest, exhausted: false, latest: latest), 0)
        XCTAssertEqual(boundedHistoryEnd(450 * hourMS, oldest: oldest, exhausted: true, latest: latest), 450 * hourMS)
        XCTAssertEqual(boundedHistoryEnd(0, oldest: nil, exhausted: true, latest: latest), 0)
    }
}
