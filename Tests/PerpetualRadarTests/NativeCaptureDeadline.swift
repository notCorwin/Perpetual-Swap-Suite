import Foundation
@testable import PerpetualRadar

/// ScreenCaptureKit can disconnect without calling its completion handler.
/// An unstructured task lets the test fail even when that system task cannot
/// be cancelled; a task-group race would wait forever for the losing task.
private final class CaptureResult<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }

    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: result)
    }
}

func withNativeCaptureDeadline<Value: Sendable>(_ capture: @escaping @Sendable () async throws -> Value) async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
        let result = CaptureResult(continuation)
        let operation = Task {
            do { result.finish(.success(try await capture())) }
            catch { result.finish(.failure(error)) }
        }
        Task {
            try await Task.sleep(for: .seconds(3))
            result.finish(.failure(FilterError("Native offscreen capture did not complete within 3 seconds.")))
            operation.cancel()
        }
    }
}
