import Foundation

// Runs the shipping research worker without AppKit, windows or network work.
// The supplied directory must be an isolated database snapshot: the command
// creates a new study and leaves its full report, events and checkpoints there.
enum ResearchBenchmark {
    static func start(arguments: [String]) -> Never {
        guard arguments.count == 4 else {
            fputs("Usage: PerpetualRadar --study-benchmark SNAPSHOT_DIRECTORY STUDY_ID\n", stderr)
            exit(2)
        }
        let directory = URL(fileURLWithPath: arguments[2], isDirectory: true), studyID = arguments[3]
        let reportOnly = arguments[1] == "--study-report-benchmark"
        Task.detached(priority: .userInitiated) {
            do {
                let store = try ResearchStore(directory: directory)
                guard let original = try store.get(studyID, as: ResearchStudy.self), let manifestID = original.manifestID,
                      let manifest = try store.get(manifestID, as: DataManifest.self) else { throw FilterError("Choose a prepared study in the isolated snapshot.") }
                let clock = ContinuousClock(), started = clock.now, output = ResearchBenchmarkProgress(started: started)
                let study: ResearchStudy
                let report: StudyReport
                if reportOnly {
                    study = original
                    report = try store.report(study, manifest: manifest) { output.update(1, 1, $0) }
                } else {
                    var copy = ResearchStudy(spec: original.spec, planID: original.planID, manifestID: manifestID)
                    copy.spec.name = String((original.spec.name + " benchmark").prefix(120)); study = copy
                    try store.put(study.id, kind: "study", study)
                    var checkpoint = try store.get("checkpoint:\(original.id)", as: Checkpoint.self) ?? .init(studyID: original.id, phase: "running")
                    checkpoint.studyID = study.id; checkpoint.phase = "running"; checkpoint.instrumentIndex = 0; checkpoint.nextHour = nil
                    checkpoint.episodes = [:]; checkpoint.calculation = nil; checkpoint.error = nil
                    try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
                    let worker = ResearchWorker(directory: directory)
                    report = try await worker.run(study) { completed, total, message in output.update(completed, total, message) }
                }
                let elapsed = researchSeconds(started.duration(to: clock.now))
                let events = try store.count("SELECT COUNT(*) FROM research_events WHERE study=?", [study.id])
                let summary = try researchJSON(ResearchBenchmarkResult(studyID: study.id, manifestID: manifest.id, seconds: elapsed, evaluated: report.evaluated,
                                                                     events: events, summaries: report.summaries.count, processors: ProcessInfo.processInfo.activeProcessorCount))
                print(summary)
                try Data(summary.utf8).write(to: directory.appendingPathComponent(reportOnly ? "report-benchmark-result.json" : "benchmark-result.json"), options: .atomic)
                exit(0)
            } catch {
                fputs("Study benchmark failed: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
        }
        dispatchMain()
    }
}

private struct ResearchBenchmarkResult: Codable {
    var studyID: String
    var manifestID: String
    var seconds: Double
    var evaluated: Int
    var events: Int
    var summaries: Int
    var processors: Int
}

private final class ResearchBenchmarkProgress: @unchecked Sendable {
    private let lock = NSLock()
    private let started: ContinuousClock.Instant
    private var reported = ContinuousClock.now
    init(started: ContinuousClock.Instant) { self.started = started }
    func update(_ completed: Int, _ total: Int, _ message: String) {
        lock.withLock {
            let now = ContinuousClock.now
            guard reported.duration(to: now) >= .seconds(5) || completed == total else { return }
            reported = now
            print("\(String(format: "%.1f", researchSeconds(started.duration(to: now))))s · \(completed)/\(total) · \(message)")
            fflush(stdout)
        }
    }
}
