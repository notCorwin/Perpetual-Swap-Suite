import Foundation
import CSQLite

struct ResearchHTTPError: LocalizedError, Sendable {
    var status: Int
    var path: String
    var errorDescription: String? { "OKX request failed (HTTP \(status)): \(path)." }
}

// Archive content failures can use a verified REST source. Storage failures
// must retain their original type so they cannot be mistaken for bad input.
struct ResearchArchiveError: LocalizedError, Sendable {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct ResearchOperationError: LocalizedError {
    var context: String
    var underlying: Error
    var errorDescription: String? { "\(context): \(underlying.localizedDescription)" }
}

enum ResearchRecovery {
    static func isRecoverable(_ error: Error) -> Bool {
        if let error = error as? ResearchOperationError { return isRecoverable(error.underlying) }
        if let error = error as? ResearchHTTPError {
            return [408, 425, 429, 500, 502, 503, 504].contains(error.status)
        }
        if let error = error as? URLError {
            return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                    .dnsLookupFailed, .notConnectedToInternet, .resourceUnavailable,
                    .cannotLoadFromNetwork, .badServerResponse].contains(error.code)
        }
        let error = error as NSError
        return error.domain == "SQLite" && [Int(SQLITE_BUSY), Int(SQLITE_LOCKED)].contains(error.code & 0xff)
    }

    static func run<Value>(
        onRetry: (Double, String) async -> Void,
        operation: () async throws -> Value
    ) async throws -> Value {
        var attempt = 0
        while true {
            try Task.checkCancellation()
            do { return try await operation() }
            catch {
                try Task.checkCancellation()
                guard isRecoverable(error) else { throw error }
                let delay = min(60, 2 * pow(2, Double(min(attempt, 5))))
                await onRetry(delay, error.localizedDescription)
                try await Task.sleep(for: .seconds(delay))
                attempt = min(attempt + 1, 5)
            }
        }
    }
}
