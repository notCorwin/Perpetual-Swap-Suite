import XCTest
@testable import PerpetualRadar

final class AppUpdaterTests: XCTestCase {
    func testAutomaticUpdatesAreOnByDefaultAndCanBeDisabled() throws {
        let name = "PerpetualRadarTests-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertTrue(AppDelegate.automaticUpdatesEnabled(in: defaults))
        defaults.set(false, forKey: "AutomaticallyInstallUpdates")
        XCTAssertFalse(AppDelegate.automaticUpdatesEnabled(in: defaults))
    }

    func testManifestUsesOnlyTheExpectedAppAndDigest() throws {
        let revision = String(repeating: "a", count: 40)
        let digest = String(repeating: "b", count: 64)
        let data = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar",
            "digest": "sha256:\(digest)",
            "published_at": "2026-09-27T00:00:00Z",
        ])

        guard case .success(let available) = AppUpdater.parse(data: data, currentRevision: String(repeating: "c", count: 40)) else {
            return XCTFail("Expected an available update")
        }
        XCTAssertEqual(available?.revision, revision)
        XCTAssertEqual(available?.assetURL.absoluteString, "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar")
        XCTAssertEqual(available?.expectedSHA256, digest)
        XCTAssertEqual(available?.publishedAt, Date(timeIntervalSince1970: 1_790_467_200))
        guard case .success(let latest) = AppUpdater.parse(data: data, currentRevision: revision) else {
            return XCTFail("Expected the installed revision to be current")
        }
        XCTAssertNil(latest)

        let missingDigest = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar",
        ])
        guard case .failure(.invalidResponse) = AppUpdater.parse(data: missingDigest, currentRevision: nil) else {
            return XCTFail("Expected an unsigned release to be rejected")
        }
        let wrongURL = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://example.com/Perpetual.Swap.Suite.app.tar",
            "digest": "sha256:\(digest)",
        ])
        guard case .failure(.invalidResponse) = AppUpdater.parse(data: wrongURL, currentRevision: nil) else {
            return XCTFail("Expected an unexpected download location to be rejected")
        }

        let immutableURL = "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/build-\(revision)-123-1/Perpetual.Swap.Suite.app.tar"
        let immutableManifest = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar",
            "immutable_asset_url": immutableURL,
            "digest": "sha256:\(digest)",
        ])
        guard case .success(let immutableUpdate) = AppUpdater.parse(data: immutableManifest, currentRevision: nil) else {
            return XCTFail("Expected a revision-specific update")
        }
        XCTAssertEqual(immutableUpdate?.assetURL.absoluteString, immutableURL)

        let versionedURL = "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.\(revision).123-1.tar"
        let versionedManifest = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar",
            "versioned_asset_url": versionedURL,
            "digest": "sha256:\(digest)",
        ])
        guard case .success(let versionedUpdate) = AppUpdater.parse(data: versionedManifest, currentRevision: nil) else {
            return XCTFail("Expected an autobuild versioned asset")
        }
        XCTAssertEqual(versionedUpdate?.assetURL.absoluteString, versionedURL)

        let invalidVersionedManifest = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar",
            "versioned_asset_url": versionedURL.replacingOccurrences(of: revision, with: String(repeating: "c", count: 40)),
            "digest": "sha256:\(digest)",
        ])
        guard case .failure(.invalidResponse) = AppUpdater.parse(data: invalidVersionedManifest, currentRevision: nil) else {
            return XCTFail("Expected a mismatched autobuild asset to be rejected")
        }

        let wrongRevisionURL = immutableURL.replacingOccurrences(of: revision, with: String(repeating: "c", count: 40))
        let mismatchedManifest = try JSONSerialization.data(withJSONObject: [
            "revision": revision,
            "asset_url": "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/Perpetual.Swap.Suite.app.tar",
            "immutable_asset_url": wrongRevisionURL,
            "digest": "sha256:\(digest)",
        ])
        guard case .failure(.invalidResponse) = AppUpdater.parse(data: mismatchedManifest, currentRevision: nil) else {
            return XCTFail("Expected a mismatched release URL to be rejected")
        }
    }

    func testRateLimitHonorsResponseHeaders() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let url = URL(string: "https://github.com")!
        let primary = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil,
                                                    headerFields: ["X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "2000"]))
        XCTAssertEqual(AppUpdater.retryDate(for: primary, now: now), Date(timeIntervalSince1970: 2_001))
        let secondary = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil,
                                                      headerFields: ["Retry-After": "120"]))
        XCTAssertEqual(AppUpdater.retryDate(for: secondary, now: now), Date(timeIntervalSince1970: 1_120))
        let generic = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil, headerFields: [:]))
        XCTAssertEqual(AppUpdater.retryDate(for: generic, now: now), Date(timeIntervalSince1970: 1_060))
    }

    func testArchiveMustContainOnlyTheExpectedApp() {
        XCTAssertEqual(AppUpdater.archiveAppRoot(from: "Perpetual Swap Suite.app/\nPerpetual Swap Suite.app/Contents/Info.plist\n"), "Perpetual Swap Suite.app")
        XCTAssertNil(AppUpdater.archiveAppRoot(from: "Other.app/Contents/Info.plist\n"))
        XCTAssertNil(AppUpdater.archiveAppRoot(from: "Perpetual Swap Suite.app/Contents/Info.plist\n../other\n"))
    }

    func testInstallReplacesTheExpectedApp() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("PerpetualRadarTests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let current = root.appendingPathComponent("Perpetual Swap Suite.app")
        let release = root.appendingPathComponent("release/Perpetual Swap Suite.app")
        let archive = root.appendingPathComponent("update.tar")
        try makeApp(at: current, marker: "old")
        try makeApp(at: release, marker: "new")

        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-cf", archive.path, "-C", release.deletingLastPathComponent().path, "Perpetual Swap Suite.app"]
        try tar.run()
        tar.waitUntilExit()
        XCTAssertEqual(tar.terminationStatus, 0)

        let updater = AppUpdater(currentAppURL: current, relauncher: { _, _ in })
        try updater.install(downloadedFile: archive, expectedRevision: "unknown")
        let marker = current.appendingPathComponent("Contents/Resources/marker")
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "new")
        XCTAssertEqual(try String(contentsOf: current.appendingPathComponent("Contents/Resources/Web/index.html"), encoding: .utf8), "<html>new</html>")
    }

    func testRelaunchWaitsForOldProcessAndReusesDockApp() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("PerpetualRadarRelaunchTests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app = root.appendingPathComponent("Perpetual Swap Suite.app")
        let backup = root.appendingPathComponent("backup.app")
        let log = root.appendingPathComponent("open.log")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        let opener = try makeFakeOpener(in: root, fail: false)

        let oldApp = Process()
        oldApp.executableURL = URL(fileURLWithPath: "/bin/sleep")
        oldApp.arguments = ["30"]
        try oldApp.run()
        defer {
            if oldApp.isRunning {
                oldApp.terminate()
                oldApp.waitUntilExit()
            }
        }

        let helper = try runRelaunchHelper(
            app: app, oldPID: oldApp.processIdentifier, backup: backup,
            opener: opener, log: log
        )
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.path), "The replacement must not open while the old app is running")

        oldApp.terminate()
        oldApp.waitUntilExit()
        helper.waitUntilExit()
        XCTAssertEqual(helper.terminationStatus, 0)
        let arguments = try String(contentsOf: log, encoding: .utf8)
        XCTAssertTrue(arguments.contains("-a\n\(app.path)\n"))
        XCTAssertFalse(arguments.contains("-g\n"), "A visible app should reopen normally after updating")
        XCTAssertFalse(arguments.contains("-n\n"), "A forced new instance creates a second Dock tile")
        XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
    }

    func testRelaunchRestoresBackupIfNewAppCannotOpen() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("PerpetualRadarRelaunchTests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app = root.appendingPathComponent("Perpetual Swap Suite.app")
        let backup = root.appendingPathComponent("backup.app")
        let log = root.appendingPathComponent("open.log")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: backup.appendingPathComponent("marker"))
        let opener = try makeFakeOpener(in: root, fail: true)

        let helper = try runRelaunchHelper(
            app: app, oldPID: Int32.max, backup: backup,
            opener: opener, log: log
        )
        helper.waitUntilExit()
        XCTAssertNotEqual(helper.terminationStatus, 0)
        XCTAssertEqual(try String(contentsOf: app.appendingPathComponent("marker"), encoding: .utf8), "old")
        XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
        XCTAssertTrue(try String(contentsOf: log, encoding: .utf8).contains("PERPETUAL_RADAR_UPDATE_ROLLBACK=1"))
    }

    func testBackgroundRelaunchAndRollbackPreserveHiddenWindowWithoutActivation() throws {
        for (fail, embeddedMonitor) in [(false, false), (true, false), (false, true), (true, true)] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("PerpetualRadarBackgroundRelaunchTests-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let app = root.appendingPathComponent("Perpetual Swap Suite.app"), backup = root.appendingPathComponent("backup.app"), log = root.appendingPathComponent("open.log")
            try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
            if embeddedMonitor {
                for bundle in [app, backup] {
                    let executable = bundle.appendingPathComponent("Contents/Library/LoginItems/Perpetual Swap Suite Monitor.app/Contents/MacOS/PerpetualRadar")
                    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data("monitor".utf8).write(to: executable)
                    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
                }
            }
            let opener = try makeFakeOpener(in: root, fail: fail)
            let helper = try runRelaunchHelper(app: app, oldPID: Int32.max, backup: backup, opener: opener, log: log, background: true)
            helper.waitUntilExit()
            let arguments = try String(contentsOf: log, encoding: .utf8)
            let openedPath = embeddedMonitor ? app.appendingPathComponent("Contents/Library/LoginItems/Perpetual Swap Suite Monitor.app").path : app.path
            XCTAssertTrue(arguments.contains("-g\n-a\n\(openedPath)\n--env\nPERPETUAL_RADAR_BACKGROUND=1\n"))
            XCTAssertEqual(arguments.components(separatedBy: "\(openedPath)\n").count - 1, fail ? 2 : 1, "Each attempt opens the app once")
            if fail { XCTAssertTrue(arguments.contains("PERPETUAL_RADAR_UPDATE_ROLLBACK=1")) }
            XCTAssertEqual(helper.terminationStatus == 0, !fail)
        }
    }

    func testExplicitOnDemandQuitPreventsUpdateRelaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("NoRelaunch-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("Radar.app"), backup = root.appendingPathComponent("backup.app"), log = root.appendingPathComponent("open.log"), suppress = root.appendingPathComponent("suppress")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        try Data().write(to: suppress)
        let opener = try makeFakeOpener(in: root, fail: false)
        let helper = try runRelaunchHelper(app: app, oldPID: Int32.max, backup: backup, opener: opener, log: log, suppress: suppress)
        helper.waitUntilExit()
        XCTAssertEqual(helper.terminationStatus, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
    }

    private func makeFakeOpener(in root: URL, fail: Bool) throws -> URL {
        let opener = root.appendingPathComponent("open")
        let body = fail ? "exit 1" : """
        for argument in "$@"; do
            case "$argument" in
                PERPETUAL_RADAR_PID_FILE=*) pid_file="${argument#*=}" ;;
                PERPETUAL_RADAR_READY_FILE=*) ready_file="${argument#*=}" ;;
            esac
        done
        printf '%s' "$PERPETUAL_RADAR_TEST_PID" > "$pid_file"
        /usr/bin/touch "$ready_file"
        """
        try Data("#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$PERPETUAL_RADAR_TEST_LOG\"\n\(body)\n".utf8).write(to: opener)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: opener.path)
        return opener
    }

    private func runRelaunchHelper(
        app: URL, oldPID: Int32, backup: URL, opener: URL, log: URL, background: Bool = false, suppress: URL? = nil
    ) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c", AppUpdater.defaultRelauncherScript, "Perpetual Swap Suite updater",
            app.path, String(oldPID), backup.path, opener.path,
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["PERPETUAL_RADAR_TEST_LOG"] = log.path
        environment["PERPETUAL_RADAR_TEST_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["PERPETUAL_RADAR_BACKGROUND"] = background ? "1" : "0"
        if let suppress { environment["PERPETUAL_RADAR_SUPPRESS_RELAUNCH_FILE"] = suppress.path }
        process.environment = environment
        try process.run()
        return process
    }

    private func makeApp(at url: URL, marker: String) throws {
        let contents = url.appendingPathComponent("Contents")
        let executable = contents.appendingPathComponent("MacOS/PerpetualRadar")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Resources/Web"), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try Data(marker.utf8).write(to: contents.appendingPathComponent("Resources/marker"))
        try Data("<html>\(marker)</html>".utf8).write(to: contents.appendingPathComponent("Resources/Web/index.html"))
        let plist = try PropertyListSerialization.data(fromPropertyList: [
            "CFBundleExecutable": "PerpetualRadar",
            "CFBundleIdentifier": "com.perpetualradar.macos",
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleName": "Perpetual Swap Suite",
            "CFBundlePackageType": "APPL",
        ], format: .xml, options: 0)
        try plist.write(to: contents.appendingPathComponent("Info.plist"))
    }
}
