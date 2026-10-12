import Foundation
import CryptoKit

enum ResearchVersion {
    static let parser = "okx-archives-2"
    static let engine = "hourly-close-btc-no-spread-3"
    static let horizons = [1, 3, 6, 12, 24, 48]
    static let memoryBudget = 128 * 1024 * 1024
    static func warmup(_ rules: [CompiledFilter]) -> Int { max(275, rules.map { max($0.requiredHours + ($0.metrics.contains("turnover") ? 24 : 0), ($0.btcRequirements?.hours ?? 0) + ($0.btcRequirements?.metrics.contains("turnover") == true ? 24 : 0)) }.max() ?? 275) }
    static var revision: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String ?? "development" }
}

func researchJSON<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
}

func researchHash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func researchHash(_ value: String) -> String { researchHash(Data(value.utf8)) }
func researchNow() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
func researchSeconds(_ duration: Duration) -> Double { Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18 }

struct StudyRule: Codable, Sendable {
    var name: String
    var filtersJSON: String
}

struct ResearchCosts: Codable, Sendable {
    var entryFeeBps: Double
    var exitFeeBps: Double
    var slippageBps: Double
    func validate() throws {
        guard [entryFeeBps, exitFeeBps, slippageBps].allSatisfy({ $0.isFinite && $0 >= 0 && $0 < 10_000 }) else {
            throw FilterError("Fees and slippage must be finite basis points from 0 to less than 10,000.")
        }
    }
}

struct StudySpec: Codable, Sendable {
    var name: String
    var kind: String = "filter"
    var rules: [StudyRule]
    var instruments: [String] = []
    var from: Int64?
    var through: Int64
    var direction: String = "auto"
    var sampling: String = "entries"
    var costs: ResearchCosts?
    var strategySnapshots: [StrategyProfile]?
    var strategyPhase: String?
    var excludedSpreadConditions: [String]?
    var allRules: [StudyRule] { rules }
    func validate() throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 120,
              ["filter", "score", "comparison"].contains(kind), ["auto", "Long", "Short"].contains(direction),
              ["entries", "hourly"].contains(sampling), (strategyPhase == nil || strategyPhase == "bullishSetup"), !rules.isEmpty, kind != "comparison" || rules.count >= 2,
              through % hourMS == 0, through <= researchNow() / hourMS * hourMS,
              from.map({ $0 >= 0 && $0 % hourMS == 0 && $0 < through }) ?? true else {
            throw FilterError("Choose a study name, complete rules, direction, sampling, and a valid completed-hour range.")
        }
        for rule in rules { _ = try FilterCompiler.compile(FilterConfigV2.decode(rule.filtersJSON)) }
        try costs?.validate()
    }
}

struct ResearchInstrument: Codable, Sendable {
    var id: String
    var listedAt: Int64?
    var delistedAt: Int64?
    var verified: Bool
    var contractValue: Double?
    var source: String
    var observedAt: Int64
    var metadataSourceID: String?
    func eligible(at timestamp: Int64) -> Bool {
        verified && listedAt.map { timestamp >= $0 } == true && delistedAt.map { timestamp < $0 } != false
    }
}

struct ResearchRange: Codable, Equatable, Sendable {
    var from: Int64
    var through: Int64
    var hours: Int { max(0, Int((through - from) / hourMS) + 1) }
}

struct ResearchSource: Codable, Sendable {
    var id: String
    var instrument: String
    var kind: String
    var from: Int64
    var through: Int64
    var url: String
    var filename: String
    var sizeBytes: Int64?
    var archive: Bool
    var module: Int?
    var rawHash: String?
    var cached = false
    var parser = ResearchVersion.parser
    var refresh = false
    var warnings: [String]?
}

struct DataPlan: Codable, Sendable {
    var id = UUID().uuidString
    var spec: StudySpec
    var instruments: [ResearchInstrument]
    var from: Int64
    var through: Int64
    var warmupHours: Int
    var sources: [ResearchSource] = []
    var coverage: [ResearchCoverage] = []
    var cachedHours = 0
    var requestedHours = 0
    var warnings: [String] = []
    var unknownInstruments: [String] = []
    var createdAt = researchNow()
    var referenceInstruments: [ResearchInstrument] = []
    var inputInstruments: [ResearchInstrument] { instruments + referenceInstruments.filter { source in !instruments.contains { $0.id == source.id } } }
    var estimatedBytes: Int64 { sources.filter { !$0.cached }.reduce(0) { $0 + ($1.sizeBytes ?? 0) } }
}

struct ResearchCoverage: Codable, Sendable {
    var instrument: String
    var kind: String
    var available: Int
    var expected: Int
    var first: Int64?
    var last: Int64?
    var gaps: [ResearchRange]
}

struct DataManifest: Codable, Sendable {
    var id = UUID().uuidString
    var planID: String
    var from: Int64
    var through: Int64
    var instruments: [ResearchInstrument]
    var parser = ResearchVersion.parser
    var engine = ResearchVersion.engine
    var sourceRevision = ResearchVersion.revision
    var createdAt = researchNow()
    var warnings: [String]
    var unknownInstruments: [String]
    var digest = ""
    var fundingRanges: [String: [ResearchRange]] = [:]
    var coverage: [ResearchCoverage] = []
    var sources: [ResearchSource] = []
    var referenceInstruments: [ResearchInstrument] = []
    var inputInstruments: [ResearchInstrument] { instruments + referenceInstruments.filter { source in !instruments.contains { $0.id == source.id } } }
}

struct Checkpoint: Codable, Sendable {
    var studyID: String
    var phase: String
    var completedSources: [String] = []
    var refresh = false
    var error: String?
    var instrumentIndex = 0
    var nextHour: Int64?
    var episodes: [String: ResearchEpisode] = [:]
    var updatedAt = researchNow()
}

struct ResearchEpisode: Codable, Sendable {
    var lastDefinite: FilterTruth?
    var uncertain = false
    // Unknown never resets a known matching episode.
    mutating func observe(_ truth: FilterTruth, baseline: Bool = false) -> String? {
        if truth == .unknown { uncertain = true; return nil }
        let previous = lastDefinite, wasUncertain = uncertain
        lastDefinite = truth; uncertain = false
        guard truth == .yes, previous != .yes, !baseline else { return nil }
        return previous == nil || wasUncertain ? "uncertain" : "entry"
    }
}

struct ResearchRawPage: Codable { var path: String; var digest: String; var sourceID: String? }

struct ResearchDatum: Codable, Sendable {
    var instrument: String
    var kind: String
    var timestamp: Int64
    var candle: Candle?
    var stat: FilterStat?
    var quote: FilterQuote?
    var rate: Double?
    var mark: Double?
    var sources: [String]
}

struct ResearchFunding: Sendable { var timestamp: Int64; var rate: Double; var mark: Double? }
struct ResearchSeries: Sendable {
    var candles: [Int64: Candle] = [:]
    var stats: [Int64: FilterStat] = [:]
    var quotes: [Int64: FilterQuote] = [:]
    var funding: [ResearchFunding] = []
    var fundingCoverage: [ResearchRange] = []
    var missingFunding = Set<Int64>()
    var sources: [String] = []
}

struct ResearchOutcome: Codable, Sendable {
    var hours: Int
    var gross: Double?
    var net: Double?
    var mfe: Double?
    var mae: Double?
    var reason: String?
    var netReason: String?
}

struct ResearchEvent: Codable, Sendable {
    var id: String
    var studyID: String
    var ruleIndex: Int
    var instrument: String
    var timestamp: Int64
    var direction: String
    var entry: String
    var score: Int?
    var scoreComplete: Bool
    var status: String
    var setup: String?
    var split: String
    var outcomes: [ResearchOutcome]
    var traceJSON: String
    var opportunityJSON: String
    var sources: [String]
}

struct ResearchSummary: Codable, Sendable {
    var group: String
    var ruleIndex: Int
    var hours: Int
    var count: Int
    var excluded: Int
    var netCount: Int
    var mean: Double?
    var median: Double?
    var winRate: Double?
    var netMean: Double?
    var netMedian: Double?
    var netWinRate: Double?
    var mfe: Double?
    var mae: Double?
    var baseline: Double?
    var excess: Double?
    var intervalLow: Double?
    var intervalHigh: Double?
    var netIntervalLow: Double?
    var netIntervalHigh: Double?
}

struct StudyReport: Codable, Sendable {
    var studyID: String
    var manifestID: String
    var spec: StudySpec
    var summaries: [ResearchSummary]
    var evaluated: Int
    var unknown: Int
    var directionless: Int
    var uncertain: Int
    var baseline: Int
    var commonPool: Int
    var warnings: [String]
    var completedAt = researchNow()
}

struct ResearchStudy: Codable, Sendable {
    var id = UUID().uuidString
    var spec: StudySpec
    var planID: String
    var manifestID: String?
    var createdAt = researchNow()
}

struct ResearchJobStatus: Codable, Sendable {
    var id: String
    var phase: String
    var completed = 0
    var total = 0
    var message = ""
    var error = ""
    var resultID: String?
    var startedAt = researchNow()
    var updatedAt = researchNow()
    var preparation: ResearchPreparationProgress?
    var catalog: ResearchCatalogProgress?
    var planning: ResearchPlanningProgress?
}

struct ResearchPlanningProgress: Codable, Sendable {
    var stage: String
    var unit: String
    var completed: Int
    var total: Int
    var message: String
    var instrument: String?
    var kind: String?
    var from: Int64?
    var through: Int64?
    var remainingSeconds: Double?
}

struct ResearchPlanningCounter {
    var stage: String
    var unit: String
    var total: Int
    private let started = ContinuousClock.now
    private var reported = ContinuousClock.now
    init(stage: String, unit: String, total: Int) {
        self.stage = stage; self.unit = unit; self.total = total
    }
    mutating func shouldReport(_ completed: Int) -> Bool {
        guard completed == 1 || completed == total || reported.duration(to: .now) >= .milliseconds(250) else { return false }
        reported = .now
        return true
    }
    func update(_ completed: Int, _ message: String, instrument: String? = nil, kind: String? = nil, range: ResearchRange? = nil) -> ResearchPlanningProgress {
        let remaining = completed > 0 ? researchSeconds(started.duration(to: .now)) / Double(completed) * Double(max(0, total - completed)) : nil
        return .init(stage: stage, unit: unit, completed: completed, total: total, message: message, instrument: instrument, kind: kind, from: range?.from, through: range?.through, remainingSeconds: remaining)
    }
}

struct ResearchCatalogProgress: Codable, Sendable {
    var kind: String
    var completed: Int
    var total: Int
    var message: String
    var waitingForResponse = false
    var remainingSeconds: Double?
}

struct ResearchDownloadProgress: Sendable {
    var receivedBytes: Int64
    var totalBytes: Int64?
    var bytesPerSecond: Double?
}

struct ResearchPreparationProgress: Codable, Sendable {
    var stage: String
    var filename: String
    var instrument: String
    var receivedBytes: Int64 = 0
    var totalBytes: Int64?
    var bytesPerSecond: Double?
    var fileRemainingSeconds: Double?
    var remainingSeconds: Double?
    var pages = 0
    var fraction: Double?
}

// Pressure notifications are shared by the downloader and the single parser /
// calculation worker. A failed chunk leaves the previous durable checkpoint.
final class ResearchPressure: @unchecked Sendable {
    static let shared = ResearchPressure()
    private let lock = NSLock()
    private var critical = false
    private let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .global(qos: .background))
    private init() {
        source.setEventHandler { [weak self] in
            guard let self else { return }
            lock.lock(); critical = source.data.contains(.critical); lock.unlock()
        }
        source.resume()
    }
    func check() throws {
        try Task.checkCancellation()
        lock.lock(); let stop = critical; lock.unlock()
        if stop { throw FilterError("Research stopped under critical memory pressure. Its checkpoint and completed files remain available for manual resume.") }
    }
}
