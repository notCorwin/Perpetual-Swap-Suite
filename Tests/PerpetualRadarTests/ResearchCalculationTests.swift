import XCTest
@testable import PerpetualRadar

final class ResearchCalculationTests: XCTestCase, @unchecked Sendable {
    func testCalculationCheckpointRetainsPreparationSourcesAndDurationsAfterReopening() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchMetadata-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        var checkpoint = Checkpoint(studyID: "metadata", phase: "running")
        checkpoint.completedSources = ["old", "new"]
        checkpoint.sourceSeconds = ["old": 4.25, "new": 2.5, "previous-attempt": 1.5]
        try store.database.execute("INSERT INTO research_prepared_sources VALUES (?,?,?)", [checkpoint.studyID, "old", nil])
        try store.put("checkpoint:metadata", kind: "checkpoint", store.calculationCheckpoint(checkpoint))
        let reopened = try ResearchStore(directory: directory)
        let retained = try XCTUnwrap(reopened.get("checkpoint:metadata", as: Checkpoint.self))
        XCTAssertEqual(retained.completedSources, checkpoint.completedSources)
        XCTAssertEqual(retained.sourceSeconds, checkpoint.sourceSeconds)
    }

    func testHistoricalReusePreservesAnchorEMAAndUnknownExplanations() throws {
        let hour = ResearchFixture.hour
        let bars = Dictionary(uniqueKeysWithValues: ResearchFixture.bars(from: hour-1_200*hourMS, through: hour+20*hourMS).map { ($0.hour, $0) })
        let series = ResearchEngine.reconstruct(ResearchSeries(candles: bars, stats: [hour: .init(oi: 0, sell: 0, buy: 0)]))
        var instrument = ResearchFixture.instrument; instrument.listedAt = hour-1_200*hourMS
        let rule = try FilterCompiler.compile(source: "EMA(200) > 0 AND closed(EMA(200) > 0) AND RSI(24) > 0 AND every(EMA(200) > 0, 3) AND (oiChange > 0 OR oiChange <= 0)")
        let reused = FilterHistoricalReadings()
        for offset in 0..<12 {
            let context = ResearchEngine.context(instrument: instrument, hour: hour+Int64(offset)*hourMS, series: series)
            var optimized = context; optimized.historicalReadings = reused
            let expected = FilterEvaluator(market: context, filter: rule), actual = FilterEvaluator(market: optimized, filter: rule)
            XCTAssertEqual(try SafeJSON.data(actual.evaluate(explain: true).snapshot, options: [.sortedKeys]), try SafeJSON.data(expected.evaluate(explain: true).snapshot, options: [.sortedKeys]))
            XCTAssertEqual(try SafeJSON.data(actual.opportunity(at: context.hour).snapshot, options: [.sortedKeys]), try SafeJSON.data(expected.opportunity(at: context.hour).snapshot, options: [.sortedKeys]))
        }
    }

    func testConcurrentResultsAndManualResumePreserveEveryFrozenEventAndStatistic() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchParallel-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        let bars = ResearchFixture.bars(), from = ResearchFixture.hour
        var instruments: [ResearchInstrument] = []
        for index in 0..<4 {
            var instrument = ResearchFixture.instrument
            instrument.id = "PARALLEL-\(index)-USDT-SWAP"
            if index == 3 { instrument.delistedAt = from+170*hourMS }
            instruments.append(instrument)
            try store.write(bars.map { .init(instrument: instrument.id, kind: "candle", timestamp: $0.hour, candle: $0, sources: ["parallel-fixture"]) })
        }
        var spec = try ResearchFixture.spec("Close > 103", through: from+200*hourMS)
        spec.sampling = "hourly"
        let plan = DataPlan(spec: spec, instruments: instruments, from: from, through: spec.through, warmupHours: 275)
        let manifest = try store.freeze(plan)
        let serial = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        var serialCheckpoint = Checkpoint(studyID: serial.id, phase: "running")
        try ResearchEngine.run(store: store, study: serial, manifest: manifest, checkpoint: &serialCheckpoint) { _,_,_ in }
        let expected = try store.report(serial, manifest: manifest)
        let parallel = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        var checkpoint = try await ResearchEngine.runConcurrent(directory: directory, study: parallel, manifest: manifest,
                                                               checkpoint: .init(studyID: parallel.id, phase: "running")) { _,_,_ in }
        var actual = try store.report(parallel, manifest: manifest)
        actual.studyID = expected.studyID; actual.completedAt = expected.completedAt
        XCTAssertEqual(try researchJSON(actual), try researchJSON(expected))
        func events(_ study: String) throws -> [String] {
            var values: [String] = [], offset = 0
            while true {
                var events = try store.events(study, offset: offset, limit: 100)
                if events.isEmpty { break }
                for index in events.indices { events[index].id = "normalized"; events[index].studyID = "normalized" }
                values += try events.map { researchHash(try researchJSON($0)) }
                offset += events.count
            }
            return values.sorted()
        }
        XCTAssertEqual(try events(parallel.id), try events(serial.id))
        XCTAssertEqual(checkpoint.instrumentIndex, instruments.count)
        // Retain completed siblings while replaying one durable instrument's
        // checkpoint. Existing rows/events must not be duplicated on resume.
        checkpoint.instrumentIndex = 0
        checkpoint.calculation?[instruments[0].id] = .init()
        checkpoint = try await ResearchEngine.runConcurrent(directory: directory, study: parallel, manifest: manifest, checkpoint: checkpoint) { _,_,_ in }
        actual = try store.report(parallel, manifest: manifest); actual.studyID = expected.studyID; actual.completedAt = expected.completedAt
        XCTAssertEqual(try researchJSON(actual), try researchJSON(expected))
        XCTAssertEqual(try events(parallel.id), try events(serial.id))
        XCTAssertEqual(checkpoint.instrumentIndex, instruments.count)
    }
}
