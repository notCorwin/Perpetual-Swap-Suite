import Foundation

struct ResearchCalculatedSample: Sendable {
    var rule: Int
    var timestamp: Int64
    var truth: FilterTruth
    var direction: String?
    var entry: String
    var opportunity: NativeOpportunity
    var complete: Bool
    var split: String
    var outcomes: [ResearchOutcome]
    var event: ResearchEvent?
}

struct ResearchCalculationBatch: Sendable {
    var instrument: ResearchInstrument
    var position: ResearchCalculationPosition
    var samples: [ResearchCalculatedSample]
    var cacheID: String
    var cacheJSON: String
    var hours: Int
}

enum ResearchIndicatorBlock {
    static func encode(_ readings: [Int64: [String: FilterScalar]]) throws -> String {
        // Preserve IEEE-754 bits and UTF-8 explanations directly. JSON objects
        // repeated every scalar's kind/value field names and formatted numbers.
        var bytes = Data([82, 73, 66, 49]); bytes.reserveCapacity(256_000)
        func integer<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) }
        }
        func string(_ value: String) {
            integer(UInt32(value.utf8.count)); bytes.append(contentsOf: value.utf8)
        }
        integer(UInt32(readings.count))
        for (hour, values) in readings {
            integer(UInt64(bitPattern: hour)); integer(UInt32(values.count))
            for (key, value) in values {
                string(key)
                switch value {
                case .number(let number): bytes.append(0); integer(number.bitPattern)
                case .text(let text): bytes.append(1); string(text)
                case .unknown(let reason): bytes.append(2); string(reason)
                }
            }
        }
        return try researchJSON((bytes as NSData).compressed(using: .lzfse) as Data)
    }
    static func read(store: ResearchStore, key: String) throws -> [Int64: [String: FilterScalar]] {
        guard let compressed = try store.get(key, as: Data.self) else { return [:] }
        let bytes = try (compressed as NSData).decompressed(using: .lzfse) as Data
        guard bytes.count <= ResearchVersion.memoryBudget else { throw FilterError("The indicator cache exceeds the research memory budget.") }
        if !bytes.starts(with: [82, 73, 66, 49]) {
            return try JSONDecoder().decode([Int64: [String: ResearchCachedScalar]].self, from: bytes).mapValues { $0.mapValues(\.scalar) }
        }
        var cursor = 4
        func integer<T: FixedWidthInteger>(_: T.Type) throws -> T {
            guard cursor+MemoryLayout<T>.size <= bytes.count else { throw FilterError("The indicator cache is incomplete.") }
            defer { cursor += MemoryLayout<T>.size }
            return bytes.withUnsafeBytes { T(littleEndian: $0.loadUnaligned(fromByteOffset: cursor, as: T.self)) }
        }
        func string() throws -> String {
            let count = Int(try integer(UInt32.self))
            guard count <= bytes.count-cursor else { throw FilterError("The indicator cache is incomplete.") }
            defer { cursor += count }
            return String(decoding: bytes[cursor..<cursor+count], as: UTF8.self)
        }
        var result: [Int64: [String: FilterScalar]] = [:]
        let hours = try integer(UInt32.self)
        guard hours <= 64 else { throw FilterError("The indicator cache has an invalid hourly range.") }
        for _ in 0..<hours {
            let hour = Int64(bitPattern: try integer(UInt64.self)), count = try integer(UInt32.self)
            guard count <= bytes.count-cursor else { throw FilterError("The indicator cache has an invalid reading count.") }
            var values: [String: FilterScalar] = [:]
            for _ in 0..<count {
                let key = try string(), kind = try integer(UInt8.self)
                switch kind {
                case 0: values[key] = .number(Double(bitPattern: try integer(UInt64.self)))
                case 1: values[key] = .text(try string())
                case 2: values[key] = .unknown(try string())
                default: throw FilterError("The indicator cache has an invalid scalar type.")
                }
            }
            result[hour] = values
        }
        guard cursor == bytes.count else { throw FilterError("The indicator cache contains unexpected trailing data.") }
        return result
    }
}

private struct ResearchCalculationJob: Sendable {
    var instrument: ResearchInstrument
    var position: ResearchCalculationPosition
}

private actor ResearchCalculationCoordinator {
    private let store: ResearchStore
    private let study: ResearchStudy
    private let manifest: DataManifest
    private let progress: @Sendable (Int, Int, String) -> Void
    private var checkpoint: Checkpoint
    private var jobs: [ResearchCalculationJob] = []
    private var next = 0
    private var completed = 0
    private let total: Int

    init(directory: URL, study: ResearchStudy, manifest: DataManifest, checkpoint: Checkpoint,
         progress: @escaping @Sendable (Int, Int, String) -> Void) throws {
        store = try ResearchStore(directory: directory)
        try store.prepareCalculationIndexes()
        self.study = study; self.manifest = manifest; self.progress = progress
        self.checkpoint = checkpoint
        total = manifest.instruments.reduce(0) { $0 + ResearchEngine.countHours($1, manifest: manifest) }
        if self.checkpoint.calculation == nil { self.checkpoint.calculation = [:] }
        for (index, instrument) in manifest.instruments.enumerated() {
            let position = ResearchEngine.position(instrument, index: index, checkpoint: checkpoint)
            self.checkpoint.calculation?[instrument.id] = position
            if position.completed { completed += ResearchEngine.countHours(instrument, manifest: manifest) }
            else {
                completed += max(0, Int(((position.nextHour ?? ResearchEngine.firstHour(instrument, manifest: manifest))-ResearchEngine.firstHour(instrument, manifest: manifest))/hourMS))
                jobs.append(.init(instrument: instrument, position: position))
            }
        }
        // Start the longest remaining histories first to keep the final worker
        // from becoming a serial tail after the smaller instruments finish.
        jobs.sort {
            let a = min(manifest.through, $0.instrument.delistedAt ?? manifest.through)-($0.position.nextHour ?? ResearchEngine.firstHour($0.instrument, manifest: manifest))
            let b = min(manifest.through, $1.instrument.delistedAt ?? manifest.through)-($1.position.nextHour ?? ResearchEngine.firstHour($1.instrument, manifest: manifest))
            return a == b ? $0.instrument.id < $1.instrument.id : a > b
        }
    }

    func take() -> ResearchCalculationJob? {
        guard next < jobs.count else { return nil }
        defer { next += 1 }; return jobs[next]
    }
    func save(_ batches: [ResearchCalculationBatch]) throws {
        try ResearchPressure.shared.check()
        guard let last = batches.last else { return }
        var saved = checkpoint
        ResearchEngine.update(&saved, instrument: last.instrument, position: last.position, manifest: manifest)
        try store.database.transaction {
            for batch in batches { try ResearchEngine.save(batch, study: study, store: store) }
            try store.saveCalculationPosition(study.id, instrument: last.instrument.id, position: saved.calculation![last.instrument.id]!)
            try store.saveCalculationCheckpoint(saved)
        }
        checkpoint = saved; completed += batches.reduce(0) { $0+$1.hours }
        progress(min(completed, total), total, last.instrument.id)
    }
    func finish(_ instrument: ResearchInstrument, position: ResearchCalculationPosition) throws {
        var saved = checkpoint
        ResearchEngine.update(&saved, instrument: instrument, position: position, manifest: manifest)
        try store.database.transaction {
            try store.saveCalculationPosition(study.id, instrument: instrument.id, position: saved.calculation![instrument.id]!)
            try store.saveCalculationCheckpoint(saved)
        }
        checkpoint = saved
    }
    func result() -> Checkpoint { checkpoint }
}

private actor ResearchCalculationWorker {
    private let store: ResearchStore
    private let study: ResearchStudy
    private let manifest: DataManifest
    private let rules: [CompiledFilter]
    init(directory: URL, study: ResearchStudy, manifest: DataManifest) throws {
        store = try ResearchStore(directory: directory); self.study = study; self.manifest = manifest
        store.useFrozenManifest(manifest)
        rules = try study.spec.excludingSpread().rules.map { try FilterCompiler.compile(FilterConfigV2.decode($0.filtersJSON)) }
    }
    func run(_ job: ResearchCalculationJob, coordinator: ResearchCalculationCoordinator) async throws {
        var position = job.position
        var pending: [ResearchCalculationBatch] = []
        let batchLimit = max(1, min(4, 512/max(1, rules.count*64)))
        try ResearchEngine.initialize(store: store, study: study, instrument: job.instrument, manifest: manifest, rules: rules, position: &position)
        while position.nextHour! < min(manifest.through, job.instrument.delistedAt ?? manifest.through) {
            try Task.checkCancellation()
            // Calculation, encoding and compression finish before entering the
            // writer actor. No database write lock is held during CPU work.
            let batch = try ResearchEngine.batch(store: store, study: study, instrument: job.instrument, manifest: manifest, rules: rules, position: position)
            pending.append(batch)
            position = batch.position
            if pending.count == batchLimit || position.completed {
                try await coordinator.save(pending)
                pending.removeAll(keepingCapacity: true)
            }
        }
        if !position.completed {
            position.completed = true
            try await coordinator.finish(job.instrument, position: position)
        }
    }
}

extension ResearchEngine {
    static func runConcurrent(directory: URL, study: ResearchStudy, manifest: DataManifest, checkpoint: Checkpoint,
                              progress: @escaping @Sendable (Int, Int, String) -> Void) async throws -> Checkpoint {
        let coordinator = try ResearchCalculationCoordinator(directory: directory, study: study, manifest: manifest, checkpoint: checkpoint, progress: progress)
        try await withThrowingTaskGroup(of: Void.self) { group in
            let compiled = try study.spec.excludingSpread().rules.map { try FilterCompiler.compile(FilterConfigV2.decode($0.filtersJSON)) }
            let windowBytes = max(1_048_576, min(ResearchVersion.memoryBudget, (ResearchVersion.warmup(compiled)+128)*2_048))
            let slots = min(ResearchLocalScan.concurrency, manifest.instruments.count, max(1, ResearchVersion.memoryBudget/windowBytes))
            for _ in 0..<slots {
                group.addTask {
                    let worker = try ResearchCalculationWorker(directory: directory, study: study, manifest: manifest)
                    while let job = await coordinator.take() {
                        try Task.checkCancellation()
                        try await worker.run(job, coordinator: coordinator)
                    }
                }
            }
            for try await _ in group {}
        }
        return await coordinator.result()
    }
}
