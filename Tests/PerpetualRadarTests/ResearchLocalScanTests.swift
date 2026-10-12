import XCTest
@testable import PerpetualRadar

private actor LocalScanProbe {
    private var active = 0
    private var peak = 0
    func read(_ value: Int) async throws -> Int {
        active += 1; peak = max(peak, active)
        defer { active -= 1 }
        try await Task.sleep(for: .milliseconds(value == 0 ? 30 : 15))
        return value * 2
    }
    func counts() -> (Int, Int) { (active, peak) }
}

private actor LocalImportProgress {
    private var updates: [ResearchPlanningProgress] = []
    func append(_ update: ResearchPlanningProgress) { updates.append(update) }
    func values() -> [ResearchPlanningProgress] { updates }
}
private actor LocalScanDelivery {
    private var count = 0
    func append() { count += 1 }
    func value() -> Int { count }
}

final class ResearchLocalScanTests: XCTestCase {
    func testIndependentReadsOverlapAndDeliverEveryResultToItsInput() async throws {
        let probe = LocalScanProbe(), inputs = Array(0..<(ResearchLocalScan.concurrency * 2 + 1))
        var received: [Int: Int] = [:]
        try await ResearchLocalScan.run(inputs, operation: { _, value in try await probe.read(value) }) { index, result in
            XCTAssertNil(received[index]); received[index] = result
        }
        let (active, peak) = await probe.counts()
        XCTAssertEqual(active, 0); XCTAssertEqual(peak, ResearchLocalScan.concurrency)
        XCTAssertEqual(inputs.map { received[$0] }, inputs.map { Optional($0 * 2) })
    }

    func testCancellationDrainsReadersAndStopsDeliveringResults() async throws {
        let probe = LocalScanProbe()
        let delivery = LocalScanDelivery()
        let work = Task {
            try await ResearchLocalScan.run(Array(0..<100), operation: { _, value in try await probe.read(value) }) { _, _ in
                await delivery.append()
                withUnsafeCurrentTask { $0?.cancel() }
            }
        }
        do { try await work.value; XCTFail("Cancelled local scans must stop.") }
        catch is CancellationError {}
        let delivered = await delivery.value()
        XCTAssertEqual(delivered, 1)
        let (active, _) = await probe.counts()
        XCTAssertEqual(active, 0)
    }

    func testRadarImportKeepsExistingReadingsFillsMissingFieldsAndReusesRawFiles() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ConcurrentRadar-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory.appendingPathComponent("Research"))
        let radarURL = directory.appendingPathComponent("radar.sqlite3"), radar = try Store(url: radarURL)
        let first = ResearchFixture.hour - 1050 * hourMS, last = first + 2100 * hourMS
        let instruments = ["BTC", "ETH", "SOL"].map { name in
            var instrument = ResearchFixture.instrument; instrument.id = "\(name)-USDT-SWAP"; return instrument
        }
        let timestamps = [first, first + 999 * hourMS, first + 1000 * hourMS, first + 2000 * hourMS, last]
        for instrument in instruments {
            try radar.saveCandles(instrument.id, ResearchFixture.bars(from: first, through: last).filter { timestamps.contains($0.hour) })
            try radar.save(instrument.id, Candle(hour: first + hourMS, high: 110, low: 90, close: 100, quoteVolume: nil, baseVolume: nil))
            for timestamp in timestamps {
                try radar.saveChartStat(instrument.id, hour: timestamp, oi: 123, sell: 40, buy: 60)
                try radar.saveHourlyQuote(instrument.id, hour: timestamp, quote: .init(turnover: 1000, spread: 2, timestamp: timestamp + 1))
            }
        }
        let id = instruments[0].id
        let savedCandle = Candle(hour: first, high: 800, low: 700, close: 777, quoteVolume: nil, baseVolume: nil, open: 750)
        try store.write([
            .init(instrument: id, kind: "candle", timestamp: first, candle: savedCandle, sources: ["existing"]),
            .init(instrument: id, kind: "stat", timestamp: first, stat: .init(oi: nil, sell: 90, buy: nil), sources: ["existing"]),
            .init(instrument: id, kind: "quote", timestamp: first, quote: .init(turnover: nil, spread: 42, timestamp: first), sources: ["existing"]),
        ])
        let progress = LocalImportProgress()
        let provider = ResearchDataProvider(store: store, radarURL: radarURL)
        try await provider.importRadar(instruments, from: first, through: last) { await progress.append($0) }
        for instrument in instruments {
            for timestamp in timestamps {
                XCTAssertNotNil(try store.latest(instrument.id, kind: "candle", timestamp: timestamp)?.candle?.open)
                XCTAssertEqual(try store.latest(instrument.id, kind: "stat", timestamp: timestamp)?.stat?.oi, 123)
                XCTAssertEqual(try store.latest(instrument.id, kind: "quote", timestamp: timestamp)?.quote?.turnover, 1000)
            }
            XCTAssertNil(try store.latest(instrument.id, kind: "candle", timestamp: first + hourMS))
        }
        XCTAssertEqual(try store.latest(id, kind: "candle", timestamp: first)?.candle?.close, 777)
        XCTAssertEqual(try store.latest(id, kind: "stat", timestamp: first)?.stat?.sell, 90)
        XCTAssertEqual(try store.latest(id, kind: "quote", timestamp: first)?.quote?.spread, 42)
        XCTAssertNil(try store.latest(instruments[1].id, kind: "quote", timestamp: first)?.quote?.spread)
        let before = try researchJSON(store.data(id, from: first, through: last))
        let revisions = try store.count("SELECT COUNT(*) FROM research_data")
        let sources = try store.objects("source", as: ResearchSource.self)
        XCTAssertEqual(sources.count, 9)
        for source in sources { XCTAssertEqual(researchHash(try Data(contentsOf: store.rawURL(source))), source.rawHash) }
        try await provider.importRadar(instruments, from: first, through: last) { _ in }
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_data"), revisions)
        XCTAssertEqual(try researchJSON(store.data(id, from: first, through: last)), before)
        XCTAssertEqual(try store.objects("source", as: ResearchSource.self).count, sources.count)
        let updates = await progress.values()
        XCTAssertEqual(updates.first?.completed, 0); XCTAssertEqual(updates.last?.completed, 9)
        XCTAssertEqual(updates.last?.total, 9); XCTAssertEqual(updates.last?.remainingSeconds, 0)
        for (previous, next) in zip(updates, updates.dropFirst()) { XCTAssertLessThanOrEqual(previous.completed, next.completed) }
    }

    func testCancelledRadarImportRetainsCompletedRangesAndResumesAfterReopening() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ConcurrentRadarResume-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let researchDirectory = directory.appendingPathComponent("Research"), store = try ResearchStore(directory: researchDirectory)
        let radarURL = directory.appendingPathComponent("radar.sqlite3"), radar = try Store(url: radarURL)
        let first = ResearchFixture.hour, last = first + 7999 * hourMS, instrument = ResearchFixture.instrument
        let bars = ResearchFixture.bars(from: first, through: last).filter { ($0.hour - first) % (1000 * hourMS) == 0 }
        try radar.saveCandles(instrument.id, bars)
        let progress = LocalImportProgress()
        let work = Task {
            try await ResearchDataProvider(store: store, radarURL: radarURL).importRadar([instrument], from: first, through: last) { update in
                await progress.append(update)
                if update.completed > 0 { withUnsafeCurrentTask { $0?.cancel() } }
            }
        }
        do { try await work.value; XCTFail("Cancelled Radar import must stop.") }
        catch is CancellationError {}
        let updates = await progress.values()
        XCTAssertLessThan(try XCTUnwrap(updates.last).completed, 8)
        let reopened = try ResearchStore(directory: researchDirectory)
        XCTAssertEqual(try reopened.count("SELECT COUNT(*) FROM research_heads WHERE kind='candle'"), 1)
        try await ResearchDataProvider(store: reopened, radarURL: radarURL).importRadar([instrument], from: first, through: last) { _ in }
        XCTAssertEqual(try reopened.count("SELECT COUNT(*) FROM research_heads WHERE kind='candle'"), bars.count)
        XCTAssertEqual(try reopened.count("SELECT COUNT(*) FROM research_data"), bars.count)
    }

    func testSparseRadarHistoryChecksEveryRangeWithoutCreatingEmptySources() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SparseRadar-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory.appendingPathComponent("Research"))
        let radarURL = directory.appendingPathComponent("radar.sqlite3")
        _ = try Store(url: radarURL)
        let instruments = (0..<286).map { index in
            var instrument = ResearchFixture.instrument; instrument.id = "TEST\(index)-USDT-SWAP"; return instrument
        }
        let progress = LocalImportProgress()
        try await ResearchDataProvider(store: store, radarURL: radarURL).importRadar(instruments, from: 0, through: 63_999 * hourMS) { await progress.append($0) }
        let updates = await progress.values()
        XCTAssertEqual(updates.last?.completed, 18_304); XCTAssertEqual(updates.last?.total, 18_304)
        XCTAssertTrue(try store.objects("source", as: ResearchSource.self).isEmpty)
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_data"), 0)
    }

    func testRadarReadErrorRetainsInstrumentAndRangeContext() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("RadarReadError-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory.appendingPathComponent("Research"))
        let radarURL = directory.appendingPathComponent("radar.sqlite3"), radar = try Store(url: radarURL)
        try radar.execute("DROP TABLE candles")
        do {
            try await ResearchDataProvider(store: store, radarURL: radarURL).importRadar([ResearchFixture.instrument], from: ResearchFixture.hour, through: ResearchFixture.hour + hourMS) { _ in }
            XCTFail("Failed local reads must stop planning.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Recorded Radar read failed · BTC-USDT-SWAP"))
            XCTAssertTrue(error.localizedDescription.contains(String(ResearchFixture.hour)))
        }
    }
}
