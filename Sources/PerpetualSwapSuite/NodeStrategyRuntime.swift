import Foundation

actor NodeStrategySession {
    private let process: Process
    private let input: FileHandle
    private let output: FileHandle
    private let store: ParquetMarketStore
    private var readBuffer = Data()
    private let encoder = JSONEncoder()

    init(nodeURL: URL, hostURL: URL, strategyURL: URL, logURL: URL, store: ParquetMarketStore) throws {
        self.store = store
        process = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        input = inputPipe.fileHandleForWriting
        output = outputPipe.fileHandleForReading
        process.executableURL = nodeURL
        process.arguments = [hostURL.path, strategyURL.path]
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        process.standardError = try FileHandle(forWritingTo: logURL)
        try process.run()
    }

    func initialize(settings: AppSettings) async throws {
        try send(HostRequest(type: "init", requestID: UUID().uuidString, event: nil, settings: settings, rows: nil, error: nil))
        _ = try await result()
    }

    func evaluate(_ event: StrategyEvent) async throws -> [StrategyCommand] {
        try send(HostRequest(type: "event", requestID: UUID().uuidString, event: event, settings: nil, rows: nil, error: nil))
        return try await result()
    }

    func stop() {
        try? send(HostRequest(type: "stop", requestID: UUID().uuidString, event: nil, settings: nil, rows: nil, error: nil))
        input.closeFile()
        if process.isRunning { process.terminate() }
    }

    private func result() async throws -> [StrategyCommand] {
        while let line = try readLine() {
            let message = try JSONDecoder().decode(HostMessage.self, from: Data(line.utf8))
            switch message.type {
            case "result", "ready": return message.commands ?? []
            case "query":
                guard let sql = message.sql, let requestID = message.requestID else { throw NodeRuntimeError.invalidMessage }
                do {
                    let rows = try await store.queryJSON(sql)
                    try send(HostRequest(type: "queryResult", requestID: requestID, event: nil, settings: nil, rows: rows, error: nil))
                } catch {
                    try send(HostRequest(type: "queryResult", requestID: requestID, event: nil, settings: nil, rows: nil, error: error.localizedDescription))
                }
            case "error": throw NodeRuntimeError.script(message.error ?? "Unknown strategy error")
            default: continue
            }
        }
        throw NodeRuntimeError.terminated
    }

    private func send(_ value: HostRequest) throws {
        var data = try encoder.encode(value)
        data.append(0x0A)
        try input.write(contentsOf: data)
    }

    private func readLine() throws -> String? {
        while true {
            if let newline = readBuffer.firstIndex(of: 0x0A) {
                let line = readBuffer[..<newline]
                readBuffer.removeSubrange(...newline)
                return String(decoding: line, as: UTF8.self)
            }
            let chunk = output.availableData
            guard !chunk.isEmpty else { return nil }
            readBuffer.append(chunk)
        }
    }
}

struct NodeStrategyRuntime: Sendable {
    private let paths: AppPaths
    private let store: ParquetMarketStore

    init(paths: AppPaths, store: ParquetMarketStore) { self.paths = paths; self.store = store }

    func session(strategyURL: URL) throws -> NodeStrategySession {
        let node = try nodeURL()
        let host = try hostURL()
        return try NodeStrategySession(
            nodeURL: node, hostURL: host, strategyURL: strategyURL,
            logURL: paths.cache.appendingPathComponent("strategy-runtime.log"), store: store
        )
    }

    private func nodeURL() throws -> URL {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Node/node")
        let candidates = [bundled, ProcessInfo.processInfo.environment["NODE_BINARY"].map(URL.init(fileURLWithPath:)), URL(fileURLWithPath: "/usr/local/bin/node"), URL(fileURLWithPath: "/opt/homebrew/bin/node")].compactMap { $0 }
        guard let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else { throw NodeRuntimeError.nodeMissing }
        return found
    }

    private func hostURL() throws -> URL {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Node/strategy-host.mjs")
        let development = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("node/strategy-host.mjs")
        guard let found = [bundled, development].compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0.path) }) else { throw NodeRuntimeError.hostMissing }
        return found
    }
}

private struct HostRequest: Codable {
    let type: String
    let requestID: String
    let event: StrategyEvent?
    let settings: AppSettings?
    let rows: [[String: AnyCodable]]?
    let error: String?
}

private struct HostMessage: Codable {
    let type: String
    let requestID: String?
    let commands: [StrategyCommand]?
    let sql: String?
    let error: String?
}

enum NodeRuntimeError: LocalizedError {
    case nodeMissing, hostMissing, invalidMessage, terminated, script(String)
    var errorDescription: String? {
        switch self {
        case .nodeMissing: "The embedded Node.js runtime is missing. Rebuild the packaged application."
        case .hostMissing: "The JavaScript strategy host is missing."
        case .invalidMessage: "The JavaScript strategy returned an invalid message."
        case .terminated: "The JavaScript strategy process terminated unexpectedly."
        case .script(let message): message
        }
    }
}
