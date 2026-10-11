import AppKit
import XCTest

/// Samples WindowServer geometry, not just focus: an unfocused test window
/// still interrupts work if it appears on any connected display.
@MainActor
final class BackgroundTestAudit {
    private var activatedPIDs = Set<Int32>()
    private var visiblePIDs = Set<Int32>()
    private var dockPIDs = Set<Int32>()
    private var windowListAvailable = true
    private var observer: NSObjectProtocol?
    private var timer: Timer?

    init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = application.processIdentifier
            MainActor.assumeIsolated { self?.activatedPIDs.insert(pid) }
        }
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        sample()
    }

    private func sample() {
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier { activatedPIDs.insert(pid) }
        // Keep only process IDs, never titles or pixels from the user's apps.
        dockPIDs.formUnion(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(\.processIdentifier))
        let displays = NSScreen.screens.compactMap { screen -> CGRect? in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return CGDisplayBounds(number.uint32Value)
        }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            windowListAvailable = false
            return
        }
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? Int32,
                  let rawBounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: rawBounds),
                  (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  displays.contains(where: { $0.intersects(bounds) }) else { continue }
            visiblePIDs.insert(pid)
        }
    }

    func assertBackground(_ pids: [Int32] = [getpid()], file: StaticString = #filePath, line: UInt = #line) {
        sample()
        XCTAssertTrue(windowListAvailable, "WindowServer geometry must be available for the background audit.", file: file, line: line)
        XCTAssertTrue(activatedPIDs.isDisjoint(with: pids), "Tests took focus: \(activatedPIDs.intersection(pids))", file: file, line: line)
        XCTAssertTrue(visiblePIDs.isDisjoint(with: pids), "Test windows appeared on a display: \(visiblePIDs.intersection(pids))", file: file, line: line)
        XCTAssertTrue(dockPIDs.isDisjoint(with: pids), "Test processes became Dock applications: \(dockPIDs.intersection(pids))", file: file, line: line)
    }

    func stop() {
        timer?.invalidate(); timer = nil
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observer = nil
    }
}

class BackgroundTestCase: XCTestCase {
    @MainActor private var backgroundAudit: BackgroundTestAudit?

    @MainActor override func setUp() async throws {
        backgroundAudit = BackgroundTestAudit()
    }

    @MainActor override func tearDown() async throws {
        backgroundAudit?.assertBackground()
        backgroundAudit?.stop()
        backgroundAudit = nil
    }
}
