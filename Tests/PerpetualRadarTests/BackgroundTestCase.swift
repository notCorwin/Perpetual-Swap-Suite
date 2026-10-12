import AppKit
import XCTest

/// Samples WindowServer geometry, not just focus: an unfocused test window
/// still interrupts work if it appears on any connected display.
@MainActor
final class BackgroundTestAudit {
    private var activatedPIDs = Set<Int32>()
    private var visiblePIDs = Set<Int32>()
    private var visibleWindowDetails: [Int32: Set<String>] = [:]
    private var dockPIDs = Set<Int32>()
    private var windowListAvailable = true
    private var observer: NSObjectProtocol?
    private var launchObserver: NSObjectProtocol?
    private var trackedPIDs: Set<Int32> = [getpid()]
    private var timer: Timer?

    init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = application.processIdentifier
            MainActor.assumeIsolated { _ = self?.activatedPIDs.insert(pid) }
        }
        launchObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = application.processIdentifier
            MainActor.assumeIsolated { self?.track(pid) }
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
        for pid in trackedPIDs where NSRunningApplication(processIdentifier: pid)?.activationPolicy == .regular { dockPIDs.insert(pid) }
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
                  // WindowServer can briefly return zero-sized placeholders
                  // during title changes. Require an intersection with pixels.
                  displays.contains(where: { !$0.intersection(bounds).isEmpty }) else { continue }
            visiblePIDs.insert(pid)
            guard pid == getpid() else { continue }
            let number = window[kCGWindowNumber as String] as? Int ?? -1
            let layer = window[kCGWindowLayer as String] as? Int ?? -1
            let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
            let name = window[kCGWindowName as String] as? String ?? ""
            visibleWindowDetails[pid, default: []].insert("#\(number) layer=\(layer) alpha=\(alpha) bounds=\(bounds) name=\(name)")
        }
    }

    func track(_ pid: Int32) { trackedPIDs.insert(pid); sample() }

    func assertBackground(_ pids: [Int32] = [getpid()], file: StaticString = #filePath, line: UInt = #line) {
        trackedPIDs.formUnion(pids)
        sample()
        XCTAssertTrue(windowListAvailable, "WindowServer geometry must be available for the background audit.", file: file, line: line)
        XCTAssertTrue(activatedPIDs.isDisjoint(with: pids), "Tests took focus: \(activatedPIDs.intersection(pids))", file: file, line: line)
        let visible = visiblePIDs.intersection(pids)
        let details = visible.flatMap { visibleWindowDetails[$0, default: []] }.sorted()
        XCTAssertTrue(visible.isEmpty, "Test windows appeared on a display: \(visible); details: \(details)", file: file, line: line)
        XCTAssertTrue(dockPIDs.isDisjoint(with: pids), "Test processes became Dock applications: \(dockPIDs.intersection(pids))", file: file, line: line)
    }

    func stop() {
        timer?.invalidate(); timer = nil
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        if let launchObserver { NSWorkspace.shared.notificationCenter.removeObserver(launchObserver) }
        observer = nil
        launchObserver = nil
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
