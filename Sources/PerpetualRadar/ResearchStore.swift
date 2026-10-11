import Foundation
import CSQLite
import CryptoKit

// Each controller/worker owns its connection. Research never writes radar.sqlite3.
final class ResearchStore {
    let directory: URL
    let database: Store
    private let decoder = JSONDecoder()
    init(directory: URL) throws {
        self.directory = directory
        database = try Store(url: directory.appendingPathComponent("research.sqlite3"))
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("Raw"), withIntermediateDirectories: true)
        if try database.preference(forKey: "researchSchemaVersion") != "1" { try database.transaction {
            guard try database.preference(forKey: "researchSchemaVersion") != "1" else { return }
            try database.execute("CREATE TABLE IF NOT EXISTS research_objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL)")
            try database.execute("CREATE TABLE IF NOT EXISTS research_data (revision INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, digest TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(inst,kind,ts,digest))")
            try database.execute("CREATE INDEX IF NOT EXISTS research_data_key ON research_data(inst,kind,ts,revision)")
            try database.execute("CREATE TABLE IF NOT EXISTS research_heads (inst TEXT, kind TEXT, ts INTEGER, revision INTEGER NOT NULL, PRIMARY KEY(inst,kind,ts))")
            try database.execute("CREATE TABLE IF NOT EXISTS research_coverage (source TEXT PRIMARY KEY, inst TEXT, kind TEXT, first INTEGER, last INTEGER, parser TEXT)")
            try database.execute("CREATE TABLE IF NOT EXISTS research_pins (manifest TEXT, revision INTEGER, PRIMARY KEY(manifest,revision))")
            try database.execute("CREATE TABLE IF NOT EXISTS research_source_pins (manifest TEXT, source TEXT, PRIMARY KEY(manifest,source))")
            try database.execute("CREATE TABLE IF NOT EXISTS research_indicator_pins (manifest TEXT,key TEXT,PRIMARY KEY(manifest,key))")
            try database.execute("CREATE TABLE IF NOT EXISTS research_samples (study TEXT, rule INTEGER, inst TEXT, ts INTEGER, truth TEXT, direction TEXT, entry TEXT, score INTEGER, complete INTEGER, status TEXT, setup TEXT, split TEXT, month TEXT, week INTEGER, PRIMARY KEY(study,rule,inst,ts))")
            try database.execute("CREATE INDEX IF NOT EXISTS research_samples_report ON research_samples(study,entry,rule,inst,direction,month)")
            try database.execute("CREATE TABLE IF NOT EXISTS research_outcomes (study TEXT, rule INTEGER, inst TEXT, ts INTEGER, hours INTEGER, gross REAL, net REAL, mfe REAL, mae REAL, reason TEXT, net_reason TEXT, PRIMARY KEY(study,rule,inst,ts,hours))")
            try database.execute("CREATE TABLE IF NOT EXISTS research_events (id TEXT PRIMARY KEY, study TEXT, ts INTEGER, json TEXT)")
            try database.execute("CREATE INDEX IF NOT EXISTS research_events_page ON research_events(study,ts,id)")
            try database.setPreference("1", forKey: "researchSchemaVersion")
        } }
    }

    static var defaultDirectory: URL {
        if let url = MonitorRuntime.storeURL { return url.deletingLastPathComponent().appendingPathComponent("Research") }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PerpetualRadar/Research")
    }
    func put<T: Encodable>(_ id: String, kind: String, _ value: T) throws {
        try database.execute("INSERT INTO research_objects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,json=excluded.json", [id, kind, try researchJSON(value)])
    }
    func get<T: Decodable>(_ id: String, as type: T.Type) throws -> T? {
        var json: String?
        try database.query("SELECT json FROM research_objects WHERE id=?", [id]) { json = Self.text($0, 0) }
        return try json.map { try decoder.decode(type, from: Data($0.utf8)) }
    }
    func objects<T: Decodable>(_ kind: String, as type: T.Type) throws -> [T] {
        var json: [String] = []
        try database.query("SELECT json FROM research_objects WHERE kind=? ORDER BY rowid DESC", [kind]) { json.append(Self.text($0, 0)) }
        return try json.map { try decoder.decode(type, from: Data($0.utf8)) }
    }
    func rawURL(_ source: ResearchSource) -> URL { directory.appendingPathComponent("Raw/\(source.id).\(source.archive ? (source.filename.hasSuffix(".tar.gz") ? "tar.gz" : "zip") : "json")") }
    func rawIsComplete(_ source: ResearchSource) throws -> Bool {
        guard let saved = try get(source.id, as: ResearchSource.self), saved.rawHash != nil else { return false }
        return FileManager.default.fileExists(atPath: rawURL(saved).path)
    }
    func count(_ sql: String, _ values: [Any?] = []) throws -> Int {
        var count = 0; try database.query(sql, values) { count = Int(sqlite3_column_int64($0, 0)) }; return count
    }
    static func text(_ row: OpaquePointer, _ col: Int32) -> String {
        sqlite3_column_text(row, col).map { String(cString: $0) } ?? ""
    }
    static func number(_ row: OpaquePointer, _ col: Int32) -> Double? {
        sqlite3_column_type(row, col) == SQLITE_NULL ? nil : sqlite3_column_double(row, col)
    }

    func write(_ values: [ResearchDatum]) throws {
        try ResearchPressure.shared.check()
        if let available = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage, available < 16 * 1024 * 1024 { throw FilterError("Research stopped because disk space is low. Completed cache and checkpoints were retained.") }
        try database.transaction {
            for var datum in values {
                if datum.kind == "stat" || datum.kind == "quote", let previous = try latest(datum.instrument, kind: datum.kind, timestamp: datum.timestamp) {
                    if datum.kind == "stat" {
                        datum.stat = FilterStat(oi: datum.stat?.oi ?? previous.stat?.oi, sell: datum.stat?.sell ?? previous.stat?.sell, buy: datum.stat?.buy ?? previous.stat?.buy)
                    } else if let quote = datum.quote {
                        datum.quote = FilterQuote(turnover: quote.turnover ?? previous.quote?.turnover, spread: quote.spread ?? previous.quote?.spread, timestamp: max(quote.timestamp, previous.quote?.timestamp ?? 0))
                    }
                    datum.sources = Array(Set(datum.sources + previous.sources)).sorted()
                }
                let json = try researchJSON(datum), hash = researchHash(json)
                try database.execute("INSERT OR IGNORE INTO research_data(inst,kind,ts,digest,json) VALUES (?,?,?,?,?)", [datum.instrument, datum.kind, datum.timestamp, hash, json])
                try database.execute("INSERT INTO research_heads SELECT inst,kind,ts,revision FROM research_data WHERE inst=? AND kind=? AND ts=? AND digest=? ON CONFLICT(inst,kind,ts) DO UPDATE SET revision=excluded.revision", [datum.instrument, datum.kind, datum.timestamp, hash])
            }
        }
    }
    func latest(_ instrument: String, kind: String, timestamp: Int64) throws -> ResearchDatum? {
        var json: String?
        try database.query("SELECT d.json FROM research_heads h JOIN research_data d USING(revision) WHERE h.inst=? AND h.kind=? AND h.ts=?", [instrument, kind, timestamp]) { json = Self.text($0, 0) }
        return try json.map { try decoder.decode(ResearchDatum.self, from: Data($0.utf8)) }
    }
    func data(_ instrument: String, from: Int64, through: Int64, manifest: String? = nil) throws -> [ResearchDatum] {
        var json: [String] = []
        let join = manifest == nil ? "JOIN research_heads h USING(revision)" : "JOIN research_pins p USING(revision)"
        let clause = manifest == nil ? "" : " AND p.manifest=?"
        var values: [Any?] = [instrument, from, through]; if let manifest { values.append(manifest) }
        try database.query("SELECT d.json FROM research_data d \(join) WHERE d.inst=? AND d.ts>=? AND d.ts<=?\(clause) ORDER BY d.ts", values) { json.append(Self.text($0, 0)) }
        return try json.map { try decoder.decode(ResearchDatum.self, from: Data($0.utf8)) }
    }
    func series(_ instrument: String, from: Int64, through: Int64, manifest: String? = nil) throws -> ResearchSeries {
        var result = ResearchSeries(), marks: [Int64: Double] = [:], rates: [Int64: Double] = [:], sources = Set<String>()
        for value in try data(instrument, from: from, through: through, manifest: manifest) {
            sources.formUnion(value.sources)
            if let bar = value.candle { result.candles[value.timestamp] = bar }
            if let stat = value.stat { result.stats[value.timestamp] = stat }
            if let quote = value.quote { result.quotes[value.timestamp] = quote }
            if value.kind == "funding" {
                if let rate = value.rate { rates[value.timestamp] = rate }
                else { result.missingFunding.insert(value.timestamp) }
            }
            if let mark = value.mark { marks[value.timestamp] = mark }
        }
        result.funding = rates.sorted { $0.key < $1.key }.map { ResearchFunding(timestamp: $0.key, rate: $0.value, mark: marks[$0.key]) }
        result.fundingCoverage = try fundingCoverage(instrument, manifest: manifest)
        result.sources = sources.sorted()
        return result
    }
    func cover(_ source: ResearchSource, kind: String? = nil, from: Int64? = nil, through: Int64? = nil) throws {
        try database.execute("INSERT OR REPLACE INTO research_coverage VALUES (?,?,?,?,?,?)", [source.id, source.instrument, kind ?? source.kind, from ?? source.from, through ?? source.through, ResearchVersion.parser])
    }
    func missing(_ instrument: String, kind: String, from: Int64, through: Int64) throws -> [ResearchRange] {
        guard through >= from else { return [] }
        var covered: [ResearchRange] = []
        try database.query("SELECT first,last FROM research_coverage WHERE inst=? AND kind=? AND parser=? AND last>=? AND first<=? ORDER BY first", [instrument, kind, ResearchVersion.parser, from, through]) {
            covered.append(.init(from: sqlite3_column_int64($0, 0), through: sqlite3_column_int64($0, 1)))
        }
        let rowKind = ["oi", "taker"].contains(kind) ? "stat" : kind == "spread" ? "quote" : kind
        let field = kind == "oi" ? " AND json_extract(d.json,'$.stat.oi') IS NOT NULL" : kind == "taker" ? " AND json_extract(d.json,'$.stat.buy') IS NOT NULL AND json_extract(d.json,'$.stat.sell') IS NOT NULL" : kind == "spread" ? " AND json_extract(d.json,'$.quote.spread') IS NOT NULL" : ""
        try database.query("SELECT d.ts FROM research_heads h JOIN research_data d USING(revision) WHERE h.inst=? AND h.kind=? AND h.ts>=? AND h.ts<=?\(field) ORDER BY h.ts", [instrument, rowKind, from, through]) {
            let ts = sqlite3_column_int64($0, 0); covered.append(.init(from: ts, through: ts))
        }
        covered.sort { $0.from < $1.from }
        var next = from, missing: [ResearchRange] = []
        for range in covered {
            guard range.through >= next else { continue }
            if range.from > next { missing.append(.init(from: next, through: min(through, range.from - hourMS))) }
            next = max(next, range.through + hourMS)
            if next > through { break }
        }
        if next <= through { missing.append(.init(from: next, through: through)) }
        return missing
    }
    func coverage(_ instruments: [ResearchInstrument], from: Int64, through: Int64, manifest: String? = nil) throws -> [ResearchCoverage] {
        var result: [ResearchCoverage] = []
        for instrument in instruments {
            let begin = max(from, (instrument.listedAt ?? from) / hourMS * hourMS), end = min(through, instrument.delistedAt.map { $0 / hourMS * hourMS - hourMS } ?? through)
            if end < begin { continue }
            for (kind, rowKind, field) in [("candle", "candle", "$.candle.open"), ("oi", "stat", "$.stat.oi"), ("taker", "stat", "$.stat.buy"), ("spread", "quote", "$.quote.spread"), ("turnover recorded", "quote", "$.quote.turnover"), ("settlement mark", "mark", "$.mark")] {
                let join = manifest == nil ? "JOIN research_heads h USING(revision)" : "JOIN research_pins p USING(revision)"
                var values: [Any?] = [instrument.id, rowKind, begin, end, field]; if let manifest { values.append(manifest) }
                var hours: [Int64] = []
                try database.query("SELECT d.ts FROM research_data d \(join) WHERE d.inst=? AND d.kind=? AND d.ts>=? AND d.ts<=? AND json_extract(d.json,?) IS NOT NULL" + (manifest == nil ? "" : " AND p.manifest=?") + " ORDER BY d.ts", values) { hours.append(sqlite3_column_int64($0, 0)) }
                let gaps = ResearchDataProvider.subtract(.init(from: begin, through: end), covered: hours.map { .init(from: $0, through: $0) })
                result.append(.init(instrument: instrument.id, kind: kind, available: hours.count, expected: Int((end-begin)/hourMS)+1, first: hours.first, last: hours.last, gaps: gaps))
            }
            let series = try fundingCoverage(instrument.id, manifest: manifest)
            let gaps = ResearchDataProvider.subtract(.init(from: begin, through: end), covered: series)
            result.append(.init(instrument: instrument.id, kind: "funding inspected", available: Int((end-begin)/hourMS)+1-gaps.reduce(0) { $0+$1.hours }, expected: Int((end-begin)/hourMS)+1, first: series.map(\.from).min(), last: series.map(\.through).max(), gaps: gaps))
        }
        return result
    }
    func fundingCoverage(_ instrument: String, manifest: String?) throws -> [ResearchRange] {
        if let manifest, let frozen = try get(manifest, as: DataManifest.self) { return frozen.fundingRanges[instrument] ?? [] }
        var values: [Any?] = [instrument, ResearchVersion.parser]; if let manifest { values.append(manifest) }
        var ranges: [ResearchRange] = []
        try database.query("SELECT first,last FROM research_coverage WHERE inst=? AND kind='funding' AND parser=?" + (manifest == nil ? "" : " AND source IN (SELECT source FROM research_source_pins WHERE manifest=?)") + " ORDER BY first", values) { ranges.append(.init(from: sqlite3_column_int64($0,0), through: sqlite3_column_int64($0,1))) }
        return ranges
    }
    func pinInputs(_ plan: DataPlan, owner: String) throws {
        for instrument in plan.inputInstruments {
            try ResearchPressure.shared.check()
            try database.execute("INSERT OR IGNORE INTO research_pins SELECT ?,revision FROM research_heads WHERE inst=? AND ts>=? AND ts<=?", [owner, instrument.id, plan.from-Int64(plan.warmupHours+1)*hourMS, plan.through+48*hourMS])
            if let id = instrument.metadataSourceID { try database.execute("INSERT OR IGNORE INTO research_source_pins VALUES (?,?)", [owner, id]) }
            try database.execute("INSERT OR IGNORE INTO research_source_pins SELECT ?,source FROM research_coverage WHERE inst=? AND last>=? AND first<=?", [owner, instrument.id, plan.from-Int64(plan.warmupHours+1)*hourMS, plan.through+48*hourMS])
        }
        for source in plan.sources { try database.execute("INSERT OR IGNORE INTO research_source_pins VALUES (?,?)", [owner, source.id]) }
        try database.execute("INSERT OR IGNORE INTO research_source_pins SELECT ?,j.value FROM research_pins p JOIN research_data d USING(revision),json_each(d.json,'$.sources') j WHERE p.manifest=?", [owner, owner])
    }
    func freeze(_ plan: DataPlan) throws -> DataManifest {
        var manifest = DataManifest(planID: plan.id, from: plan.from, through: plan.through, instruments: plan.instruments, warnings: plan.warnings, unknownInstruments: plan.unknownInstruments)
        manifest.referenceInstruments = plan.referenceInstruments
        var hash = SHA256()
        try database.transaction {
            for instrument in plan.inputInstruments {
                if let source = instrument.metadataSourceID { try database.execute("INSERT OR IGNORE INTO research_source_pins VALUES (?,?)", [manifest.id, source]) }
                try database.execute("INSERT INTO research_pins SELECT ?,h.revision FROM research_heads h WHERE h.inst=? AND h.ts>=? AND h.ts<=?", [manifest.id, instrument.id, plan.from - Int64(plan.warmupHours + 1) * hourMS, plan.through + 48 * hourMS])
            }
            try database.execute("INSERT OR IGNORE INTO research_source_pins SELECT ?,j.value FROM research_pins p JOIN research_data d USING(revision),json_each(d.json,'$.sources') j WHERE p.manifest=?", [manifest.id, manifest.id])
            for source in plan.sources {
                if (try get(source.id, as: ResearchSource.self))?.rawHash != nil {
                    try database.execute("INSERT OR IGNORE INTO research_source_pins VALUES (?,?)", [manifest.id, source.id])
                }
            }
            // Include successfully inspected empty funding ranges, not just rows.
            for instrument in plan.inputInstruments {
                try database.execute("INSERT OR IGNORE INTO research_source_pins SELECT ?,source FROM research_coverage WHERE inst=? AND last>=? AND first<=?", [manifest.id, instrument.id, plan.from, plan.through + 48 * hourMS])
            }
            try database.query("SELECT digest FROM research_pins JOIN research_data USING(revision) WHERE manifest=? ORDER BY inst,kind,ts", [manifest.id]) { hash.update(data: Data(Self.text($0, 0).utf8)) }
            try database.query("SELECT source,kind,first,last,parser FROM research_coverage WHERE source IN (SELECT source FROM research_source_pins WHERE manifest=?) ORDER BY source", [manifest.id]) {
                hash.update(data: Data("\(Self.text($0,0))|\(Self.text($0,1))|\(sqlite3_column_int64($0,2))|\(sqlite3_column_int64($0,3))|\(Self.text($0,4))".utf8))
            }
            hash.update(data: Data(try researchJSON(plan.inputInstruments).utf8))
            for instrument in plan.inputInstruments { manifest.fundingRanges[instrument.id] = try fundingCoverage(instrument.id, manifest: nil) }
            manifest.coverage = try coverage(plan.inputInstruments, from: plan.from - hourMS, through: plan.through + 48 * hourMS, manifest: manifest.id)
            var sourceIDs: [String] = []
            try database.query("SELECT source FROM research_source_pins WHERE manifest=? ORDER BY source", [manifest.id]) { sourceIDs.append(Self.text($0,0)) }
            manifest.sources = try sourceIDs.compactMap { try get($0, as: ResearchSource.self) }
            manifest.unknownInstruments = Array(Set(plan.unknownInstruments + (try objects("instrument", as: ResearchInstrument.self)).filter { !$0.verified || $0.listedAt == nil }.map(\.id))).sorted()
            manifest.digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
            try put(manifest.id, kind: "manifest", manifest)
        }
        return manifest
    }
    func saveSample(study: String, rule: Int, instrument: String, timestamp: Int64, truth: FilterTruth, direction: String?, entry: String, opportunity: NativeOpportunity, complete: Bool, split: String, outcomes: [ResearchOutcome], event: ResearchEvent?) throws {
        let date = Date(timeIntervalSince1970: Double(timestamp) / 1000), formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM"
        let week = (timestamp + 3 * 24 * hourMS) / (7 * 24 * hourMS)
        try database.execute("INSERT OR REPLACE INTO research_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [study, Int64(rule), instrument, timestamp, truth.rawValue, direction, entry, opportunity.score.map { Int64($0) }, Int64(complete ? 1 : 0), opportunity.status, opportunity.setup, split, formatter.string(from: date), week])
        for outcome in outcomes {
            try database.execute("INSERT OR REPLACE INTO research_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?)", [study, Int64(rule), instrument, timestamp, Int64(outcome.hours), outcome.gross, outcome.net, outcome.mfe, outcome.mae, outcome.reason, outcome.netReason])
        }
        if let event { try database.execute("INSERT OR REPLACE INTO research_events VALUES (?,?,?,?)", [event.id, study, timestamp, try researchJSON(event)]) }
    }
    func events(_ study: String, offset: Int = 0, limit: Int = 50) throws -> [ResearchEvent] {
        var values: [String] = []
        try database.query("SELECT json FROM research_events WHERE study=? ORDER BY ts,id LIMIT ? OFFSET ?", [study, Int64(min(100, max(1, limit))), Int64(max(0, offset))]) { values.append(Self.text($0, 0)) }
        return try values.map { try decoder.decode(ResearchEvent.self, from: Data($0.utf8)) }
    }
    func event(_ id: String) throws -> ResearchEvent? {
        var value: String?; try database.query("SELECT json FROM research_events WHERE id=?", [id]) { value = Self.text($0, 0) }
        return try value.map { try decoder.decode(ResearchEvent.self, from: Data($0.utf8)) }
    }
    func deleteStudy(_ id: String) throws {
        let study = try get(id, as: ResearchStudy.self)
        try database.transaction {
            for table in ["research_samples", "research_outcomes", "research_events"] { try database.execute("DELETE FROM \(table) WHERE study=?", [id]) }
            for key in [id, "checkpoint:\(id)", "report:\(id)"] { try database.execute("DELETE FROM research_objects WHERE id=?", [key]) }
            for table in ["research_pins", "research_source_pins"] { try database.execute("DELETE FROM \(table) WHERE manifest=?", [id]) }
            if let manifest = study?.manifestID {
                let others = try objects("study", as: ResearchStudy.self).filter { $0.manifestID == manifest }
                if others.isEmpty {
                    try database.execute("DELETE FROM research_pins WHERE manifest=?", [manifest])
                    try database.execute("DELETE FROM research_source_pins WHERE manifest=?", [manifest])
                    try database.execute("DELETE FROM research_indicator_pins WHERE manifest=?", [manifest])
                    try database.execute("DELETE FROM research_objects WHERE id=?", [manifest])
                }
            }
        }
    }
    func cleanCache() throws -> Int64 {
        let studies = try objects("study", as: ResearchStudy.self)
        let pendingPlans = try studies.filter { $0.manifestID == nil }.compactMap { try get($0.planID, as: DataPlan.self) }
        try database.transaction {
            for study in studies where study.manifestID == nil {
                if let plan = try get(study.planID, as: DataPlan.self) { try pinInputs(plan, owner: study.id) }
            }
            let live = "SELECT id FROM research_objects WHERE kind='study' UNION SELECT json_extract(json,'$.manifestID') FROM research_objects WHERE kind='study' AND json_extract(json,'$.manifestID') IS NOT NULL"
            for table in ["research_pins", "research_source_pins", "research_indicator_pins"] { try database.execute("DELETE FROM \(table) WHERE manifest NOT IN (\(live))") }
            try database.execute("DELETE FROM research_objects WHERE kind='manifest' AND id NOT IN (\(live))")
        }
        var bytes: Int64 = 0
        let sources = try objects("source", as: ResearchSource.self)
        let metadataReferences = Set(try objects("instrument", as: ResearchInstrument.self).compactMap(\.metadataSourceID))
        for source in sources {
            guard try count("SELECT COUNT(*) FROM research_source_pins WHERE source=?", [source.id]) == 0, !metadataReferences.contains(source.id) else { continue }
            let file = rawURL(source)
            bytes += (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            try database.execute("DELETE FROM research_objects WHERE id=?", [source.id])
            try database.execute("DELETE FROM research_coverage WHERE source=?", [source.id])
        }
        try database.transaction {
            try database.execute("DELETE FROM research_heads WHERE revision NOT IN (SELECT revision FROM research_pins)")
            try database.execute("DELETE FROM research_data WHERE revision NOT IN (SELECT revision FROM research_pins)")

        }
        var referencedPages = Set<String>(), referencedFiles = Set<String>()
        for plan in pendingPlans {
            for source in plan.sources {
                let file = rawURL(source); referencedFiles.formUnion([file.path, file.appendingPathExtension("part").path, file.appendingPathExtension("part").appendingPathExtension("validator").path])
            }
        }
        for page in try objects("rawPage", as: ResearchRawPage.self) {
            if let source = page.sourceID, try count("SELECT COUNT(*) FROM research_source_pins WHERE source=?", [source]) > 0 { referencedPages.insert(page.path) }
        }
        for source in try objects("source", as: ResearchSource.self) {
            let raw = rawURL(source); referencedFiles.insert(raw.path)
            if !source.archive, let data = try? Data(contentsOf: raw), let pages = try? decoder.decode([ResearchRawPage].self, from: data) { referencedPages.formUnion(pages.map(\.path)) }
        }
        for file in try FileManager.default.contentsOfDirectory(at: directory.appendingPathComponent("Raw"), includingPropertiesForKeys: [.fileSizeKey]) where !referencedFiles.contains(file.path) && !referencedPages.contains(file.path) {
            bytes += (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            try FileManager.default.removeItem(at: file)
        }
        try database.execute("DELETE FROM research_objects WHERE kind='rawPage' AND json_extract(json,'$.sourceID') NOT IN (SELECT source FROM research_source_pins)")
        try database.execute("DELETE FROM research_objects WHERE kind='indicator' AND id NOT IN (SELECT key FROM research_indicator_pins)")
        return bytes
    }
}
