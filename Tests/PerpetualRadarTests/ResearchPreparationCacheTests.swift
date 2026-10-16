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
        try await Task.sleep(for: .milliseconds(40))
        if url.lastPathComponent == failure { failure = nil; throw FilterError("Interrupted source") }
        try archive.write(to: destination)
    }
    func counts() -> (Int, Int) { (downloads, peak) }
}
private actor PlanningStages {
    private var stages: [String] = []
    func append(_ update: ResearchPlanningProgress) { stages.append(update.stage) }
    func values() -> [String] { stages }
}
private actor PipelineArchiveTransport: ResearchTransport {
    private let archive: Data
    private var blocked = true, downloads = 0, requests = 0
    init(archive: Data) { self.archive = archive }
    func release() { blocked = false }
    func counts() -> (downloads: Int, requests: Int) { (downloads, requests) }
    func get(_ url: URL) async throws -> Data {
        requests += 1
        while blocked { try await Task.sleep(for: .milliseconds(5)) }
        return Data(#"{"code":"0","data":[]}"#.utf8)
    }
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws {
        downloads += 1
        try archive.write(to: destination, options: .atomic)
    }
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
    func testPreparationDownloadsEverySWAPAndRetainsInFlightSuccessesAfterAnotherSourceFails() async throws {
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
        XCTAssertEqual(checkpoint.completedSources.count, count - 1, "Every other SWAP must start independently and save its checkpoint before reporting failure.")
        let firstCounts = await transport.counts()
        XCTAssertEqual(firstCounts.0, count)
        _ = try await controller.handle(["action": "resume", "studyID": studyID])
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
        let finalCounts = await transport.counts()
        XCTAssertEqual(finalCounts.0, count + 1, "Resume must download only failed and untouched sources.")
        XCTAssertEqual(finalCounts.1, count, "Network concurrency must cover every SWAP, independently of the CPU count.")
        XCTAssertEqual(try store.get("checkpoint:\(studyID)", as: Checkpoint.self)?.completedSources.count, count)
        for instrument in plan.instruments { XCTAssertNotNil(try store.latest(instrument.id, kind: "candle", timestamp: ResearchFixture.hour)) }
        _ = try controller.prepare(planID: plan.id)
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        let cachedCounts = await transport.counts(); XCTAssertEqual(cachedCounts.0, finalCounts.0)
        XCTAssertEqual(controller.status?.phase, "ready")
    }

    func testCompletedArchiveIsReusedWhenInterruptedBeforeHashMetadataIsCommitted() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let input = source("promoted"), payload = try zip(store)
        try payload.write(to: store.rawURL(input), options: .atomic)
        let transport = PreparationTransport(archive: payload)
        XCTAssertFalse(try store.rawIsComplete(input))
        try await ResearchDataProvider(store: store, transport: transport).prepare(input, instruments: [ResearchFixture.instrument])
        let counts = await transport.counts()
        XCTAssertEqual(counts.0, 0, "A completed file must not be downloaded again merely because its hash record was interrupted.")
        XCTAssertEqual(try store.get(input.id, as: ResearchSource.self)?.rawHash, researchHash(payload))
        XCTAssertTrue(try store.isPrepared(input, instruments: [ResearchFixture.instrument]))
        XCTAssertEqual(try store.latest(input.instrument, kind: "candle", timestamp: input.from)?.candle?.open, 100)
    }

    @MainActor
    func testQueuedDownloadsArePersistedDuringImportWaitsAndReusedAfterPause() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let count = ResearchLocalScan.concurrency + 3
        let transport = PipelineArchiveTransport(archive: try zip(store, confirmedHours: 0, unconfirmedHours: 1))
        var plan = ResearchFixture.plan(try ResearchFixture.spec())
        plan.through = ResearchFixture.hour + Int64(count) * hourMS
        plan.sources = (0..<count).map { index in
            var input = source("queued\(index)")
            input.from += Int64(index) * hourMS; input.through = input.from
            return input
        }
        try store.put(plan.id, kind: "plan", plan)
        let controller = try ResearchController(directory: store.directory, transport: transport)
        _ = try controller.prepare(planID: plan.id)
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            let counts = await transport.counts()
            if counts.downloads == count, counts.requests == 1,
               try plan.sources.allSatisfy({ try store.isPrepared($0, instruments: plan.inputInstruments) }) { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let waiting = await transport.counts()
        XCTAssertEqual(waiting.downloads, count, "Later files must download while every importer is repairing gaps.")
        XCTAssertEqual(waiting.requests, 1, "A SWAP needs only one active repair stream while every queued archive is imported.")
        let reopened = try ResearchStore(directory: store.directory)
        for input in plan.sources {
            XCTAssertTrue(try reopened.rawIsComplete(input), "Queued downloads need a durable raw file and SHA-256 record.")
            XCTAssertTrue(try reopened.isPrepared(input, instruments: plan.inputInstruments), "Every archive must import before REST repair is released.")
            XCTAssertEqual(try Data(contentsOf: reopened.rawURL(input)), try Data(contentsOf: store.directory.appendingPathComponent("fixture.zip")))
        }
        let studyID = try XCTUnwrap(reopened.objects("study", as: ResearchStudy.self).first?.id)
        XCTAssertTrue(try XCTUnwrap(reopened.get("checkpoint:\(studyID)", as: Checkpoint.self)).completedSources.isEmpty)
        try await controller.stop()
        XCTAssertEqual(controller.status?.phase, "paused")
        await transport.release()
        _ = try await controller.handle(["action": "resume", "studyID": studyID])
        let resumedDeadline = ContinuousClock.now + .seconds(3)
        while controller.isBusy, ContinuousClock.now < resumedDeadline { try await Task.sleep(for: .milliseconds(5)) }
        if controller.isBusy { try await controller.stop(); XCTFail("Resume did not finish.") }
        XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
        let resumed = await transport.counts(); XCTAssertEqual(resumed.downloads, count, "Resume must reuse downloaded files even when their imports were queued.")
        XCTAssertEqual(try reopened.get("checkpoint:\(studyID)", as: Checkpoint.self)?.completedSources.count, count)
    }
}
