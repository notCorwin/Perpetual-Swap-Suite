import AppKit
import CoreFoundation
import XCTest
@testable import PerpetualRadar

@MainActor
final class ServiceRecoveryTests: XCTestCase {
    func testFailedResourcesRetryWithoutLatchingTheErrorOrResettingSavedData() async throws {
        var attempts = 0
        let resource = RecoveringResource(label: "Cannot open test cache", retryDelay: .milliseconds(30)) {
            attempts += 1
            if attempts == 1 { throw FilterError("temporarily locked") }
            return "saved data"
        }
        XCTAssertThrowsError(try resource.get())
        XCTAssertTrue(resource.error.contains("Automatically retrying"))
        for _ in 0..<10 { XCTAssertThrowsError(try resource.get()) }
        XCTAssertEqual(attempts, 1, "Concurrent callers must share the retry schedule.")
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(try resource.get(), "saved data")
        XCTAssertEqual(resource.error, "")
        XCTAssertEqual(try resource.get(), "saved data")
        XCTAssertEqual(attempts, 2)
    }

    func testIPCReplaysCompletedRepliesUntilAcknowledgedWithoutRepeatingWrites() async throws {
        let name = "com.perpetualradar.recovery.\(UUID())", id = UUID().uuidString
        var writes = 0
        let server = try MonitorIPCServer(name: name) { _ in
            writes += 1
            return try! JSONSerialization.data(withJSONObject: ["value": ["writes": writes]])
        }
        defer { server.invalidate() }
        let submission = try JSONSerialization.data(withJSONObject: ["id": id, "body": ["save": true]])
        func send(_ data: Data, _ message: Int32) async throws -> [String: Any] {
            let result = try await Task.detached { try MonitorIPC.send(data, message: message, name: name) }.value
            return try JSONSerialization.jsonObject(with: result) as! [String: Any]
        }
        _ = try await send(submission, 1)
        let key = Data(id.utf8)
        for _ in 0..<100 {
            if (try await send(key, 2))["value"] != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        _ = try await send(submission, 1)
        let replay = try await send(key, 2)
        XCTAssertEqual((replay["value"] as? [String: Any])?["writes"] as? Int, 1)
        XCTAssertEqual(writes, 1)
        _ = try await send(key, 4)
        let acknowledged = try await send(key, 2)
        XCTAssertEqual(acknowledged["ipcError"] as? String, "expired")
    }

    func testConcurrentClientRequestsShareOneLaunchAndValidationErrorsDoNotRestartIt() async throws {
        let name = "com.perpetualradar.recovery.\(UUID())", app = URL(fileURLWithPath: "/tmp/Recovery.app")
        var launches = 0, server: MonitorIPCServer?
        defer { server?.invalidate() }
        let client = MonitorClient(name: name, appURL: app, revision: "fixture") {
            launches += 1
            try await Task.sleep(for: .milliseconds(60))
            server = try MonitorIPCServer(name: name) { data in
                let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
                if body["badRule"] != nil { return Data("{\"error\":\"Invalid rule\"}".utf8) }
                return try! JSONSerialization.data(withJSONObject: ["value": ["appPath": app.path, "revision": "fixture", "serviceSession": "one", "ok": true]])
            }
        }
        var completed = 0
        let tasks = (0..<8).map { _ in Task {
            let result = try await client.request(["serviceInfo": true])
            XCTAssertEqual(result["ok"] as? Bool, true); completed += 1
        } }
        for task in tasks { try await task.value }
        XCTAssertEqual(launches, 1); XCTAssertEqual(completed, 8)
        do { _ = try await client.request(["badRule": true]); XCTFail("Invalid input must fail.") }
        catch { XCTAssertEqual(error.localizedDescription, "Invalid rule") }
        XCTAssertEqual(launches, 1)
    }

    func testClientReconnectsAndReplaysReadsAfterTheMonitorExitsDuringARequest() async throws {
        try await checkInterruptedRequest(isWrite: false)
    }

    func testClientRecoversAfterAnInterruptedWriteWithoutDuplicatingItsUncertainOutcome() async throws {
        try await checkInterruptedRequest(isWrite: true)
    }

    private func checkInterruptedRequest(isWrite: Bool) async throws {
        let name = "com.perpetualradar.recovery.\(UUID())", app = URL(fileURLWithPath: "/tmp/Recovery.app")
        var old: MonitorIPCServer?, replacement: MonitorIPCServer?, oldCalls = 0, newCalls = 0, launches = 0
        defer { old?.invalidate(); replacement?.invalidate() }
        func reply(_ session: String) -> Data {
            try! JSONSerialization.data(withJSONObject: ["value": ["appPath": app.path, "revision": "fixture", "serviceSession": session, "ok": true]])
        }
        old = try MonitorIPCServer(name: name) { data in
            let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            if body["serviceInfo"] as? Bool != true { oldCalls += 1; old?.invalidate() }
            return reply("old")
        }
        let client = MonitorClient(name: name, appURL: app, revision: "fixture") {
            launches += 1
            replacement = try MonitorIPCServer(name: name) { data in
                let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
                if body["serviceInfo"] as? Bool != true { newCalls += 1 }
                return reply("new")
            }
        }
        let body: [String: Any] = ["suite": ["mode": "radar", "action": isWrite ? "save" : "evaluate"]]
        do {
            let result = try await client.request(body)
            XCTAssertFalse(isWrite, "An uncertain write must be reconciled before the user retries.")
            XCTAssertEqual(result["serviceSession"] as? String, "new")
        } catch {
            XCTAssertTrue(isWrite)
            XCTAssertTrue(error.localizedDescription.contains("may already have been saved"), error.localizedDescription)
        }
        XCTAssertEqual(launches, 1); XCTAssertEqual(oldCalls, 1); XCTAssertEqual(newCalls, isWrite ? 0 : 1)
        let recovered = try await client.request(["serviceInfo": true])
        XCTAssertEqual(recovered["serviceSession"] as? String, "new")
    }

    func testCancelledRequestDoesNotSubmitWork() async throws {
        let name = "com.perpetualradar.recovery.\(UUID())"
        var calls = 0
        let server = try MonitorIPCServer(name: name) { _ in calls += 1; return Data("{\"value\":{}}".utf8) }
        defer { server.invalidate() }
        let request = Task { _ = try await MonitorIPC.request([:], name: name) }
        request.cancel()
        do { try await request.value; XCTFail("Cancellation must propagate.") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(calls, 0)
    }
}
