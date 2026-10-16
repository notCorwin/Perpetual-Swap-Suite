import XCTest
@testable import PerpetualRadar

final class ResearchSpreadTests: XCTestCase {
    private func projected(_ formula: String, price: Double) throws -> FilterTruth {
        let spec = try ResearchFixture.spec(formula).excludingSpread()
        let rule = try FilterCompiler.compile(FilterConfigV2.decode(spec.rules[0].filtersJSON))
        XCTAssertFalse(rule.metrics.contains("spread"))
        XCTAssertFalse(rule.btcRequirements?.metrics.contains("spread") == true)
        let hour = ResearchFixture.hour
        let candles = Dictionary(uniqueKeysWithValues: (0...8).map { age in
            let ts = hour - Int64(age) * hourMS
            return (ts, Candle(hour: ts, high: price, low: price, close: price, quoteVolume: 1, baseVolume: 1, open: price))
        })
        let context = FilterMarketData(id: ResearchFixture.instrument.id, hour: hour, now: hour + hourMS, listedAt: 1, candles: candles, stats: [:], quotes: [:], historicalClose: true)
        return FilterEvaluator(market: context, filter: rule).evaluate().result
    }

    func testRemainingBooleanAndTemporalConditionsStillDetermineMatches() throws {
        let formulas = [
            "spread < 0.15 AND Close > 100", "spread < 0.15 OR Close > 100",
            "NOT (spread > 1 OR Close <= 100)", "NOT (spread > 1) AND Close > 100",
            "every(spread < 1 AND Close > 100, 3)", "recent(spread < 1, 3) AND Close > 100",
            "crossUp(spread, 1) AND Close > 100", "btc(closed(spread)) < 1 AND Close > 100",
            "let quote = mean(spread, 3); let gate = quote * 2; gate < 1 OR Close > 100",
        ]
        for formula in formulas {
            XCTAssertEqual(try projected(formula, price: 150), .yes, formula)
            XCTAssertEqual(try projected(formula, price: 50), .no, formula)
        }
        for formula in ["spread > 1", "NOT (spread > 1)", "unavailable(spread)"] {
            XCTAssertEqual(try projected(formula, price: 50), .yes, "A spread-only restriction is omitted entirely.")
        }
        XCTAssertEqual(try projected("Symbol == \"spread\" OR Close > 100", price: 50), .no, "Text literals must not be treated as metric dependencies.")
    }

    func testSequenceRetainsClocksAndIndependentCapturesWithoutSpreadDependencies() throws {
        let formula = #"sequence(5, stage("a", Close > 100 AND spread < 1, 3, capture("price", Close), capture("quote", spread)), stage("b", Close >= a.price AND Close > a.quote, 3))"#
        XCTAssertEqual(try projected(formula, price: 150), .yes)
        XCTAssertEqual(try projected(formula, price: 50), .no)
        let spec = try ResearchFixture.spec(formula).excludingSpread()
        XCTAssertEqual(spec.excludedSpreadConditions?.count, 3)
        XCTAssertEqual(try spec.excludingSpread().rules[0].filtersJSON, spec.rules[0].filtersJSON)
        XCTAssertEqual(try spec.excludingSpread().excludedSpreadConditions, spec.excludedSpreadConditions)
    }

    func testCachedSpreadIsDiscardedAndRecordedTurnoverIsPreserved() throws {
        let hour = ResearchFixture.hour
        var series = ResearchSeries(candles: Dictionary(uniqueKeysWithValues: ResearchFixture.bars().map { ($0.hour, $0) }))
        series.quotes[hour] = .init(turnover: 42_000_000, spread: 50, timestamp: hour + hourMS - 1)
        let built = ResearchEngine.reconstruct(series)
        XCTAssertNil(built.quotes[hour]?.spread)
        XCTAssertEqual(built.quotes[hour]?.turnover, 42_000_000)
        let context = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: hour, series: built)
        XCTAssertEqual(FilterEvaluator(market: context, filter: try FilterCompiler.compile(source: "turnover > 10")).evaluate().result, .yes)
    }

    @MainActor
    func testLegacyPlanReviewAndResumeSkipOrderBooksAndRunRemainingRules() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchSpread-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        try ResearchFixture.seed(store)
        let spec = try ResearchFixture.spec("Close > 100 AND spread < 0", through: ResearchFixture.hour + 24 * hourMS)
        var plan = ResearchFixture.plan(spec)
        plan.sources = [.init(id: "old-books", instrument: ResearchFixture.instrument.id, kind: "spread", from: plan.from, through: plan.through, url: "https://example.com/books", filename: "books.zip", sizeBytes: 583_508_199_978, archive: true, module: 4)]
        plan.warnings = ["Earlier spread readings remain Unknown."]
        let study = ResearchStudy(spec: spec, planID: plan.id)
        try store.put(plan.id, kind: "plan", plan); try store.put(study.id, kind: "study", study)
        try store.put("checkpoint:\(study.id)", kind: "checkpoint", Checkpoint(studyID: study.id, phase: "paused"))
        let transport = ResearchFixtureTransport()
        let controller = try ResearchController(directory: directory, transport: transport, radarURL: directory.appendingPathComponent("absent"))
        let detail = try await controller.handle(["action": "planDetail", "planID": plan.id])
        XCTAssertEqual(detail["estimatedBytes"] as? Int64, 0)
        let reviewed = try XCTUnwrap(detail["plan"] as? [String: Any])
        XCTAssertEqual((reviewed["sources"] as? [Any])?.count, 0)
        _ = try await controller.handle(["action": "resume", "studyID": study.id])
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
        let counts = await transport.counts()
        XCTAssertEqual(counts.0, 0); XCTAssertEqual(counts.1, 0)
        let prepared = try XCTUnwrap(store.get(study.id, as: ResearchStudy.self))
        XCTAssertEqual(prepared.spec.excludedSpreadConditions?.count, 1)
        let manifest = try XCTUnwrap(store.get(try XCTUnwrap(prepared.manifestID), as: DataManifest.self))
        XCTAssertFalse(manifest.coverage.contains { $0.kind == "spread" })
        XCTAssertFalse(manifest.sources.contains { $0.kind == "spread" })
        _ = try controller.run(studyID: study.id)
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(controller.status?.phase, "completed", controller.status?.error ?? "")
        let report = try XCTUnwrap(store.get("report:\(study.id)", as: StudyReport.self))
        XCTAssertEqual(report.unknown, 0)
        XCTAssertGreaterThan(try store.events(study.id).count, 0)
        XCTAssertEqual(report.spec.excludedSpreadConditions?.count, 1)
    }
}
