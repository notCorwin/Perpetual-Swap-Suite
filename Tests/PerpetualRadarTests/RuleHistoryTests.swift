import XCTest
@testable import PerpetualRadar

private actor TestHistoryTransport: FilterHistoryTransport {
    private var requests: [(String, [String: String])] = []
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private let delay: UInt64
    var missingHour: Int64?
    init(missingHour: Int64? = nil, delay: UInt64 = 2_000_000) { self.missingHour = missingHour; self.delay = delay }
    func fetch(path: String, parameters: [String: String]) async throws -> [[String]] {
        requests.append((path, parameters))
        startedWaiters.forEach { $0.resume() }; startedWaiters.removeAll()
        try await Task.sleep(nanoseconds: delay)
        let before = Int64(parameters["after"] ?? parameters["end"] ?? "0")!
        let count = path.contains("history-candles") ? 300 : 100
        return (1...count).compactMap { offset in
            let ts = before - Int64(offset) * hourMS
            guard ts >= 0, ts != missingHour else { return nil }
            if path.contains("history-candles") { return [String(ts), "100", "110", "90", "100", "1", "1", "100", "1"] }
            if path.contains("open-interest") { return [String(ts), "1", "1", "1000000"] }
            return [String(ts), "10", "20"]
        }
    }
    func count(_ path: String? = nil) -> Int { requests.filter { path == nil || $0.0 == path }.count }
    func cursors() -> [Int64] { requests.compactMap { $0.1["after"].flatMap(Int64.init) } }
    func waitForFirstRequest() async { if requests.isEmpty { await withCheckedContinuation { startedWaiters.append($0) } } }
}

final class RuleHistoryTests: XCTestCase, @unchecked Sendable {
    private let hour = Int64(10_000) * hourMS
    private func database() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("RuleHistory-\(UUID())").appendingPathComponent("radar.sqlite3") }
    private func market() -> FilterMarketData { .init(id: "BTC-USDT-SWAP", hour: hour, now: hour + 1, listedAt: 1, candles: [:], stats: [:], quotes: [:]) }

    func testPagesDemandedHistoryDeduplicatesRequestsAndPersistsOnlyClosedBars() async throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let transport = TestHistoryTransport(), loader = FilterHistoryLoader(url: url, transport: transport, requestDelay: 0)
        let filter = try FilterCompiler.compile(source: "mean(Close, 720) > 0")
        var context = market()
        context.candles[hour] = Candle(hour: hour, high: 110, low: 90, close: 100, quoteVolume: 100, baseVolume: 1, open: 100, confirmed: false)
        let initial = try await loader.prepare([context], filter: filter)
        await loader.schedule(initial, filter: filter)
        await loader.schedule(initial, filter: filter)
        await loader.waitUntilIdle()
        let calls = await transport.count(), cursors = await transport.cursors()
        XCTAssertEqual(calls, 3)
        XCTAssertEqual(cursors, [hour, hour - 300 * hourMS, hour - 600 * hourMS])
        let hydrated = try await loader.prepare([context], filter: filter)
        XCTAssertEqual(FilterEvaluator(market: hydrated[0], filter: filter).evaluate().result, .yes)
        let db = try Store(url: url)
        XCTAssertNil(try db.candles(context.id, since: hour, through: hour)[hour])
        let updated = try await loader.consumeUpdatedHistory(through: hour)
        XCTAssertNotNil(updated[context.id]?[hour - hourMS])
        let consumed = try await loader.consumeUpdatedHistory(through: hour)
        XCTAssertTrue(consumed.isEmpty)
        await loader.schedule(hydrated, filter: filter)
        await loader.waitUntilIdle()
        let afterCalls = await transport.count()
        XCTAssertEqual(afterCalls, calls)
    }

    func testLongerQueuedRulesSharePagesAndShrinkingDoesNotLoseDurableHistory() async throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let transport = TestHistoryTransport(), loader = FilterHistoryLoader(url: url, transport: transport, requestDelay: 0)
        let short = try FilterCompiler.compile(source: "mean(Close, 30) > 0"), long = try FilterCompiler.compile(source: "mean(Close, 700) > 0")
        let original = market(), first = try await loader.prepare([original], filter: short)
        await loader.schedule(first, filter: short)
        let second = try await loader.prepare([original], filter: long)
        await loader.schedule(second, filter: long)
        await loader.schedule(second, filter: long)
        await loader.waitUntilIdle()
        let calls = await transport.count()
        XCTAssertEqual(calls, 3)
        let final = try await loader.prepare([original], filter: long)
        XCTAssertNotNil(final[0].candles[hour - 690 * hourMS])
        // Force a later short hydration to prune memory; a larger request must reread SQLite.
        var next = original; next.hour += hourMS; next.now += hourMS
        let small = try await loader.prepare([next], filter: short)
        await loader.schedule(small, filter: short); await loader.waitUntilIdle()
        let restored = try await loader.prepare([next], filter: long)
        XCTAssertNotNil(restored[0].candles[hour - 690 * hourMS])
    }

    func testStatsPagesMergeSeparateColumnsAndHistoricalGapsStayUnknown() async throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let transport = TestHistoryTransport(missingHour: hour - 20 * hourMS), loader = FilterHistoryLoader(url: url, transport: transport, requestDelay: 0)
        let filter = try FilterCompiler.compile(source: "closed(every(oiUSD > 0 AND buy > sell, 250))")
        let prepared = try await loader.prepare([market()], filter: filter)
        await loader.schedule(prepared, filter: filter); await loader.waitUntilIdle()
        let loaded = try await loader.prepare([market()], filter: filter)
        XCTAssertEqual(loaded[0].stats[hour - hourMS]?.oi, 1_000_000)
        XCTAssertEqual(loaded[0].stats[hour - hourMS]?.sell, 10)
        XCTAssertEqual(loaded[0].stats[hour - hourMS]?.buy, 20)
        XCTAssertNil(loaded[0].stats[hour - 20 * hourMS])
        XCTAssertEqual(FilterEvaluator(market: loaded[0], filter: filter).evaluate().result, .unknown)
        let calls = await transport.count()
        await loader.schedule(loaded, filter: filter); await loader.waitUntilIdle()
        let after = await transport.count()
        XCTAssertEqual(after, calls)
    }

    func testHourlyQuotesKeepNullValuesAndRejectStaleTimestamp() throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let db = try Store(url: url), id = market().id
        try db.saveHourlyQuote(id, hour: hour - hourMS, quote: .init(turnover: 20_000_000, spread: nil, timestamp: hour - 1))
        try db.saveHourlyQuote(id, hour: hour, quote: .init(turnover: 50_000_000, spread: 0.1, timestamp: hour - 1))
        let snapshots = try db.hourlyQuotes(id, since: hour - 2 * hourMS, through: hour)
        XCTAssertEqual(snapshots.count, 1)
        XCTAssertEqual(snapshots[hour - hourMS]?.turnover, 20_000_000)
        XCTAssertNil(snapshots[hour - hourMS]?.spread)
        try db.saveHourlyQuote(id, hour: hour - hourMS, quote: .init(turnover: 99, spread: 2, timestamp: hour - 2))
        XCTAssertEqual(try db.hourlyQuotes(id, since: hour - hourMS, through: hour)[hour - hourMS]?.turnover, 20_000_000)
    }

    func testExternalDatabaseWritesInvalidateCachedHistoryGaps() async throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let db = try Store(url: url), loader = FilterHistoryLoader(url: url, transport: TestHistoryTransport(), requestDelay: 0)
        let filter = try FilterCompiler.compile(source: "closed(Close > 0 AND oiUSD > 0 AND spread < 1)")
        let initial = try await loader.prepare([market()], filter: filter)
        XCTAssertEqual(FilterEvaluator(market: initial[0], filter: filter).evaluate().result, .unknown)
        let ts = hour - hourMS
        try db.saveCandles(market().id, [Candle(hour: ts, high: 110, low: 90, close: 100, quoteVolume: 100, baseVolume: 1, open: 100)])
        try db.saveChartStat(market().id, hour: ts, oi: 1_000_000)
        try db.saveHourlyQuote(market().id, hour: ts, quote: .init(turnover: 20_000_000, spread: 0.1, timestamp: hour - 1))
        let refreshed = try await loader.prepare([market()], filter: filter)
        XCTAssertEqual(FilterEvaluator(market: refreshed[0], filter: filter).evaluate().result, .yes)
    }

    func testResearchCacheHydratesRadarWithoutDuplicateOKXRequests() async throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let research = try ResearchStore(directory: url.deletingLastPathComponent().appendingPathComponent("Research"))
        let filter = try FilterCompiler.compile(source: "closed(every(Close > 0 AND oiUSD > 0 AND buy > sell AND turnover > 0, 3))")
        let id = market().id, hours = (1...filter.requiredHours).map { hour - Int64($0) * hourMS }
        for (index, timestamp) in hours.enumerated() {
            let candle = Candle(hour: timestamp, high: 110, low: 90, close: 100, quoteVolume: 100, baseVolume: 1, open: 100)
            try research.write([
                .init(instrument: id, kind: "candle", timestamp: timestamp, candle: candle, sources: ["research"]),
                .init(instrument: id, kind: "stat", timestamp: timestamp, stat: .init(oi: 1_000_000, sell: 10, buy: 20), sources: ["research"]),
                .init(instrument: id, kind: "quote", timestamp: timestamp, quote: .init(turnover: 20_000_000, spread: nil, timestamp: timestamp + hourMS - 1), sources: ["research-\(index)"]),
            ])
        }
        let transport = TestHistoryTransport(), loader = FilterHistoryLoader(url: url, transport: transport, requestDelay: 0)
        let prepared = try await loader.prepare([market()], filter: filter)
        await loader.schedule(prepared, filter: filter); await loader.waitUntilIdle()
        let hydrated = try await loader.prepare([market()], filter: filter)
        XCTAssertEqual(FilterEvaluator(market: hydrated[0], filter: filter).evaluate().result, .yes)
        let requests = await transport.count()
        XCTAssertEqual(requests, 0, "Radar must not request history already normalized by Research.")
        let radar = try Store(url: url)
        XCTAssertEqual(try radar.candles(id, since: hours.last!, through: hours.first!).count, filter.requiredHours)
        XCTAssertEqual(try radar.chartStats(id, since: hours.last!, through: hours.first!).count, filter.requiredHours)
        XCTAssertEqual(try radar.hourlyQuotes(id, since: hours.last!, through: hours.first!).count, filter.requiredHours)
    }

    func testSmallerDraftCancelsObsoleteLongHistoryWork() async throws {
        let url = database(); defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let transport = TestHistoryTransport(delay: 500_000_000), loader = FilterHistoryLoader(url: url, transport: transport, requestDelay: 0)
        let long = try FilterCompiler.compile(source: "mean(Close, 720) > 0"), empty = try FilterCompiler.compile(source: "true")
        let initial = try await loader.prepare([market()], filter: long)
        await loader.schedule(initial, filter: long)
        await transport.waitForFirstRequest()
        await loader.schedule(try await loader.prepare([market()], filter: empty), filter: empty)
        await loader.waitUntilIdle()
        let calls = await transport.count(), progress = await loader.progress()
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(progress.pending, 0)
        XCTAssertTrue(progress.error.isEmpty)
        XCTAssertTrue(try Store(url: url).candles(market().id, since: hour - 720 * hourMS, through: hour).isEmpty)
    }
}
