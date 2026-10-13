import Foundation
import Security
import LocalAuthentication

struct GatewayError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

protocol GatewayCredentialReader: Sendable {
    func read() async throws -> String?
}

protocol GatewayCredentials: GatewayCredentialReader {
    func write(_ key: String) async throws
    func remove() async throws
}

actor KeychainGatewayCredentials: GatewayCredentialReader {
    private var query: [String: Any] {
        let context = LAContext()
        // Only legacy migration reads Keychain. Every test channel forbids
        // authentication UI, including direct invocations of this reader.
        context.interactionNotAllowed = MonitorRuntime.testChannel != nil
        return [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.perpetualradar.macos.ai-gateway",
         kSecAttrAccount as String: "api-key",
         kSecUseAuthenticationContext as String: context]
    }
    func read() throws -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw GatewayError("Cannot read the Gateway API Key from Keychain (\(status)).")
        }
        return value
    }
}

@MainActor
final class GatewaySettings {
    static let defaultModel = "openai/gpt-6.1-sol"
    private let credentials: any GatewayCredentials
    private let defaults: UserDefaults
    init(credentials: any GatewayCredentials = FileGatewayCredentials(), defaults: UserDefaults = .standard) {
        self.credentials = credentials; self.defaults = defaults
    }
    func snapshot() async throws -> [String: Any] {
        ["model": defaults.string(forKey: "AIAnalysisModel") ?? Self.defaultModel,
         "hasAPIKey": !(try await credentials.read() ?? "").isEmpty]
    }
    func handle(_ request: [String: Any]) async throws -> [String: Any] {
        switch request["action"] as? String {
        case "read": break
        case "save":
            guard let model = request["model"] as? String, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw GatewayError("Enter a model ID.")
            }
            if let key = request["apiKey"] as? String, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try await credentials.write(key.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            defaults.set(model.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "AIAnalysisModel")
        case "removeKey": try await credentials.remove()
        default: throw GatewayError("Invalid analysis settings action.")
        }
        return try await snapshot()
    }
    func authorizedRequest(body: String) async throws -> URLRequest {
        guard let data = body.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["model"] is String, object["messages"] is [Any] else { throw GatewayError("Invalid Gateway request.") }
        guard let key = try await credentials.read(), !key.isEmpty else { throw GatewayError("Configure a Gateway API Key to analyze charts.") }
        var request = URLRequest(url: URL(string: "https://ai-gateway.vercel.sh/v1/chat/completions")!)
        request.httpMethod = "POST"; request.httpBody = data
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return request
    }
}

/// Sends the SDK's serialized request through native networking. The SDK owns
/// SSE parsing; this layer forwards bytes, including non-2xx response bodies.
@MainActor
final class GatewayClient {
    let settings: GatewaySettings
    private let session: URLSession
    private var tasks: [String: Task<Void, Never>] = [:]
    private var networkTasks: [String: URLSessionTask] = [:]
    init(settings: GatewaySettings = GatewaySettings(), session: URLSession? = nil) {
        self.settings = settings
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 600
        self.session = session ?? URLSession(configuration: configuration)
    }
    func cancel(_ id: String) { networkTasks[id]?.cancel(); tasks[id]?.cancel() }
    func cancelAll() { for task in networkTasks.values { task.cancel() }; for task in tasks.values { task.cancel() } }
    func start(id: String, body: String,
               reply: @escaping @MainActor @Sendable (Any?, String?) -> Void,
               emit: @escaping @MainActor ([String: Any]) async -> Void) throws {
        guard !id.isEmpty, tasks[id] == nil else { throw GatewayError("Invalid or duplicate Gateway request ID.") }
        tasks[id] = Task {
            var replied = false
            defer { tasks.removeValue(forKey: id) }
            do {
                let request = try await settings.authorizedRequest(body: body)
                try Task.checkCancellation()
                let (bytes, response) = try await session.bytes(for: request)
                networkTasks[id] = bytes.task
                defer { bytes.task.cancel(); networkTasks.removeValue(forKey: id) }
                try Task.checkCancellation()
                guard let http = response as? HTTPURLResponse else { throw GatewayError("Invalid Gateway response.") }
                let headers = http.allHeaderFields.reduce(into: [String: String]()) { result, item in
                    result[String(describing: item.key)] = String(describing: item.value)
                }
                reply(["status": http.statusCode, "headers": headers], nil); replied = true
                var chunk = Data()
                for try await byte in bytes {
                    try Task.checkCancellation()
                    chunk.append(byte)
                    if byte == 10 || chunk.count >= 16_384 {
                        await emit(["id": id, "type": "data", "base64": chunk.base64EncodedString()])
                        chunk.removeAll(keepingCapacity: true)
                    }
                }
                try Task.checkCancellation()
                if !chunk.isEmpty { await emit(["id": id, "type": "data", "base64": chunk.base64EncodedString()]) }
                await emit(["id": id, "type": "end"])
            } catch {
                let cancelled = Task.isCancelled || error is CancellationError
                let message = cancelled ? "Request stopped." : "Gateway request failed: \(error.localizedDescription)"
                if !replied { reply(nil, message) }
                else if !cancelled { await emit(["id": id, "type": "error", "message": message]) }
            }
        }
    }
}
