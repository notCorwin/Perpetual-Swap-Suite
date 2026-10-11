import Foundation
import CryptoKit

protocol ResearchTransport: Sendable {
    func get(_ url: URL) async throws -> Data
    func download(_ url: URL, to destination: URL) async throws
}

actor OKXResearchTransport: ResearchTransport {
    private let session: URLSession
    private var lastRequest = ContinuousClock.now - .seconds(1)
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        session = URLSession(configuration: configuration)
    }
    func get(_ url: URL) async throws -> Data {
        let wait = lastRequest + .milliseconds(420) - ContinuousClock.now
        if wait > .zero { try await Task.sleep(for: wait) }
        lastRequest = .now
        let (data, response) = try await session.data(from: url)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count < 16 * 1024 * 1024 else { throw FilterError("OKX history request failed: \(url.path).") }
        return data
    }
    func download(_ url: URL, to destination: URL) async throws {
        let part = destination.appendingPathExtension("part"), validatorURL = part.appendingPathExtension("validator")
        let existing = (try? part.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        let validator = try? String(contentsOf: validatorURL, encoding: .utf8)
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if existing > 0, let validator { request.setValue("bytes=\(existing)-", forHTTPHeaderField: "Range"); request.setValue(validator, forHTTPHeaderField: "If-Range") }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw FilterError("Archive download failed; completed files remain cached.") }
        if response.statusCode == 416, existing > 0, validator != nil,
           response.value(forHTTPHeaderField: "Content-Range") == "bytes */\(existing)",
           (response.value(forHTTPHeaderField: "ETag") ?? response.value(forHTTPHeaderField: "Last-Modified")).map({ $0 == validator }) != false {
            // Cancellation after the final buffer can leave a complete .part.
            // The importer still verifies the full file's hash and archive CRC.
            try FileManager.default.moveItem(at: part, to: destination)
            try? FileManager.default.removeItem(at: validatorURL); return
        }
        guard [200, 206].contains(response.statusCode) else { throw FilterError("Archive download failed; completed files remain cached.") }
        let resumed = response.statusCode == 206
        if resumed {
            guard existing > 0, response.value(forHTTPHeaderField: "Content-Range")?.hasPrefix("bytes \(existing)-") == true else { throw FilterError("Invalid archive continuation response.") }
        } else {
            FileManager.default.createFile(atPath: part.path, contents: nil)
            let handle = try FileHandle(forWritingTo: part); try handle.truncate(atOffset: 0); try handle.close()
        }
        if let value = response.value(forHTTPHeaderField: "ETag") ?? response.value(forHTTPHeaderField: "Last-Modified") { try value.write(to: validatorURL, atomically: true, encoding: .utf8) }
        if response.expectedContentLength > 0 {
            let available = try destination.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
            if let available, available < response.expectedContentLength + 64 * 1024 * 1024 { throw FilterError("Not enough disk space for this archive. Clear unreferenced cache or free disk space, then resume.") }
        }
        let handle = try FileHandle(forWritingTo: part); defer { try? handle.close() }
        if resumed { try handle.seekToEnd() }
        var buffer = Data(); buffer.reserveCapacity(64 * 1024)
        do {
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count >= 64 * 1024 { try handle.write(contentsOf: buffer); buffer.removeAll(keepingCapacity: true); try ResearchPressure.shared.check() }
            }
            if !buffer.isEmpty { try handle.write(contentsOf: buffer) }
            try handle.synchronize()
        } catch {
            if !buffer.isEmpty { try? handle.write(contentsOf: buffer) }
            throw error
        }
        if response.expectedContentLength >= 0 {
            let actual = try part.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard Int64(actual) == response.expectedContentLength + (resumed ? existing : 0) else { throw FilterError("The archive download ended before its declared length. Resume to finish the partial file.") }
        }
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        try FileManager.default.moveItem(at: part, to: destination)
        try? FileManager.default.removeItem(at: validatorURL)
    }
}

final class ResearchDataProvider {
    // OKX rejects catalog requests with more than five families (code 50025).
    private static let archiveFamilyLimit = 5
    let store: ResearchStore
    let transport: any ResearchTransport
    let radarURL: URL?
    init(store: ResearchStore, transport: any ResearchTransport = OKXResearchTransport(), radarURL: URL? = nil) {
        self.store = store; self.transport = transport
        self.radarURL = radarURL ?? MonitorRuntime.storeURL ?? ResearchStore.defaultDirectory.deletingLastPathComponent().appendingPathComponent("radar.sqlite3")
    }
    static func url(_ path: String, _ parameters: [(String, String)]) -> URL {
        var components = URLComponents(string: "https://www.okx.com/api/v5\(path)")!
        components.queryItems = parameters.map { URLQueryItem(name: $0.0, value: $0.1) }; return components.url!
    }
    private func rows(_ data: Data) throws -> [Any] {
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any], response["code"] as? String == "0", let rows = response["data"] as? [Any] else { throw FilterError("OKX rejected a public history request: \(String(decoding: data.prefix(300), as: UTF8.self)).") }
        return rows
    }
    private func instruments(through: Int64, refresh: Bool) async throws -> [ResearchInstrument] {
        var previous = try store.objects("instrument", as: ResearchInstrument.self)
        if !refresh, !previous.isEmpty, previous.filter(\.verified).map(\.observedAt).max().map({ $0 >= through }) == true { return previous }
        let url = Self.url("/public/instruments", [("instType", "SWAP")]), data = try await transport.get(url)
        let raw = ResearchSource(id: researchHash(url.absoluteString + researchHash(data)), instrument: "CATALOG", kind: "metadata", from: 0, through: researchNow(), url: url.absoluteString, filename: "OKX instrument metadata snapshot", sizeBytes: Int64(data.count), archive: false, rawHash: researchHash(data))
        try data.write(to: store.rawURL(raw), options: .atomic); try store.put(raw.id, kind: "source", raw)
        for case let item as [String: Any] in try rows(data) {
            guard let id = item["instId"] as? String, id.hasSuffix("-USDT-SWAP") else { continue }
            let old = previous.first { $0.id == id }
            let verified = item["instCategory"] as? String == "1" && item["settleCcy"] as? String == "USDT"
            let base = id.components(separatedBy: "-").first
            let value = item["ctValCcy"] as? String == base ? (item["ctVal"] as? String).flatMap(Double.init) : nil
            let multiplier = (item["ctMult"] as? String).flatMap(Double.init) ?? 1
            let instrument = ResearchInstrument(id: id, listedAt: (item["listTime"] as? String).flatMap(Int64.init).flatMap { $0 > 0 ? $0 : nil } ?? old?.listedAt,
                delistedAt: (item["expTime"] as? String).flatMap(Int64.init).flatMap { $0 > 0 ? $0 : nil } ?? old?.delistedAt,
                verified: verified, contractValue: value.map { $0 * multiplier }, source: url.absoluteString, observedAt: researchNow(), metadataSourceID: raw.id)
            try store.put("instrument:\(id)", kind: "instrument", instrument)
            previous.removeAll { $0.id == id }; previous.append(instrument)
        }
        return previous.sorted { $0.id < $1.id }
    }
    private func importRadar(_ instruments: [ResearchInstrument], from: Int64, through: Int64) throws {
        guard let radarURL, FileManager.default.fileExists(atPath: radarURL.path) else { return }
        let radar = try Store(url: radarURL)
        for instrument in instruments {
            var first = from
            while first <= through {
                try ResearchPressure.shared.check()
                let last = min(through, first + 999 * hourMS)
                let candles = try radar.candles(instrument.id, since: first, through: last), stats = try radar.chartStats(instrument.id, since: first, through: last), quotes = try radar.hourlyQuotes(instrument.id, since: first, through: last)
                let id = "radar:\(instrument.id):\(first):\(last)", raw = try researchJSON(LocalRows(candles: Array(candles.values).sorted { $0.hour < $1.hour }, stats: stats.mapValues { FilterStat(oi: $0.oi, sell: $0.sell, buy: $0.buy) }, quotes: quotes))
                let source = ResearchSource(id: researchHash(id + raw), instrument: instrument.id, kind: "local", from: first, through: last, url: radarURL.path, filename: "Local confirmed hours", sizeBytes: Int64(raw.utf8.count), archive: false, rawHash: researchHash(raw))
                if !candles.isEmpty || !stats.isEmpty || !quotes.isEmpty {
                    if !(try store.rawIsComplete(source)) { try Data(raw.utf8).write(to: store.rawURL(source), options: .atomic); try store.put(source.id, kind: "source", source) }
                    var values = candles.values.filter { $0.confirmed && $0.open != nil }.map { ResearchDatum(instrument: instrument.id, kind: "candle", timestamp: $0.hour, candle: $0, sources: [source.id]) }
                    values += stats.map { ResearchDatum(instrument: instrument.id, kind: "stat", timestamp: $0.key, stat: FilterStat(oi: $0.value.oi, sell: $0.value.sell, buy: $0.value.buy), sources: [source.id]) }
                    values += quotes.map { ResearchDatum(instrument: instrument.id, kind: "quote", timestamp: $0.key, quote: $0.value, sources: [source.id]) }
                    values = try values.compactMap { value in
                        guard let old = try store.latest(value.instrument, kind: value.kind, timestamp: value.timestamp) else { return value }
                        if value.kind == "candle" { return nil }
                        var fill = value
                        if let stat = value.stat {
                            fill.stat = FilterStat(oi: old.stat?.oi == nil ? stat.oi : nil, sell: old.stat?.sell == nil ? stat.sell : nil, buy: old.stat?.buy == nil ? stat.buy : nil)
                            if fill.stat?.oi == nil && fill.stat?.buy == nil && fill.stat?.sell == nil { return nil }
                        }
                        if let quote = value.quote {
                            fill.quote = FilterQuote(turnover: old.quote?.turnover == nil ? quote.turnover : nil, spread: old.quote?.spread == nil ? quote.spread : nil, timestamp: quote.timestamp)
                            if fill.quote?.turnover == nil && fill.quote?.spread == nil { return nil }
                        }
                        return fill
                    }
                    try store.write(values)
                }
                first = last + hourMS
            }
        }
    }
    private struct LocalRows: Codable { var candles: [Candle]; var stats: [Int64: FilterStat]; var quotes: [Int64: FilterQuote] }
    private func restSource(_ instrument: String, kind: String, _ range: ResearchRange, refresh: Bool) -> ResearchSource {
        let paths = ["candle": "/market/history-candles", "oi": "/rubik/stat/contracts/open-interest-history", "taker": "/rubik/stat/taker-volume-contract", "funding": "/public/funding-rate-history", "mark": "/market/history-mark-price-candles"]
        var parameters = [("instId", instrument)]
        if kind == "candle" || kind == "mark" { parameters += [("bar", "1H"), ("after", String(range.through + hourMS)), ("limit", kind == "mark" ? "100" : "300")] }
        else if kind == "funding" { parameters += [("after", String(range.through + hourMS)), ("limit", "400")] }
        else { parameters += [("period", "1H"), ("end", String(range.through + hourMS)), ("begin", String(range.from - 1)), ("limit", "100")]; if kind == "taker" { parameters.append(("unit", "1")) } }
        let url = Self.url(paths[kind]!, parameters).absoluteString
        return ResearchSource(id: researchHash(url + ":\(range.from):\(range.through)" + (refresh ? UUID().uuidString : "")), instrument: instrument, kind: kind, from: range.from, through: range.through, url: url, filename: "\(instrument) · \(kind) · REST", sizeBytes: nil, archive: false, refresh: refresh)
    }
    private func archiveSources(module: Int, instruments: [ResearchInstrument], from: Int64, through: Int64, refresh: Bool) async throws -> [ResearchSource] {
        guard from <= through else { return [] }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        if [4, 5, 6].contains(module) { calendar.timeZone = TimeZone(secondsFromGMT: 0)! }
        let firstDate = Date(timeIntervalSince1970: Double(from) / 1000)
        let daily = [4, 5, 6].contains(module)
        var month = daily ? calendar.startOfDay(for: firstDate) : calendar.date(from: calendar.dateComponents([.year, .month], from: firstDate))!
        var result: [ResearchSource] = []
        while Int64(month.timeIntervalSince1970 * 1000) <= through {
            try Task.checkCancellation()
            let endMonth = calendar.date(byAdding: daily ? .day : .month, value: 10, to: month)!
            let end = min(through, Int64(endMonth.timeIntervalSince1970 * 1000) - 1)
            for chunk in stride(from: 0, to: instruments.count, by: Self.archiveFamilyLimit) {
                let group = Array(instruments[chunk..<min(chunk + Self.archiveFamilyLimit, instruments.count)])
                let families = group.map { $0.id.replacingOccurrences(of: "-SWAP", with: "") }.joined(separator: ",")
                let url = Self.url("/public/market-data-history", [("module", String(module)), ("instType", "SWAP"), ("instFamilyList", families), ("dateAggrType", daily ? "daily" : "monthly"), ("begin", String(Int64(month.timeIntervalSince1970 * 1000))), ("end", String(end))])
                let cacheID = "catalog:" + researchHash(url.absoluteString)
                let catalogRows: [Any]
                if !refresh, let cached = try store.get(cacheID, as: CachedCatalog.self) { catalogRows = try rows(Data(cached.json.utf8)) }
                else {
                    let data = try await transport.get(url)
                    catalogRows = try rows(data)
                    try store.put(cacheID, kind: "catalog", CachedCatalog(json: String(decoding: data, as: UTF8.self)))
                }
                for case let top as [String: Any] in catalogRows {
                    for case let detail as [String: Any] in top["details"] as? [Any] ?? [] {
                        for case let file as [String: Any] in detail["groupDetails"] as? [Any] ?? [] {
                            guard let filename = file["filename"] as? String, let download = file["url"] as? String else { continue }
                            let instrument = group.first { filename.hasPrefix($0.id + "-") }?.id
                                ?? (detail["instFamily"] as? String).map { $0 + "-SWAP" }
                            guard let instrument, group.contains(where: { $0.id == instrument }) else { continue }
                            // Dates in API queries use module-specific timezones. File rows
                            // remain absolute UTC timestamps; filename dates use the module timezone.
                            let period = Self.fileRange(filename, module: module) ?? ResearchRange(from: from, through: end)
                            if period.through < from || period.from > through { continue }
                            let kind = module == 2 ? "candle" : module == 3 ? "funding" : module == 1 ? "taker" : "spread"
                            result.append(ResearchSource(id: researchHash(download + (refresh ? UUID().uuidString : "")), instrument: instrument, kind: kind, from: period.from, through: period.through, url: download, filename: filename, sizeBytes: (file["sizeMB"] as? String).flatMap(Double.init).map { Int64($0 * 1_000_000) }, archive: true, module: module))
                        }
                    }
                }
            }
            month = endMonth
        }
        return result
    }
    private struct CachedCatalog: Codable { var json: String }
    static func fileRange(_ filename: String, module: Int = 2) -> ResearchRange? {
        let pattern = /([0-9]{4})-([0-9]{2})(?:-([0-9]{2}))?\.(?:zip|tar\.gz)/
        guard let match = filename.firstMatch(of: pattern), let year = Int(match.1), let month = Int(match.2) else { return nil }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: [4, 5, 6].contains(module) ? 0 : 8 * 3600)!
        guard let first = calendar.date(from: DateComponents(year: year, month: month, day: match.3.flatMap { Int($0) } ?? 1)),
              let end = calendar.date(byAdding: match.3 == nil ? .month : .day, value: 1, to: first) else { return nil }
        return .init(from: Int64(first.timeIntervalSince1970 * 1000), through: Int64(end.timeIntervalSince1970 * 1000) - hourMS)
    }
    func plan(_ spec: StudySpec, refresh: Bool = false, progress: @escaping @Sendable (String) async -> Void) async throws -> DataPlan {
        try spec.validate()
        await progress("Reading the fixed local cache and instrument registry…")
        let registry = try await instruments(through: spec.through, refresh: refresh)
        let chosen = registry.filter { $0.verified && $0.listedAt != nil && (spec.instruments.isEmpty || spec.instruments.contains($0.id)) }
        guard !chosen.isEmpty else { throw FilterError("No verified eligible USDT swaps. Refresh the instrument catalog or choose a known instrument.") }
        let earliest = chosen.compactMap(\.listedAt).min()! / hourMS * hourMS + hourMS
        let first = spec.from ?? earliest
        let rules = try spec.allRules.map { try FilterCompiler.compile(FilterConfigV2.decode($0.filtersJSON)) }
        let warmup = ResearchVersion.warmup(rules)
        let last = min(spec.through + 48 * hourMS, researchNow() / hourMS * hourMS - hourMS)
        var plan = DataPlan(spec: spec, instruments: chosen, from: first, through: spec.through, warmupHours: warmup)
        if rules.contains(where: \.referencesBTC) {
            if let reference = registry.first(where: { $0.id == btcReferenceID && $0.verified && $0.listedAt != nil }) { plan.referenceInstruments = [reference] }
            else { plan.warnings.append("BTC reference metadata is unavailable; BTC readings remain Unknown.") }
        }
        let inputs = plan.inputInstruments
        try importRadar(inputs, from: max(0, first - Int64(warmup + 1) * hourMS), through: last)
        plan.unknownInstruments = Array(Set(registry.filter { !$0.verified || $0.listedAt == nil }.map(\.id) + spec.instruments.filter { id in !chosen.contains { $0.id == id } })).sorted()
        plan.warnings += ["Historic eligibility is limited to instruments with verified metadata. Archive-only symbols without verified classification or listing dates are reported separately.", "Hourly OI has limited public coverage. Full and partial Opportunity scores are reported separately."]
        if rules.contains(where: \.hasLiveBTC) { plan.warnings.append("Hourly approximation of live BTC rules: check at the completed hourly close and execute at the next hourly open. Intrahour trigger times are not reconstructed.") }
        let metrics = Set(rules.flatMap { $0.metrics }), scoreInputs = spec.kind == "score" || metrics.contains { $0.hasPrefix("opportunity") }
        let needSpread = metrics.contains("spread"), needFlow = scoreInputs || !metrics.isDisjoint(with: ["buy", "sell", "takerRatio", "buyVsSell"])
        let needOI = scoreInputs || !metrics.isDisjoint(with: ["oiUSD", "oiChange", "oiTrend"])
        let btcMetrics = Set(rules.flatMap { $0.btcRequirements?.metrics ?? [] })
        func needs(_ kind: String, _ id: String) -> Bool {
            let target = chosen.contains { $0.id == id }
            let reference = id == btcReferenceID && rules.contains(where: \.referencesBTC)
            switch kind {
            case "candle": return true
            case "oi": return target && needOI || reference && (btcMetrics.contains { $0.hasPrefix("opportunity") } || !btcMetrics.isDisjoint(with: ["oiUSD", "oiChange", "oiTrend"]))
            case "taker": return target && needFlow || reference && (btcMetrics.contains { $0.hasPrefix("opportunity") } || !btcMetrics.isDisjoint(with: ["buy", "sell", "buyVsSell", "takerRatio"]))
            case "spread": return target && needSpread || reference && btcMetrics.contains("spread")
            default: return target && spec.costs != nil
            }
        }
        let recent = researchNow() / hourMS * hourMS - 60 * 24 * hourMS
        let oldEnd = min(last, recent - hourMS)
        let earliestInput = max(0, first - Int64(warmup + 1) * hourMS)
        var catalogs: [Int: [ResearchSource]] = [:]
        // Batch within the catalog family limit; cached complete periods need no catalog requests.
        for (module, kind, end) in [(2, "candle", oldEnd), (1, "taker", oldEnd), (3, "funding", oldEnd), (4, "spread", last)] where earliestInput <= end {
            let missing = try inputs.filter { instrument in
                guard needs(kind, instrument.id) else { return false }
                let begin = max(earliestInput, instrument.listedAt! / hourMS * hourMS)
                guard begin <= end else { return false }
                if refresh { return true }
                return try !store.missing(instrument.id, kind: kind, from: begin, through: end).isEmpty
            }
            if !missing.isEmpty {
                await progress("Reading published \(kind) archive ranges for \(missing.count) instrument families…")
                catalogs[module] = try await archiveSources(module: module, instruments: missing, from: earliestInput, through: end, refresh: refresh)
            }
        }
        func published(_ module: Int, _ id: String, _ from: Int64, _ through: Int64) -> [ResearchSource] {
            catalogs[module, default: []].filter { $0.instrument == id && $0.through >= from && $0.from <= through }
        }
        for (index, instrument) in inputs.enumerated() {
            try Task.checkCancellation(); await progress("Planning \(instrument.id) · \(index + 1)/\(inputs.count)")
            let begin = max(first - Int64(warmup + 1) * hourMS, instrument.listedAt! / hourMS * hourMS)
            guard begin <= last else { continue }
            plan.requestedHours += Int((last - begin) / hourMS) + 1
            plan.cachedHours += try store.count("SELECT COUNT(*) FROM research_heads WHERE inst=? AND kind='candle' AND ts>=? AND ts<=?", [instrument.id, begin, last])
            let missingPrices = refresh ? [ResearchRange(from: begin, through: last)] : try store.missing(instrument.id, kind: "candle", from: begin, through: last)
            for range in missingPrices {
                var archives: [ResearchSource] = []
                if range.from <= oldEnd { archives = published(2, instrument.id, range.from, min(range.through, oldEnd)) }
                plan.sources += archives
                // REST also covers older periods when an archive is not published.
                let archiveRanges = archives.map { ResearchRange(from: $0.from, through: $0.through) }
                for gap in Self.subtract(range, covered: archiveRanges) { plan.sources.append(restSource(instrument.id, kind: "candle", gap, refresh: refresh)) }
            }
            for kind in ["oi", "taker", "funding", "mark", "spread"] where needs(kind, instrument.id) {
                let ranges = refresh ? [ResearchRange(from: begin, through: last)] : try store.missing(instrument.id, kind: kind, from: begin, through: last)
                for range in ranges {
                    if ["taker", "funding", "spread"].contains(kind), range.from <= oldEnd {
                        let module = kind == "taker" ? 1 : kind == "funding" ? 3 : 4
                        let archives = published(module, instrument.id, range.from, min(range.through, oldEnd))
                        plan.sources += archives
                        if archives.isEmpty { plan.warnings.append("\(instrument.id): no \(kind) archive is available for part of the requested range; those inputs remain Unknown.") }
                    }
                    if kind != "spread" {
                        let restBegin = ["oi", "taker", "funding"].contains(kind) ? max(range.from, kind == "funding" ? recent - 30 * 24 * hourMS : recent) : range.from
                        if restBegin <= range.through { plan.sources.append(restSource(instrument.id, kind: kind, .init(from: restBegin, through: range.through), refresh: refresh)) }
                    } else if range.through > oldEnd {
                        plan.sources += published(4, instrument.id, max(range.from, oldEnd + hourMS), range.through)
                    }
                }
            }
        }
        if !refresh {
            plan.sources += try store.objects("source", as: ResearchSource.self).filter { source in
                source.parser != ResearchVersion.parser && needs(source.kind, source.instrument) && source.through >= earliestInput && source.from <= last && inputs.contains(where: { $0.id == source.instrument })
            }
        }
        plan.sources = Array(Dictionary(plan.sources.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }).values).sorted { ($0.instrument, $0.kind, $0.from) < ($1.instrument, $1.kind, $1.from) }
        for index in plan.sources.indices { plan.sources[index].cached = try store.rawIsComplete(plan.sources[index]) }
        plan.warnings = Array(Set(plan.warnings)).sorted()
        await progress("Inspecting local input coverage and gaps…")
        plan.coverage = try store.coverage(inputs, from: max(0, first-Int64(warmup+1)*hourMS), through: last)
        try store.put(plan.id, kind: "plan", plan)
        return plan
    }
    static func subtract(_ range: ResearchRange, covered: [ResearchRange]) -> [ResearchRange] {
        var next = range.from, result: [ResearchRange] = []
        for part in covered.sorted(by: { $0.from < $1.from }) {
            if part.through < next { continue }
            if part.from > next { result.append(.init(from: next, through: min(range.through, part.from - hourMS))) }
            next = max(next, part.through + hourMS); if next > range.through { break }
        }
        if next <= range.through { result.append(.init(from: next, through: range.through)) }; return result
    }
    private func hashFile(_ file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }; var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { try Task.checkCancellation(); hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func prepare(_ source: ResearchSource, instruments: [ResearchInstrument]) async throws {
        var source = source
        let file = store.rawURL(source)
        if !(try store.rawIsComplete(source)) {
            if source.archive { try await transport.download(URL(string: source.url)!, to: file) }
            else { try await fetchREST(source, file: file) }
            source.rawHash = try hashFile(file)
            try store.put(source.id, kind: "source", source)
        } else if let saved = try store.get(source.id, as: ResearchSource.self) {
            guard try hashFile(file) == saved.rawHash else { throw FilterError("A cached archive failed its SHA-256 check. Refresh the data plan to replace it.") }
            source.rawHash = saved.rawHash
        }
        if source.archive {
            let importer = ResearchArchiveImporter(store: store, source: source, instruments: instruments)
            let encountered = try importer.run(file: file)
            for id in encountered where !instruments.contains(where: { $0.id == id }) {
                if try store.get("instrument:\(id)", as: ResearchInstrument.self) == nil {
                    try store.put("instrument:\(id)", kind: "instrument", ResearchInstrument(id: id, verified: false, source: source.url, observedAt: researchNow()))
                }
            }
        } else { try parseREST(source, file: file) }
        source.parser = ResearchVersion.parser; try store.put(source.id, kind: "source", source)
        try store.cover(source)
    }
    private func fetchREST(_ source: ResearchSource, file: URL) async throws {
        // Each fetched page is fixed immediately. A restart reuses all completed
        // pages rather than refetching a partially prepared multi-year range.
        var cursor = source.through + hourMS, pages: [ResearchRawPage] = []
        while cursor > source.from {
            try Task.checkCancellation()
            var components = URLComponents(string: source.url)!
            let key = ["oi", "taker"].contains(source.kind) ? "end" : "after"
            components.queryItems = components.queryItems?.map { $0.name == key ? URLQueryItem(name: key, value: String(cursor)) : $0 }
            let url = components.url!, pageID = "page:" + researchHash(url.absoluteString + (source.refresh ? source.id : ""))
            let page = store.directory.appendingPathComponent("Raw/\(researchHash(pageID)).page")
            let data: Data
            if FileManager.default.fileExists(atPath: page.path) { data = try Data(contentsOf: page) }
            else { data = try await transport.get(url); _ = try rows(data); try data.write(to: page, options: .atomic) }
            let record = ResearchRawPage(path: page.path, digest: researchHash(data), sourceID: source.id)
            pages.append(record)
            try store.put("raw-page:\(source.id):\(researchHash(pageID))", kind: "rawPage", record)
            let values = try rows(data)
            let timestamps = values.compactMap { row -> Int64? in
                if let row = row as? [String] { return row.first.flatMap(Int64.init) }
                return (row as? [String: Any])?["fundingTime"].flatMap { ($0 as? String).flatMap(Int64.init) }
            }
            guard let oldest = timestamps.min(), oldest < cursor else { break }
            cursor = oldest
            if oldest <= source.from { break }
        }
        // The compact file is an index of permanently cached raw response pages.
        try researchJSON(pages).write(to: file, atomically: true, encoding: .utf8)
    }
    private func parseREST(_ source: ResearchSource, file: URL) throws {
        let pages = try JSONDecoder().decode([ResearchRawPage].self, from: Data(contentsOf: file))
        for page in pages {
            try Task.checkCancellation()
            var batch: [ResearchDatum] = []
            let data = try Data(contentsOf: URL(fileURLWithPath: page.path))
            guard researchHash(data) == page.digest else { throw FilterError("A cached REST page failed its SHA-256 check. Refresh the data plan to replace it.") }
            for item in try rows(data) {
                if source.kind == "funding" {
                    guard let value = item as? [String: Any], let ts = (value["fundingTime"] as? String).flatMap(Int64.init) else { throw FilterError("Funding history contains an invalid settlement timestamp. Its raw response was retained.") }
                    guard ts >= source.from, ts <= source.through + hourMS else { continue }
                    let rate = (value["realizedRate"] as? String).flatMap(Double.init).flatMap { $0.isFinite ? $0 : nil }
                    batch.append(.init(instrument: source.instrument, kind: "funding", timestamp: ts, rate: rate, sources: [source.id])); continue
                }
                guard let value = item as? [String], let ts = value.first.flatMap(Int64.init), ts >= source.from, ts <= source.through else { continue }
                if source.kind == "candle", let candle = Candle(value), candle.confirmed { batch.append(.init(instrument: source.instrument, kind: "candle", timestamp: ts, candle: candle, sources: [source.id])) }
                if source.kind == "mark", value.count >= 6, value[5] == "1", let mark = Double(value[1]), mark.isFinite, mark > 0 { batch.append(.init(instrument: source.instrument, kind: "mark", timestamp: ts, mark: mark, sources: [source.id])) }
                if source.kind == "oi", value.count >= 4, let oi = Double(value[3]), oi.isFinite, oi >= 0 { batch.append(.init(instrument: source.instrument, kind: "stat", timestamp: ts, stat: FilterStat(oi: oi, sell: nil, buy: nil), sources: [source.id])) }
                if source.kind == "taker", value.count >= 3, let sell = Double(value[1]), let buy = Double(value[2]), sell.isFinite, buy.isFinite, sell >= 0, buy >= 0 { batch.append(.init(instrument: source.instrument, kind: "stat", timestamp: ts, stat: FilterStat(oi: nil, sell: sell, buy: buy), sources: [source.id])) }
            }
            try store.write(batch)
        }
    }
}
