import Foundation
import XCTest
@testable import PerpetualRadar

private final class SlowLoginStatusReader: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    private var status = "requiresApproval"
    private var usedMainThread = false
    func read() -> String {
        lock.lock(); calls += 1; usedMainThread = usedMainThread || Thread.isMainThread; let status = status; lock.unlock()
        Thread.sleep(forTimeInterval: 0.2)
        return status
    }
    func set(_ status: String) { lock.lock(); self.status = status; lock.unlock() }
    var readings: Int { lock.lock(); defer { lock.unlock() }; return calls }
    var blockedMainThread: Bool { lock.lock(); defer { lock.unlock() }; return usedMainThread }
}

final class LoginItemStatusTests: XCTestCase {
    @MainActor
    func testSlowStatusRequestsRunOffMainActorCoalesceAndRefreshAfterSettingsChange() async throws {
        let reader = SlowLoginStatusReader(), cache = LoginItemStatus(read: { reader.read() })
        let requests = (0..<20).map { _ in Task { await cache.refresh(force: true) } }
        let start = ContinuousClock.now
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertLessThan(start.duration(to: .now), .milliseconds(150), "A slow login-service reply must not block Apply filters or native menus.")
        XCTAssertEqual(cache.value, "unavailable")
        for request in requests { let result = await request.value; XCTAssertEqual(result, "requiresApproval") }
        XCTAssertEqual(reader.readings, 1)
        XCTAssertFalse(reader.blockedMainThread)
        let cached = await cache.refresh()
        XCTAssertEqual(cached, "requiresApproval"); XCTAssertEqual(reader.readings, 1)
        reader.set("enabled")
        let updated = await cache.refresh(force: true)
        XCTAssertEqual(updated, "enabled"); XCTAssertEqual(cache.value, "enabled"); XCTAssertEqual(reader.readings, 2)
    }
}
