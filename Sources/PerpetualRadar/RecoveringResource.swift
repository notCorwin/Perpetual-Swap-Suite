import Foundation

// A transient open failure must not permanently disable an otherwise live app.
// All callers share one resource and one retry schedule; no user data is reset.
@MainActor
final class RecoveringResource<Value> {
    private let label: String
    private let retryDelay: Duration
    private let factory: () throws -> Value
    private var nextAttempt: ContinuousClock.Instant?
    private var failures = 0
    private(set) var value: Value?
    private(set) var error = ""

    init(label: String, retryDelay: Duration = .seconds(2), factory: @escaping () throws -> Value) {
        self.label = label; self.retryDelay = retryDelay; self.factory = factory
    }

    func get() throws -> Value {
        if let value { return value }
        if let nextAttempt, ContinuousClock.now < nextAttempt { throw FilterError(error) }
        do {
            let result = try factory()
            value = result; error = ""; failures = 0; nextAttempt = nil
            return result
        } catch {
            failures += 1
            nextAttempt = .now + min(retryDelay * (1 << min(failures - 1, 4)), .seconds(30))
            self.error = "\(label): \(error.localizedDescription). Automatically retrying."
            throw FilterError(self.error)
        }
    }

    func retryNow() { nextAttempt = nil }
}
