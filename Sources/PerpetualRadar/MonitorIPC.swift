import AppKit
import CoreFoundation

enum MonitorRuntime {
    static let helperIdentifier = "com.perpetualradar.macos.monitor"
    static let helperName = "Perpetual Swap Suite Monitor.app"
    static let isHelper = Bundle.main.bundleIdentifier == helperIdentifier || ProcessInfo.processInfo.environment["PERPETUAL_RADAR_ROLE"] == "monitor"
    static let testChannel = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_TEST_CHANNEL"]
    static let portName = "com.perpetualradar.monitor.\(getuid())\(testChannel.map { ".\($0)" } ?? "")"
    static let quitUI = Notification.Name(portName + ".quit-ui")
    static var updateSuppressionURL: URL {
        let directory = storeURL?.deletingLastPathComponent() ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PerpetualRadar")
        return directory.appendingPathComponent("suppress-update-relaunch")
    }
    static var backgroundMonitoringEnabled: Bool { defaults.bool(forKey: "BackgroundMonitoring") }
    static var defaults: UserDefaults {
        let suite = testChannel.map { "RadarServiceTests.\($0)" } ?? "com.perpetualradar.macos"
        // Foundation rejects an explicit suite matching the running app's bundle ID.
        // The interface already uses this domain; the helper opens it as a shared suite.
        if suite == Bundle.main.bundleIdentifier { return .standard }
        return UserDefaults(suiteName: suite)!
    }
    static var appURL: URL {
        if Bundle.main.bundleIdentifier == helperIdentifier {
            return Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        }
        return Bundle.main.bundleURL
    }
    static var helperURL: URL { appURL.appendingPathComponent("Contents/Library/LoginItems/\(helperName)") }
    static var storeURL: URL? {
        guard testChannel != nil, let directory = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_TEST_DIRECTORY"] else { return nil }
        return URL(fileURLWithPath: directory).appendingPathComponent("radar.sqlite3")
    }
    static func markReady() {
        for (key, data) in [("PERPETUAL_RADAR_PID_FILE", Data(String(ProcessInfo.processInfo.processIdentifier).utf8)), ("PERPETUAL_RADAR_READY_FILE", Data())] {
            if let path = ProcessInfo.processInfo.environment[key], !path.isEmpty {
                FileManager.default.createFile(atPath: path, contents: data)
            }
        }
    }
}

// A named Mach message port is independent of both app lifetimes. Submit/poll
// messages return immediately: chart/history awaits never block another client
// or the AppKit run loop. Requests and completed replies exist only in memory.
final class MonitorIPCServer: @unchecked Sendable {
    typealias Handler = @MainActor @Sendable (Data) async -> Data
    private final class Context {
        weak var server: MonitorIPCServer?
        init(_ server: MonitorIPCServer) { self.server = server }
    }
    private struct Job {
        var task: Task<Void, Never>?
        var reply: Data?
        let expires = ContinuousClock.now + .seconds(120)
    }
    private let handler: Handler
    private let lock = NSLock()
    private var jobs: [String: Job] = [:]
    private var port: CFMessagePort?
    private var expiryTimer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "com.perpetualradar.monitor.ipc")

    init(name: String = MonitorRuntime.portName, handler: @escaping Handler) throws {
        self.handler = handler
        let info = Unmanaged.passRetained(Context(self))
        defer { info.release() }
        var context = CFMessagePortContext(version: 0, info: info.toOpaque(), retain: {
            guard let pointer = $0 else { return nil }
            _ = Unmanaged<Context>.fromOpaque(pointer).retain(); return UnsafeRawPointer(pointer)
        }, release: { pointer in
            if let pointer { Unmanaged<Context>.fromOpaque(pointer).release() }
        }, copyDescription: nil)
        var unused = DarwinBoolean(false)
        guard let local = CFMessagePortCreateLocal(nil, name as CFString, { _, message, data, info in
            guard let info, let data else { return nil }
            guard let server = Unmanaged<Context>.fromOpaque(info).takeUnretainedValue().server else { return nil }
            return Unmanaged.passRetained(server.receive(message, data: data as Data) as CFData)
        }, &context, &unused), !unused.boolValue else { throw FilterError("Background monitoring is already running.") }
        port = local
        CFMessagePortSetDispatchQueue(local, queue)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.expireJobs() }
        timer.resume(); expiryTimer = timer
    }

    deinit { invalidate() }
    func invalidate() {
        expiryTimer?.cancel(); expiryTimer = nil
        if let port { CFMessagePortInvalidate(port) }
        port = nil
        lock.lock(); let tasks = jobs.values.compactMap(\.task); jobs.removeAll(); lock.unlock()
        tasks.forEach { $0.cancel() }
    }

    private func expireJobs() {
        lock.lock(); defer { lock.unlock() }
        let expired = jobs.filter { $0.value.expires < .now }.map(\.key)
        for key in expired { jobs.removeValue(forKey: key)?.task?.cancel() }
    }

    private func receive(_ message: Int32, data: Data) -> Data {
        if message == 1 {
            guard let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = request["id"] as? String, let body = request["body"],
                  let payload = try? SafeJSON.data(body) else { return Data("{}".utf8) }
            lock.lock()
            let expired = jobs.filter { $0.value.expires < .now }.map(\.key)
            for key in expired { jobs.removeValue(forKey: key)?.task?.cancel() }
            if jobs[id] == nil {
                jobs[id] = Job()
                jobs[id]?.task = Task { @MainActor [weak self, handler] in
                    let reply = await handler(payload)
                    self?.complete(id, reply: reply)
                }
            }
            lock.unlock()
            return Data("{\"accepted\":true}".utf8)
        }
        let id = String(decoding: data, as: UTF8.self)
        lock.lock(); defer { lock.unlock() }
        if message == 3 { jobs.removeValue(forKey: id)?.task?.cancel(); return Data("{}".utf8) }
        if message == 4 {
            if jobs[id]?.reply != nil { jobs.removeValue(forKey: id) }
            return Data("{}".utf8)
        }
        guard let job = jobs[id] else { return Data("{\"ipcError\":\"expired\"}".utf8) }
        // Keep the result until receipt is acknowledged. A lost poll reply or a
        // repeated submission must never run a mutation twice in this session.
        if let reply = job.reply { return reply }
        return Data("{\"pending\":true}".utf8)
    }

    private func complete(_ id: String, reply: Data) {
        lock.lock(); defer { lock.unlock() }
        jobs[id]?.reply = reply
        jobs[id]?.task = nil
    }
}

struct MonitorIPCFailure: Error, LocalizedError {
    enum Reason { case unavailable, transport(Int32), expired, timeout, invalidResponse }
    let reason: Reason
    var requestMayHaveRun = false
    var isConnectionFailure: Bool {
        switch reason { case .unavailable, .transport: true; default: false }
    }
    var errorDescription: String? {
        switch reason {
        case .unavailable: "Monitor is reconnecting. Automatically retrying."
        case .transport(let status): "Monitor connection was interrupted (\(status)). Automatically reconnecting."
        case .expired: "The monitor request expired. Try this action again."
        case .timeout: "The monitor request took too long. Live data will retry automatically."
        case .invalidResponse: "The monitor returned an invalid response."
        }
    }
}

enum MonitorIPC {
    // CoreFoundation reuses remote ports. Serialize individual send/poll calls
    // so concurrent clients cannot race the port's reply bookkeeping; submitted
    // asynchronous jobs still run concurrently in the monitor.
    private static let sendLock = NSLock()
    static func send(_ data: Data, message: Int32, name: String = MonitorRuntime.portName) throws -> Data {
        sendLock.lock(); defer { sendLock.unlock() }
        guard let port = CFMessagePortCreateRemote(nil, name as CFString) else { throw MonitorIPCFailure(reason: .unavailable) }
        var reply: Unmanaged<CFData>?
        let result = CFMessagePortSendRequest(port, message, data as CFData, 2, 2, CFRunLoopMode.defaultMode.rawValue, &reply)
        guard result == kCFMessagePortSuccess, let reply else {
            reply?.release()
            CFMessagePortInvalidate(port)
            throw MonitorIPCFailure(reason: .transport(result))
        }
        return reply.takeRetainedValue() as Data
    }

    @MainActor
    static func request(_ body: [String: Any], name: String = MonitorRuntime.portName,
                        id: String = UUID().uuidString, timeout: Duration = .seconds(100)) async throws -> [String: Any] {
        let key = Data(id.utf8)
        let data = try SafeJSON.data(["id": id, "body": body])
        var submitted = false
        do {
            try Task.checkCancellation()
            let deadline = ContinuousClock.now + timeout
            _ = try await Task.detached { try send(data, message: 1, name: name) }.value
            submitted = true
            while ContinuousClock.now < deadline {
                try Task.checkCancellation()
                let data = try await Task.detached { try send(key, message: 2, name: name) }.value
                guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MonitorIPCFailure(reason: .invalidResponse) }
                if response["ipcError"] as? String == "expired" { throw MonitorIPCFailure(reason: .expired) }
                if response["error"] is String || response["value"] is [String: Any] {
                    try Task.checkCancellation()
                    _ = try? await Task.detached { try send(key, message: 4, name: name) }.value
                    if let error = response["error"] as? String { throw FilterError(error) }
                    return response["value"] as! [String: Any]
                }
                guard response["pending"] as? Bool == true else { throw MonitorIPCFailure(reason: .invalidResponse) }
                try await Task.sleep(for: .milliseconds(30))
            }
            throw MonitorIPCFailure(reason: .timeout)
        } catch {
            if var failure = error as? MonitorIPCFailure, failure.isConnectionFailure, !Task.isCancelled {
                // An unavailable endpoint before submission is known not to
                // have executed; send timeouts can occur after acceptance.
                failure.requestMayHaveRun = submitted || {
                    if case .transport = failure.reason { return true }; return false
                }()
                throw failure
            }
            _ = try? await Task.detached { try send(key, message: 3, name: name) }.value
            try Task.checkCancellation()
            throw error
        }
    }
}

@MainActor
final class MonitorClient {
    private struct Connection {
        let session: String
        let checkedAt = ContinuousClock.now
    }
    private let name: String
    private let appURL: URL
    private let revision: String
    private let launch: (@MainActor () async throws -> Void)?
    private var connection: Connection?
    private var launchTask: Task<Void, Error>?
    private var launchedProcess: Process?
    private var helperApplication: NSRunningApplication?
    private var failedHealthChecks = 0
    var workspace = "radar"
    var researchBusy = false
    private var shuttingDown = false
    private var lease: [String: Any] { ["pid": ProcessInfo.processInfo.processIdentifier, "workspace": workspace, "researchBusy": researchBusy] }

    init(name: String = MonitorRuntime.portName, appURL: URL = MonitorRuntime.appURL,
         revision: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String ?? "development",
         launch: (@MainActor () async throws -> Void)? = nil) {
        self.name = name; self.appURL = appURL; self.revision = revision; self.launch = launch
    }

    // Only reads may be repeated across a service restart. A write with an
    // uncertain outcome is retried with the same ID only in the same session.
    static func canReplayAfterRestart(_ body: [String: Any]) -> Bool {
        let reads: Set<String> = ["serviceInfo", "rocPeriod", "marocPeriod", "sinceRevision", "compileMarketFilters",
                                  "previewMarketFilters", "explainMarketFilters", "chartInstId", "chartEndHour", "loadChart"]
        if body.keys.allSatisfy({ reads.contains($0) }) { return true }
        if body.count == 1, let request = body["suite"] as? [String: Any] {
            return ["inventory", "evaluate"].contains(request["action"] as? String ?? "inventory")
        }
        return body.count == 1 && body["notificationAction"] as? String == "refresh"
    }

    func request(_ body: [String: Any]) async throws -> [String: Any] {
        guard !shuttingDown else { throw CancellationError() }
        try await ensureRunning()
        let id = UUID().uuidString
        for attempt in 0..<2 {
            let session = connection?.session
            var request = body; request["foregroundLease"] = lease
            do {
                let result = try await MonitorIPC.request(request, name: name, id: id)
                try Task.checkCancellation()
                if body["serviceInfo"] as? Bool == true {
                    if compatible(result), let session = result["serviceSession"] as? String {
                        connection = Connection(session: session)
                        failedHealthChecks = 0
                    } else { connection = nil }
                }
                return result
            } catch let failure as MonitorIPCFailure where failure.isConnectionFailure && attempt == 0 {
                try Task.checkCancellation()
                if connection?.session == session { connection = nil }
                try await ensureRunning()
                if failure.requestMayHaveRun, session != connection?.session, !Self.canReplayAfterRestart(body) {
                    throw FilterError("Monitor reconnected. This action may already have been saved; check its current state before trying again.")
                }
            }
        }
        throw MonitorIPCFailure(reason: .unavailable)
    }

    func shutdown() async {
        shuttingDown = true; launchTask?.cancel()
        _ = try? await launchTask?.value
        if endpointExists {
            _ = try? await MonitorIPC.request(["stopForReplacement": true], name: name, timeout: .seconds(3))
            for _ in 0..<60 {
                if !endpointExists { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
        await stopOwnedHelper()
        connection = nil
    }

    func ensureRunning() async throws {
        guard !shuttingDown else { throw CancellationError() }
        try Task.checkCancellation()
        if let launchTask { try await launchTask.value; try Task.checkCancellation(); return }
        if let connection, connection.checkedAt.duration(to: .now) < .seconds(10), endpointExists { return }
        let task = Task { try await connectOrLaunch() }
        launchTask = task
        defer { launchTask = nil }
        try await task.value
        try Task.checkCancellation()
    }

    private var endpointExists: Bool { CFMessagePortCreateRemote(nil, name as CFString) != nil }
    private var helperURL: URL { appURL.appendingPathComponent("Contents/Library/LoginItems/\(MonitorRuntime.helperName)") }
    private func compatible(_ info: [String: Any]) -> Bool {
        info["appPath"] as? String == appURL.path && info["revision"] as? String == revision
    }
    private func probe() async throws -> [String: Any] {
        try await MonitorIPC.request(["serviceInfo": true, "foregroundLease": lease], name: name, timeout: .seconds(8))
    }
    private func acceptConnection(_ info: [String: Any]) throws {
        guard compatible(info), let session = info["serviceSession"] as? String else {
            throw FilterError("Monitor is switching versions. Automatically reconnecting.")
        }
        connection = Connection(session: session); failedHealthChecks = 0
        if let pid = info["pid"] as? Int32, let application = NSRunningApplication(processIdentifier: pid),
           application.bundleURL?.standardizedFileURL == helperURL.standardizedFileURL {
            helperApplication = application
        }
    }

    private func stopOwnedHelper() async {
        // Only supervise a process launched by us or the exact embedded helper
        // validated by serviceInfo; never terminate unrelated app instances.
        let process = launchedProcess, application = helperApplication
        if process?.isRunning == true { process?.terminate() }
        if application?.isTerminated == false { application?.terminate() }
        let deadline = ContinuousClock.now + .seconds(3)
        while (process?.isRunning == true || application?.isTerminated == false), ContinuousClock.now < deadline {
            do { try await Task.sleep(for: .milliseconds(50)) } catch { break }
        }
        if process?.isRunning == true, let process { kill(process.processIdentifier, SIGKILL) }
        if application?.isTerminated == false { application?.forceTerminate() }
        launchedProcess = nil; helperApplication = nil
    }

    private func connectOrLaunch() async throws {
        // Reopening the interface must also recover a helper that was already
        // stalled before this client existed. Test channels have isolated owners.
        if helperApplication == nil, MonitorRuntime.testChannel == nil, launch == nil, appURL.pathExtension == "app" {
            helperApplication = NSRunningApplication.runningApplications(withBundleIdentifier: MonitorRuntime.helperIdentifier)
                .first { $0.bundleURL?.standardizedFileURL == helperURL.standardizedFileURL }
        }
        if endpointExists {
            let info: [String: Any]
            do { info = try await probe() }
            catch {
                try Task.checkCancellation()
                if endpointExists {
                    failedHealthChecks += 1
                    if failedHealthChecks < 2 || launchedProcess?.isRunning != true && helperApplication?.isTerminated != false {
                        throw error
                    }
                    await stopOwnedHelper()
                }
                connection = nil
                return try await launchAndConnect()
            }
            if compatible(info) { try acceptConnection(info); return }
            _ = try await MonitorIPC.request(["stopForReplacement": true], name: name, timeout: .seconds(5))
            for _ in 0..<100 {
                if !endpointExists { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            guard !endpointExists else { throw FilterError("Monitor is switching versions. Automatically reconnecting.") }
        }
        try await launchAndConnect()
    }

    private func launchAndConnect() async throws {
        try Task.checkCancellation()
        guard !shuttingDown else { throw CancellationError() }
        // A helper with slow database initialization may already be starting.
        // Keep it alive and keep waiting instead of creating duplicate workers.
        if let launch { try await launch() }
        else if MonitorRuntime.testChannel != nil || appURL.pathExtension != "app" {
            if launchedProcess?.isRunning != true {
                let process = Process()
                process.executableURL = appURL.pathExtension == "app"
                    ? helperURL.appendingPathComponent("Contents/MacOS/PerpetualRadar")
                    : URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
                var environment = ProcessInfo.processInfo.environment
                environment["PERPETUAL_RADAR_ROLE"] = "monitor"
                environment["PERPETUAL_RADAR_OWNER_PID"] = String(ProcessInfo.processInfo.processIdentifier)
                environment.removeValue(forKey: "PERPETUAL_RADAR_PID_FILE")
                environment.removeValue(forKey: "PERPETUAL_RADAR_READY_FILE")
                process.environment = environment
                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                try process.run(); launchedProcess = process
            }
        } else {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.environment = ["PERPETUAL_RADAR_OWNER_PID": String(ProcessInfo.processInfo.processIdentifier)]
            if let rollback = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_UPDATE_ROLLBACK"] {
                configuration.environment["PERPETUAL_RADAR_UPDATE_ROLLBACK"] = rollback
            }
            helperApplication = try await NSWorkspace.shared.openApplication(at: helperURL, configuration: configuration)
        }
        let deadline = ContinuousClock.now + .seconds(15)
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            if endpointExists {
                do {
                    let info = try await probe()
                    try acceptConnection(info); return
                } catch let failure as MonitorIPCFailure {
                    failedHealthChecks += 1
                    throw failure
                }
            }
            if launch == nil, let process = launchedProcess, !process.isRunning {
                throw FilterError("Monitor stopped during startup (\(process.terminationStatus)). Automatically retrying.")
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        failedHealthChecks += 1
        if failedHealthChecks >= 2 { await stopOwnedHelper() }
        throw FilterError("Monitor is still starting. Automatically retrying the connection.")
    }
}
