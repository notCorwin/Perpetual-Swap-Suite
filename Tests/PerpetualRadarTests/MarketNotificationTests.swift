import UserNotifications
import XCTest
@testable import PerpetualRadar

@MainActor
private final class NotificationTransportFixture: MarketNotificationTransport {
    var state = MarketNotificationAuthorization.notDetermined
    var requests: [UNNotificationRequest] = []
    var permissionRequests = 0
    var failDelivery = false
    func authorization() async -> MarketNotificationAuthorization { state }
    func requestAuthorization() async throws { permissionRequests += 1; state = .authorized }
    func add(_ request: UNNotificationRequest) async throws {
        if failDelivery { throw FilterError("Notification transport failure") }
        requests.append(request)
    }
}

final class MarketNotificationTests: XCTestCase {
    @MainActor
    func testPermissionIsRequestedOnlyWhenUndeterminedAndDeniedStateRemainsVisible() async {
        let transport = NotificationTransportFixture()
        let service = MarketNotifications(transport: transport, enabled: { true })
        await service.refresh()
        XCTAssertEqual(transport.permissionRequests, 0)
        await service.refresh(requestPermission: true)
        XCTAssertEqual(service.authorization, .authorized)
        await service.refresh(requestPermission: true)
        XCTAssertEqual(transport.permissionRequests, 1)
        transport.state = .denied
        await service.refresh(requestPermission: true)
        XCTAssertEqual(transport.permissionRequests, 1)
        XCTAssertEqual(service.authorization, .denied)
    }

    @MainActor
    func testEntryAndExitNotificationsHaveDistinctIDsSoundAndContractRouting() async throws {
        let transport = NotificationTransportFixture(); transport.state = .authorized
        let service = MarketNotifications(transport: transport, enabled: { true })
        await service.send([.init(instId: "BTC-USDT-SWAP", direction: .entered), .init(instId: "BTC-USDT-SWAP", direction: .exited)])
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(Set(transport.requests.map(\.identifier)).count, 2)
        let entry = try XCTUnwrap(transport.requests.first), exit = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(entry.content.title, "Strategy signal confirmed")
        XCTAssertEqual(exit.content.title, "Strategy signal ended")
        for request in transport.requests {
            XCTAssertNil(request.trigger)
            XCTAssertNotNil(request.content.sound)
            XCTAssertEqual(request.content.subtitle, "BTC-USDT-SWAP")
            XCTAssertEqual(request.content.userInfo["instId"] as? String, "BTC-USDT-SWAP")
            XCTAssertEqual(request.content.threadIdentifier, "saved-strategy-signals")
        }
        XCTAssertEqual(entry.content.userInfo["direction"] as? String, "entered")
        XCTAssertEqual(exit.content.userInfo["direction"] as? String, "exited")
    }

    @MainActor
    func testDisabledAndDeniedNotificationsAreSuppressedWithoutRequestingPermission() async {
        let transport = NotificationTransportFixture(); transport.state = .authorized
        var enabled = false
        let service = MarketNotifications(transport: transport, enabled: { enabled })
        let changes = [FilterMembershipChange(instId: "BTC-USDT-SWAP", direction: .entered)]
        await service.send(changes)
        enabled = true; transport.state = .denied
        await service.send(changes)
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(transport.permissionRequests, 0)
        XCTAssertEqual(service.authorization, .denied)
        transport.state = .quiet
        await service.send(changes)
        XCTAssertEqual(transport.requests.count, 1, "Notification Center can still receive alerts when banners are disabled.")
    }

    @MainActor
    func testTestNotificationAndDeliveryFailureAreReportedAndRecover() async {
        let transport = NotificationTransportFixture()
        let service = MarketNotifications(transport: transport, enabled: { true })
        transport.failDelivery = true
        await service.sendTest()
        XCTAssertEqual(transport.permissionRequests, 1)
        XCTAssertTrue(service.error.contains("Notification transport failure"))
        transport.failDelivery = false
        await service.sendTest()
        XCTAssertEqual(service.error, "")
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(transport.requests.first?.content.title, "Perpetual Swap Suite")
    }

    @MainActor
    func testNotificationPreferencePersistsInSQLiteAndFailedWriteKeepsCurrentState() throws {
        let suite = "MarketNotificationTests-\(UUID())", directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)), url = directory.appendingPathComponent("radar.sqlite3")
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let radar = try Radar(defaults: defaults, storeURL: url)
        XCTAssertTrue(radar.notificationsEnabled)
        try radar.setNotificationsEnabled(false)
        defaults.removePersistentDomain(forName: suite)
        XCTAssertFalse(try Radar(defaults: defaults, storeURL: url).notificationsEnabled)
        let blocker = try Store(url: url)
        try blocker.execute("CREATE TRIGGER reject_notification_write BEFORE UPDATE ON preferences WHEN NEW.key='strategyNotificationsEnabled' BEGIN SELECT RAISE(ABORT,'Fixture write failure'); END")
        XCTAssertThrowsError(try radar.setNotificationsEnabled(true))
        XCTAssertFalse(radar.notificationsEnabled)
        try blocker.execute("DROP TRIGGER reject_notification_write")
        try radar.setNotificationsEnabled(true)
        XCTAssertTrue(try Radar(defaults: defaults, storeURL: url).notificationsEnabled)
    }
}
