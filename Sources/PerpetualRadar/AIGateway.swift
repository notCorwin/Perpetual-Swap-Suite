import Foundation
import Security
import LocalAuthentication

struct GatewayError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

@MainActor
protocol GatewayCredentials {
    func read() throws -> String?
    func write(_ key: String) throws
    func remove() throws
}

@MainActor
final class KeychainGatewayCredentials: GatewayCredentials {
    private var query: [String: Any] {
        let context = LAContext()
        // Normal app use can authorize Keychain access after an app update;
        // every test channel forbids authentication UI.
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
    func write(_ key: String) throws {
        let data = Data(key.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw GatewayError("Cannot save the Gateway API Key in Keychain (\(status)).") }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw GatewayError("Cannot remove the Gateway API Key from Keychain (\(status)).")
        }
    }
}

@MainActor
final class GatewaySettings {
    static let defaultModel = "openai/gpt-6.1-sol"
    private let credentials: any GatewayCredentials
    private let defaults: UserDefaults
    init(credentials: any GatewayCredentials = KeychainGatewayCredentials(), defaults: UserDefaults = .standard) {
        self.credentials = credentials; self.defaults = defaults
    }
    func snapshot() throws -> [String: Any] {
        ["model": defaults.string(forKey: "AIAnalysisModel") ?? Self.defaultModel,
         "hasAPIKey": !(try credentials.read() ?? "").isEmpty]
    }
    func handle(_ request: [String: Any]) throws -> [String: Any] {
        switch request["action"] as? String {
        case "read": break
        case "save":
            guard let model = request["model"] as? String, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw GatewayError("Enter a model ID.")
            }
            if let key = request["apiKey"] as? String, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try credentials.write(key.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            defaults.set(model.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "AIAnalysisModel")
        case "removeKey": try credentials.remove()
        default: throw GatewayError("Invalid analysis settings action.")
        }
        return try snapshot()
    }
    func authorizedRequest(body: String) throws -> URLRequest {
        guard let key = try credentials.read(), !key.isEmpty else { throw GatewayError("Configure a Gateway API Key to analyze charts.") }
        guard let data = body.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["model"] is String, object["messages"] is [Any] else { throw GatewayError("Invalid Gateway request.") }
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
        let request = try settings.authorizedRequest(body: body)
        tasks[id] = Task {
            var replied = false
            defer { tasks.removeValue(forKey: id) }
            do {
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
