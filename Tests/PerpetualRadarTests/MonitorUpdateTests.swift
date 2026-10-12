import AppKit
import XCTest
@testable import PerpetualRadar

final class MonitorUpdateTests: BackgroundTestCase {
    @MainActor
    private func withMonitor(_ body: (UpdateTransport, TestClock) async throws -> Void) async throws {
        _ = try XCTUnwrap(MonitorRuntime.testChannel, "Use scripts/test-native.sh for an isolated monitor.")
        NSApplication.shared.setActivationPolicy(.accessory)
        let defaults = MonitorRuntime.defaults
        let keys = ["BackgroundMonitoring", "AutomaticallyInstallUpdates"]
        let previous = keys.map { defaults.object(forKey: $0) }
        defaults.set(true, forKey: "BackgroundMonitoring")
        defaults.set(true, forKey: "AutomaticallyInstallUpdates")
        let transport = UpdateTransport(), clock = TestClock()
        let delegate = MonitorDelegate(updater: transport, now: { clock.date })
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer {
            delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            for (key, value) in zip(keys, previous) { defaults.set(value, forKey: key) }
        }
        try await body(transport, clock)
    }

    @MainActor
    private func request(_ body: [String: Any]) async throws -> [String: Any] {
        try await MonitorIPC.request(body)
    }

    @MainActor
    private func lease(busy: Bool, pid: Int32 = getpid()) async throws -> [String: Any] {
        try await request(["serviceInfo": true, "foregroundLease": ["pid": pid, "workspace": "research", "researchBusy": busy]])
    }

    @MainActor
    func testIdleResearchAllowsUpdatesAndMenusShowRealProgress() async throws {
        try await withMonitor { transport, _ in
            _ = try await lease(busy: false)
            var info = try await request(["updateAction": "check"])
            XCTAssertEqual(transport.downloads, 1)
            XCTAssertEqual(info["updateMenuTitle"] as? String, "Downloading Update…")
            XCTAssertEqual(info["updateMenuEnabled"] as? Bool, false)
            _ = try await lease(busy: false)
            XCTAssertEqual(transport.cancellations, 0, "Opening idle Research must not cancel the download.")
            transport.progress?(.downloading(received: 8_000_000, total: 32_000_000))
            info = try await request(["serviceInfo": true])
            XCTAssertEqual(info["updateMenuTitle"] as? String, "Downloading Update · 25%")
            transport.progress?(.retrying(attempt: 2, total: 3))
            info = try await request(["serviceInfo": true])
            XCTAssertEqual(info["updateMenuTitle"] as? String, "Retrying Update Download · 2/3")
            transport.progress?(.installing)
            info = try await request(["serviceInfo": true])
            XCTAssertEqual(info["updateMenuTitle"] as? String, "Installing Update…")
        }
    }

    @MainActor
    func testResearchWorkDefersCancelsAndResumesUpdatesWithoutLeavingThePage() async throws {
        try await withMonitor { transport, _ in
            _ = try await lease(busy: true)
            var info = try await request(["updateAction": "check"])
            XCTAssertEqual(transport.downloads, 0)
            XCTAssertTrue((info["updateMenuTitle"] as? String ?? "").contains("Waiting for Research"))
            info = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 1)
            XCTAssertEqual(info["foregroundWorkspace"] as? String, "research")
            info = try await lease(busy: true)
            XCTAssertEqual(transport.cancellations, 1)
            XCTAssertTrue((info["updateMenuTitle"] as? String ?? "").contains("Waiting for Research"))
            _ = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 2)
        }
    }

    @MainActor
    func testEveryClientMustFinishResearchBeforeAnUpdateResumes() async throws {
        try await withMonitor { transport, _ in
            _ = try await lease(busy: true)
            _ = try await lease(busy: true, pid: getppid())
            _ = try await request(["updateAction": "check"])
            _ = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 0)
            _ = try await request(["releaseLease": getppid()])
            XCTAssertEqual(transport.downloads, 1)
        }
    }

    @MainActor
    func testAutomaticUpdatePreferenceControlsDeferredInstallation() async throws {
        try await withMonitor { transport, _ in
            _ = try await lease(busy: true)
            _ = try await request(["updateAction": "check"])
            _ = try await request(["updateAction": "toggleAutomatic"])
            _ = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 0)
            let info = try await request(["updateAction": "toggleAutomatic"])
            XCTAssertEqual(info["automaticUpdatesEnabled"] as? Bool, true)
            XCTAssertEqual(transport.downloads, 1)
        }
    }

    @MainActor
    func testFailedDownloadsExposeTheReasonAndRespectRetryDelays() async throws {
        try await withMonitor { transport, clock in
            _ = try await request(["updateAction": "check"])
            transport.fail(.downloadFailed("The request timed out."))
            var info = try await request(["serviceInfo": true])
            XCTAssertTrue((info["updateMenuTitle"] as? String ?? "").contains("Retrying in 5m"))
            XCTAssertTrue((info["updateMenuToolTip"] as? String ?? "").contains("The request timed out."))
            XCTAssertEqual(info["updateMenuEnabled"] as? Bool, true)
            _ = try await lease(busy: true)
            _ = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 1)
            clock.date.addTimeInterval(301)
            _ = try await lease(busy: true)
            _ = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 2)
            transport.fail(.rateLimited(clock.date.addingTimeInterval(120)))
            info = try await request(["serviceInfo": true])
            XCTAssertTrue((info["updateMenuTitle"] as? String ?? "").contains("Retrying in 2m"))
            clock.date.addTimeInterval(121)
            _ = try await lease(busy: true)
            info = try await lease(busy: false)
            XCTAssertEqual(transport.downloads, 3)
            XCTAssertEqual(info["updateMenuToolTip"] as? String, "")
        }
    }
}

@MainActor
private final class TestClock {
    var date = Date()
}

@MainActor
private final class UpdateTransport: AppUpdating {
    var downloads = 0
    var cancellations = 0
    var progress: AppUpdater.ProgressHandler?
    private var completion: AppUpdater.InstallCompletion?

    func check(completion: @escaping AppUpdater.CheckCompletion) {
        completion(.success(AppUpdate(
            name: "autobuild", revision: String(repeating: "a", count: 40),
            assetURL: URL(string: "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar")!,
            expectedSHA256: String(repeating: "b", count: 64)
        )))
    }

    func downloadAndInstall(_ update: AppUpdate, progress: @escaping AppUpdater.ProgressHandler, completion: @escaping AppUpdater.InstallCompletion) {
        downloads += 1
        self.progress = progress
        self.completion = completion
    }

    @discardableResult
    func cancel() -> Bool {
        cancellations += 1
        progress = nil; completion = nil
        return true
    }

    func fail(_ error: AppUpdateError) {
        let callback = completion
        progress = nil; completion = nil
        callback?(.failure(error))
    }
}
