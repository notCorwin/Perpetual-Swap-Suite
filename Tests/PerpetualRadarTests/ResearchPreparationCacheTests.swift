import XCTest
import ZIPFoundation
@testable import PerpetualRadar

private actor PreparationTransport: ResearchTransport {
    let archive: Data
    private var active = 0, peak = 0, downloads = 0
    private var failure: String?
    init(archive: Data, failure: String? = nil) { self.archive = archive; self.failure = failure }
    func get(_ url: URL) async throws -> Data { Data(#"{"code":"0","data":[]}"#.utf8) }
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws {
        downloads += 1; active += 1; peak = max(peak, active)
        defer { active -= 1 }
        if url.lastPathComponent == failure { failure = nil; throw FilterError("Interrupted source") }
        try await Task.sleep(for: .milliseconds(40))
        try archive.write(to: destination)
    }
    func counts() -> (Int, Int) { (downloads, peak) }
}
private actor PlanningStages {
    private var stages: [String] = []
    func append(_ update: ResearchPlanningProgress) { stages.append(update.stage) }
    func values() -> [String] { stages }
}

final class ResearchPreparationCacheTests: XCTestCase {
    private func store() throws -> ResearchStore {
        try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("PreparationCache-\(UUID())"))
    }
    private func zip(_ store: ResearchStore, confirmedHours: Int = 1, unconfirmedHours: Int = 0) throws -> Data {
        let file = store.directory.appendingPathComponent("fixture.zip"), archive = try Archive(url: file, accessMode: .create)
        let csv = Data(("open_time,open,high,low,close,vol_ccy,vol_quote,confirm\n" + (0..<((confirmedHours + unconfirmedHours) * 60)).map {
            "\(ResearchFixture.hour + Int64($0) * 60_000),100,110,90,105,1,100,\($0 < confirmedHours * 60 ? 1 : 0)\n"
        }.joined()).utf8)
        try archive.addEntry(with: "candles.csv", type: .file, uncompressedSize: Int64(csv.count), compressionMethod: .deflate) { position, count in
            csv.subdata(in: Int(position)..<min(csv.count, Int(position) + count))
        }
        return try Data(contentsOf: file)
    }
    private func source(_ id: String, instrument: String = ResearchFixture.instrument.id, hours: Int = 1) -> ResearchSource {
        .init(id: id, instrument: instrument, kind: "candle", from: ResearchFixture.hour, through: ResearchFixture.hour + Int64(hours - 1) * hourMS, url: "https://fixture.test/\(id)", filename: "\(id).zip", archive: true, module: 2)
    }

    func testPlanCacheSurvivesReopeningAndInvalidatesWhenInputsMetadataOrRadarChange() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        let radarURL = store.directory.appendingPathComponent("radar.sqlite3"), radar = try Store(url: radarURL)
        let spec = try ResearchFixture.spec(), transport = ResearchFixtureTransport()
        let original = try await ResearchDataProvider(store: store, transport: transport, radarURL: radarURL).plan(spec) { _ in }
        let reopened = try ResearchStore(directory: store.directory), stages = PlanningStages()
        var renamed = spec; renamed.name = "Renamed study"
        let provider = ResearchDataProvider(store: reopened, transport: transport, radarURL: radarURL)
        let repeated = try await provider.plan(renamed) { await stages.append($0) }
        let cachedStages = await stages.values()
        XCTAssertEqual(cachedStages, ["saving"], "A repeat plan must bypass local scans and network planning.")
        XCTAssertNotEqual(repeated.id, original.id); XCTAssertEqual(repeated.spec.name, renamed.name)
        XCTAssertNotNil(try reopened.get(repeated.id, as: DataPlan.self))
        for change in 0..<3 {
            if change == 0 { try reopened.write([.init(instrument: ResearchFixture.instrument.id, kind: "candle", timestamp: spec.from!, candle: ResearchFixture.bars().first!, sources: ["new-data"])]) }
            if change == 1 {
                var instrument = ResearchFixture.instrument; instrument.contractValue = 0.02
                try reopened.put("instrument:\(instrument.id)", kind: "instrument", instrument)
            }
            if change == 2 { try radar.saveChartStat(ResearchFixture.instrument.id, hour: spec.from!, oi: 99, sell: 1, buy: 2) }
            let updates = PlanningStages()
            _ = try await provider.plan(renamed) { await updates.append($0) }
            let values = await updates.values()
            XCTAssertTrue(values.contains("missing"), "Changed fixed inputs must invalidate the durable plan.")
        }
    }

    func testUnconfirmedArchiveMinutesAreFilledFromConfirmedRESTAndCachedAcrossReopening() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let external = ProcessInfo.processInfo.environment["RADAR_RESEARCH_UNCONFIRMED_ARCHIVE_FIXTURE"].map { URL(fileURLWithPath: $0) }
        var source = source("mixed", hours: 2)
        if external != nil {
            let range = try XCTUnwrap(ResearchDataProvider.fileRange("1INCH-USDT-SWAP-candlesticks-2023-09.zip"))
            source.instrument = "1INCH-USDT-SWAP"; source.from = range.from; source.through = range.through
        }
        let file = store.rawURL(source), payload = try external.map { try Data(contentsOf: $0) } ?? zip(store, unconfirmedHours: 1)
        var instrument = ResearchFixture.instrument; instrument.id = source.instrument
        instrument.listedAt = min(instrument.listedAt ?? source.from, source.from - hourMS)
        try payload.write(to: file)
        var saved = source; saved.rawHash = researchHash(payload)
        try store.put(source.id, kind: "source", saved)
        let bars = ResearchFixture.bars(from: source.from, through: source.through)
        let transport = ResearchFixtureTransport(candles: bars)
        try await ResearchDataProvider(store: store, transport: transport).prepare(source, instruments: [instrument])
        XCTAssertEqual(try store.latest(source.instrument, kind: "candle", timestamp: source.from)?.candle?.open, external == nil ? 100 : 0.2518)
        XCTAssertEqual(try store.latest(source.instrument, kind: "candle", timestamp: source.through)?.candle?.close, bars.last?.close)
        XCTAssertTrue(try store.missing(source.instrument, kind: "candle", from: source.from, through: source.through).isEmpty)
        let skipped = external == nil ? 60 : 41_760
        XCTAssertTrue(try store.get(source.id, as: ResearchSource.self)?.warnings?.contains { $0.contains("\(skipped) unconfirmed") } == true)
        let counts = await transport.counts(), revisions = try store.count("SELECT COUNT(*) FROM research_data")
        let reopened = try ResearchStore(directory: store.directory), stages = PlanningStages()
        try await ResearchDataProvider(store: reopened, transport: transport).prepare(source, instruments: [instrument]) { update in
            await stages.append(.init(stage: update.stage, unit: "steps", completed: 0, total: 1, message: ""))
        }
        let updates = await stages.values(), repeated = await transport.counts()
        XCTAssertEqual(updates, ["checking"]); XCTAssertEqual(repeated.0, counts.0)
        XCTAssertEqual(try reopened.count("SELECT COUNT(*) FROM research_data"), revisions)
        try reopened.database.execute("DELETE FROM research_heads")
        try await ResearchDataProvider(store: reopened, transport: transport).prepare(source, instruments: [instrument])
        XCTAssertNotNil(try reopened.latest(source.instrument, kind: "candle", timestamp: source.through))
        let replayed = await transport.counts(); XCTAssertEqual(replayed.0, counts.0, "Replay must reuse the cached REST pages and archive.")
    }

    @MainActor
    func testPreparationUsesEveryWorkerAndRetainsInFlightSuccessesAfterAnotherSourceFails() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let count = ResearchLocalScan.concurrency * 2
        let transport = PreparationTransport(archive: try zip(store), failure: "source0")
        var plan = ResearchFixture.plan(try ResearchFixture.spec())
        plan.instruments = (0..<count).map { index in
            var instrument = ResearchFixture.instrument; instrument.id = "TEST\(index)-USDT-SWAP"; return instrument
        }
        plan.sources = plan.instruments.enumerated().map { source("source\($0.offset)", instrument: $0.element.id) }
        try store.put(plan.id, kind: "plan", plan)
        let controller = try ResearchController(directory: store.directory, transport: transport)
        _ = try controller.prepare(planID: plan.id)
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(controller.status?.phase, "failed")
        let studyID = try XCTUnwrap(controller.status?.resultID)
        let checkpoint = try XCTUnwrap(store.get("checkpoint:\(studyID)", as: Checkpoint.self))
        XCTAssertEqual(checkpoint.completedSources.count, ResearchLocalScan.concurrency - 1, "Successful siblings must save their checkpoint before reporting failure.")
        let firstCounts = await transport.counts()
        XCTAssertEqual(firstCounts.0, ResearchLocalScan.concurrency)
        _ = try await controller.handle(["action": "resume", "studyID": studyID])
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
        let finalCounts = await transport.counts()
        XCTAssertEqual(finalCounts.0, count + 1, "Resume must download only failed and untouched sources.")
        XCTAssertEqual(finalCounts.1, ResearchLocalScan.concurrency, "All CPU-sized worker slots must overlap.")
        XCTAssertEqual(try store.get("checkpoint:\(studyID)", as: Checkpoint.self)?.completedSources.count, count)
        for instrument in plan.instruments { XCTAssertNotNil(try store.latest(instrument.id, kind: "candle", timestamp: ResearchFixture.hour)) }
        _ = try controller.prepare(planID: plan.id)
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        let cachedCounts = await transport.counts(); XCTAssertEqual(cachedCounts.0, finalCounts.0)
        XCTAssertEqual(controller.status?.phase, "ready")
    }
}
