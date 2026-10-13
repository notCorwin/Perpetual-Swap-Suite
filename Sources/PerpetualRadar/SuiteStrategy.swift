import Foundation

let defaultStrategyID = "builtin.default-strategy"
private let defaultStrategyRevision = 1
let radarChartHours = 96

func radarStrategyReplayStart(chartEnd: Int64) -> Int64 {
    max(0, chartEnd - Int64(radarChartHours - 1) * hourMS)
}

private func defaultRule(_ id: String, _ name: String, left: String, _ comparison: String, right: String) -> FilterNode {
    var node = FilterNode(kind: "condition", name: name, left: left, comparison: comparison, right: right)
    node.id = id
    return node
}

private func defaultGroup(_ id: String, _ name: String, _ children: [FilterNode]) -> FilterNode {
    var node = FilterNode(kind: "all", name: name, children: children)
    node.id = id
    return node
}

func defaultStrategyProfile() -> StrategyProfile {
    let universe = defaultGroup("default-universe", "Universe", [
        defaultRule("default-universe-turnover", "24h trading volume ≥ 10M USDT", left: "turnover", "gte", right: "10"),
        defaultRule("default-universe-oi", "Live Open Interest is increasing", left: "oiTrend", "eq", right: #""rising""#),
        defaultRule("default-universe-age", "Trading history ≥ 6 months", left: "ListingAgeMonths", "gte", right: "6"),
        defaultRule("default-universe-bb", "Live Bollinger Bandwidth is expanding", left: "bbExpansion", "gt", right: "0"),
    ])
    var setup = defaultGroup("default-bullish-setup", "Bullish Setup", [
        defaultGroup("default-momentum", "Momentum", [
            defaultRule("default-roc-positive", "ROC(9) > 0", left: "ROC(9)", "gt", right: "0"),
            defaultRule("default-roc-rising", "Hour-over-hour change in ROC(9) > 0", left: "change(ROC(9), 1)", "gt", right: "0"),
        ]),
        defaultGroup("default-trend", "Trend", [
            defaultRule("default-price-ema", "Live price is above EMA(200)", left: "Price", "gt", right: "EMA(200)"),
        ]),
        defaultGroup("default-breakout", "Breakout", [
            defaultRule("default-high-logbb", "Live HH > Log BB upper band", left: "High", "gt", right: #"LogBB(20, 2, "upper")"#),
            defaultRule("default-high-48", "Price wick breaks above the previous 48h high", left: "High", "gt", right: #"PriorExtreme(48, "high")"#),
        ]),
        defaultGroup("default-overheat", "Overheat", [
            defaultRule("default-rsi", "RSI(24) < 70", left: "RSI(24)", "lt", right: "70"),
        ]),
    ])
    setup.mode = "live"
    return StrategyProfile(id: defaultStrategyID, name: "Default Strategy", universeJSON: FilterConfigV2(root: universe).json,
                           phaseRules: ["bullishSetup": FilterConfigV2(root: setup).json], revision: defaultStrategyRevision, updatedAt: 0)
}

enum SuitePhase: String, CaseIterable, Codable, Sendable {
    case bullishSetup
    var label: String { "Bullish Setup" }
}

func strategyObservation(profile: StrategyProfile, readings: [SuiteReading]) throws -> FilterObservation {
    // Duplicate instrument readings must not trap; conflicting duplicates are Unknown.
    var results: [String: FilterTruth] = [:]
    for reading in readings {
        let truth = FilterTruth(rawValue: reading.phases["bullishSetup"]?.result ?? "unknown") ?? .unknown
        let result: FilterTruth = truth == .no || reading.universe == "false" ? .no : truth == .yes && reading.universe == "true" ? .yes : .unknown
        let key = reading.instrument + "|Bullish Setup"
        results[key] = results[key].map { $0 == result ? result : .unknown } ?? result
    }
    return .init(configuration: try researchJSON(profile), universe: Set(results.keys), results: results)
}

struct StrategyProfile: Codable, Sendable {
    var id = UUID().uuidString
    var mode = "radar"
    var name: String
    var universeJSON: String
    var phaseRules: [String: String]
    var revision = 0
    var updatedAt = researchNow()
    static func validateRule(_ rule: CompiledFilter, phase: SuitePhase?) throws {
        if phase != nil, ["all", "any"].contains(rule.config.root.kind), rule.config.root.children.isEmpty {
            throw FilterError("Add at least one Bullish Setup condition before saving or activation.")
        }
    }
    var studyRules: [StudyRule] { [.init(name: name + " · Universe", filtersJSON: universeJSON)] + SuitePhase.allCases.map { .init(name: name + " · " + $0.label, filtersJSON: phaseRules[$0.rawValue] ?? "") } }
    func compiled() throws -> [CompiledFilter] {
        guard ["radar", "research"].contains(mode), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 80 else { throw FilterError("Use a strategy name from 1 to 80 characters and a valid mode.") }
        let rules = try studyRules.map { try FilterCompiler.compile(FilterConfigV2.decode($0.filtersJSON)) }
        for (index, rule) in rules.enumerated() {
            try Self.validateRule(rule, phase: index == 0 ? nil : SuitePhase.allCases[index-1])
        }
        return rules
    }
    func hydration() throws -> CompiledFilter {
        let all = try compiled(); var combined = all[0]
        combined.requiredHours = ResearchVersion.warmup(all) + 1
        for rule in all { combined.mergeRequirements(rule) }
        if combined.referencesBTC {
            let hours = max(combined.btcRequirements?.hours ?? 0,ResearchVersion.warmup(all)+1)
            combined.btcRequirements?.hours = hours
        }
        return combined
    }
}

struct SuitePhaseReading: Codable, Sendable {
    var result: String
    var hour: Int64
    var traceJSON: String?
}
struct SuiteReading: Codable, Sendable {
    var strategyID = ""
    var revision = 0
    var instrument: String
    var hour: Int64
    var provisional: Bool
    var universe: String
    var universeTraceJSON: String?
    var phases: [String: SuitePhaseReading]
    var action: String
    var reason: String
    var price: Double?
}

struct StrategyChartSignal: Codable, Sendable, Equatable {
    var hour: Int64
    var price: Double
}

struct StrategyChartReplay: Codable, Sendable, Equatable {
    var fromHour: Int64
    var throughHour: Int64
    var historyHours: Int
    var completedHours = 0
    var matchedHours = 0
    var unknownHours = 0
    var signals: [StrategyChartSignal] = []
}

enum SuiteEvaluation {
    static func context(_ input: FilterMarketData, forming: Bool) -> FilterMarketData {
        if forming { return input }
        var market = input
        market.evaluationTime = input.evaluationTime ?? input.now
        market.hour -= hourMS; market.now = market.hour + hourMS
        market.current = [:]; market.previousEMA = nil; market.historicalClose = true
        let series = ResearchEngine.reconstruct(ResearchSeries(candles: market.candles, stats: market.stats, quotes: market.quotes))
        market.quotes = series.quotes
        return market
    }
    static func traces(_ context: FilterMarketData, filters: [CompiledFilter], explain: Bool = false) -> [FilterTrace] {
        var shared: [String: FilterScalar] = [:]
        return filters.map { filter in
            let evaluator = FilterEvaluator(market: context, filter: filter, sharedReadings: shared)
            let trace = evaluator.evaluate(explain: explain); shared = evaluator.sharedReadings; return trace
        }
    }
    static func truth(_ traces: [FilterTrace], _ phase: SuitePhase) -> FilterTruth { traces[1 + SuitePhase.allCases.firstIndex(of: phase)!].result }
    static func decision(_ traces: [FilterTrace]) -> (String, String) {
        let setup = truth(traces, .bullishSetup)
        if traces[0].result == .no || setup == .no { return ("Wait", "Universe or Bullish Setup rules do not match.") }
        if traces[0].result == .unknown || setup == .unknown { return ("Unknown", "A Universe or Bullish Setup input is unavailable.") }
        return ("Bullish Setup", "Universe and Bullish Setup match at this hour.")
    }
}

/// Replays a saved strategy one completed hour at a time. Each context ends at
/// that candle and includes the rule-required warm-up, so indicators are usable
/// without exposing any future data to the evaluator.
func strategyChartReplay(profile: StrategyProfile, market: FilterMarketData,
                          reference: FilterMarketData? = nil, from: Int64, through: Int64) throws -> StrategyChartReplay {
    let filters = try profile.compiled(), cooldowns = FilterCooldownMemory()
    let historyHours = ResearchVersion.warmup(filters)
    var output = StrategyChartReplay(fromHour: from, throughHour: through, historyHours: historyHours)
    guard from <= through else { return output }
    func rollingContext(_ input: FilterMarketData, at anchor: Int64) -> FilterMarketData {
        var result = input
        let first = max(0, anchor - Int64(historyHours) * hourMS)
        result.candles = input.candles.filter { $0.key >= first && $0.key <= anchor }
        result.stats = input.stats.filter { $0.key >= first && $0.key <= anchor }
        result.quotes = input.quotes.filter { $0.key >= first && $0.key <= anchor }
        result.historicalReadings = nil
        let recordedQuotes = result.quotes
        let series = ResearchEngine.reconstruct(.init(candles: result.candles, stats: result.stats, quotes: result.quotes))
        result.candles = series.candles; result.stats = series.stats
        result.quotes = Dictionary(uniqueKeysWithValues: series.quotes.map { hour, generated in
            (hour, FilterQuote(turnover: generated.turnover, spread: recordedQuotes[hour]?.spread, timestamp: generated.timestamp))
        })
        // Preserve exact recorded spread snapshots, including hours where a
        // turnover snapshot was absent; generated turnover never invents spread.
        for (hour, recorded) in recordedQuotes where result.quotes[hour] == nil { result.quotes[hour] = recorded }
        return result
    }
    var episode = ResearchEpisode()
    let replayFrom = from >= hourMS ? from - hourMS : from
    for hour in stride(from: replayFrom, through: through, by: Int(hourMS)) {
        let baseline = hour < from
        var context = rollingContext(market, at: hour)
        context.hour = hour; context.now = hour + hourMS
        context.current = [:]; context.previousEMA = nil; context.historicalClose = true
        context.evaluationTime = context.now; context.cooldowns = cooldowns; context.recordCooldowns = true
        if let reference {
            var referenceAtClose = rollingContext(reference, at: hour)
            referenceAtClose.hour = hour; referenceAtClose.now = hour + hourMS
            referenceAtClose.current = [:]; referenceAtClose.previousEMA = nil; referenceAtClose.historicalClose = true
            referenceAtClose.evaluationTime = referenceAtClose.now; referenceAtClose.cooldowns = cooldowns
            context.referenceBTC = FilterReferenceSnapshot(market: referenceAtClose)
        } else { context.referenceBTC = nil }
        guard context.candles[hour]?.confirmed == true else {
            _ = episode.observe(.unknown)
            if !baseline { output.unknownHours += 1 }
            continue
        }
        if !baseline { output.completedHours += 1 }
        let traces = SuiteEvaluation.traces(context, filters: filters)
        let matches = FilterTruth.all([traces[0].result, SuiteEvaluation.truth(traces, .bullishSetup)])
        if !baseline, matches == .yes { output.matchedHours += 1 }
        if !baseline, matches == .unknown { output.unknownHours += 1 }
        if episode.observe(matches, baseline: baseline) == "entry", let close = context.candles[hour]?.close, close.isFinite, close > 0 {
            output.signals.append(.init(hour: hour, price: close))
        }
    }
    return output
}

func strategyChartSignals(profile: StrategyProfile, market: FilterMarketData,
                          reference: FilterMarketData? = nil, from: Int64, through: Int64) throws -> [StrategyChartSignal] {
    try strategyChartReplay(profile: profile, market: market, reference: reference, from: from, through: through).signals
}

actor SuiteEvaluationWorker {
    private let confirmationCooldowns = FilterCooldownMemory()
    func evaluate(_ markets: [FilterMarketData], profile: StrategyProfile, forming: Bool, available: Bool, detail: String? = nil) throws -> [SuiteReading] {
        let filters = try profile.compiled()
        var closedReferences: [ObjectIdentifier: FilterReferenceSnapshot] = [:]
        return try markets.map { original in
            try Task.checkCancellation()
            var context = SuiteEvaluation.context(original, forming: forming)
            context.cooldowns = confirmationCooldowns
            if !forming {
                context.evaluationTime = context.now
                if let reference = context.referenceBTC, !reference.market.historicalClose {
                    let key = ObjectIdentifier(reference)
                    if closedReferences[key] == nil { closedReferences[key] = FilterReferenceSnapshot(market: SuiteEvaluation.context(reference.market,forming:false), receivedAt:reference.receivedAt,connected:reference.connected) }
                    context.referenceBTC = closedReferences[key]
                }
            }
            let ready = available && context.candles[context.hour].map { forming || $0.confirmed } == true
            // Paused or unavailable hours are reported as Unknown, so they must not advance cooldown memory either.
            context.recordCooldowns = !forming && ready
            var traces = SuiteEvaluation.traces(context, filters: filters, explain: detail == original.id)
            if !ready {
                for index in traces.indices { traces[index].result = .unknown; traces[index].reason = "Monitoring is paused or this hourly candle is unavailable. Last definite membership is retained."; traces[index].children = [] }
            }
            var phases: [String: SuitePhaseReading] = [:]
            for (index, phase) in SuitePhase.allCases.enumerated() {
                let trace = traces[index + 1]
                phases[phase.rawValue] = .init(result: ready ? trace.result.rawValue : "unknown", hour: context.hour, traceJSON: detail == original.id ? String(decoding: try SafeJSON.data(trace.snapshot, options: [.sortedKeys]), as: UTF8.self) : nil)
            }
            let decision = ready ? SuiteEvaluation.decision(traces) : ("Unknown", "Monitoring is paused or this hourly candle is unavailable.")
            return SuiteReading(strategyID: profile.id, revision: profile.revision, instrument: original.id, hour: context.hour, provisional: forming, universe: ready ? traces[0].result.rawValue : "unknown", universeTraceJSON: detail == original.id ? String(decoding: try SafeJSON.data(traces[0].snapshot, options: [.sortedKeys]), as: UTF8.self) : nil, phases: phases, action: decision.0, reason: decision.1, price: context.candles[context.hour]?.close)
        }
    }
}

extension Store {
    // Modes are views over one library. Research experiments retain their own
    // immutable snapshots; only editable profiles live in the shared service.
    func initializeSharedSuiteLibrary(researchURL: URL? = nil) throws {
        func legacy(_ store: Store, _ mode: String) throws -> [StrategyProfile] {
            try store.preference(forKey: "suiteProfiles.\(mode)").map { try JSONDecoder().decode([StrategyProfile].self, from: Data($0.utf8)) } ?? []
        }
        let shared = try preference(forKey: "suiteProfiles")
        var sources: [StrategyProfile]
        if let shared {
            sources = try JSONDecoder().decode([StrategyProfile].self, from: Data(shared.utf8))
        } else {
            sources = try legacy(self, "radar") + legacy(self, "research")
            if let researchURL, FileManager.default.fileExists(atPath: researchURL.path) {
                sources += try legacy(Store(url: researchURL), "research")
            }
        }
        var profiles = [defaultStrategyProfile()]
        for var profile in sources where profile.id != defaultStrategyID && !profiles.contains(where: { $0.id == profile.id }) {
            if profiles.contains(where: { $0.name.lowercased() == profile.name.lowercased() }) {
                let base = String(profile.name.prefix(60)); var suffix = 1
                repeat { profile.name = base + " · Research \(suffix)"; suffix += 1 }
                while profiles.contains(where: { $0.name.lowercased() == profile.name.lowercased() })
            }
            profile.mode = "radar"; profiles.append(profile)
        }
        let existingSelection = try preference(forKey: "suiteSelected")
        let migratedSelection = try preference(forKey: "suiteSelected.radar")
        // Opening an already normalized library must remain read-only. Radar can
        // launch while the collector or Research owns the SQLite writer lock.
        let normalized = try researchJSON(profiles)
        if shared == normalized, existingSelection != nil { return }
        try transaction {
            try setPreference(normalized, forKey: "suiteProfiles")
            try setPreference(existingSelection ?? migratedSelection ?? defaultStrategyID, forKey: "suiteSelected")
        }
    }
    func suiteProfiles(_ mode: String) throws -> [StrategyProfile] {
        let profiles = try preference(forKey: "suiteProfiles").map { try JSONDecoder().decode([StrategyProfile].self, from: Data($0.utf8)) } ?? []
        return profiles.map { source in
            var profile = source
            profile.phaseRules = profile.phaseRules.filter { $0.key == "bullishSetup" }
            return profile
        }
    }
    func selectedSuiteProfile(_ mode: String) throws -> StrategyProfile? {
        let selected = try preference(forKey: "suiteSelected")
        return try suiteProfiles(mode).first { $0.id == selected }
    }
    func saveSuiteProfile(_ input: StrategyProfile, copy: Bool = false) throws -> StrategyProfile {
        guard copy || input.id != defaultStrategyID else { throw FilterError("Default Strategy is built in and cannot be edited.") }
        var result = input; let rules = try input.compiled()
        result.mode = "radar"
        result.universeJSON = rules[0].config.json
        result.phaseRules = ["bullishSetup": rules[1].config.json]
        result.name = result.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if copy || result.id.isEmpty { result.id = UUID().uuidString; result.revision = 0 }
        try transaction {
            var profiles = try suiteProfiles(result.mode)
            if copy {
                let base = String(result.name.prefix(65)); var suffix = 1
                while profiles.contains(where: { $0.name.lowercased() == result.name.lowercased() }) {
                    result.name = base + " copy" + (suffix == 1 ? "" : " \(suffix)"); suffix += 1
                }
            }
            guard !profiles.contains(where: { $0.id != result.id && $0.name.lowercased() == result.name.lowercased() }) else { throw FilterError("A strategy with this name already exists. Choose a new name.") }
            if let old = profiles.first(where: { $0.id == result.id }) { guard result.revision == old.revision else { throw FilterError("The strategy changed. Reload before saving.") } }
            else { guard result.revision == 0 else { throw FilterError("The strategy was deleted. Save a new copy.") } }
            result.revision += 1; result.updatedAt = researchNow()
            profiles.removeAll { $0.id == result.id }; profiles.insert(result, at: 0)
            try setPreference(try researchJSON(profiles), forKey: "suiteProfiles")
        }
        return result
    }
    func suiteInventory(_ mode: String, saved: StrategyProfile? = nil) throws -> [String: Any] {
        func object<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: Data(researchJSON(value).utf8)) }
        var response: [String: Any] = ["profiles": try object(suiteProfiles(mode)), "selectedID": try preference(forKey: "suiteSelected") ?? ""]
        if let draft = try preference(forKey: "suiteDraft.\(mode)"), !draft.isEmpty { response["draft"] = try JSONSerialization.jsonObject(with: Data(draft.utf8)) }
        if let saved { response["saved"] = try object(saved) }
        return response
    }
    func manageSuite(_ request: [String: Any], mode: String) throws -> [String: Any] {
        guard ["radar", "research"].contains(mode) else { throw FilterError("Invalid workspace.") }
        let action = request["action"] as? String ?? "inventory", id = request["profileID"] as? String ?? ""
        var saved: StrategyProfile?
        switch action {
        case "draft":
            // Drafts are opaque editor state. They never compile, activate or
            // change confirmation membership, and may contain incomplete text.
            guard let raw = request["draft"], JSONSerialization.isValidJSONObject(raw) else { throw FilterError("Provide valid editor state.") }
            let data = try SafeJSON.data(raw, options: [.sortedKeys])
            guard data.count <= 1_048_576 else { throw FilterError("The editor draft exceeds 1 MiB.") }
            try setPreference(String(decoding: data, as: UTF8.self), forKey: "suiteDraft.\(mode)")
        case "save", "copy":
            guard let raw = request["profile"] else { throw FilterError("Provide Universe and Bullish Setup rules.") }
            var profile = try JSONDecoder().decode(StrategyProfile.self, from: SafeJSON.data(raw)); profile.mode = mode
            saved = try saveSuiteProfile(profile, copy: action == "copy")
        case "select":
            guard try id.isEmpty || suiteProfiles(mode).contains(where: { $0.id == id }) else { throw FilterError("This strategy no longer exists.") }
            try setPreference(id, forKey: "suiteSelected")
        case "delete":
            guard id != defaultStrategyID else { throw FilterError("Default Strategy is built in and cannot be deleted.") }
            try setPreference(try researchJSON(try suiteProfiles(mode).filter { $0.id != id }), forKey: "suiteProfiles")
            if try preference(forKey: "suiteSelected") == id { try setPreference("", forKey: "suiteSelected") }
        case "inventory", "evaluate", "preview": break
        default: throw FilterError("Unknown strategy action.")
        }
        return try suiteInventory(mode, saved: saved)
    }
}
