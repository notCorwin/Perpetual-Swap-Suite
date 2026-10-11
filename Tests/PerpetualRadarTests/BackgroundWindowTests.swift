import AppKit
import XCTest
@testable import PerpetualRadar

@MainActor
private final class MiniaturizationStateWindow: BackgroundTestWindow {
    // Test native delegate state transitions without asking Dock to animate
    // a thumbnail. AppKit only performs that animation for foreground apps.
    var miniaturizedForCallback = false
    override var isMiniaturized: Bool { miniaturizedForCallback }
}

final class BackgroundWindowTests: BackgroundTestCase {
    @MainActor
    func testTitledWindowStaysOffEveryDisplayThroughOrderingAndLayoutChanges() async throws {
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        defer { window.close() }
        window.contentView = NSView()
        let operations: [() -> Void] = [
            { window.orderBack(nil) },
            { window.center() },
            { window.setFrameOrigin(.zero) },
            { window.setContentSize(NSSize(width: 720, height: 1000)) },
            { window.setFrame(NSRect(x: 100, y: 100, width: 1440, height: 900), display: true, animate: true) },
            { window.makeKeyAndOrderFront(nil) },
            { window.orderFrontRegardless() },
            { window.orderOut(nil); window.orderBack(nil) },
            { NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: NSApp) },
        ]
        for operation in operations {
            operation()
            try await Task.sleep(for: .milliseconds(60))
            XCTAssertFalse(NSScreen.screens.contains { $0.frame.intersects(window.frame) })
            XCTAssertFalse(window.isKeyWindow)
            XCTAssertFalse(window.isMainWindow)
            XCTAssertEqual(window.level, .normal)
            XCTAssertEqual(NSApp.activationPolicy(), .accessory)
            XCTAssertTrue(window.isExcludedFromWindowsMenu)
            XCTAssertTrue(window.collectionBehavior.contains(.transient))
            XCTAssertTrue(window.collectionBehavior.contains(.ignoresCycle))
        }
    }

    @MainActor
    func testMiniaturizeAndRestoreCallbacksPersistRelaunchPresentationWithoutDock() throws {
        let defaults = MonitorRuntime.defaults
        let previousMode = defaults.object(forKey: "BackgroundMonitoring")
        let previousPresentation = defaults.object(forKey: AppUpdater.backgroundRelaunchKey)
        let window = MiniaturizationStateWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled, .miniaturizable], backing: .buffered, defer: false)
        let delegate = AppDelegate()
        defer {
            window.close()
            defaults.set(previousMode, forKey: "BackgroundMonitoring")
            defaults.set(previousPresentation, forKey: AppUpdater.backgroundRelaunchKey)
        }
        window.orderBack(nil)
        for monitoring in [true, false] {
            defaults.set(monitoring, forKey: "BackgroundMonitoring")
            window.miniaturizedForCallback = true
            delegate.windowDidMiniaturize(Notification(name: NSWindow.didMiniaturizeNotification, object: window))
            XCTAssertEqual(defaults.bool(forKey: AppUpdater.backgroundRelaunchKey), monitoring)
            window.miniaturizedForCallback = false
            delegate.windowDidDeminiaturize(Notification(name: NSWindow.didDeminiaturizeNotification, object: window))
            XCTAssertFalse(defaults.bool(forKey: AppUpdater.backgroundRelaunchKey))
        }
    }
}
