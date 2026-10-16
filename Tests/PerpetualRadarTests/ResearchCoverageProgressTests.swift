import XCTest
@testable import PerpetualRadar

private actor CoverageProgressRecorder {
    var values: [ResearchPlanningProgress] = []
    func append(_ value: ResearchPlanningProgress) { values.append(value) }
    func updates() -> [ResearchPlanningProgress] { values }
}

final class ResearchCoverageProgressTests: XCTestCase {
    func testCoverageReportsMeasuredProgressAndMergesGapsAcrossChunks() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CoverageProgress-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory), recorder = CoverageProgressRecorder()
        let first = ResearchFixture.hour - 800 * hourMS, last = first + 2500 * hourMS
        let bars = ResearchFixture.bars(from: first, through: last).filter { $0.hour < first + 709 * hourMS || $0.hour > first + 730 * hourMS }
        try ResearchFixture.seed(store, bars: bars)
        let source = ResearchSource(id: "funding", instrument: ResearchFixture.instrument.id, kind: "funding", from: first + 12 * hourMS, through: last, url: "fixture", filename: "No settlements", archive: false)
        try store.cover(source)
        let expected = try store.coverage([ResearchFixture.instrument], from: first, through: last)
        let actual = try await store.coverageWithProgress([ResearchFixture.instrument], from: first, through: last) { await recorder.append($0) }
        XCTAssertEqual(try researchJSON(actual), try researchJSON(expected))
        let gaps = try XCTUnwrap(actual.first { $0.kind == "candle" }).gaps
        XCTAssertEqual(gaps, [.init(from: first + 709 * hourMS, through: first + 730 * hourMS)])
        let updates = await recorder.updates()
        XCTAssertEqual(updates.first?.completed, 0)
        XCTAssertEqual(updates.last?.completed, 2501 * 6); XCTAssertEqual(updates.last?.total, 2501 * 6)
        XCTAssertEqual(updates.last?.remainingSeconds, 0)
        XCTAssertTrue(updates.contains { $0.completed > 0 && $0.completed < $0.total && ($0.remainingSeconds ?? -1) >= 0 })
        XCTAssertTrue(updates.contains { $0.kind == "candle" && $0.instrument == ResearchFixture.instrument.id && $0.from != nil })
        for (previous, next) in zip(updates, updates.dropFirst()) { XCTAssertLessThanOrEqual(previous.completed, next.completed) }
    }

    func testCoverageCancellationStopsBeforeAllRangesAreInspected() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CoverageCancel-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory), recorder = CoverageProgressRecorder()
        let work = Task {
            try await store.coverageWithProgress([ResearchFixture.instrument], from: ResearchFixture.hour, through: ResearchFixture.hour + 4000 * hourMS) { update in
                await recorder.append(update)
                if update.completed > 0 { withUnsafeCurrentTask { $0?.cancel() } }
            }
        }
        do { _ = try await work.value; XCTFail("Cancelled checking must stop between bounded local ranges.") }
        catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        let updates = await recorder.updates()
        XCTAssertLessThan(try XCTUnwrap(updates.last).completed, try XCTUnwrap(updates.last).total)
    }

    func testCoverageFailureNamesTheInstrumentInputAndTimeRange() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CoverageError-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        try store.database.execute("DROP TABLE research_heads")
        do {
            _ = try await store.coverageWithProgress([ResearchFixture.instrument], from: ResearchFixture.hour, through: ResearchFixture.hour + hourMS) { _ in }
            XCTFail("A local read error must fail checking.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Local coverage check failed"))
            // Concurrent checks can encounter the same missing table in any
            // input first; the error must still identify the actual input.
            XCTAssertTrue(["candle", "oi", "taker", "turnover recorded", "settlement mark"].contains { error.localizedDescription.contains("BTC-USDT-SWAP · \($0) ·") })
            XCTAssertTrue(error.localizedDescription.contains(String(ResearchFixture.hour)))
        }
    }

    @MainActor
    func testFailedPlanningRetainsStageCountsAndErrorAfterReopening() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("PlanningError-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        try ResearchFixture.seed(store)
        try store.database.execute("ALTER TABLE research_heads RENAME TO failed_heads")
        let controller = try ResearchController(directory: directory, transport: ResearchFixtureTransport(), radarURL: directory.appendingPathComponent("absent"))
        _ = try controller.plan(ResearchFixture.spec())
        while controller.isBusy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(controller.status?.phase, "failed")
        XCTAssertEqual(controller.status?.planning?.stage, "missing")
        XCTAssertEqual(controller.status?.total, 1)
        XCTAssertTrue(controller.status?.error.contains("Checking local gaps for archive planning · BTC-USDT-SWAP · candle") == true)
        try store.database.execute("ALTER TABLE failed_heads RENAME TO research_heads")
        let reopened = try ResearchController(directory: directory, transport: ResearchFixtureTransport())
        let inventory = try await reopened.handle(["action": "inventory"])
        let study = try XCTUnwrap((inventory["studies"] as? [[String: Any]])?.first)
        XCTAssertEqual(study["phase"] as? String, "failed")
        XCTAssertTrue((study["error"] as? String)?.contains("BTC-USDT-SWAP · candle") == true)
    }
}
