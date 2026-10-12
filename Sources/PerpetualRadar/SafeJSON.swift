import Foundation

struct JSONEncodingFailure: LocalizedError {
    var errorDescription: String? { "The value contains data that cannot be encoded as JSON." }
}

/// `JSONSerialization.data(withJSONObject:)` raises an uncatchable Objective-C exception for
/// non-JSON values (NaN, infinity, dates, unsupported top-level fragments). Validate first so
/// malformed bridge, IPC or evaluation data becomes a Swift error instead of terminating the process.
enum SafeJSON {
    static func data(_ object: Any, options: JSONSerialization.WritingOptions = []) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object) else { throw JSONEncodingFailure() }
        return try JSONSerialization.data(withJSONObject: object, options: options)
    }
}
