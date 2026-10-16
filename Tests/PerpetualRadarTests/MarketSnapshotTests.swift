import XCTest
@testable import PerpetualRadar

final class MarketSnapshotTests: XCTestCase {
    private func input(_ id: String = "BTC-USDT-SWAP") -> MarketSnapshotInput {
        let hour = 1000 * hourMS
        let bars = Dictionary(uniqueKeysWithValues: (0...300).map { age in
            let ts = hour - Int64(age) * hourMS
            return (ts, Candle(hour: ts, high: 111, low: 99, close: 110, quoteVolume: age == 0 ? 300 : 100, baseVolume: 1, open: 105, confirmed: age != 0))
        })
        return .init(id: id, hour: hour, now: hour + hourMS / 2, candles: bars, listedAt: 0,
            turnover: 20_000_000, spreadPercent: 0.1, quoteTimestamp: hour + 1,
            buy: 3, sell: 1, takerRatio: 50, currentOI: 1_020_000, currentOIUSD: 82_000_000,
            previousOI: 1_000_000, previousEMA: 100)
    }

    func testBackgroundRowsPreserveSnapshotReadingsAndUseTheCapturedHourForRules() async throws {
        let input = input(), worker = MarketSnapshotWorker()
        let result = try await worker.calculate([input], rocPeriod: 9, marocPeriod: 9)
        let row = try XCTUnwrap(result[input.id]?.fields)
        XCTAssertEqual(row["oiChange"] as? Double, 2)
        let market = input.filterData(row: row)
        XCTAssertEqual(market.hour, input.hour)
        XCTAssertEqual(market.current["oiTrend"]?.text, "rising")
        XCTAssertEqual(market.current["emaBody"]?.text, "above")
        XCTAssertEqual(market.stats[input.hour]?.oi, 1_020_000)
        XCTAssertEqual(market.stats[input.hour]?.oiUSD, 82_000_000)
        XCTAssertEqual(market.quotes[input.hour]?.timestamp, input.quoteTimestamp)
        XCTAssertEqual(NSDictionary(dictionary: row), NSDictionary(dictionary: input.calculate(rocPeriod: 9, marocPeriod: 9).fields))
        let filter = try FilterCompiler.compile(source: "oiTrend == \"rising\" AND emaBody == \"above\"")
        XCTAssertEqual(FilterEvaluator(market: market, filter: filter).evaluate().result, .yes)
    }

    @MainActor
    func testFiveHundredMarketCalculationsLeaveTheMainActorResponsiveAndCanBeCancelled() async throws {
        let template = input(), worker = MarketSnapshotWorker()
        let markets = (0..<500).map { index in
            MarketSnapshotInput(id: "MKT\(index)", hour: template.hour, now: template.now, candles: template.candles,
                listedAt: template.listedAt, currentOI: template.currentOI, currentOIUSD: template.currentOIUSD,
                previousOI: template.previousOI, previousEMA: template.previousEMA)
        }
        let task = Task { try await worker.calculate(markets, rocPeriod: 9, marocPeriod: 9) }
        let start = Date()
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.15, "Native menus must not wait for all contract indicators.")
        task.cancel()
        do { _ = try await task.value; XCTFail("Obsolete snapshot work should be cancelled.") }
        catch is CancellationError {}
    }

    @MainActor
    func testAsyncBridgePreservesSettingsCatalogAndRevisionContract() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "Snapshot-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let radar = try Radar(defaults: defaults, storeURL: directory.appendingPathComponent("radar.sqlite3"))
        let synchronous = radar.snapshot(rocPeriod: 9, marocPeriod: 9)
        let asynchronous = try await radar.asyncSnapshot(rocPeriod: 9, marocPeriod: 9)
        XCTAssertEqual(NSDictionary(dictionary: synchronous), NSDictionary(dictionary: asynchronous))
        let catalog = try XCTUnwrap(asynchronous["filterMetricsCatalog"] as? [[String: Any]])
        for metric in catalog where metric["unit"] as? String == "category" {
            XCTAssertFalse((metric["choices"] as? [[String: String]] ?? []).isEmpty, "\(metric["key"]!) must have visual values.")
        }
        let revision = try XCTUnwrap(asynchronous["revision"] as? Int)
        let unchanged = try await radar.asyncSnapshot(rocPeriod: 9, marocPeriod: 9, sinceRevision: revision)
        XCTAssertEqual(unchanged["unchanged"] as? Bool, true)
    }
}
