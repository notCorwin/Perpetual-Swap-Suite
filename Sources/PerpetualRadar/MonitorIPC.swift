import AppKit
import CryptoKit
import Network

enum MonitorRuntime {
    static let helperIdentifier = "com.perpetualradar.macos.monitor"
    static let helperName = "Perpetual Swap Suite Monitor.app"
    static let isHelper = Bundle.main.bundleIdentifier == helperIdentifier || ProcessInfo.processInfo.environment["PERPETUAL_RADAR_ROLE"] == "monitor"
    static let testChannel = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_TEST_CHANNEL"]
    static let productionPortName = "com.perpetualradar.monitor.\(getuid())"
    static let portName = productionPortName + (testChannel.map { ".\($0)" } ?? "")
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

// One persistent Unix-domain stream per client. Replies are pushed as soon as a
// job completes, so no client polls, holds a process-wide lock or blocks a Swift
// concurrency thread. Requests and completed replies exist only in memory.
struct MonitorIPCFrame {
    enum Op: UInt8 { case submit = 1, reply = 2, cancel = 3, acknowledge = 4, ping = 5, pong = 6 }
    static let maximumLength = 512 << 20
    let op: Op
    let id: String
    var payload = Data()

    var encoded: Data {
        let key = Data(id.utf8)
        var data = Data(capacity: 7 + key.count + payload.count)
        withUnsafeBytes(of: UInt32(3 + key.count + payload.count).bigEndian) { data.append(contentsOf: $0) }
        data.append(op.rawValue)
        withUnsafeBytes(of: UInt16(key.count).bigEndian) { data.append(contentsOf: $0) }
        data.append(key); data.append(payload)
        return data
    }

    init(op: Op, id: String, payload: Data = Data()) { self.op = op; self.id = id; self.payload = payload }
    init?(_ body: Data) {
        let bytes = [UInt8](body)
        guard bytes.count >= 3, let op = Op(rawValue: bytes[0]) else { return nil }
        let length = Int(bytes[1]) << 8 | Int(bytes[2])
        guard bytes.count >= 3 + length, let id = String(bytes: bytes[3..<(3 + length)], encoding: .utf8) else { return nil }
        self.op = op; self.id = id; payload = Data(bytes[(3 + length)...])
    }

    static func read(_ connection: NWConnection, _ done: @escaping @Sendable (MonitorIPCFrame?) -> Void) {
        connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { header, _, _, error in
            guard error == nil, let header, header.count == 4 else { return done(nil) }
            let length = header.reduce(0) { $0 << 8 | Int($1) }
            guard (3...maximumLength).contains(length) else { return done(nil) }
            connection.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, error in
                guard error == nil, let body, body.count == length else { return done(nil) }
                done(MonitorIPCFrame(body))
            }
        }
    }
}

final class MonitorIPCServer: @unchecked Sendable {
    typealias Handler = @MainActor @Sendable (Data) async -> Data
    private struct Job {
        var task: Task<Void, Never>?
        var reply: Data?
        var waiters: [ObjectIdentifier: NWConnection] = [:]
        let expires = ContinuousClock.now + .seconds(120)
    }
    private let handler: Handler
    private let path: String
    private let queue = DispatchQueue(label: "com.perpetualradar.monitor.ipc")
    private let queueKey = DispatchSpecificKey<Bool>()
    // All state below is confined to `queue`.
    private var jobs: [String: Job] = [:]
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var listener: NWListener?
    private var lockDescriptor: Int32 = -1
    private var expiryTimer: DispatchSourceTimer?

    init(name: String = MonitorRuntime.portName, handler: @escaping Handler) throws {
        self.handler = handler
        path = MonitorIPC.socketPath(name)
        queue.setSpecific(key: queueKey, value: true)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        // The kernel releases this lock when the process exits, so a crashed
        // monitor never blocks its successor and two monitors never coexist.
        let descriptor = open(path + ".lock", O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw FilterError("Cannot create the background monitor lock: \(String(cString: strerror(errno))).") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { close(descriptor); throw FilterError("Background monitoring is already running.") }
        lockDescriptor = descriptor
        unlink(path)
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .unix(path: path)
            let listener = try NWListener(using: parameters)
            let ready = DispatchSemaphore(value: 0)
            nonisolated(unsafe) var failure: Error?
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: ready.signal()
                case .failed(let error): failure = error; ready.signal()
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
            guard ready.wait(timeout: .now() + 5) == .success, failure == nil else {
                listener.cancel()
                throw FilterError("Cannot start the background monitor endpoint: \(failure?.localizedDescription ?? "timed out").")
            }
            listener.stateUpdateHandler = nil
            self.listener = listener
            chmod(path, 0o600)
        } catch { close(descriptor); lockDescriptor = -1; throw error }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.expireJobs() }
        timer.resume(); expiryTimer = timer
    }

    deinit { invalidate() }
    func invalidate() {
        let tasks: [Task<Void, Never>] = onQueue {
            guard lockDescriptor >= 0 else { return [] }
            expiryTimer?.cancel(); expiryTimer = nil
            listener?.cancel(); listener = nil
            connections.values.forEach { $0.cancel() }; connections.removeAll()
            let tasks = jobs.values.compactMap(\.task); jobs.removeAll()
            // Unlink before releasing the lock: only a lock holder owns the path.
            unlink(path); close(lockDescriptor); lockDescriptor = -1
            return tasks
        }
        tasks.forEach { $0.cancel() }
    }

    private func onQueue<T>(_ body: () -> T) -> T {
        DispatchQueue.getSpecific(key: queueKey) == true ? body() : queue.sync(execute: body)
    }

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            switch state {
            case .failed, .cancelled: if let connection { self?.drop(connection) }
            default: break
            }
        }
        connection.start(queue: queue)
        receive(connection)
    }

    private func receive(_ connection: NWConnection) {
        MonitorIPCFrame.read(connection) { [weak self, weak connection] frame in
            guard let self, let connection else { return }
            guard let frame else { return drop(connection) }
            handle(frame, from: connection)
            receive(connection)
        }
    }

    private func drop(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        guard connections.removeValue(forKey: key) != nil else { return }
        // Keep the job: a reconnecting client resubmits the same ID and
        // receives this result instead of repeating a mutation.
        for id in jobs.keys { jobs[id]?.waiters.removeValue(forKey: key) }
        connection.cancel()
    }

    private func expireJobs() {
        for (id, job) in jobs where job.expires < .now { jobs.removeValue(forKey: id); job.task?.cancel() }
    }

    private func handle(_ frame: MonitorIPCFrame, from connection: NWConnection) {
        switch frame.op {
        case .submit:
            expireJobs()
            if let reply = jobs[frame.id]?.reply { return send(reply, id: frame.id, to: connection) }
            if jobs[frame.id] != nil { jobs[frame.id]?.waiters[ObjectIdentifier(connection)] = connection; return }
            var job = Job(); job.waiters[ObjectIdentifier(connection)] = connection
            let id = frame.id, payload = frame.payload, handler = handler
            job.task = Task { @MainActor [weak self] in
                let reply = await handler(payload)
                guard let server = self else { return }
                server.queue.async { server.complete(id, reply: reply) }
            }
            jobs[id] = job
        case .cancel: jobs.removeValue(forKey: frame.id)?.task?.cancel()
        // Keep the result until receipt is acknowledged. A lost reply or a
        // repeated submission must never run a mutation twice in this session.
        case .acknowledge: if jobs[frame.id]?.reply != nil { jobs.removeValue(forKey: frame.id) }
        // Answered on the IPC queue, so a busy main actor is not mistaken for a hung process.
        case .ping: connection.send(content: MonitorIPCFrame(op: .pong, id: frame.id).encoded, completion: .contentProcessed { _ in })
        case .reply, .pong: drop(connection)
        }
    }

    private func complete(_ id: String, reply: Data) {
        guard let waiters = jobs[id]?.waiters else { return }
        jobs[id]?.reply = reply; jobs[id]?.task = nil; jobs[id]?.waiters.removeAll()
        for connection in waiters.values { send(reply, id: id, to: connection) }
    }

    private func send(_ reply: Data, id: String, to connection: NWConnection) {
        connection.send(content: MonitorIPCFrame(op: .reply, id: id, payload: reply).encoded, completion: .contentProcessed { _ in })
    }
}

struct MonitorIPCFailure: Error, LocalizedError {
    enum Reason { case unavailable, transport, timeout, invalidResponse }
    let reason: Reason
    var requestMayHaveRun = false
    var isConnectionFailure: Bool {
        switch reason { case .unavailable, .transport: true; default: false }
    }
    var errorDescription: String? {
        switch reason {
        case .unavailable: "Monitor is reconnecting. Automatically retrying."
        case .transport: "Monitor connection was interrupted. Automatically reconnecting."
        case .timeout: "The monitor request took too long. Live data will retry automatically."
        case .invalidResponse: "The monitor returned an invalid response."
        }
    }
}

// A client's persistent stream. Pending replies resume immediately when the
// monitor answers or the connection drops; nothing is polled.
final class MonitorIPCConnection: @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "com.perpetualradar.monitor.client")
    // State below is confined to `queue`.
    private var opening: CheckedContinuation<Void, Error>?
    private var pending: [String: (token: UUID, continuation: CheckedContinuation<Data, Error>)] = [:]
    private var cancelled = Set<String>()
    private var failed = false
    private var lastHeard = ContinuousClock.now
    private var heartbeat: DispatchSourceTimer?
    // A stopped or hung monitor keeps its socket open; while requests are
    // outstanding, missing heartbeats turn it into a connection failure.
    private static let heartbeatTimeout: Duration = .seconds(3)

    init(name: String) { connection = NWConnection(to: .unix(path: MonitorIPC.socketPath(name)), using: .tcp) }

    var isFailed: Bool { queue.sync { failed } }

    func open() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                opening = continuation
                connection.stateUpdateHandler = { [weak self] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        opening?.resume(); opening = nil
                        receive(); startHeartbeat()
                    // A missing or refused socket waits for a path change; treat it as unavailable.
                    case .waiting, .failed, .cancelled: fail()
                    default: break
                    }
                }
                connection.start(queue: queue)
            }
        }
    }

    func send(_ frame: MonitorIPCFrame) {
        connection.send(content: frame.encoded, completion: .contentProcessed { [weak self] error in
            if error != nil { self?.fail() }
        })
    }

    func call(id: String, payload: Data, timeout: Duration) async throws -> Data {
        let token = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                queue.async { [self] in
                    if cancelled.remove(id) != nil { return continuation.resume(throwing: CancellationError()) }
                    guard !failed else { return continuation.resume(throwing: MonitorIPCFailure(reason: .unavailable)) }
                    pending.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
                    if pending.isEmpty { lastHeard = .now }
                    pending[id] = (token, continuation)
                    send(MonitorIPCFrame(op: .submit, id: id, payload: payload))
                    let (seconds, attoseconds) = timeout.components
                    queue.asyncAfter(deadline: .now() + .milliseconds(Int(seconds * 1_000 + attoseconds / 1_000_000_000_000_000))) { [weak self] in
                        guard let self, pending[id]?.token == token else { return }
                        pending.removeValue(forKey: id)?.continuation.resume(throwing: MonitorIPCFailure(reason: .timeout))
                    }
                }
            }
        } onCancel: {
            queue.async { [self] in
                if let entry = pending[id], entry.token == token { pending.removeValue(forKey: id); entry.continuation.resume(throwing: CancellationError()) }
                else { cancelled.insert(id) }
            }
        }
    }

    private func receive() {
        MonitorIPCFrame.read(connection) { [weak self] frame in
            guard let self else { return }
            guard let frame, frame.op == .reply || frame.op == .pong else { return fail() }
            lastHeard = .now
            if frame.op == .pong { return receive() }
            pending.removeValue(forKey: frame.id)?.continuation.resume(returning: frame.payload)
            cancelled.remove(frame.id)
            receive()
        }
    }

    private func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, !pending.isEmpty else { return }
            if lastHeard.duration(to: .now) > Self.heartbeatTimeout { return fail() }
            send(MonitorIPCFrame(op: .ping, id: ""))
        }
        timer.resume(); heartbeat = timer
    }

    private func fail() {
        guard !failed else { return }
        failed = true
        heartbeat?.cancel(); heartbeat = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        opening?.resume(throwing: MonitorIPCFailure(reason: .unavailable)); opening = nil
        let waiting = pending.values; pending.removeAll()
        waiting.forEach { $0.continuation.resume(throwing: MonitorIPCFailure(reason: .transport)) }
    }
}

enum MonitorIPC {
    // Bump when the request or reply format changes. Copies of the app that
    // share this version may share one monitor; see MonitorClient.compatible.
    static let protocolVersion = 2
    @MainActor private static var connections: [String: Task<MonitorIPCConnection, Error>] = [:]

    static func socketPath(_ name: String) -> String {
        let digest = SHA256.hash(data: Data(name.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
        // The production endpoint lives beside the cache, which the system
        // never purges; process tests keep theirs in the temporary directory.
        let production = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PerpetualRadar/monitor-\(digest).sock").path
        if name == MonitorRuntime.productionPortName, production.utf8.count < 100 { return production }
        return URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("psm-\(digest).sock").path
    }

    static func endpointExists(_ name: String) -> Bool {
        let path = socketPath(name)
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return false }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        } == 0
    }

    @MainActor
    private static func connection(_ name: String) async throws -> MonitorIPCConnection {
        if let existing = connections[name] {
            if let connection = try? await existing.value, !connection.isFailed { return connection }
            if connections[name] == existing { connections[name] = nil }
        }
        let task = Task { () throws -> MonitorIPCConnection in
            let connection = MonitorIPCConnection(name: name)
            try await connection.open()
            return connection
        }
        connections[name] = task
        do { return try await task.value }
        catch { if connections[name] == task { connections[name] = nil }; throw error }
    }

    @MainActor
    static func request(_ body: [String: Any], name: String = MonitorRuntime.portName,
                        id: String = UUID().uuidString, timeout: Duration = .seconds(100),
                        acknowledge: Bool = true) async throws -> [String: Any] {
        let payload = try SafeJSON.data(body)
        var submitted: MonitorIPCConnection?  // Set once a submission may reach the monitor.
        do {
            try Task.checkCancellation()
            let connection = try await connection(name)
            try Task.checkCancellation()
            submitted = connection
            let data = try await connection.call(id: id, payload: payload, timeout: timeout)
            guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MonitorIPCFailure(reason: .invalidResponse) }
            if acknowledge { connection.send(MonitorIPCFrame(op: .acknowledge, id: id)) }
            if let error = response["error"] as? String { throw FilterError(error) }
            guard let value = response["value"] as? [String: Any] else { throw MonitorIPCFailure(reason: .invalidResponse) }
            return value
        } catch {
            if var failure = error as? MonitorIPCFailure, failure.isConnectionFailure, !Task.isCancelled {
                // An unavailable endpoint is known not to have received the submission.
                failure.requestMayHaveRun = failure.reason == .transport
                throw failure
            }
            submitted?.send(MonitorIPCFrame(op: .cancel, id: id))
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
        // Another open copy keeps using the monitor; only the last client stops it.
        let released = try? await MonitorIPC.request(["releaseLease": ProcessInfo.processInfo.processIdentifier], name: name, timeout: .seconds(3))
        if released?["remainingClients"] as? Int ?? 0 == 0 {
            for _ in 0..<60 {
                if !endpointExists { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            await stopOwnedHelper()
        }
        connection = nil
    }

    func ensureRunning() async throws {
        guard !shuttingDown else { throw CancellationError() }
        try Task.checkCancellation()
        if let launchTask { try await launchTask.value; try Task.checkCancellation(); return }
        if let connection, connection.checkedAt.duration(to: .now) < .seconds(10) { return }
        let task = Task { try await connectOrLaunch() }
        launchTask = task
        defer { launchTask = nil }
        try await task.value
        try Task.checkCancellation()
    }

    private var endpointExists: Bool { MonitorIPC.endpointExists(name) }
    private var helperURL: URL { appURL.appendingPathComponent("Contents/Library/LoginItems/\(MonitorRuntime.helperName)") }
    private func otherClients(_ info: [String: Any]) -> Bool {
        (info["foregroundPIDs"] as? [Int32] ?? []).contains { $0 != ProcessInfo.processInfo.processIdentifier }
    }
    // Our own monitor build is always preferred, but another open copy of the
    // app keeps its monitor while it shares the IPC protocol. Replacing it
    // would make both copies replace each other forever.
    private func compatible(_ info: [String: Any]) -> Bool {
        if info["appPath"] as? String == appURL.path && info["revision"] as? String == revision { return true }
        return info["ipcVersion"] as? Int == MonitorIPC.protocolVersion && otherClients(info)
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
            if otherClients(info) {
                throw FilterError("Another copy of Perpetual Swap Suite (\((info["appPath"] as? String) ?? "unknown location")) is using an incompatible background monitor. Quit that copy to continue.")
            }
            // The monitor may exit before its acknowledgment arrives; its endpoint is checked below.
            do { _ = try await MonitorIPC.request(["stopForReplacement": true], name: name, timeout: .seconds(5)) }
            catch let failure as MonitorIPCFailure where failure.isConnectionFailure {}
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
