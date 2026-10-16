import XCTest
@testable import PerpetualRadar

@MainActor
final class ResearchStartTests: XCTestCase {
    func testRejectedInitialWritesLeaveResearchIdleAndAllowRetry() async throws {
        for phase in ["planning", "preparing"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchStart-\(UUID())")
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = try ResearchStore(directory: directory)
            try ResearchFixture.seed(store)
            let spec = try ResearchFixture.spec(), plan = ResearchFixture.plan(spec)
            try store.put(plan.id, kind: "plan", plan)
            let controller = try ResearchController(directory: directory, transport: ResearchFixtureTransport(), radarURL: directory.appendingPathComponent("absent"))
            var busyChanges: [Bool] = []
            controller.onBusyChanged = { busyChanges.append($0) }
            try store.database.execute("CREATE TRIGGER reject_start BEFORE INSERT ON research_objects WHEN NEW.kind IN ('study','checkpoint') BEGIN SELECT RAISE(ABORT, 'Research storage unavailable'); END")
            if phase == "planning" { XCTAssertThrowsError(try controller.plan(spec)) }
            else { XCTAssertThrowsError(try controller.prepare(planID: plan.id)) }
            XCTAssertFalse(controller.isBusy)
            XCTAssertNil(controller.status, "A rejected start must not leave an unpausable \(phase) job in the UI.")
            XCTAssertEqual(busyChanges, [], "Updates must not be deferred for a job that never started.")
            let inventory = try await controller.handle(["action": "inventory"])
            XCTAssertTrue(inventory["job"] is NSNull)
            XCTAssertTrue(try store.objects("study", as: ResearchStudy.self).isEmpty)

            try store.database.execute("DROP TRIGGER reject_start")
            _ = try controller.prepare(planID: plan.id)
            let deadline = ContinuousClock.now + .seconds(3)
            while controller.isBusy && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
            if controller.isBusy { try await controller.stop(); XCTFail("Retry did not complete.") }
            XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
            XCTAssertEqual(busyChanges, [true, false])
        }
    }
}
