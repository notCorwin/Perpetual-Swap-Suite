import Foundation

struct FilterMembershipChange: Equatable, Sendable {
    enum Direction: String, Sendable { case entered, exited }
    var instId: String
    var direction: Direction
}

struct FilterObservation: Sendable {
    var configuration: String
    var universe: Set<String>
    var results: [String: FilterTruth]
}

// Membership is runtime data. Keep the last definite decision through Unknown
// readings, and establish a quiet baseline for existing markets after launch or
// a saved-rule change. A newly listed market can enter on its first known result.
struct FilterMembershipTracker {
    private var configuration: String?
    private var universe = Set<String>()
    private var baselinePending = Set<String>()
    private var membership: [String: Bool] = [:]

    mutating func consume(_ observation: FilterObservation) -> [FilterMembershipChange] {
        if configuration != observation.configuration {
            configuration = observation.configuration
            universe = observation.universe
            baselinePending = universe
            membership.removeAll()
        }
        var changes: [FilterMembershipChange] = []
        for id in universe.subtracting(observation.universe).sorted() {
            if membership[id] == true { changes.append(.init(instId: id, direction: .exited)) }
            membership.removeValue(forKey: id)
            baselinePending.remove(id)
        }
        for id in observation.universe.sorted() {
            guard let truth = observation.results[id], truth != .unknown else { continue }
            let matches = truth == .yes
            if baselinePending.remove(id) == nil {
                if matches, membership[id] != true { changes.append(.init(instId: id, direction: .entered)) }
                if !matches, membership[id] == true { changes.append(.init(instId: id, direction: .exited)) }
            }
            membership[id] = matches
        }
        universe = observation.universe
        return changes
    }
}

@MainActor
final class FilterMonitor {
    private let sample: () async throws -> FilterObservation?
    private let onChanges: ([FilterMembershipChange]) async -> Void
    private let onError: (String) -> Void
    private let interval: Duration
    private var tracker = FilterMembershipTracker()
    private var sampling = false
    private var wakePending = false
    private var generation = 0
    private var task: Task<Void, Never>?

    init(interval: Duration = .seconds(2), sample: @escaping () async throws -> FilterObservation?,
         onChanges: @escaping ([FilterMembershipChange]) async -> Void, onError: @escaping (String) -> Void = { _ in }) {
        self.interval = interval; self.sample = sample; self.onChanges = onChanges; self.onError = onError
    }

    deinit { task?.cancel() }

    func start() {
        guard task == nil else { return }
        generation += 1; wakePending = true
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await poll()
                do { try await Task.sleep(for: interval) }
                catch { return }
            }
        }
    }

    func wake() { guard task != nil else { return }; wakePending = true; Task { [weak self] in await self?.poll() } }
    private func poll() async {
        guard !sampling, task != nil else { return }
        let started = generation
        sampling = true
        defer {
            sampling = false
            if wakePending, task != nil { Task { [weak self] in await self?.poll() } }
        }
        repeat {
            wakePending = false
            do {
                if let observation = try await sample() {
                    try Task.checkCancellation()
                    guard task != nil, generation == started else { return }
                    let changes = tracker.consume(observation)
                    onError("")
                    if !changes.isEmpty { await onChanges(changes) }
                    guard generation == started else { return }
                }
            } catch { if !Task.isCancelled, generation == started, task != nil { onError(error.localizedDescription) } }
        } while wakePending && task != nil && generation == started && !Task.isCancelled
    }
    func stop() { task?.cancel(); task = nil; wakePending = false; generation += 1 }
}
