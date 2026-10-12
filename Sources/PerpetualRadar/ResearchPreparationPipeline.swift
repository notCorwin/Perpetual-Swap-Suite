import Foundation
import Darwin

// Network waits do not occupy import slots. Every instrument has an independent
// download lane; completed inputs queue as small descriptors of durable files.
// A shared CPU-sized pool imports them in completion order, keeping fast SWAPs
// moving even while another instrument is downloading or repairing history.
enum ResearchPreparationPipeline {
    static func reserveFileCapacity(downloads: Int, workers: Int) throws {
        // LaunchServices normally starts GUI apps with a 256-descriptor soft
        // limit. Each SWAP needs streaming files/connections, and each of the
        // two CPU-sized store pools needs SQLite/WAL handles. Raise only this
        // process's soft limit, retaining headroom for WebKit and the monitor.
        var limit = rlimit()
        guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        let required = rlim_t(downloads) * 4 + rlim_t(workers) * 6 + 128
        guard limit.rlim_cur < required else { return }
        limit.rlim_cur = min(limit.rlim_max, required)
        guard setrlimit(RLIMIT_NOFILE, &limit) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EMFILE) }
    }
    private struct Input: Sendable {
        var source: ResearchSource
        let started: ContinuousClock.Instant
    }
    private enum Event<Imported: Sendable>: Sendable {
        case acquired(Int, Input, Result<ResearchSource, Error>)
        case imported(Int, Input, Result<Imported, Error>)
        case prepared(Input, Result<Double, Error>)
    }
    private struct Finalization<Imported: Sendable>: Sendable {
        let slot: Int
        let input: Input
        let imported: Imported
    }

    static func run<Imported: Sendable>(
        _ sources: [ResearchSource], concurrency: Int,
        acquire: @escaping @Sendable (Int, ResearchSource) async throws -> ResearchSource,
        importSource: @escaping @Sendable (Int, ResearchSource) async throws -> Imported,
        finish: @escaping @Sendable (Int, ResearchSource, Imported, ContinuousClock.Instant) async throws -> Double,
        receive: (ResearchSource, Double) async throws -> Void
    ) async throws {
        try Task.checkCancellation()
        let slots = min(max(1, concurrency), sources.count)
        var lanes: [[ResearchSource]] = [], laneIndex: [String: Int] = [:]
        for source in sources {
            if let lane = laneIndex[source.instrument] { lanes[lane].append(source) }
            else { laneIndex[source.instrument] = lanes.count; lanes.append([source]) }
        }
        try reserveFileCapacity(downloads: lanes.count, workers: slots)
        var firstError: String?
        try await withThrowingTaskGroup(of: Event<Imported>.self) { group in
            var next = Array(repeating: 0, count: lanes.count)
            var ready: [Input] = [], head = 0, available = Array((0..<slots).reversed())
            var finishing = Set<String>(), pendingFinishes: [String: [Finalization<Imported>]] = [:], finishHeads: [String: Int] = [:]
            func enqueueDownload(_ lane: Int) {
                let input = Input(source: lanes[lane][next[lane]], started: .now)
                next[lane] += 1
                group.addTask {
                    do { return .acquired(lane, input, .success(try await acquire(lane % slots, input.source))) }
                    catch {
                        if Task.isCancelled { throw error }
                        return .acquired(lane, input, .failure(error))
                    }
                }
            }
            func enqueueImports() {
                while head < ready.count, let slot = available.popLast() {
                    let input = ready[head]; head += 1
                    group.addTask {
                        do { return .imported(slot, input, .success(try await importSource(slot, input.source))) }
                        catch {
                            if Task.isCancelled { throw error }
                            return .imported(slot, input, .failure(error))
                        }
                    }
                }
                // Release consumed descriptors rather than retaining a second
                // copy of the entire plan throughout a long preparation.
                if head == ready.count { ready.removeAll(keepingCapacity: true); head = 0 }
            }
            func failed(_ source: ResearchSource, _ error: Error) {
                firstError = firstError ?? "\(source.instrument) · \(source.filename): \(error.localizedDescription)"
            }
            func enqueueFinish(_ instrument: String) {
                let head = finishHeads[instrument] ?? 0
                guard !finishing.contains(instrument), head < (pendingFinishes[instrument]?.count ?? 0) else { return }
                let work = pendingFinishes[instrument]![head]
                finishing.insert(instrument); finishHeads[instrument] = head + 1
                if head + 1 == pendingFinishes[instrument]?.count {
                    pendingFinishes[instrument]?.removeAll(keepingCapacity: true); finishHeads[instrument] = 0
                }
                group.addTask {
                    do { return .prepared(work.input, .success(try await finish(work.slot, work.input.source, work.imported, work.input.started))) }
                    catch {
                        if Task.isCancelled { throw error }
                        return .prepared(work.input, .failure(error))
                    }
                }
            }
            for lane in lanes.indices { enqueueDownload(lane) }
            while let event = try await group.next() {
                try Task.checkCancellation()
                switch event {
                case let .acquired(lane, input, result):
                    switch result {
                    case let .success(source): ready.append(Input(source: source, started: input.started))
                    case let .failure(error): failed(input.source, error)
                    }
                    // Refill the network lane before waiting for an importer.
                    if firstError == nil, next[lane] < lanes[lane].count { enqueueDownload(lane) }
                    enqueueImports()
                case let .imported(slot, input, result):
                    available.append(slot)
                    switch result {
                    case let .success(imported):
                        // REST gap repair/retries are network work too. Release
                        // this CPU slot. One repair stream per SWAP avoids
                        // thousands of same-endpoint waiters without preventing
                        // every other SWAP from finalizing concurrently.
                        pendingFinishes[input.source.instrument, default: []].append(.init(slot: slot, input: input, imported: imported))
                        enqueueFinish(input.source.instrument)
                    case let .failure(error): failed(input.source, error)
                    }
                    enqueueImports()
                case let .prepared(input, result):
                    finishing.remove(input.source.instrument)
                    enqueueFinish(input.source.instrument)
                    switch result {
                    case let .success(elapsed): try await receive(input.source, elapsed)
                    case let .failure(error): failed(input.source, error)
                    }
                }
            }
        }
        // Drain and persist successful siblings and already downloaded inputs
        // before surfacing a permanent failure. Pause/cancel instead cancels
        // the task group and waits for all transfer handles to close.
        if let firstError { throw FilterError(firstError) }
    }
}
