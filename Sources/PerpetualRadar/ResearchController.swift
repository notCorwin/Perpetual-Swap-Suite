import AppKit
import UniformTypeIdentifiers

struct ResearchChartBar: Codable, Sendable {
    var hour: Int64
    var open: Double, high: Double, low: Double, close: Double
    var confirmed = true
    var vwap: Double?, ema: Double?, logBBUpper: Double?, logBBMiddle: Double?, logBBLower: Double?
    var roc: Double?, maroc: Double?, rsi6: Double?, rsi12: Double?, rsi24: Double?
    var oi: Double?, buy: Double?, sell: Double?
}
struct ResearchChart: Codable, Sendable {
    var bars: [ResearchChartBar]
    var error = ""
    var revision = 0
    var endHour: Int64
    var oldestHour: Int64?
    var latestHour: Int64?
    var signalHour: Int64
    var manifestID: String
}

actor ResearchWorker {
    private let directory: URL
    private let transport: any ResearchTransport
    private let radarURL: URL?
    init(directory: URL, transport: any ResearchTransport = OKXResearchTransport(), radarURL: URL? = nil) {
        self.directory = directory; self.transport = transport; self.radarURL = radarURL
    }
    func plan(_ spec: StudySpec, refresh: Bool, owner: String, catalogProgress: @escaping @Sendable (ResearchCatalogProgress) async -> Void, progress: @escaping @Sendable (ResearchPlanningProgress) async -> Void) async throws -> DataPlan {
        let store = try ResearchStore(directory: directory)
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: radarURL)
        let plan = try await provider.plan(spec, refresh: refresh, catalogProgress: catalogProgress, progress: progress)
        try store.database.transaction { try store.pinInputs(plan, owner: owner) }
        await progress(.init(stage: "saving", unit: "steps", completed: 1, total: 1, message: "Data plan and checkpoint saved."))
        return plan
    }
    func prepare(_ study: ResearchStudy, plan: DataPlan, progress: @escaping @Sendable (Int, Int, ResearchPreparationProgress) async -> Void) async throws -> ResearchStudy {
        let plan = try plan.excludingSpread()
        let initialStore = try ResearchStore(directory: directory)
        var checkpoint = try initialStore.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "preparing")
        let previousDurations = Array((checkpoint.sourceSeconds ?? [:]).values)
        checkpoint.phase = "preparing"; checkpoint.error = nil; checkpoint.completedSources = []; checkpoint.sourceSeconds = nil
        try initialStore.database.transaction {
            try initialStore.pinInputs(plan, owner: study.id)
            try initialStore.database.execute("DELETE FROM research_prepared_sources WHERE study=?", [study.id])
            try initialStore.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        
        // A checkpoint is advisory; verify the durable source cache on resume.
        // Keep acquisition actors separate from long synchronous import work,
        // so a busy parser cannot delay starting a SWAP's next download. Both
        // pools reuse CPU-sized sets of connections rather than one per SWAP.
        try ResearchPreparationPipeline.reserveFileCapacity(downloads: Set(plan.sources.map(\.instrument)).count,
                                                            workers: min(ResearchLocalScan.concurrency, plan.sources.count))
        let workers = try (0..<min(ResearchLocalScan.concurrency, plan.sources.count)).map { _ in
            try PreparationWorker(directory: directory, transport: transport, radarURL: radarURL, plan: plan, checkpoint: checkpoint)
        }
        let downloaders = try workers.map { _ in
            try AcquisitionWorker(directory: directory, transport: transport, radarURL: radarURL, instruments: plan.inputInstruments)
        }
        let downloadLanes = Set(plan.sources.filter { $0.instrument.hasSuffix("-USDT-SWAP") }.map(\.instrument)).count
        let coordinator = PreparationCoordinator(total: plan.sources.count, concurrency: workers.count, downloadLanes: downloadLanes, durations: previousDurations)
        try await ResearchPreparationPipeline.run(plan.sources, concurrency: workers.count, acquire: { slot, source in
            try await ResearchRecovery.run(onRetry: { delay, reason in
                await coordinator.report(.init(stage: "retrying", filename: source.filename, instrument: source.instrument,
                                               retryAt: researchNow() + Int64(delay * 1_000), recovery: reason), progress: progress)
            }) {
                try await downloaders[slot].acquire(source) { await coordinator.report($0, progress: progress) }
            }
        }, importSource: { slot, source in
            try await ResearchRecovery.run(onRetry: { delay, reason in
                await coordinator.report(.init(stage: "retrying", filename: source.filename, instrument: source.instrument,
                                               retryAt: researchNow() + Int64(delay * 1_000), recovery: reason), progress: progress)
            }) {
                try await workers[slot].importSource(source) { await coordinator.report($0, progress: progress) }
            }
        }, finish: { slot, source, imported, started in
            try await ResearchRecovery.run(onRetry: { delay, reason in
                await coordinator.report(.init(stage: "retrying", filename: source.filename, instrument: source.instrument,
                                               retryAt: researchNow() + Int64(delay * 1_000), recovery: reason), progress: progress)
            }) {
                try await workers[slot].finish(imported, started: started) { await coordinator.report($0, progress: progress) }
            }
        }, receive: { source, elapsed in
            await coordinator.completed(source, elapsed: elapsed, progress: progress)
        })
        try Task.checkCancellation()
        await progress(plan.sources.count, plan.sources.count, .init(stage: "freezing", filename: "Freezing verified local inputs…", instrument: ""))
        let manifest = try initialStore.freeze(plan)
        var result = study; result.spec = plan.spec; result.manifestID = manifest.id
        checkpoint = try initialStore.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? checkpoint
        checkpoint.phase = "ready"; checkpoint.updatedAt = researchNow()
        try initialStore.database.transaction {
            try initialStore.put(result.id, kind: "study", result)
            try initialStore.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        return result
    }

    private actor AcquisitionWorker {
        private let provider: ResearchDataProvider
        private let instruments: [ResearchInstrument]
        init(directory: URL, transport: any ResearchTransport, radarURL: URL?, instruments: [ResearchInstrument]) throws {
            provider = ResearchDataProvider(store: try ResearchStore(directory: directory), transport: transport, radarURL: radarURL)
            self.instruments = instruments
        }
        func acquire(_ source: ResearchSource, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void) async throws -> ResearchSource {
            try await provider.acquire(source, instruments: instruments, progress: progress)
        }
    }

    private actor PreparationWorker {
        private let provider: ResearchDataProvider
        private let plan: DataPlan
        private let instruments: [ResearchInstrument]
        private let metadata: [String: ResearchInstrument]
        private var checkpoint: Checkpoint
        init(directory: URL, transport: any ResearchTransport, radarURL: URL?, plan: DataPlan, checkpoint: Checkpoint) throws {
            provider = ResearchDataProvider(store: try ResearchStore(directory: directory), transport: transport, radarURL: radarURL)
            self.plan = plan; self.checkpoint = checkpoint
            instruments = plan.inputInstruments
            metadata = Dictionary(instruments.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        }
        func importSource(_ source: ResearchSource, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void) async throws -> ResearchImportResult {
            await progress(.init(stage: "importing", filename: source.filename, instrument: source.instrument))
            return try provider.importAcquired(source, instruments: instruments)
        }
        func finish(_ imported: ResearchImportResult, started: ContinuousClock.Instant, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void) async throws -> Double {
            let source = imported.source
            let instrument = metadata[source.instrument]
            let from = max(plan.from - Int64(plan.warmupHours + 1) * hourMS, (instrument?.listedAt ?? 0) / hourMS * hourMS)
            let through = min(plan.through + 48 * hourMS, researchNow() / hourMS * hourMS - hourMS, instrument?.delistedAt.map { $0 / hourMS * hourMS - hourMS } ?? Int64.max)
            try await provider.finishImport(imported, instruments: instruments, requiredRange: .init(from: from, through: through), progress: progress)
            let elapsed = researchSeconds(started.duration(to: .now))
            checkpoint.updatedAt = researchNow()
            // Commit on the owning worker before publishing completion.
            // Completed inputs survive even if the UI or
            // another transfer is slow, fails, or is cancelled.
            try provider.store.database.transaction {
                try provider.store.pinPreparedSource(source, plan: plan, owner: checkpoint.studyID)
                try provider.store.database.execute("INSERT OR REPLACE INTO research_prepared_sources VALUES (?,?,?)", [checkpoint.studyID, source.id, elapsed])
                try provider.store.put("checkpoint:\(checkpoint.studyID)", kind: "checkpoint", checkpoint)
            }
            return elapsed
        }
    }

    private actor PreparationCoordinator {
        private let total: Int, concurrency: Int, downloadLanes: Int
        private let started = ContinuousClock.now
        private var count = 0
        private var measuredSeconds = 0.0
        private var measuredCount = 0
        private var reported: ContinuousClock.Instant?
        private var pending: ResearchPreparationProgress?
        private var delivery: Task<Void, Never>?
        init(total: Int, concurrency: Int, downloadLanes: Int, durations: [Double]) {
            self.total = total; self.concurrency = max(1, concurrency)
            self.downloadLanes = downloadLanes
            measuredSeconds = durations.reduce(0, +); measuredCount = durations.count
        }
        func report(_ update: ResearchPreparationProgress, progress: @escaping @Sendable (Int, Int, ResearchPreparationProgress) async -> Void) async {
            // Hundreds of simultaneous transfers must not flood the main actor.
            // Keep retries visible immediately and coalesce ordinary updates.
            if update.retryAt == nil, let reported, reported.duration(to: .now) < .milliseconds(100) {
                pending = update
                if delivery == nil {
                    delivery = Task {
                        do { try await Task.sleep(until: reported + .milliseconds(100), clock: .continuous) }
                        catch { return }
                        await self.flush(progress: progress)
                    }
                }
                return
            }
            pending = nil; delivery?.cancel(); delivery = nil
            await publish(update, progress: progress)
        }
        private func flush(progress: @Sendable (Int, Int, ResearchPreparationProgress) async -> Void) async {
            guard !Task.isCancelled else { return }
            delivery = nil
            guard let update = pending else { return }
            pending = nil
            await publish(update, progress: progress)
        }
        private func publish(_ update: ResearchPreparationProgress, progress: @Sendable (Int, Int, ResearchPreparationProgress) async -> Void) async {
            reported = .now
            var update = update
            update.workers = concurrency
            update.downloadLanes = downloadLanes
            if count > 0 {
                update.remainingSeconds = researchSeconds(started.duration(to: .now)) / Double(count) * Double(total - count)
            } else if measuredCount > 0 {
                update.remainingSeconds = measuredSeconds / Double(measuredCount) * Double(total - count) / Double(concurrency)
            }
            await progress(count, total, update)
        }
        func completed(_ source: ResearchSource, elapsed: Double, progress: @Sendable (Int, Int, ResearchPreparationProgress) async -> Void) async {
            count += 1; measuredCount += 1; measuredSeconds += elapsed
            pending = nil; delivery?.cancel(); delivery = nil
            await publish(.init(stage: "prepared", filename: source.filename, instrument: source.instrument), progress: progress)
        }
    }
    func run(_ study: ResearchStudy, progress: @escaping @Sendable (Int, Int, String) -> Void) async throws -> StudyReport {
        let store = try ResearchStore(directory: directory)
        guard let id = study.manifestID, let manifest = try store.get(id, as: DataManifest.self) else { throw FilterError("Prepare data before running this study.") }
        guard manifest.engine == ResearchVersion.engine else { throw FilterError("This checkpoint requires engine \(manifest.engine). Keep its frozen results or copy its configuration to use the current engine.") }
        var checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "running")
        checkpoint.phase = "running"; checkpoint.error = nil; try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        try study.spec.validate()
        progress(0, 0, "Indexing frozen history for calculation…")
        try store.prepareCalculationIndexes()
        checkpoint = try store.calculationCheckpoint(checkpoint)
        checkpoint = try await ResearchEngine.runConcurrent(directory: directory, study: study, manifest: manifest, checkpoint: checkpoint, progress: progress)
        progress(1, 1, "Calculating baselines, medians and confidence intervals…")
        let report = try store.report(study, manifest: manifest) { progress(1, 1, $0) }
        checkpoint.phase = "completed"; checkpoint.updatedAt = researchNow()
        try store.database.transaction {
            try store.put("report:\(study.id)", kind: "report", report)
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        return report
    }
}

// Frozen chart reads and CSV exports stay responsive while the single long
// preparation/calculation worker is occupied. Each reader has its own WAL connection.
actor ResearchReader {
    private let directory: URL
    init(directory: URL) { self.directory = directory }
    func chart(eventID: String, endingAt: Int64?) throws -> ResearchChart {
        let store = try ResearchStore(directory: directory)
        guard let event = try store.event(eventID), let study = try store.get(event.studyID, as: ResearchStudy.self),
              let id = study.manifestID, let manifest = try store.get(id, as: DataManifest.self),
              let instrument = manifest.instruments.first(where: { $0.id == event.instrument }) else { throw FilterError("This frozen event no longer exists.") }
        var oldest: Int64?, latest: Int64?
        try store.database.query("SELECT MIN(d.ts),MAX(d.ts) FROM research_pins p JOIN research_data d USING(revision) WHERE p.manifest=? AND d.inst=? AND d.kind='candle'", [id, instrument.id]) {
            oldest = ResearchStore.number($0, 0).map { Int64($0) }; latest = ResearchStore.number($0, 1).map { Int64($0) }
        }
        let end = min(latest ?? event.timestamp, max((oldest ?? event.timestamp) + 95 * hourMS, endingAt ?? event.timestamp + 47 * hourMS))
        let series = ResearchEngine.reconstruct(try store.series(instrument.id, from: max(0, end - 370 * hourMS), through: end, manifest: id))
        let expressions = ["VWAP(14)", "EMA(200)", "LogBB(20, 2, \"upper\")", "LogBB(20, 2, \"middle\")", "LogBB(20, 2, \"lower\")"]
        let compiled = try FilterCompiler.compile(FilterConfigV2(root: FilterNode(children: expressions.map { FilterNode(kind: "condition", left: $0, comparison: "present") })))
        var bars: [ResearchChartBar] = []
        for h in stride(from: end - 95 * hourMS, through: end, by: Int(hourMS)) {
            guard let bar = series.candles[h], let open = bar.open else { continue }
            let e = FilterEvaluator(market: ResearchEngine.context(instrument: instrument, hour: h, series: series), filter: compiled)
            func value(_ expression: String) -> Double? { e.scalar(expression, at: h).number.flatMap { $0.isFinite ? $0 : nil } }
            bars.append(.init(hour: h, open: open, high: bar.high, low: bar.low, close: bar.close,
                vwap: value(expressions[0]), ema: value(expressions[1]), logBBUpper: value(expressions[2]), logBBMiddle: value(expressions[3]), logBBLower: value(expressions[4]),
                roc: e.metric("roc", at: h).number, maroc: e.metric("maroc", at: h).number, rsi6: e.metric("rsi6", at: h).number, rsi12: e.metric("rsi12", at: h).number, rsi24: e.metric("rsi24", at: h).number,
                oi: series.stats[h]?.oi, buy: series.stats[h]?.buy, sell: series.stats[h]?.sell))
        }
        return .init(bars: bars, endHour: end, oldestHour: oldest, latestHour: latest, signalHour: event.timestamp - hourMS, manifestID: id)
    }
    func export(studyID: String, kind: String, to file: URL) throws {
        let store = try ResearchStore(directory: directory)
        guard let report = try store.get("report:\(studyID)", as: StudyReport.self), let manifest = try store.get(report.manifestID, as: DataManifest.self) else { throw FilterError("Complete this study before exporting it.") }
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).csv")
        FileManager.default.createFile(atPath: temporary.path, contents: nil)
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        func write(_ values: [String]) throws {
            let line = values.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: ",") + "\r\n"
            try handle.write(contentsOf: Data(line.utf8))
        }
        let spec = try researchJSON(report.spec)
        if kind == "summary" {
            try write(["study_id", "manifest_id", "data_digest", "engine", "source_revision", "group", "rule", "hours", "n", "excluded", "net_n", "mean", "median", "win_rate", "net_mean", "net_median", "net_win_rate", "mfe", "mae", "baseline", "excess", "ci_low", "ci_high", "net_ci_low", "net_ci_high", "spec_json"])
            func n(_ value: Double?) -> String { value.map { String($0) } ?? "" }
            for s in report.summaries {
                try Task.checkCancellation()
                try write([studyID, manifest.id, manifest.digest, manifest.engine, manifest.sourceRevision, s.group, report.spec.rules[s.ruleIndex].name, String(s.hours), String(s.count), String(s.excluded), String(s.netCount), n(s.mean), n(s.median), n(s.winRate), n(s.netMean), n(s.netMedian), n(s.netWinRate), n(s.mfe), n(s.mae), n(s.baseline), n(s.excess), n(s.intervalLow), n(s.intervalHigh), n(s.netIntervalLow), n(s.netIntervalHigh), spec])
            }
        } else {
            try write(["study_id", "manifest_id", "data_digest", "engine", "instrument", "timestamp_utc_ms", "rule", "direction", "entry", "split", "score", "score_complete", "status", "setup", "hours", "gross", "net", "mfe", "mae", "exclusion", "net_unavailable", "sources_json", "trace_json", "opportunity_json"])
            var offset = 0
            while true {
                try Task.checkCancellation(); let events = try store.events(studyID, offset: offset, limit: 100); if events.isEmpty { break }
                for event in events {
                    for o in event.outcomes {
                        try write([studyID, manifest.id, manifest.digest, manifest.engine, event.instrument, String(event.timestamp), report.spec.rules[event.ruleIndex].name, event.direction, event.entry, event.split, event.score.map { String($0) } ?? "", String(event.scoreComplete), event.status, event.setup ?? "", String(o.hours), o.gross.map { String($0) } ?? "", o.net.map { String($0) } ?? "", o.mfe.map { String($0) } ?? "", o.mae.map { String($0) } ?? "", o.reason ?? "", o.netReason ?? "", try researchJSON(event.sources), event.traceJSON, event.opportunityJSON])
                    }
                }
                offset += events.count
            }
        }
        try handle.synchronize(); try handle.close()
        if FileManager.default.fileExists(atPath: file.path) { _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary) }
        else { try FileManager.default.moveItem(at: temporary, to: file) }
    }
}

@MainActor
final class ResearchController {
    private let store: ResearchStore
    private let worker: ResearchWorker
    private let reader: ResearchReader
    private let library: ResearchLibrary
    private let exportDestination: (@MainActor (String, NSWindow?) async -> URL?)?
    private var task: Task<Void, Never>?
    private var activeStudyID: String?
    private var activity: NSObjectProtocol?
    private(set) var status: ResearchJobStatus?
    var isBusy: Bool { task != nil }
    var onBusyChanged: ((Bool) -> Void)?
    init(directory: URL = ResearchStore.defaultDirectory, transport: any ResearchTransport = OKXResearchTransport(), radarURL: URL? = nil, exportDestination: (@MainActor (String, NSWindow?) async -> URL?)? = nil) throws {
        self.exportDestination = exportDestination
        store = try ResearchStore(directory: directory); worker = ResearchWorker(directory: directory, transport: transport, radarURL: radarURL)
        reader = ResearchReader(directory: directory)
        library = ResearchLibrary(directory: directory)
    }
    private func begin(_ phase: String, studyID: String? = nil, persist: () throws -> Void = {}) throws -> String {
        guard task == nil else { throw FilterError("Pause or cancel the current research task first.") }
        try persist()
        activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Complete user-requested research while the window is minimized")
        let id = UUID().uuidString; status = .init(id: id, phase: phase); activeStudyID = studyID; onBusyChanged?(true); return id
    }
    private func advance(_ id: String, completed: Int, total: Int, message: String, preparation: ResearchPreparationProgress? = nil, catalog: ResearchCatalogProgress? = nil, planning: ResearchPlanningProgress? = nil) {
        guard status?.id == id, ["planning", "preparing", "running"].contains(status?.phase ?? "") else { return }
        status?.completed = completed; status?.total = total; status?.message = message
        status?.preparation = preparation; status?.updatedAt = researchNow()
        status?.catalog = catalog; status?.planning = planning
        status?.retryAt = nil; status?.recovery = nil
    }
    private func retry(_ id: String, delay: Double, reason: String) {
        guard status?.id == id else { return }
        status?.retryAt = researchNow() + Int64(delay * 1_000)
        status?.recovery = reason; status?.updatedAt = researchNow()
    }
    private func finish(_ id: String, phase: String, resultID: String? = nil, error: String = "") {
        guard status?.id == id else { return }
        let context = status?.phase == "planning" && !error.isEmpty ? status?.message : nil
        status?.phase = phase; status?.resultID = resultID; status?.error = context.map { $0 + "\n" + error } ?? error
        if phase == "ready" { status?.message = "Dataset frozen and ready to run." }
        if phase == "completed" { status?.message = "Study complete." }
        status?.updatedAt = researchNow()
        status?.retryAt = nil; status?.recovery = nil
        if let studyID = activeStudyID, phase == "failed" {
            do {
                var checkpoint = try store.get("checkpoint:\(studyID)", as: Checkpoint.self) ?? Checkpoint(studyID: studyID, phase: phase)
                checkpoint.phase = phase; checkpoint.error = status?.error; checkpoint.updatedAt = researchNow()
                try store.put("checkpoint:\(studyID)", kind: "checkpoint", checkpoint)
            } catch { status?.error += " Checkpoint status could not be saved: \(error.localizedDescription)" }
        }
        if ["ready", "completed"].contains(phase) { let total = status?.total ?? 0; status?.completed = total }
        task = nil
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
        onBusyChanged?(false)
    }
    func plan(_ spec: StudySpec, refresh: Bool = false, resumeID: String? = nil) throws -> String {
        let spec = try spec.resolvingStrategyRules()
        try spec.validate()
        let study = try resumeID.flatMap { try store.get($0, as: ResearchStudy.self) } ?? ResearchStudy(spec: spec, planID: UUID().uuidString)
        let id = try begin("planning", studyID: study.id) {
            var checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "planning")
            checkpoint.phase = "planning"; checkpoint.refresh = refresh; checkpoint.error = nil
            try store.database.transaction {
                try store.put(study.id, kind: "study", study)
                try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
            }
        }
        task = Task.detached(priority: .userInitiated) { [self, worker] in
            do {
                let plan = try await ResearchRecovery.run(onRetry: { delay, reason in await self.retry(id, delay: delay, reason: reason) }) {
                    let plan = try await worker.plan(spec, refresh: refresh, owner: study.id, catalogProgress: { update in
                        await self.advance(id, completed: update.completed, total: update.total, message: update.message, catalog: update)
                    }) { update in await self.advance(id, completed: update.completed, total: update.total, message: update.message, planning: update) }
                    try await self.savePlan(plan, study: study)
                    return plan
                }
                await self.finish(id, phase: "planned", resultID: plan.id)
            } catch { await self.finish(id, phase: Task.isCancelled ? "paused" : "failed", resultID: study.id, error: Task.isCancelled ? "" : error.localizedDescription) }
        }
        return id
    }
    private func savePlan(_ plan: DataPlan, study: ResearchStudy) throws {
        var study = study; study.planID = plan.id; study.spec = plan.spec
        var checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "planned")
        checkpoint.phase = "planned"; checkpoint.updatedAt = researchNow()
        try store.database.transaction {
            try store.put(study.id, kind: "study", study)
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
    }
    func prepare(planID: String, resumeID: String? = nil) throws -> String {
        guard let savedPlan = try store.get(planID, as: DataPlan.self) else { throw FilterError("Create a data plan first.") }
        let plan = try savedPlan.excludingSpread()
        let existing = try store.objects("study", as: ResearchStudy.self).first { $0.planID == planID && $0.manifestID == nil }
        var study = try resumeID.flatMap { try store.get($0, as: ResearchStudy.self) } ?? existing ?? ResearchStudy(spec: plan.spec, planID: planID)
        study.spec = plan.spec
        guard (try store.get("checkpoint:\(study.id)", as: Checkpoint.self))?.phase != "cancelled" else { throw FilterError("This task was cancelled. Copy its configuration to start a new study.") }
        let id = try begin("preparing", studyID: study.id) {
            try store.database.transaction {
                try store.put(plan.id, kind: "plan", plan)
                try store.put(study.id, kind: "study", study)
            }
        }
        task = Task.detached(priority: .userInitiated) { [self, worker] in
            do {
                let prepared = try await ResearchRecovery.run(onRetry: { delay, reason in await self.retry(id, delay: delay, reason: reason) }) {
                    try await worker.prepare(study, plan: plan) { n, total, update in await self.advance(id, completed: n, total: total, message: update.filename, preparation: update) }
                }
                await self.finish(id, phase: "ready", resultID: prepared.id)
            } catch { await self.finish(id, phase: Task.isCancelled ? "paused" : "failed", resultID: study.id, error: Task.isCancelled ? "" : error.localizedDescription) }
        }
        return id
    }
    func run(studyID: String) throws -> String {
        guard let study = try store.get(studyID, as: ResearchStudy.self), study.manifestID != nil else { throw FilterError("Prepare the study's data first.") }
        guard (try store.get("checkpoint:\(study.id)", as: Checkpoint.self))?.phase != "cancelled" else { throw FilterError("This task was cancelled. Copy its configuration to start a new study.") }
        guard try store.get("report:\(study.id)", as: StudyReport.self) == nil else { throw FilterError("This completed experiment is immutable. Copy its configuration to run a new study.") }
        let id = try begin("running", studyID: study.id)
        task = Task.detached(priority: .userInitiated) { [self, worker] in
            do {
                let report = try await ResearchRecovery.run(onRetry: { delay, reason in await self.retry(id, delay: delay, reason: reason) }) {
                    try await worker.run(study) { n, total, message in Task { await self.advance(id, completed: n, total: total, message: message) } }
                }
                await self.finish(id, phase: "completed", resultID: report.studyID)
            } catch { await self.finish(id, phase: Task.isCancelled ? "paused" : "failed", resultID: study.id, error: Task.isCancelled ? "" : error.localizedDescription) }
        }
        return id
    }
    func stop(cancel: Bool = false) async throws {
        guard let pending = task else { return }
        let jobID = status?.id, studyID = activeStudyID
        pending.cancel(); await pending.value
        // Another job may have started while this one wound down; never relabel it.
        guard status?.id == jobID else { return }
        if let id = studyID {
            var checkpoint = try store.get("checkpoint:\(id)", as: Checkpoint.self) ?? Checkpoint(studyID: id, phase: "paused")
            // A job that reached a terminal state before cancellation took effect keeps it;
            // only an explicit cancel discards a frozen (ready) dataset.
            if checkpoint.phase == "completed" || (!cancel && checkpoint.phase == "ready") { return }
            checkpoint.phase = cancel ? "cancelled" : "paused"; checkpoint.updatedAt = researchNow()
            try store.put("checkpoint:\(id)", kind: "checkpoint", checkpoint)
        }
        status?.phase = cancel ? "cancelled" : "paused"; status?.resultID = studyID
    }
    private func snapshot<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: Data(try researchJSON(value).utf8)) }
    func handle(_ request: [String: Any], window: NSWindow? = nil) async throws -> [String: Any] {
        let action = request["action"] as? String ?? "inventory"
        switch action {
        case "plan":
            guard let value = request["spec"] else { throw FilterError("A complete study specification is required.") }
            let spec = try JSONDecoder().decode(StudySpec.self, from: SafeJSON.data(value))
            return ["jobID": try plan(spec, refresh: request["refresh"] as? Bool == true)]
        case "prepare":
            guard let id = request["planID"] as? String else { throw FilterError("Choose a data plan.") }
            return ["jobID": try prepare(planID: id)]
        case "run", "resume":
            guard let id = request["studyID"] as? String, let study = try store.get(id, as: ResearchStudy.self) else { throw FilterError("Choose a saved study.") }
            if action == "resume", (try store.get("checkpoint:\(id)", as: Checkpoint.self))?.phase == "cancelled" { throw FilterError("This task was cancelled. Create a new study to reuse its cached data.") }
            if action == "resume", study.manifestID == nil, try store.get(study.planID, as: DataPlan.self) == nil {
                let checkpoint = try store.get("checkpoint:\(id)", as: Checkpoint.self)
                return ["jobID": try plan(study.spec, refresh: checkpoint?.refresh == true, resumeID: id)]
            }
            return ["jobID": try study.manifestID == nil ? prepare(planID: study.planID, resumeID: id) : run(studyID: id)]
        case "pause", "cancel": try await stop(cancel: action == "cancel"); return ["ok": true]
        case "planDetail":
            guard let id = request["planID"] as? String else { throw FilterError("Data plan not found.") }
            return try await library.plan(id)
        case "study":
            guard let id = request["studyID"] as? String else { throw FilterError("Study not found.") }
            return try await library.study(id)
        case "events":
            guard let id = request["studyID"] as? String else { throw FilterError("Choose a study.") }
            return try await library.events(id, offset: request["offset"] as? Int ?? 0)
        case "chart":
            guard let id = request["eventID"] as? String else { throw FilterError("Choose an event.") }
            let chart = try await reader.chart(eventID: id, endingAt: (request["endHour"] as? NSNumber)?.int64Value)
            return ["chart": try snapshot(chart)]
        case "export":
            guard let id = request["studyID"] as? String else { throw FilterError("Choose a study.") }
            let requestedKind = request["kind"] as? String ?? "summary"
            let kind = ["events", "equity"].contains(requestedKind) ? requestedKind : "summary"
            let url: URL?
            if let exportDestination { url = await exportDestination(kind, window) }
            else {
                let panel = NSSavePanel(); panel.allowedContentTypes = [.commaSeparatedText]; panel.nameFieldStringValue = "Research-\(kind)-\(id.prefix(8)).csv"
                let result: NSApplication.ModalResponse
                if let window { result = await withCheckedContinuation { continuation in panel.beginSheetModal(for: window) { continuation.resume(returning: $0) } } }
                else { result = panel.runModal() }
                url = result == .OK ? panel.url : nil
            }
            guard let url else { return ["cancelled": true] }
            try await reader.export(studyID: id, kind: kind, to: url); return ["ok": true]
        case "delete":
            guard let id = request["studyID"] as? String, activeStudyID != id || !isBusy else { throw FilterError("Stop the study before deleting it.") }
            try store.deleteStudy(id); return ["ok": true]
        case "importCatalog":
            guard !isBusy else { throw FilterError("Stop research before importing an instrument catalog.") }
            let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false; panel.canChooseDirectories = false
            let response: NSApplication.ModalResponse
            if let window { response = await withCheckedContinuation { continuation in panel.beginSheetModal(for: window) { continuation.resume(returning: $0) } } }
            else { response = panel.runModal() }
            guard response == .OK, let file = panel.url else { return ["cancelled": true] }
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            guard data.count <= 8 * 1024 * 1024 else { throw FilterError("The verified instrument catalog exceeds 8 MiB.") }
            let instruments = try JSONDecoder().decode([ResearchInstrument].self, from: data)
            for instrument in instruments {
                guard instrument.verified, instrument.id.hasSuffix("-USDT-SWAP"), instrument.listedAt.map({ $0 > 0 }) == true,
                      instrument.delistedAt.map({ $0 > instrument.listedAt! }) != false,
                      let url = URL(string: instrument.source), url.scheme == "https", url.host.map({ $0 == "okx.com" || $0.hasSuffix(".okx.com") }) == true,
                      instrument.contractValue.map({ $0.isFinite && $0 > 0 }) != false else { throw FilterError("Each imported symbol requires verified crypto USDT swap metadata, a listing timestamp and an official OKX evidence URL.") }
            }
            let source = ResearchSource(id: researchHash(data), instrument: "CATALOG", kind: "metadata", from: instruments.compactMap(\.listedAt).min() ?? 0, through: researchNow(), url: file.path, filename: "Verified historical metadata", sizeBytes: Int64(data.count), archive: false, rawHash: researchHash(data))
            try data.write(to: store.rawURL(source), options: .atomic)
            try store.database.transaction {
                try store.put(source.id, kind: "source", source)
                for var instrument in instruments { instrument.metadataSourceID = source.id; try store.put("instrument:\(instrument.id)", kind: "instrument", instrument) }
            }
            return ["ok": true, "count": instruments.count]
        case "cleanCache":
            guard !isBusy else { throw FilterError("Stop research before clearing unreferenced cache.") }
            return ["bytesRemoved": try store.cleanCache()]
        case "inventory":
            var result = try await library.inventory()
            var studies = result["studies"] as! [[String: Any]]
            // Read the live job only after the background query returns. A job
            // can finish (or a new one start) while this request is suspended.
            if isBusy, let index = studies.firstIndex(where: { $0["id"] as? String == activeStudyID }) {
                studies[index]["phase"] = status?.phase ?? "running"
                studies[index]["active"] = true
            }
            result["studies"] = studies
            result["job"] = try status.map(snapshot) ?? NSNull()
            return result
        default: throw FilterError("Unknown research action.")
        }
    }
}
