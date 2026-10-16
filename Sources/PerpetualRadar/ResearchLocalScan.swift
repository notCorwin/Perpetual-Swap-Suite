import Foundation

enum ResearchLocalScan {
    static var concurrency: Int { max(1, ProcessInfo.processInfo.activeProcessorCount) }

    // Each slot owns a reader connection. Refill it after consuming its result
    // so reads/encoding overlap the single SQLite writer without buffering an
    // entire history in memory or creating thousands of connections/tasks.
    static func run<Input: Sendable, Output: Sendable>(
        _ inputs: [Input],
        operation: @escaping @Sendable (Int, Input) async throws -> Output,
        receive: (Int, Output) async throws -> Void
    ) async throws {
        try Task.checkCancellation()
        try await withThrowingTaskGroup(of: (Int, Int, Output).self) { group in
            var next = 0
            func enqueue(_ slot: Int) {
                let index = next, input = inputs[index]
                group.addTask {
                    try ResearchPressure.shared.check()
                    return (slot, index, try await operation(slot, input))
                }
                next += 1
            }
            for slot in 0..<min(concurrency, inputs.count) { enqueue(slot) }
            while let (slot, index, result) = try await group.next() {
                try Task.checkCancellation()
                // Keep reads running during persistence and progress delivery.
                if next < inputs.count { enqueue(slot) }
                try await receive(index, result)
                try Task.checkCancellation()
            }
        }
    }
}
