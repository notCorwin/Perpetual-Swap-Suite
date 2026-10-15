import Foundation

struct AICredentialStatus: Codable, Sendable { let configured: Bool }

struct AIGatewayRequest: Codable, Sendable {
    let url: String
    let method: String
    let headers: [String: String]
    let body: String?
}

struct AIGatewayResponse: Codable, Sendable {
    let status: Int
    let headers: [String: String]
    let body: String
}

actor AIGateway {
    private let credentialURL: URL
    private let settings: SettingsStore
    private let session: URLSession

    init(credentialURL: URL, settings: SettingsStore, session: URLSession = .shared) {
        self.credentialURL = credentialURL
        self.settings = settings
        self.session = session
    }

    func status() -> AICredentialStatus {
        .init(configured: (try? key())?.isEmpty == false)
    }

    func save(key: String?) throws -> AICredentialStatus {
        guard let key, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            try? FileManager.default.removeItem(at: credentialURL)
            return status()
        }
        try Data(key.trimmingCharacters(in: .whitespacesAndNewlines).utf8).write(to: credentialURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credentialURL.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: credentialURL.deletingLastPathComponent().path)
        return status()
    }

    func fetch(_ value: AIGatewayRequest) async throws -> AIGatewayResponse {
        let configuration = await settings.current()
        guard let base = URL(string: configuration.aiBaseURL), let target = URL(string: value.url),
              ["https", "http"].contains(target.scheme?.lowercased() ?? ""),
              target.scheme == base.scheme, target.host == base.host,
              target.path.hasPrefix(base.path.isEmpty ? "/" : base.path)
        else { throw AIGatewayError.invalidURL }
        let secret = try key()
        guard !secret.isEmpty else { throw AIGatewayError.missingKey }
        var request = URLRequest(url: target)
        request.httpMethod = value.method
        request.timeoutInterval = 120
        for (name, headerValue) in value.headers where name.lowercased() != "authorization" {
            request.setValue(headerValue, forHTTPHeaderField: name)
        }
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.httpBody = value.body.map { Data($0.utf8) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AIGatewayError.invalidResponse }
        var headers = [String: String]()
        for (name, headerValue) in http.allHeaderFields {
            if let name = name as? String { headers[name] = String(describing: headerValue) }
        }
        return .init(status: http.statusCode, headers: headers, body: String(decoding: data, as: UTF8.self))
    }

    private func key() throws -> String {
        guard FileManager.default.fileExists(atPath: credentialURL.path) else { return "" }
        return try String(contentsOf: credentialURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum AIGatewayError: LocalizedError {
    case invalidURL, missingKey, invalidResponse
    var errorDescription: String? {
        switch self {
        case .invalidURL: "The AI request must use the configured OpenAI-compatible base URL."
        case .missingKey: "Save an API key before running AI analysis."
        case .invalidResponse: "The AI endpoint returned an invalid response."
        }
    }
}
