import AppKit
import XCTest
@testable import PerpetualRadar

final class MonitorServiceTests: BackgroundTestCase {
    @MainActor
    private func requestShutdown(_ body: [String: Any], name: String) async throws {
        do { _ = try await MonitorIPC.request(body, name: name) }
        catch let failure as MonitorIPCFailure where failure.isConnectionFailure && failure.requestMayHaveRun {
            // The endpoint can exit before the client polls its reply. Each
            // caller verifies process termination and persisted state below.
        }
    }

    private func serviceTestDirectory(_ channel: String) -> URL {
        let root = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_TEST_DIRECTORY"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        return root.appendingPathComponent(channel)
    }

    @MainActor
    func testPackagedLaunchSelectsEmbeddedMonitorWhenAnotherCopyIsRunning() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["RADAR_SERVICE_TESTS"] == "1", "Run after packaging; both monitors stay hidden.")
        let builtApp = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".build/app/Perpetual Swap Suite.app")
        let channel = UUID().uuidString, foreignChannel = UUID().uuidString
        let directory = serviceTestDirectory(channel), foreignDirectory = serviceTestDirectory(foreignChannel)
        let identifier = "RadarServiceTests.\(channel)"
        for id in [channel, foreignChannel] {
            UserDefaults(suiteName: "RadarServiceTests.\(id)")?.set(false, forKey: "BackgroundMonitoring")
        }
        let focus = BackgroundTestAudit(); defer { focus.stop() }
        let foreign = Process()
        var selected: NSRunningApplication?
        defer {
            if foreign.isRunning { kill(foreign.processIdentifier, SIGKILL) }
            if let selected, !selected.isTerminated { selected.forceTerminate() }
            for (id, path) in [(channel, directory), (foreignChannel, foreignDirectory)] {
                UserDefaults(suiteName: "RadarServiceTests.\(id)")?.removePersistentDomain(forName: "RadarServiceTests.\(id)")
                try? FileManager.default.removeItem(at: path)
            }
        }
        // Both copies deliberately share a test-only identity to reproduce
        // LaunchServices' reuse behavior without registering production IDs.
        let ownApp = try backgroundTestApp(from: builtApp, in: directory, bundleIdentifier: identifier)
        let foreignApp = try backgroundTestApp(from: builtApp, in: foreignDirectory, bundleIdentifier: identifier)
        func environment(_ id: String, _ path: URL) -> [String: String] {
            ["PERPETUAL_RADAR_TEST_CHANNEL": id, "PERPETUAL_RADAR_TEST_DIRECTORY": path.path,
             "PERPETUAL_RADAR_OWNER_PID": String(ProcessInfo.processInfo.processIdentifier), "PERPETUAL_RADAR_BACKGROUND": "1"]
        }
        func info(_ id: String) async throws -> [String: Any] {
            let name = "com.perpetualradar.monitor.\(getuid()).\(id)"
            let deadline = ContinuousClock.now + .seconds(5)
            while !MonitorIPC.endpointExists(name), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(25)) }
            return try await MonitorIPC.request(["serviceInfo": true], name: name, timeout: .seconds(5))
        }
        let helperPath = "Contents/Library/LoginItems/\(MonitorRuntime.helperName)"
        foreign.executableURL = foreignApp.appendingPathComponent(helperPath + "/Contents/MacOS/PerpetualRadar")
        foreign.environment = environment(foreignChannel, foreignDirectory)
        foreign.standardOutput = FileHandle.nullDevice; foreign.standardError = FileHandle.nullDevice
        try foreign.run(); focus.track(foreign.processIdentifier)
        let foreignInfo = try await info(foreignChannel)
        XCTAssertEqual(foreignInfo["pid"] as? Int32, foreign.processIdentifier)
        selected = try await MonitorClient.openHelper(at: ownApp.appendingPathComponent(helperPath), environment: environment(channel, directory))
        let own = try XCTUnwrap(selected); focus.track(own.processIdentifier)
        let ownInfo = try await info(channel)
        XCTAssertEqual(ownInfo["pid"] as? Int32, own.processIdentifier)
        XCTAssertNotEqual(own.processIdentifier, foreign.processIdentifier)
        XCTAssertEqual(URL(fileURLWithPath: try XCTUnwrap(ownInfo["appPath"] as? String)).resolvingSymlinksInPath(), ownApp.resolvingSymlinksInPath())
        XCTAssertEqual(ownInfo["revision"] as? String, Bundle(url: ownApp)?.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String)
        XCTAssertTrue(foreign.isRunning, "Launching the embedded monitor must not terminate another copy's monitor.")
        focus.assertBackground([foreign.processIdentifier, own.processIdentifier])
        try await requestShutdown(["quitCompletely": true], name: "com.perpetualradar.monitor.\(getuid()).\(channel)")
        try await requestShutdown(["quitCompletely": true], name: "com.perpetualradar.monitor.\(getuid()).\(foreignChannel)")
        let deadline = ContinuousClock.now + .seconds(3)
        while (foreign.isRunning || !own.isTerminated), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertFalse(foreign.isRunning); XCTAssertTrue(own.isTerminated)
    }

    @MainActor
    func testPackagedDatabaseStartupFailuresRecoverInPlaceAndRetainSettings() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["RADAR_SERVICE_TESTS"] == "1", "Run after packaging; the application stays hidden.")
        let builtApp = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".build/app/Perpetual Swap Suite.app")
        let channel = UUID().uuidString, name = "com.perpetualradar.monitor.\(getuid()).\(channel)", suite = "RadarServiceTests.\(channel)"
        let directory = serviceTestDirectory(channel), defaults = UserDefaults(suiteName: suite)!
        let radarURL = directory.appendingPathComponent("radar.sqlite3"), researchDirectory = directory.appendingPathComponent("Research")
        let researchURL = researchDirectory.appendingPathComponent("research.sqlite3")
        let config = try FilterCompiler.compile(source: "Close > 105").config.json
        let focus = BackgroundTestAudit(); defer { focus.stop() }
        let process = Process(); var helperPID: Int32?
        defer {
            if process.isRunning { process.terminate() }
            if let helperPID { kill(helperPID, SIGTERM) }
            defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory)
        }
        let app = try backgroundTestApp(from: builtApp, in: directory)
        defaults.set(false, forKey: "BackgroundMonitoring"); defaults.set(false, forKey: "AutomaticallyInstallUpdates")
        do {
            let radar = try Radar(defaults: defaults, storeURL: radarURL)
            let store = try Store(url: radarURL), off = try FilterCompiler.compile(source: "1 > 2").config.json
            let profile = try store.saveSuiteProfile(.init(name: "Recovery strategy", universeJSON: config, phaseRules: Dictionary(uniqueKeysWithValues: SuitePhase.allCases.map { ($0.rawValue, off) })))
            _ = try store.manageSuite(["action": "select", "profileID": profile.id], mode: "radar")
            XCTAssertTrue(try radar.setFrostedBackground(enabled: true, opacity: 0.55))
            let research = try ResearchStore(directory: researchDirectory)
            try research.put("sentinel", kind: "test", ["value": "preserved"])
        }
        // A path temporarily occupied by a directory fails immediately without
        // altering the saved SQLite files. Restore the same files after startup.
        for url in [radarURL, researchURL] {
            try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("parked"))
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
        process.executableURL = app.appendingPathComponent("Contents/MacOS/PerpetualRadar")
        var environment = ProcessInfo.processInfo.environment
        environment["PERPETUAL_RADAR_TEST_CHANNEL"] = channel; environment["PERPETUAL_RADAR_TEST_DIRECTORY"] = directory.path
        environment["PERPETUAL_RADAR_BACKGROUND"] = "1"
        environment["PERPETUAL_RADAR_READY_FILE"] = directory.appendingPathComponent("ui-ready").path
        process.environment = environment; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); focus.track(process.processIdentifier)
        func request(_ body: [String: Any], interface: Bool = false) async throws -> [String: Any] {
            try await MonitorIPC.request(body, name: name + (interface ? ".interface-tests" : ""), timeout: .seconds(15))
        }
        func wait(_ condition: () async throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(30)
            while ContinuousClock.now < deadline {
                if (try? await condition()) == true { return }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw FilterError("Startup recovery did not complete.")
        }
        try await wait { (try await request(["serviceInfo": true]))["pid"] != nil }
        let failed = try await request(["serviceInfo": true]); helperPID = try XCTUnwrap(failed["pid"] as? Int32)
        XCTAssertEqual(failed["databaseReady"] as? Bool, false)
        XCTAssertTrue((failed["backgroundMonitoringError"] as? String)?.contains("Automatically retrying") == true)
        do { _ = try await request(["research": ["action": "inventory"]], interface: true); XCTFail("The research cache is temporarily unavailable.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Cannot open research cache")) }
        for url in [radarURL, researchURL] {
            try FileManager.default.removeItem(at: url)
            try FileManager.default.moveItem(at: url.appendingPathExtension("parked"), to: url)
        }
        try await wait { ((try await request(["suite": ["mode": "radar", "action": "inventory"]], interface: true))["profiles"] as? [[String: Any]])?.first?["universeJSON"] as? String == config }
        try await wait { (try await request(["research": ["action": "inventory"]], interface: true))["studies"] != nil }
        let restored = try await request(["monitor": [:]], interface: true)
        XCTAssertEqual(restored["frostedBackgroundOpacity"] as? Double, 0.55)
        XCTAssertEqual(restored["backgroundMonitoringError"] as? String, "")
        let recoveredInfo = try await request(["serviceInfo": true])
        XCTAssertEqual(recoveredInfo["pid"] as? Int32, helperPID, "Database recovery must reuse the same monitor.")
        XCTAssertEqual(try ResearchStore(directory: researchDirectory).get("sentinel", as: [String: String].self)?["value"], "preserved")
        XCTAssertTrue(process.isRunning)
        focus.assertBackground([process.processIdentifier, helperPID!])
        _ = try await request(["quitCompletely": true])
        try await wait { !process.isRunning && !MonitorIPC.endpointExists(name) }
        helperPID = nil
    }

    @MainActor
    func testIPCAllowsConcurrentHistoryRequestsAndCancelsAbandonedWork() async throws {
        let name = "com.perpetualradar.tests.\(UUID())"
        var cancelled = false
        let server = try MonitorIPCServer(name: name) { data in
            let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            if body["slow"] as? Bool == true {
                do { try await Task.sleep(for: .seconds(10)) }
                catch { cancelled = true }
            }
            return try! JSONSerialization.data(withJSONObject: ["value": ["ok": true]])
        }
        defer { server.invalidate() }
        let slow = Task { _ = try await MonitorIPC.request(["slow": true], name: name) }
        try await Task.sleep(for: .milliseconds(100))
        let start = ContinuousClock.now
        let reply = try await MonitorIPC.request(["fast": true], name: name)
        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertLessThan(start.duration(to: .now), .seconds(2), "A history load must not block snapshots or preferences.")
        slow.cancel(); _ = try? await slow.value
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(cancelled)
        XCTAssertThrowsError(try MonitorIPCServer(name: name) { _ in Data() })
    }

    @MainActor
    func testPackagedOnDemandResearchHiddenWindowCloseQuitCrashAndManualResume() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["RADAR_SERVICE_TESTS"] == "1", "Package the app and set RADAR_SERVICE_TESTS=1.")
        let builtApp = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".build/app/Perpetual Swap Suite.app")
        let channel = UUID().uuidString, name = "com.perpetualradar.monitor.\(getuid()).\(channel)", suite = "RadarServiceTests.\(channel)"
        let directory = serviceTestDirectory(channel), defaults = UserDefaults(suiteName: suite)!
        let focus = BackgroundTestAudit(); defer { focus.stop() }
        let store = try ResearchStore(directory: directory.appendingPathComponent("Research"))
        try ResearchFixture.seed(store, bars: ResearchFixture.bars(through: ResearchFixture.hour+3048*hourMS))
        let spec = try ResearchFixture.spec(through: ResearchFixture.hour+3000*hourMS), plan = ResearchFixture.plan(spec)
        try store.put(plan.id, kind: "plan", plan)
        defaults.set(false, forKey: "BackgroundMonitoring"); defaults.set(false, forKey: "AutomaticallyInstallUpdates")
        var processes: [Process] = [], helperPID: Int32?, helperPIDs: [Int32] = []
        defer {
            processes.filter(\.isRunning).forEach { $0.terminate() }
            if let helperPID { kill(helperPID, SIGTERM) }
            defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory)
        }
        let app = try backgroundTestApp(from: builtApp, in: directory)
        func launch() throws -> Process {
            let process = Process(); process.executableURL = app.appendingPathComponent("Contents/MacOS/PerpetualRadar")
            var environment = ProcessInfo.processInfo.environment
            environment["PERPETUAL_RADAR_TEST_CHANNEL"] = channel; environment["PERPETUAL_RADAR_TEST_DIRECTORY"] = directory.path
            environment.removeValue(forKey: "PERPETUAL_RADAR_BACKGROUND"); process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            let log = directory.appendingPathComponent("process-\(processes.count).log")
            FileManager.default.createFile(atPath: log.path, contents: Data()); process.standardError = try FileHandle(forWritingTo: log)
            try process.run(); focus.track(process.processIdentifier); processes.append(process); return process
        }
        func request(_ body: [String: Any], interface: Bool = false) async throws -> [String: Any] {
            try await MonitorIPC.request(body, name: name + (interface ? ".interface-tests" : ""))
        }
        func wait(_ label: String, _ condition: () async throws -> Bool) async throws {
            for _ in 0..<240 { if (try? await condition()) == true { return }; try await Task.sleep(for: .milliseconds(50)) }
            throw FilterError("On-demand lifecycle timed out at \(label); processes: \(processes.map { "\($0.processIdentifier):\($0.isRunning)" }), helper: \(String(describing: helperPID)), checkpoint: \(String(describing: try? store.objects("checkpoint", as: Checkpoint.self)))")
        }
        let ui = try launch()
        try await wait("startup") { (try await request(["serviceInfo": true]))["samples"] as? Int ?? 0 >= 2 }
        let info = try await request(["serviceInfo": true]); helperPID = try XCTUnwrap(info["pid"] as? Int32)
        helperPIDs.append(helperPID!)
        XCTAssertEqual(info["backgroundMonitoringEnabled"] as? Bool, false)
        let phaseProfile=StrategyProfile(name:"Packaged suite",universeJSON:FilterConfigV2().json,phaseRules:["bullishSetup":try FilterCompiler.compile(source:"Close > 105").config.json])
        let rawProfile=try JSONSerialization.jsonObject(with:Data(researchJSON(phaseProfile).utf8))
        let applyStart = ContinuousClock.now
        let savedSuite=try await request(["suite":["mode":"radar","action":"save","profile":rawProfile]])
        print("Packaged Strategy persistence acknowledgment: \(applyStart.duration(to: .now))")
        XCTAssertNil(savedSuite["rows"], "Saving a strategy must not rebuild the market snapshot.")
        XCTAssertNil(savedSuite["filterMetricsCatalog"], "Saving must not retransmit the editor catalog.")
        XCTAssertEqual(try Store(url: directory.appendingPathComponent("radar.sqlite3")).suiteProfiles("radar").first?.universeJSON, phaseProfile.universeJSON)
        XCTAssertNotNil(savedSuite["saved"])
        let copiedSuite=try await request(["suite":["mode":"research","action":"copy","profile":rawProfile]],interface:true)
        XCTAssertEqual((copiedSuite["profiles"] as? [[String:Any]])?.count,2)
        XCTAssertNotEqual((copiedSuite["saved"] as? [String:Any])?["id"] as? String,phaseProfile.id)
        let researchWindow = try await request(["workspace": "research"], interface: true)
        XCTAssertEqual(researchWindow["windowTitle"] as? String,"Perpetual Swap Research")
        let radarWindow = try await request(["workspace":"radar"],interface:true)
        XCTAssertEqual(radarWindow["windowTitle"] as? String,"Perpetual Swap Radar")
        _ = try await request(["workspace":"research"],interface:true)
        let samples = (try await request(["serviceInfo": true]))["samples"] as! Int
        try await Task.sleep(for: .milliseconds(350))
        let researchInfo = try await request(["serviceInfo": true])
        XCTAssertGreaterThan(researchInfo["samples"] as? Int ?? 0, samples, "Radar must continue sampling while Research is open.")
        _ = try await request(["research": ["action": "prepare", "planID": plan.id]], interface: true)
        try await wait("ready") { ((try await request(["research": ["action": "inventory"]], interface: true))["job"] as? [String: Any])?["phase"] as? String == "ready" }
        let inventory = try await request(["research": ["action": "inventory"]], interface: true)
        let studyID = try XCTUnwrap((inventory["job"] as? [String: Any])?["resultID"] as? String)
        _ = try await request(["research": ["action": "run", "studyID": studyID]], interface: true)
        _ = try await request(["showWindow": true], interface: true)
        _ = try await request(["hideWindow": true], interface: true)
        try await wait("hidden") { (try await request([:], interface: true))["windowHidden"] as? Bool == true }
        try await wait("checkpoint") { (try store.get("checkpoint:\(studyID)", as: Checkpoint.self))?.nextHour != nil }
        try await requestShutdown(["close": true], name: name + ".interface-tests")
        let oldHelper = helperPID!
        try await wait("closed") { !ui.isRunning && !MonitorIPC.endpointExists(name) && kill(oldHelper,0) != 0 }
        XCTAssertEqual(ui.terminationStatus, 0)
        XCTAssertFalse(defaults.bool(forKey: AppUpdater.backgroundRelaunchKey))
        XCTAssertEqual(try store.get("checkpoint:\(studyID)", as: Checkpoint.self)?.phase, "paused")
        let checkpoint = try researchJSON(store.get("checkpoint:\(studyID)", as: Checkpoint.self))
        helperPID = nil
        let reopened = try launch()
        try await wait("reopened") { (try await request(["serviceInfo": true]))["pid"] != nil }
        let reopenedInfo = try await request(["serviceInfo": true]); helperPID = try XCTUnwrap(reopenedInfo["pid"] as? Int32)
        helperPIDs.append(helperPID!)
        let restoredSuite = try await request(["suite": ["mode": "radar", "action": "inventory"]])
        XCTAssertEqual((restoredSuite["profiles"] as? [[String: Any]])?.count, 2)
        XCTAssertEqual((restoredSuite["profiles"] as? [[String: Any]])?.first?["phaseRules"] as? [String: String], phaseProfile.phaseRules)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(try researchJSON(store.get("checkpoint:\(studyID)", as: Checkpoint.self)), checkpoint, "Reopening must not resume research automatically.")
        _ = try await request(["workspace": "research", "research": ["action": "resume", "studyID": studyID]], interface: true)
        try await Task.sleep(for: .milliseconds(150))
        try await requestShutdown(["testQuitUI": true], name: name)
        let quitHelper = helperPID!
        try await wait("quit") { !reopened.isRunning && kill(quitHelper,0) != 0 }
        XCTAssertEqual(try store.get("checkpoint:\(studyID)", as: Checkpoint.self)?.phase, "paused")
        helperPID = nil
        let crashing = try launch()
        try await wait("crash-startup") { (try await request(["serviceInfo": true]))["pid"] != nil }
        let crashingInfo = try await request(["serviceInfo": true]); helperPID = try XCTUnwrap(crashingInfo["pid"] as? Int32)
        helperPIDs.append(helperPID!)
        let orphan = helperPID!
        kill(crashing.processIdentifier, SIGKILL)
        try await wait("crash-exit") { !crashing.isRunning && kill(orphan,0) != 0 && !MonitorIPC.endpointExists(name) }
        helperPID = nil
        focus.assertBackground(processes.map(\.processIdentifier) + helperPIDs)
    }

    @MainActor
    func testPackagedMonitorLifecycleAndInterfacePreferencesDomain() async throws {
        try await checkPackagedMonitorLifecycle()
    }

    @MainActor
    private func checkPackagedMonitorLifecycle() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["RADAR_SERVICE_TESTS"] == "1", "Run after packaging with RADAR_SERVICE_TESTS=1; every process remains in the background.")
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let builtApp = root.appendingPathComponent(".build/app/Perpetual Swap Suite.app")
        let channel = UUID().uuidString, name = "com.perpetualradar.monitor.\(getuid()).\(channel)"
        let directory = serviceTestDirectory(channel)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let suite = "RadarServiceTests.\(channel)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let focus = BackgroundTestAudit(); defer { focus.stop() }
        var processes: [Process] = []
        var monitorPID: Int32?
        defer {
            processes.filter(\.isRunning).forEach { $0.terminate() }
            if let monitorPID { kill(monitorPID, SIGTERM) }
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        // Also exercise the production preference-domain relationship in an
        // isolated bundle, with background metadata set before process launch.
        let app = try backgroundTestApp(from: builtApp, in: directory, bundleIdentifier: suite)
        defaults.set(true, forKey: "BackgroundMonitoring")
        defaults.set(false, forKey: "AutomaticallyInstallUpdates")
        defaults.set(false, forKey: AppUpdater.backgroundRelaunchKey)
        func launch(helper: Bool) throws -> Process {
            let process = Process()
            let bundle = helper ? app.appendingPathComponent("Contents/Library/LoginItems/Perpetual Swap Suite Monitor.app") : app
            process.executableURL = bundle.appendingPathComponent("Contents/MacOS/PerpetualRadar")
            var environment = ProcessInfo.processInfo.environment
            environment["PERPETUAL_RADAR_TEST_CHANNEL"] = channel
            environment["PERPETUAL_RADAR_TEST_DIRECTORY"] = directory.path
            environment["PERPETUAL_RADAR_BACKGROUND"] = "1"
            environment["PERPETUAL_RADAR_READY_FILE"] = directory.appendingPathComponent(helper ? "helper-ready" : "ui-ready").path
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            let log = directory.appendingPathComponent("\(processes.count).log")
            FileManager.default.createFile(atPath: log.path, contents: Data())
            process.standardError = try FileHandle(forWritingTo: log)
            try process.run(); focus.track(process.processIdentifier); processes.append(process); return process
        }
        func request(_ body: [String: Any], line: UInt = #line) async throws -> [String: Any] {
            do { return try await MonitorIPC.request(body, name: name) }
            catch { throw FilterError("Background lifecycle request at line \(line) (\(body.keys.sorted().joined(separator: ", "))): \(error)") }
        }
        func wait(_ label: String, _ condition: () async throws -> Bool) async throws {
            for _ in 0..<200 { if (try? await condition()) == true { return }; try await Task.sleep(for: .milliseconds(50)) }
            let logs = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "log" }.map { (try? String(contentsOf: $0, encoding: .utf8)) ?? "" }.joined(separator: "\n")
            XCTFail("Background lifecycle timed out at \(label); processes: \(processes.map { "\($0.processIdentifier):\($0.isRunning)" }); \(logs)")
            throw FilterError("Lifecycle timeout")
        }
        let ui = try launch(helper: false)
        try await wait("startup") {
            guard FileManager.default.fileExists(atPath: directory.appendingPathComponent("ui-ready").path) else { return false }
            return (try await request(["serviceInfo": true]))["samples"] as? Int ?? 0 >= 2
        }
        var info = try await request(["serviceInfo": true])
        let helperPID = try XCTUnwrap(info["pid"] as? Int32)
        monitorPID = helperPID
        XCTAssertNotEqual(helperPID, ui.processIdentifier)
        XCTAssertNotNil(NSImage(systemSymbolName: MonitorDelegate.symbolName, accessibilityDescription: nil))
        XCTAssertEqual(info["menuSymbol"] as? String, "dot.radiowaves.left.and.right")
        let reportedApp = URL(fileURLWithPath: try XCTUnwrap(info["appPath"] as? String))
        XCTAssertEqual(reportedApp.resolvingSymlinksInPath(), app.resolvingSymlinksInPath())
        XCTAssertEqual(info["automaticUpdatesEnabled"] as? Bool, false, "The helper must read the interface's existing preferences.")
        let config = try FilterCompiler.compile(source: "Close > 105").config.json
        let profile = StrategyProfile(name: "Background strategy", universeJSON: FilterConfigV2().json, phaseRules: ["bullishSetup": config])
        _ = try await request(["suite": ["mode": "radar", "action": "save", "profile": try JSONSerialization.jsonObject(with: Data(researchJSON(profile).utf8))]])
        _ = try await request(["suite": ["mode": "radar", "action": "select", "profileID": profile.id]])
        let saved = try await request(["frostedBackgroundOpacity": 0.55, "windowBlurRadius": 112, "floatingBlurRadius": 96])
        XCTAssertNil(saved["filterConfigJSON"])
        XCTAssertEqual(saved["frostedBackgroundOpacity"] as? Double, 0.55)
        XCTAssertEqual(saved["windowBlurRadius"] as? Double, 112)
        XCTAssertEqual(saved["floatingBlurRadius"] as? Double, 96)
        let baseline = (try await request(["serviceInfo": true]))["samples"] as! Int
        try await wait("rule-samples") { (try await request(["serviceInfo": true]))["samples"] as? Int ?? 0 >= baseline + 2 }
        _ = try await request(["testQuitUI": true])
        try await wait("ui-quit") { !ui.isRunning }
        XCTAssertEqual(ui.terminationStatus, 0)
        XCTAssertTrue(defaults.bool(forKey: AppUpdater.backgroundRelaunchKey), "Interface writes must use the shared preference domain.")
        _ = try await request(["testPrice": 110.0])
        try await wait("notification-enter") { ((try await request(["serviceInfo": true]))["delivered"] as? [[String: String]])?.count == 1 }
        _ = try await request(["testPrice": 100.0])
        try await wait("notification-exit") { ((try await request(["serviceInfo": true]))["delivered"] as? [[String: String]])?.count == 2 }
        info = try await request(["serviceInfo": true])
        let delivered = try XCTUnwrap(info["delivered"] as? [[String: String]])
        XCTAssertEqual(delivered.map { $0["direction"]! }, ["entered", "exited"])
        XCTAssertEqual(delivered.map { $0["instId"]! }, ["BTC-USDT-SWAP", "BTC-USDT-SWAP"])
        try FileManager.default.removeItem(at: directory.appendingPathComponent("ui-ready"))
        let reopened = try launch(helper: false)
        try await wait("reopen") { FileManager.default.fileExists(atPath: directory.appendingPathComponent("ui-ready").path) }
        XCTAssertNotEqual(reopened.processIdentifier, ui.processIdentifier)
        info = try await request(["serviceInfo": true])
        XCTAssertEqual(info["pid"] as? Int32, helperPID, "Reopening must reuse the existing collector.")
        let restored = try await request([:])
        XCTAssertEqual(try Store(url: directory.appendingPathComponent("radar.sqlite3")).selectedSuiteProfile("radar")?.phaseRules["bullishSetup"], config)
        XCTAssertEqual(restored["frostedBackgroundOpacity"] as? Double, 0.55)
        XCTAssertEqual(restored["windowBlurRadius"] as? Double, 112)
        XCTAssertEqual(restored["floatingBlurRadius"] as? Double, 96)
        _ = try await request(["monitoringPaused": true])
        let pausedSamples = (try await request(["serviceInfo": true]))["samples"] as! Int
        _ = try await request(["testPrice": 110.0]); try await Task.sleep(for: .milliseconds(350))
        info = try await request(["serviceInfo": true])
        XCTAssertTrue(info["monitoringPaused"] as? Bool == true)
        XCTAssertEqual(info["samples"] as? Int, pausedSamples)
        _ = try await request(["monitoringPaused": false])
        try await wait("unpause") { (try await request(["serviceInfo": true]))["samples"] as? Int ?? 0 > pausedSamples + 1 }
        info = try await request(["serviceInfo": true])
        XCTAssertEqual((info["delivered"] as? [[String: String]])?.count, 2, "Resuming establishes a quiet baseline.")
        let duplicate = try launch(helper: true)
        try await wait("duplicate-helper") { !duplicate.isRunning }
        info = try await request(["serviceInfo": true])
        XCTAssertEqual(info["pid"] as? Int32, helperPID)
        _ = try await request(["monitoringPaused": true])
        kill(helperPID, SIGKILL)
        try await wait("helper-restart") {
            let candidate = try await request(["serviceInfo": true])
            guard let pid = candidate["pid"] as? Int32, pid != helperPID else { return false }
            monitorPID = pid; return true
        }
        info = try await request(["serviceInfo": true])
        XCTAssertTrue(info["monitoringPaused"] as? Bool == true, "A restarted helper must preserve the pause setting.")
        XCTAssertEqual(info["samples"] as? Int, 0)
        let afterRestart = try await request([:])
        XCTAssertEqual(try Store(url: directory.appendingPathComponent("radar.sqlite3")).selectedSuiteProfile("radar")?.phaseRules["bullishSetup"], config)
        XCTAssertEqual(afterRestart["frostedBackgroundOpacity"] as? Double, 0.55)
        XCTAssertEqual(afterRestart["windowBlurRadius"] as? Double, 112)
        XCTAssertEqual(afterRestart["floatingBlurRadius"] as? Double, 96)
        let stalledPID = monitorPID!
        defer { if monitorPID == stalledPID { kill(stalledPID, SIGCONT) } }
        XCTAssertEqual(kill(stalledPID, SIGSTOP), 0)
        // Drive recovery through the actual interface client. Its heartbeat and
        // UI requests must share one replacement even when the helper is hung.
        var recoveredPID: Int32?
        for _ in 0..<10 {
            if let recovered = try? await MonitorIPC.request(["monitor": ["serviceInfo": true]], name: name + ".interface-tests"),
               let pid = recovered["pid"] as? Int32, pid != stalledPID {
                recoveredPID = pid; break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        monitorPID = try XCTUnwrap(recoveredPID, "A stalled helper must recover while the same interface remains open.")
        XCTAssertTrue(reopened.isRunning)
        let afterHang = try await request([:])
        XCTAssertEqual(try Store(url: directory.appendingPathComponent("radar.sqlite3")).selectedSuiteProfile("radar")?.phaseRules["bullishSetup"], config)
        XCTAssertEqual(afterHang["frostedBackgroundOpacity"] as? Double, 0.55)
        XCTAssertEqual(afterHang["windowBlurRadius"] as? Double, 112)
        XCTAssertEqual(afterHang["floatingBlurRadius"] as? Double, 96)
        XCTAssertEqual(afterHang["monitoringPaused"] as? Bool, true)
        let quittingPID = monitorPID!
        _ = try await request(["quitCompletely": true])
        try await wait("quit-completely") { !reopened.isRunning && !MonitorIPC.endpointExists(name) && kill(quittingPID, 0) != 0 }
        XCTAssertEqual(reopened.terminationStatus, 0)
        XCTAssertNotEqual(kill(quittingPID, 0), 0, "Quit Completely must terminate the helper too.")
        focus.assertBackground(processes.map(\.processIdentifier) + [helperPID, stalledPID, quittingPID])
        monitorPID = nil
    }

    @MainActor
    func testPausePreferencePersistsAndNotificationRoutesValidateContracts() throws {
        let suite = "PauseTests.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite), url = directory.appendingPathComponent("radar.sqlite3")
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let radar = try Radar(defaults: defaults, storeURL: url)
        XCTAssertFalse(radar.monitoringPaused); try radar.setMonitoringPaused(true)
        XCTAssertTrue(try Radar(defaults: defaults, storeURL: url).monitoringPaused)
        XCTAssertEqual(RadarNotificationRoute.contract(in: URL(string: "perpetualradar://contract/BTC-USDT-SWAP")!), "BTC-USDT-SWAP")
        XCTAssertEqual(RadarNotificationRoute.strategy(in: try XCTUnwrap(RadarNotificationRoute.url(strategy: "suite-1"))), "suite-1")
        XCTAssertEqual(RadarNotificationRoute.contract(in: try XCTUnwrap(RadarNotificationRoute.url(contract: "BTC-USDT-SWAP"))), "BTC-USDT-SWAP")
        XCTAssertNil(RadarNotificationRoute.contract(in: URL(string: "perpetualradar://contract/BTC-USDT-SWAP/extra")!))
        XCTAssertNil(RadarNotificationRoute.contract(in: URL(string: "https://contract/BTC-USDT-SWAP")!))
        XCTAssertNil(RadarNotificationRoute.contract(in: URL(string: "perpetualradar://contract/../../../etc/passwd")!))
    }
}
