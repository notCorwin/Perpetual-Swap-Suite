import XCTest
@testable import PerpetualRadar

@MainActor
final class ResearchLibraryTests: XCTestCase {
    func testSlowInventoryLeavesTheInterfaceActorAvailable() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchLibrary-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        // A lazy million-row fixture makes COUNT expensive without creating a
        // large test database. Exercise the real request and SQLite read path.
        try store.database.execute("DROP TABLE research_heads")
        try store.database.execute("CREATE VIEW research_heads AS WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<1000000) SELECT n FROM rows")
        let controller = try ResearchController(directory: directory)
        var started = false, finished = false
        let query = Task { @MainActor in
            started = true
            let result = try await controller.handle(["action": "inventory"])
            finished = true
            return result["cachedRows"] as? Int
        }
        while !started { await Task.yield() }
        XCTAssertFalse(finished, "The UI must process another event while a slow inventory query is still running.")
        let rows = try await query.value
        XCTAssertEqual(rows, 1_000_000)
    }

    func testInventoryObservesCommittedCacheAndStudyChangesAcrossConnections() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchLibrary-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory)
        let controller = try ResearchController(directory: directory)
        let empty = try await controller.handle(["action": "inventory"])
        XCTAssertEqual(empty["cachedRows"] as? Int, 0)
        XCTAssertEqual(empty["rawFiles"] as? Int, 0)
        let spec = try ResearchFixture.spec(), plan = ResearchFixture.plan(spec)
        let study = ResearchStudy(spec: spec, planID: plan.id)
        var checkpoint = Checkpoint(studyID: study.id, phase: "preparing")
        checkpoint.completedSources = (0..<10_000).map { "source-\($0)" }
        checkpoint.sourceSeconds = Dictionary(uniqueKeysWithValues: checkpoint.completedSources.map { ($0, 1.0) })
        let source = ResearchSource(id: "fixture", instrument: ResearchFixture.instrument.id, kind: "candle", from: plan.from, through: plan.through, url: "fixture", filename: "fixture", archive: false)
        try store.database.transaction {
            try store.put(plan.id, kind: "plan", plan)
            try store.put(study.id, kind: "study", study)
            try store.put(source.id, kind: "source", source)
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        try ResearchFixture.seed(store, bars: Array(ResearchFixture.bars().prefix(2)))
        for _ in 0..<2 {
            let result = try await controller.handle(["action": "inventory"])
            XCTAssertEqual(result["cachedRows"] as? Int, 4)
            XCTAssertEqual(result["rawFiles"] as? Int, 1)
            let saved = try XCTUnwrap((result["studies"] as? [[String: Any]])?.first)
            XCTAssertEqual(saved["phase"] as? String, "paused")
            XCTAssertEqual(saved["active"] as? Bool, false)
        }
        checkpoint.phase = "failed"; checkpoint.error = "Saved archive failure"; checkpoint.updatedAt += 1
        try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        try store.database.execute("DELETE FROM research_heads")
        try store.database.execute("DELETE FROM research_objects WHERE id=?", [source.id])
        let updated = try await controller.handle(["action": "inventory"])
        XCTAssertEqual(updated["cachedRows"] as? Int, 0)
        XCTAssertEqual(updated["rawFiles"] as? Int, 0)
        let saved = try XCTUnwrap((updated["studies"] as? [[String: Any]])?.first)
        XCTAssertEqual(saved["phase"] as? String, "failed")
        XCTAssertEqual(saved["error"] as? String, checkpoint.error)
        XCTAssertEqual(saved["updatedAt"] as? Int64, checkpoint.updatedAt)
        // The lightweight inventory read must leave the full resume state intact.
        XCTAssertEqual(try store.get("checkpoint:\(study.id)", as: Checkpoint.self)?.completedSources.count, 10_000)
    }
}
