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
        try store.pinInputs(plan, owner: owner)
        await progress(.init(stage: "saving", unit: "steps", completed: 1, total: 1, message: "Data plan and checkpoint saved."))
        return plan
    }
    func prepare(_ study: ResearchStudy, plan: DataPlan, progress: @escaping @Sendable (Int, Int, ResearchPreparationProgress) async -> Void) async throws -> ResearchStudy {
        let store = try ResearchStore(directory: directory), provider = ResearchDataProvider(store: store, transport: transport, radarURL: radarURL)
        let plan = try plan.excludingSpread()
        var checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "preparing")
        try store.pinInputs(plan, owner: study.id)
        checkpoint.phase = "preparing"; checkpoint.error = nil; try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        var measuredSeconds = 0.0, measuredSources = 0
        for (index, source) in plan.sources.enumerated() {
            try Task.checkCancellation()
            if checkpoint.completedSources.contains(source.id) { continue }
            let started = ContinuousClock.now
            let estimate = measuredSources > 0 ? measuredSeconds / Double(measuredSources) * Double(plan.sources.count - index) : nil
            do {
                try await provider.prepare(source, instruments: plan.inputInstruments) { update in
                    var update = update
                    if let estimate {
                        let remaining = max(update.fileRemainingSeconds ?? 0, estimate - researchSeconds(started.duration(to: .now)))
                        update.remainingSeconds = remaining > 0 ? remaining : nil
                    }
                    await progress(index, plan.sources.count, update)
                }
            } catch {
                if Task.isCancelled { throw error }
                throw FilterError("\(source.instrument) · \(source.filename): \(error.localizedDescription)")
            }
            measuredSeconds += researchSeconds(started.duration(to: .now)); measuredSources += 1
            try store.pinInputs(plan, owner: study.id)
            checkpoint.completedSources.append(source.id); checkpoint.updatedAt = researchNow()
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
            await progress(index + 1, plan.sources.count, .init(stage: "prepared", filename: source.filename, instrument: source.instrument))
        }
        try Task.checkCancellation()
        await progress(plan.sources.count, plan.sources.count, .init(stage: "freezing", filename: "Freezing verified local inputs…", instrument: ""))
        let manifest = try store.freeze(plan)
        var result = study; result.spec = plan.spec; result.manifestID = manifest.id
        checkpoint.phase = "ready"; checkpoint.updatedAt = researchNow()
        try store.database.transaction {
            try store.put(result.id, kind: "study", result)
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        return result
    }
    func run(_ study: ResearchStudy, progress: @escaping @Sendable (Int, Int, String) -> Void) throws -> StudyReport {
        let store = try ResearchStore(directory: directory)
        guard let id = study.manifestID, let manifest = try store.get(id, as: DataManifest.self) else { throw FilterError("Prepare data before running this study.") }
        guard manifest.engine == ResearchVersion.engine else { throw FilterError("This checkpoint requires engine \(manifest.engine). Keep its frozen results or copy its configuration to use the current engine.") }
        var checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "running")
        checkpoint.phase = "running"; checkpoint.error = nil; try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        try study.spec.validate()
        try ResearchEngine.run(store: store, study: study, manifest: manifest, checkpoint: &checkpoint, progress: progress)
        progress(1, 1, "Calculating baselines, medians and confidence intervals…")
        let report = try store.report(study, manifest: manifest)
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
        let expressions = ["VWAP(14)", "EMA(200)", "LogBBUpper(20, 2)", "LogBBMiddle(20, 2)", "LogBBLower(20, 2)"]
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
    }
    private func begin(_ phase: String, studyID: String? = nil) throws -> String {
        guard task == nil else { throw FilterError("Pause or cancel the current research task first.") }
        activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Complete user-requested research while the window is minimized")
        let id = UUID().uuidString; status = .init(id: id, phase: phase); activeStudyID = studyID; onBusyChanged?(true); return id
    }
    private func advance(_ id: String, completed: Int, total: Int, message: String, preparation: ResearchPreparationProgress? = nil, catalog: ResearchCatalogProgress? = nil, planning: ResearchPlanningProgress? = nil) {
        guard status?.id == id, ["planning", "preparing", "running"].contains(status?.phase ?? "") else { return }
        status?.completed = completed; status?.total = total; status?.message = message
        status?.preparation = preparation; status?.updatedAt = researchNow()
        status?.catalog = catalog; status?.planning = planning
    }
    private func finish(_ id: String, phase: String, resultID: String? = nil, error: String = "") {
        guard status?.id == id else { return }
        let context = status?.phase == "planning" && !error.isEmpty ? status?.message : nil
        status?.phase = phase; status?.resultID = resultID; status?.error = context.map { $0 + "\n" + error } ?? error
        if phase == "ready" { status?.message = "Dataset frozen and ready to run." }
        if phase == "completed" { status?.message = "Study complete." }
        status?.updatedAt = researchNow()
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
        let id = try begin("planning", studyID: study.id)
        var checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self) ?? Checkpoint(studyID: study.id, phase: "planning")
        checkpoint.phase = "planning"; checkpoint.refresh = refresh; checkpoint.error = nil
        try store.database.transaction {
            try store.put(study.id, kind: "study", study)
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        task = Task.detached(priority: .background) { [self, worker] in
            do {
                let plan = try await worker.plan(spec, refresh: refresh, owner: study.id, catalogProgress: { update in
                    await self.advance(id, completed: update.completed, total: update.total, message: update.message, catalog: update)
                }) { update in await self.advance(id, completed: update.completed, total: update.total, message: update.message, planning: update) }
                try await self.savePlan(plan, study: study)
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
        let id = try begin("preparing", studyID: study.id)
        try store.database.transaction {
            try store.put(plan.id, kind: "plan", plan)
            try store.put(study.id, kind: "study", study)
        }
        task = Task.detached(priority: .background) { [self, worker] in
            do {
                let prepared = try await worker.prepare(study, plan: plan) { n, total, update in await self.advance(id, completed: n, total: total, message: update.filename, preparation: update) }
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
        task = Task.detached(priority: .background) { [self, worker] in
            do {
                let report = try await worker.run(study) { n, total, message in Task { await self.advance(id, completed: n, total: total, message: message) } }
                await self.finish(id, phase: "completed", resultID: report.studyID)
            } catch { await self.finish(id, phase: Task.isCancelled ? "paused" : "failed", resultID: study.id, error: Task.isCancelled ? "" : error.localizedDescription) }
        }
        return id
    }
    func stop(cancel: Bool = false) async throws {
        guard let pending = task else { return }
        pending.cancel(); await pending.value
        if let id = activeStudyID {
            var checkpoint = try store.get("checkpoint:\(id)", as: Checkpoint.self) ?? Checkpoint(studyID: id, phase: "paused")
            if checkpoint.phase == "completed" { return }
            checkpoint.phase = cancel ? "cancelled" : "paused"; checkpoint.updatedAt = researchNow()
            try store.put("checkpoint:\(id)", kind: "checkpoint", checkpoint)
        }
        status?.phase = cancel ? "cancelled" : "paused"; status?.resultID = activeStudyID
    }
    private func snapshot<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: Data(try researchJSON(value).utf8)) }
    func handle(_ request: [String: Any], window: NSWindow? = nil) async throws -> [String: Any] {
        let action = request["action"] as? String ?? "inventory"
        switch action {
        case "plan":
            guard let value = request["spec"] else { throw FilterError("A complete study specification is required.") }
            let spec = try JSONDecoder().decode(StudySpec.self, from: JSONSerialization.data(withJSONObject: value))
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
            guard let id = request["planID"] as? String, let saved = try store.get(id, as: DataPlan.self) else { throw FilterError("Data plan not found.") }
            let plan = try saved.excludingSpread()
            return ["plan": try snapshot(plan), "estimatedBytes": plan.estimatedBytes]
        case "study":
            guard let id = request["studyID"] as? String, let study = try store.get(id, as: ResearchStudy.self) else { throw FilterError("Study not found.") }
            let report = try store.get("report:\(id)", as: StudyReport.self)
            let manifest = try study.manifestID.flatMap { try store.get($0, as: DataManifest.self) }
            let savedPlan = try store.get(study.planID, as: DataPlan.self)
            let plan = try study.manifestID == nil ? savedPlan?.excludingSpread() : savedPlan
            return ["study": try snapshot(study), "report": try report.map(snapshot) ?? NSNull(), "manifest": try manifest.map(snapshot) ?? NSNull(), "plan": try plan.map(snapshot) ?? NSNull(), "estimatedBytes": plan?.estimatedBytes ?? 0]
        case "events":
            guard let id = request["studyID"] as? String else { throw FilterError("Choose a study.") }
            return ["events": try snapshot(store.events(id, offset: request["offset"] as? Int ?? 0)), "count": try store.count("SELECT COUNT(*) FROM research_events WHERE study=?", [id])]
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
            var studies: [[String: Any]] = []
            for study in try store.objects("study", as: ResearchStudy.self) where ["filter", "score", "comparison"].contains(study.spec.kind) && (study.spec.strategyPhase == nil || study.spec.strategyPhase == "bullishSetup") {
                var item = try snapshot(study) as! [String: Any]
                let checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self)
                item["phase"] = activeStudyID == study.id && isBusy ? status?.phase ?? "running" : ["running", "preparing", "planning"].contains(checkpoint?.phase ?? "") ? "paused" : checkpoint?.phase ?? "paused"
                item["error"] = checkpoint?.error ?? ""
                studies.append(item)
            }
            return ["job": try status.map(snapshot) ?? NSNull(), "studies": studies, "cacheDirectory": store.directory.path,
                "rawFiles": try store.count("SELECT COUNT(*) FROM research_objects WHERE kind='source'"), "cachedRows": try store.count("SELECT COUNT(*) FROM research_heads")]
        default: throw FilterError("Unknown research action.")
        }
    }
}
