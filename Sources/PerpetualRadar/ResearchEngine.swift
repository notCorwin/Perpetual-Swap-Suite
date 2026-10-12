import Foundation
import CSQLite

struct ResearchCachedScalar: Codable {
    var kind: String
    var value: String
    init(_ scalar: FilterScalar) {
        switch scalar { case .number(let n): kind = "number"; value = String(n); case .text(let t): kind = "text"; value = t; case .unknown(let r): kind = "unknown"; value = r }
    }
    var scalar: FilterScalar { kind == "number" ? Double(value).map(FilterScalar.number) ?? .unknown("Cached number is invalid.") : kind == "text" ? .text(value) : .unknown(value) }
}

enum ResearchEngine {
    struct BTCSeries {
        var instrument: ResearchInstrument
        var series: ResearchSeries
        var sources: [String] { Array(Set(series.sources + [instrument.metadataSourceID].compactMap { $0 })).sorted() }
        func snapshot(at hour: Int64) -> FilterReferenceSnapshot {
            let market = ResearchEngine.context(instrument: instrument, hour: hour, series: series)
            return FilterReferenceSnapshot(market: market)
        }
    }
    static func btcSeries(store: ResearchStore, manifest: DataManifest, from: Int64, through: Int64, required: Bool) throws -> BTCSeries? {
        guard required, let instrument = manifest.inputInstruments.first(where: { $0.id == btcReferenceID }) else { return nil }
        return .init(instrument: instrument, series: reconstruct(try store.series(btcReferenceID, from: from, through: through, manifest: manifest.id)))
    }
    static func context(instrument: ResearchInstrument, hour: Int64, series: ResearchSeries, reference: BTCSeries? = nil) -> FilterMarketData {
        return FilterMarketData(id: instrument.id, hour: hour, now: hour + hourMS, listedAt: instrument.listedAt,
            candles: series.candles, stats: series.stats, quotes: series.quotes, previousEMA: nil, historicalClose: true, referenceBTC: reference?.snapshot(at: hour), evaluationTime: hour+hourMS)
    }
    static func reconstruct(_ input: ResearchSeries) -> ResearchSeries {
        var result = input, volumes: [(Int64, Double)] = [], sum = 0.0
        result.quotes = input.quotes.compactMapValues { quote in quote.turnover.map { .init(turnover: $0, spread: nil, timestamp: quote.timestamp) } }
        for hour in input.candles.keys.sorted() {
            guard let bar = input.candles[hour], bar.confirmed, let base = bar.baseVolume else { volumes.removeAll(); sum = 0; continue }
            if let previous = volumes.last, previous.0 + hourMS != hour { volumes.removeAll(); sum = 0 }
            volumes.append((hour, base)); sum += base
            if volumes.count > 24 { sum -= volumes.removeFirst().1 }
            if volumes.count == 24, result.quotes[hour]?.turnover == nil {
                result.quotes[hour] = FilterQuote(turnover: sum * bar.close, spread: nil, timestamp: hour + hourMS - 1)
            }
        }
        return result
    }
    static func outcome(timestamp: Int64, direction: String, hours: Int, series: ResearchSeries, costs: ResearchCosts?) -> ResearchOutcome {
        let end = timestamp + Int64(hours) * hourMS, sign = direction == "Long" ? 1.0 : -1.0
        var result = ResearchOutcome(hours: hours)
        guard let entryBar = series.candles[timestamp], entryBar.confirmed, let entry = entryBar.open,
              let exitBar = series.candles[end], exitBar.confirmed, let exit = exitBar.open, entry > 0, exit > 0 else {
            result.reason = "Entry or exit open is missing, or the holding period is not complete."; return result
        }
        var favorable = 0.0, adverse = 0.0
        for hour in stride(from: timestamp, to: end, by: Int(hourMS)) {
            guard let bar = series.candles[hour], bar.confirmed, bar.open != nil else { result.reason = "A holding-period hour is missing."; return result }
            favorable = max(favorable, sign * ((sign > 0 ? bar.high : bar.low) / entry - 1))
            adverse = min(adverse, sign * ((sign > 0 ? bar.low : bar.high) / entry - 1))
        }
        result.gross = sign * (exit / entry - 1); result.mfe = favorable; result.mae = adverse
        guard let costs else { result.netReason = "Enter both fees and slippage to calculate modeled net returns."; return result }
        var coveredThrough = timestamp
        for range in series.fundingCoverage.sorted(by: { $0.from < $1.from }) where range.through >= timestamp {
            if range.from > coveredThrough { break }
            coveredThrough = max(coveredThrough, range.through + hourMS)
            if coveredThrough >= end { break }
        }
        guard coveredThrough >= end else { result.netReason = "Actual funding-rate coverage is incomplete."; return result }
        guard !series.missingFunding.contains(where: { $0 > timestamp && $0 <= end }) else { result.netReason = "The actual funding rate is missing for a settlement."; return result }
        let settlements = series.funding.filter { $0.timestamp > timestamp && $0.timestamp <= end }
        guard settlements.allSatisfy({ $0.mark?.isFinite == true && $0.mark! > 0 && $0.rate.isFinite }) else { result.netReason = "The settlement mark price or actual funding rate is missing."; return result }
        let pe = entry * (1 + sign * costs.slippageBps / 10_000), px = exit * (1 - sign * costs.slippageBps / 10_000), quantity = 1 / pe
        let fees = quantity * (pe * costs.entryFeeBps + px * costs.exitFeeBps) / 10_000
        let funding = sign * quantity * settlements.reduce(0) { $0 + $1.mark! * $1.rate }
        result.net = sign * quantity * (px - pe) - fees - funding
        return result
    }
    static func split(timestamp: Int64, from: Int64, through: Int64) -> String {
        let span = through - from
        let a = from + Int64(Double(span) * 0.6) / hourMS * hourMS, b = from + Int64(Double(span) * 0.8) / hourMS * hourMS
        if (timestamp >= a - 48 * hourMS && timestamp < a) || (timestamp >= b - 48 * hourMS && timestamp < b) { return "Purged" }
        return timestamp < a ? "Observation" : timestamp < b ? "Validation" : "Holdout"
    }
    static func scoreComplete(_ opportunity: NativeOpportunity) -> Bool {
        opportunity.score != nil && !opportunity.reasons.contains { $0.contains("unavailable") || $0.contains("incomplete") || $0.contains("lower bound") }
    }
    static func run(store: ResearchStore, study: ResearchStudy, manifest: DataManifest, checkpoint: inout Checkpoint,
                    progress: (Int, Int, String) -> Void) throws {
        let rules = try study.spec.excludingSpread().rules.map { try FilterCompiler.compile(FilterConfigV2.decode($0.filtersJSON)) }
        let warmup = ResearchVersion.warmup(rules)
        let total = manifest.instruments.count
        func firstHour(_ instrument: ResearchInstrument) -> Int64 { max(manifest.from - hourMS, (instrument.listedAt ?? manifest.from) / hourMS * hourMS) }
        func countHours(_ instrument: ResearchInstrument) -> Int { max(0, Int((min(manifest.through, instrument.delistedAt ?? manifest.through) - firstHour(instrument)) / hourMS)) }
        let hourlyTotal = manifest.instruments.reduce(0) { $0 + countHours($1) }
        for index in checkpoint.instrumentIndex..<total {
            try ResearchPressure.shared.check()
            let instrument = manifest.instruments[index]
            let firstHour = firstHour(instrument)
            var hour = checkpoint.nextHour ?? firstHour
            if checkpoint.nextHour == nil {
                checkpoint.episodes = [:]
                let series = reconstruct(try store.series(instrument.id, from: max(0, firstHour - Int64(warmup + 1) * hourMS), through: firstHour, manifest: manifest.id))
                let reference = try btcSeries(store: store, manifest: manifest, from: max(0, firstHour-Int64(warmup+1)*hourMS), through: firstHour, required: rules.contains(where: \.referencesBTC))
                let context = context(instrument: instrument, hour: firstHour - hourMS, series: series, reference: reference)
                let evaluator = FilterEvaluator(market: context, filter: rules[0]), opportunity = evaluator.opportunity(at: context.hour)
                let direction = study.spec.direction == "auto" ? opportunity.direction : study.spec.direction
                for (ri, rule) in rules.enumerated() {
                    let truth = FilterEvaluator(market: context, filter: rule).evaluate().result
                    for side in ["Long", "Short"] {
                        var episode = ResearchEpisode()
                        _ = episode.observe(.all([truth, direction.map { $0 == side ? .yes : .no } ?? .unknown]), baseline: true)
                        checkpoint.episodes["\(ri):\(side)"] = episode
                    }
                }
            }
            while hour < min(manifest.through, instrument.delistedAt ?? manifest.through) {
                try ResearchPressure.shared.check()
                guard ProcessInfo.processInfo.thermalState != .critical else { throw FilterError("Research paused under critical thermal pressure. Resume when the Mac cools down.") }
                let last = min(min(manifest.through, instrument.delistedAt ?? manifest.through) - hourMS, hour + 63 * hourMS)
                let from = max(0, hour - Int64(warmup + 1) * hourMS), through = last + 49 * hourMS
                let referenceID = rules.contains(where: \.referencesBTC) ? btcReferenceID : instrument.id
                let estimated = try store.count("SELECT COALESCE(SUM(length(json)),0) FROM research_pins p JOIN research_data d USING(revision) WHERE p.manifest=? AND d.inst IN (?,?) AND d.ts>=? AND d.ts<=?", [manifest.id, instrument.id, referenceID, from, through])
                guard estimated < ResearchVersion.memoryBudget / 4 else { throw FilterError("This rule's lookback exceeds the 128 MiB research budget. The checkpoint was retained.") }
                let series = reconstruct(try store.series(instrument.id, from: from, through: through, manifest: manifest.id))
                let reference = try btcSeries(store: store, manifest: manifest, from: from, through: last, required: rules.contains(where: \.referencesBTC))
                try store.database.transaction {
                    for h in stride(from: hour, through: last, by: Int(hourMS)) {
                        try ResearchPressure.shared.check()
                        let timestamp = h + hourMS
                        guard instrument.eligible(at: timestamp) else { continue }
                        let context = context(instrument: instrument, hour: h, series: series, reference: reference)
                        let cacheID = "indicator:" + researchHash(manifest.digest + manifest.engine + instrument.id + String(h))
                        let saved = try store.get(cacheID, as: [String: ResearchCachedScalar].self)?.mapValues(\.scalar) ?? [:]
                        let evaluator = FilterEvaluator(market: context, filter: rules[0], sharedReadings: saved)
                        let opportunity = evaluator.opportunity(at: h), complete = scoreComplete(opportunity)
                        let direction = study.spec.direction == "auto" ? opportunity.direction : study.spec.direction
                        var shared = evaluator.sharedReadings
                        var traces: [FilterTrace] = []
                        for rule in rules {
                            let e = FilterEvaluator(market: context, filter: rule, sharedReadings: shared)
                            traces.append(e.evaluate(explain: true)); shared = e.sharedReadings
                        }
                        try store.put(cacheID, kind: "indicator", shared.mapValues(ResearchCachedScalar.init))
                        try store.database.execute("INSERT OR IGNORE INTO research_indicator_pins VALUES (?,?)", [manifest.id, cacheID])
                        let common = direction != nil && traces.allSatisfy { $0.result != .unknown }
                        let split = split(timestamp: timestamp, from: manifest.from, through: manifest.through)
                        for (ri, trace) in traces.enumerated() {
                            var entry = "none"
                            for side in ["Long", "Short"] {
                                let key = "\(ri):\(side)"
                                var episode = checkpoint.episodes[key] ?? ResearchEpisode()
                                let truth = study.spec.kind == "comparison" && !common ? FilterTruth.unknown : .all([trace.result, direction.map { $0 == side ? .yes : .no } ?? .unknown])
                                let onset = episode.observe(truth, baseline: timestamp == manifest.from)
                                checkpoint.episodes[key] = episode
                                if direction == side, trace.result == .yes {
                                    entry = timestamp == manifest.from ? "baseline" : onset == "uncertain" ? "uncertain" : study.spec.kind == "score" || study.spec.sampling == "hourly" ? "hourly" : onset ?? "none"
                                }
                            }
                            if study.spec.kind == "comparison" && !common { entry = "outsidePool" }
                            let hasEvent = ["entry", "hourly", "uncertain"].contains(entry)
                            let needsOutcomes = direction != nil && (hasEvent || trace.result == .no || study.spec.kind == "score" && trace.result == .yes)
                            let outcomes = needsOutcomes ? ResearchVersion.horizons.map { outcome(timestamp: timestamp, direction: direction!, hours: $0, series: series, costs: study.spec.costs) } : []
                            let event = hasEvent ? ResearchEvent(id: researchHash("\(study.id)|\(ri)|\(instrument.id)|\(timestamp)"), studyID: study.id, ruleIndex: ri, instrument: instrument.id, timestamp: timestamp, direction: direction!, entry: entry,
                                score: opportunity.score, scoreComplete: complete, status: opportunity.status, setup: opportunity.setup, split: split, outcomes: outcomes,
                                traceJSON: String(decoding: try SafeJSON.data(trace.snapshot, options: [.sortedKeys]), as: UTF8.self),
                                opportunityJSON: String(decoding: try SafeJSON.data(opportunity.snapshot, options: [.sortedKeys]), as: UTF8.self), sources: Array(Set(series.sources + [instrument.metadataSourceID].compactMap { $0 } + (reference?.sources ?? []))).sorted()) : nil
                            let recordedEntry = split == "Purged" && hasEvent ? "purged" : entry
                            try store.saveSample(study: study.id, rule: ri, instrument: instrument.id, timestamp: timestamp, truth: trace.result, direction: direction, entry: recordedEntry, opportunity: opportunity, complete: complete, split: split, outcomes: outcomes, event: event)
                        }
                    }
                    checkpoint.instrumentIndex = index; checkpoint.nextHour = last + hourMS; checkpoint.updatedAt = researchNow()
                    try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
                }
                hour = last + hourMS
                progress(manifest.instruments.prefix(index).reduce(0) { $0 + countHours($1) } + Int((hour - firstHour)/hourMS), hourlyTotal, "\(instrument.id) · \(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(hour) / 1000)))")
            }
            checkpoint.instrumentIndex = index + 1; checkpoint.nextHour = nil; checkpoint.episodes = [:]
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
    }
}

struct ResearchBootstrap {
    private var seed: UInt64 = 20_261_007
    private mutating func random(_ count: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 32) % UInt64(count)) }
    mutating func interval(_ blocks: [(sum: Double, count: Int)]) -> (Double, Double)? {
        guard blocks.count >= 8, blocks.reduce(0, { $0 + $1.count }) >= 30 else { return nil }
        var means: [Double] = []; means.reserveCapacity(2_000)
        for _ in 0..<2_000 {
            var sum = 0.0, count = 0
            for _ in blocks { let block = blocks[random(blocks.count)]; sum += block.sum; count += block.count }
            if count > 0 { means.append(sum / Double(count)) }
        }
        means.sort(); return (means[Int(Double(means.count - 1) * 0.025)], means[Int(Double(means.count - 1) * 0.975)])
    }
}

extension ResearchStore {
    func report(_ study: ResearchStudy, manifest: DataManifest) throws -> StudyReport {
        let scoreOnly = study.spec.kind == "score"
        var categories = ["'All signals'", "'Split · ' || s.split", "'Direction · ' || s.direction", "'Status · ' || s.status", "'Setup · ' || COALESCE(s.setup,'None')", "'Month · ' || s.month",
            "CASE WHEN s.score IS NULL THEN 'Score · Unavailable' ELSE (CASE WHEN s.complete=1 THEN 'Score · Full · ' ELSE 'Score · Partial · ' END) || (CASE WHEN s.score<40 THEN '0–39' WHEN s.score<60 THEN '40–59' WHEN s.score<65 THEN '60–64' WHEN s.score<70 THEN '65–69' WHEN s.score<75 THEN '70–74' WHEN s.score<80 THEN '75–79' ELSE '80–100' END) END"]
        for threshold in [65, 70, 75, 80] {
            categories.append("CASE WHEN s.complete=1 AND s.score>=\(threshold) THEN 'Score · Full · ≥\(threshold)' ELSE NULL END")
        }
        var summaries: [ResearchSummary] = []
        let joins = "research_samples s JOIN research_outcomes o USING(study,rule,inst,ts)"
        categories.append("'Uncertain entries · Excluded'")
        let controlWhere = scoreOnly ? "c.truth='true' AND c.complete=1 AND c.status='Watch'" : "c.truth='false'"
        let baseline = "SELECT c.rule,c.inst,c.direction,c.month,x.hours,AVG(x.gross) mean FROM research_samples c JOIN research_outcomes x USING(study,rule,inst,ts) WHERE c.study=? AND \(controlWhere) AND c.split!='Purged' AND c.entry!='outsidePool' GROUP BY c.rule,c.inst,c.direction,c.month,x.hours"
        for category in categories {
            try ResearchPressure.shared.check()
            let uncertain = category == "'Uncertain entries · Excluded'"
            let signalWhere = "s.study=? AND s.entry IN (\(uncertain ? "'uncertain'" : "'entry','hourly'")) AND s.direction IS NOT NULL"
            let full = scoreOnly && !uncertain && !category.hasPrefix("CASE") ? " AND s.complete=1" : ""
            let sql = "SELECT \(category),s.rule,o.hours,COUNT(o.gross),SUM(o.gross IS NULL),COUNT(o.net),AVG(o.gross),AVG(CASE WHEN o.gross IS NOT NULL THEN o.gross>0 END),AVG(o.net),AVG(CASE WHEN o.net IS NOT NULL THEN o.net>0 END),AVG(o.mfe),AVG(o.mae),AVG(CASE WHEN o.gross IS NOT NULL THEN b.mean END),AVG(o.gross-b.mean) FROM \(joins) LEFT JOIN (\(baseline)) b ON b.rule=s.rule AND b.inst=s.inst AND b.direction=s.direction AND b.month=s.month AND b.hours=o.hours WHERE \(signalWhere)\(full) GROUP BY 1,s.rule,o.hours HAVING (\(category)) IS NOT NULL ORDER BY 1,s.rule,o.hours"
            var rows: [ResearchSummary] = []
            try database.query(sql, [study.id, study.id]) { row in
                rows.append(ResearchSummary(group: Self.text(row, 0), ruleIndex: Int(sqlite3_column_int64(row, 1)), hours: Int(sqlite3_column_int64(row, 2)), count: Int(sqlite3_column_int64(row, 3)), excluded: Int(sqlite3_column_int64(row, 4)), netCount: Int(sqlite3_column_int64(row, 5)), mean: Self.number(row, 6), winRate: Self.number(row, 7), netMean: Self.number(row, 8), netWinRate: Self.number(row, 9), mfe: Self.number(row, 10), mae: Self.number(row, 11), baseline: Self.number(row, 12), excess: Self.number(row, 13)))
            }
            for var summary in rows {
                let values: [Any?] = [study.id, summary.group, Int64(summary.ruleIndex), Int64(summary.hours)]
                let whereSQL = "\(signalWhere)\(full) AND (\(category))=? AND s.rule=? AND o.hours=?"
                for net in [false, true] {
                    let metric = net ? "net" : "gross", count = net ? summary.netCount : summary.count
                    if count > 0 {
                        var middle: [Double] = []
                        try database.query("SELECT o.\(metric) FROM \(joins) WHERE \(whereSQL) AND o.\(metric) IS NOT NULL ORDER BY o.\(metric) LIMIT ? OFFSET ?", values + [Int64(count % 2 == 0 ? 2 : 1), Int64((count - 1) / 2)]) { middle.append(sqlite3_column_double($0, 0)) }
                        let median = middle.isEmpty ? nil : middle.reduce(0, +) / Double(middle.count)
                        if net { summary.netMedian = median } else { summary.median = median }
                    }
                    var blocks: [(Double, Int)] = []
                    try database.query("SELECT SUM(o.\(metric)),COUNT(o.\(metric)) FROM \(joins) WHERE \(whereSQL) AND o.\(metric) IS NOT NULL GROUP BY s.week ORDER BY s.week", values) { blocks.append((sqlite3_column_double($0, 0), Int(sqlite3_column_int64($0, 1)))) }
                    var bootstrap = ResearchBootstrap()
                    if !uncertain, let interval = bootstrap.interval(blocks) {
                        if net { summary.netIntervalLow = interval.0; summary.netIntervalHigh = interval.1 }
                        else { summary.intervalLow = interval.0; summary.intervalHigh = interval.1 }
                    }
                }
                summaries.append(summary)
            }
        }
        let evaluated = try count("SELECT COUNT(*) FROM research_samples WHERE study=?", [study.id])
        let unknown = try count("SELECT COUNT(*) FROM research_samples WHERE study=? AND truth='unknown'", [study.id])
        let directionless = try count("SELECT COUNT(*) FROM research_samples WHERE study=? AND truth='true' AND direction IS NULL", [study.id])
        let uncertain = try count("SELECT COUNT(*) FROM research_samples WHERE study=? AND entry='uncertain'", [study.id])
        let baselineCount = try count("SELECT COUNT(*) FROM research_samples WHERE study=? AND entry='baseline'", [study.id])
        let common = try count("SELECT COUNT(*) FROM research_samples WHERE study=? AND rule=0 AND direction IS NOT NULL AND entry!='outsidePool' AND truth!='unknown'", [study.id])
        return StudyReport(studyID: study.id, manifestID: manifest.id, spec: study.spec, summaries: summaries, evaluated: evaluated, unknown: unknown, directionless: directionless, uncertain: uncertain, baseline: baselineCount, commonPool: common, warnings: manifest.warnings)
    }
}
