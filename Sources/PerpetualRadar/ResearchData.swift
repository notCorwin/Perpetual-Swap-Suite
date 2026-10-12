import Foundation
import CryptoKit

protocol ResearchTransport: Sendable {
    func get(_ url: URL) async throws -> Data
    func get(_ url: URL, onRetry: @escaping @Sendable (Double) async -> Void) async throws -> Data
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws
}

extension ResearchTransport {
    func get(_ url: URL, onRetry: @escaping @Sendable (Double) async -> Void) async throws -> Data { try await get(url) }
}

final class OKXResearchTransport: ResearchTransport, Sendable {
    private let session: URLSession
    private let apiSession: URLSession
    private let limiter: ResearchRequestLimiter
    init(session: URLSession? = nil, limiter: ResearchRequestLimiter = .shared) {
        self.limiter = limiter
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 8
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        self.session = session ?? URLSession(configuration: configuration)
        // Small JSON requests need a total deadline; archive transfers can take hours.
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        apiSession = session ?? URLSession(configuration: configuration)
    }
    func get(_ url: URL) async throws -> Data {
        try await get(url, onRetry: { _ in })
    }
    func get(_ url: URL, onRetry: @escaping @Sendable (Double) async -> Void) async throws -> Data {
        var attempt = 0
        while true {
            try await limiter.wait(for: url)
            let data: Data, response: URLResponse
            do { (data, response) = try await apiSession.data(from: url) }
            catch {
                try Task.checkCancellation()
                guard ResearchRecovery.isRecoverable(error) else { throw error }
                let delay = await limiter.retrying(url, attempt: attempt)
                await onRetry(delay)
                attempt = min(attempt + 1, 30)
                continue
            }
            guard let response = response as? HTTPURLResponse else { throw FilterError("OKX returned an invalid history response: \(url.path).") }
            // OKX can also report rate limiting in a successful HTTP envelope.
            let code = data.count < 16 * 1024 * 1024 ? (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String : nil
            if ResearchRecovery.isRecoverable(ResearchHTTPError(status: response.statusCode, path: url.path)) || code == "50011" {
                let delay = await limiter.retrying(url, response: response, attempt: attempt)
                await onRetry(delay)
                attempt = min(attempt + 1, 30)
                continue
            }
            try Task.checkCancellation()
            guard response.statusCode == 200 else { throw ResearchHTTPError(status: response.statusCode, path: url.path) }
            guard data.count < 16 * 1024 * 1024 else { throw FilterError("OKX history response exceeds the 16 MB page limit: \(url.path).") }
            return data
        }
    }
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws {
        var attempt = 0
        while true {
            try Task.checkCancellation()
            try await limiter.wait(for: url)
            let delay: Double
            do {
                let response = try await ResearchArchiveDownload.transfer(url, to: destination, configuration: session.configuration, progress: progress)
                if !ResearchRecovery.isRecoverable(ResearchHTTPError(status: response.statusCode, path: url.path)) { return }
                delay = await limiter.retrying(url, response: response, attempt: attempt)
            } catch {
                try Task.checkCancellation()
                guard ResearchRecovery.isRecoverable(error) else { throw error }
                delay = await limiter.retrying(url, attempt: attempt)
            }
            let received = (try? destination.appendingPathExtension("part").resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            await progress(.init(receivedBytes: received, totalBytes: nil, bytesPerSecond: nil, retryAt: researchNow() + Int64(delay * 1_000)))
            attempt = min(attempt + 1, 30)
        }
    }

}

struct ResearchImportResult: Sendable {
    var source: ResearchSource
    var accepted = true
    var alreadyPrepared = false
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
    private func instruments(through: Int64, refresh: Bool, onRetry: @escaping @Sendable (Double) async -> Void) async throws -> [ResearchInstrument] {
        var previous = try store.objects("instrument", as: ResearchInstrument.self)
        if !refresh, !previous.isEmpty, previous.filter(\.verified).map(\.observedAt).max().map({ $0 >= through }) == true { return previous }
        let url = Self.url("/public/instruments", [("instType", "SWAP")]), data = try await transport.get(url, onRetry: onRetry)
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
    func importRadar(_ instruments: [ResearchInstrument], from: Int64, through: Int64, progress: @escaping @Sendable (ResearchPlanningProgress) async -> Void) async throws {
        guard let radarURL, FileManager.default.fileExists(atPath: radarURL.path) else { return }
        var ranges: [RadarRange] = []
        // Interleave instruments so one long history cannot block every other
        // instrument, including when only a few have recorded data.
        var first = from
        while first <= through {
            try Task.checkCancellation()
            let last = min(through, first + 999 * hourMS)
            ranges += instruments.map { RadarRange(instrument: $0.id, range: .init(from: first, through: last)) }
            first = last + hourMS
        }
        let readers = try (0..<min(ResearchLocalScan.concurrency, ranges.count)).map { _ in try RadarReader(url: radarURL) }
        var counter = ResearchPlanningCounter(stage: "localImport", unit: "ranges", total: ranges.count)
        var completed = 0
        let initial = ranges.first
        await progress(counter.update(0, "Reading recorded Radar history concurrently…", instrument: initial?.instrument, range: initial?.range))
        try await ResearchLocalScan.run(ranges, operation: { slot, input in
            try await readers[slot].read(input)
        }) { index, batch in
            let input = ranges[index]
            if let source = batch.source, let raw = batch.raw {
                if !(try store.rawIsComplete(source)) {
                    try raw.write(to: store.rawURL(source), options: .atomic)
                    try store.put(source.id, kind: "source", source)
                }
                // Load existing heads once per range rather than issuing one
                // SQLite query for every candle/stat/quote being considered.
                var existing: [String: [Int64: ResearchDatum]] = [:]
                for value in try store.radarInputs(input.instrument, from: input.range.from, through: input.range.through) {
                    existing[value.kind, default: [:]][value.timestamp] = value
                }
                let values = batch.values.compactMap { value -> ResearchDatum? in
                    guard let old = existing[value.kind]?[value.timestamp] else { return value }
                    if value.kind == "candle" { return nil }
                    var fill = value
                    if let stat = value.stat {
                        fill.stat = FilterStat(oi: old.stat?.oi == nil ? stat.oi : nil, sell: old.stat?.sell == nil ? stat.sell : nil, buy: old.stat?.buy == nil ? stat.buy : nil)
                        if fill.stat?.oi == nil && fill.stat?.buy == nil && fill.stat?.sell == nil { return nil }
                    }
                    if let quote = value.quote {
                        fill.quote = FilterQuote(turnover: old.quote?.turnover == nil ? quote.turnover : nil, spread: nil, timestamp: quote.timestamp)
                        if fill.quote?.turnover == nil { return nil }
                    }
                    return fill
                }
                if !values.isEmpty { try store.write(values) }
            }
            completed += 1
            if counter.shouldReport(completed) {
                await progress(counter.update(completed, "Recorded Radar ranges inspected concurrently · \(input.instrument)", instrument: input.instrument, range: input.range))
            }
        }
    }
    private struct RadarRange: Sendable { var instrument: String; var range: ResearchRange }
    private struct RadarBatch: Sendable {
        var source: ResearchSource?
        var raw: Data?
        var values: [ResearchDatum] = []
    }
    private actor RadarReader {
        private let radar: Store
        init(url: URL) throws { radar = try Store(url: url) }
        func read(_ input: RadarRange) throws -> RadarBatch {
            try ResearchPressure.shared.check()
            let instrument = input.instrument, range = input.range
            do {
                let candles = try radar.candles(instrument, since: range.from, through: range.through)
                let stats = try radar.chartStats(instrument, since: range.from, through: range.through).mapValues { FilterStat(oi: $0.oi, sell: $0.sell, buy: $0.buy) }
                let quotes = try radar.hourlyQuotes(instrument, since: range.from, through: range.through).compactMapValues { quote in
                    quote.turnover.map { FilterQuote(turnover: $0, spread: nil, timestamp: quote.timestamp) }
                }
                // Most historical ranges predate Radar's local recordings.
                guard !candles.isEmpty || !stats.isEmpty || !quotes.isEmpty else { return RadarBatch() }
                try ResearchPressure.shared.check()
                // String timestamp keys let JSONEncoder sort them. Int64-keyed
                // dictionaries encode as unordered arrays and change the raw
                // hash on a repeat scan even when every reading is unchanged.
                let raw = try researchJSON(LocalRows(candles: Array(candles.values).sorted { $0.hour < $1.hour },
                    stats: Dictionary(uniqueKeysWithValues: stats.map { (String($0.key), $0.value) }),
                    quotes: Dictionary(uniqueKeysWithValues: quotes.map { (String($0.key), $0.value) })))
                let id = "radar:\(instrument):\(range.from):\(range.through)"
                let source = ResearchSource(id: researchHash(id + raw), instrument: instrument, kind: "local", from: range.from, through: range.through, url: radar.url.path, filename: "Local confirmed hours", sizeBytes: Int64(raw.utf8.count), archive: false, rawHash: researchHash(raw))
                var values = candles.values.filter { $0.confirmed && $0.open != nil }.map { ResearchDatum(instrument: instrument, kind: "candle", timestamp: $0.hour, candle: $0, sources: [source.id]) }
                values += stats.map { ResearchDatum(instrument: instrument, kind: "stat", timestamp: $0.key, stat: $0.value, sources: [source.id]) }
                values += quotes.map { ResearchDatum(instrument: instrument, kind: "quote", timestamp: $0.key, quote: $0.value, sources: [source.id]) }
                return RadarBatch(source: source, raw: Data(raw.utf8), values: values)
            } catch {
                if Task.isCancelled { throw error }
                throw ResearchOperationError(context: "Recorded Radar read failed · \(instrument) · \(range.from)–\(range.through)", underlying: error)
            }
        }
    }
    private struct LocalRows: Encodable { var candles: [Candle]; var stats: [String: FilterStat]; var quotes: [String: FilterQuote] }
    private func restSource(_ instrument: String, kind: String, _ range: ResearchRange, refresh: Bool) -> ResearchSource {
        let paths = ["candle": "/market/history-candles", "oi": "/rubik/stat/contracts/open-interest-history", "taker": "/rubik/stat/taker-volume-contract", "funding": "/public/funding-rate-history", "mark": "/market/history-mark-price-candles"]
        var parameters = [("instId", instrument)]
        if kind == "candle" || kind == "mark" { parameters += [("bar", "1H"), ("after", String(range.through + hourMS)), ("limit", kind == "mark" ? "100" : "300")] }
        else if kind == "funding" { parameters += [("after", String(range.through + hourMS)), ("limit", "400")] }
        else { parameters += [("period", "1H"), ("end", String(range.through + hourMS)), ("begin", String(range.from - 1)), ("limit", "100")]; if kind == "taker" { parameters.append(("unit", "1")) } }
        let url = Self.url(paths[kind]!, parameters).absoluteString
        return ResearchSource(id: researchHash(url + ":\(range.from):\(range.through)" + (refresh ? UUID().uuidString : "")), instrument: instrument, kind: kind, from: range.from, through: range.through, url: url, filename: "\(instrument) · \(kind) · REST", sizeBytes: nil, archive: false, refresh: refresh)
    }
    private struct CatalogRequest: Sendable {
        var url: URL
        var instruments: [ResearchInstrument]
        var from: Int64
        var through: Int64
        var cacheID: String { "catalog:" + researchHash(url.absoluteString) }
    }
    private func archiveSources(module: Int, kind: String, instruments: [ResearchInstrument], ranges: [String: [ResearchRange]], from: Int64, through: Int64, refresh: Bool,
                                progress: @escaping @Sendable (ResearchCatalogProgress) async -> Void) async throws -> [ResearchSource] {
        guard from <= through else { return [] }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        if [4, 5, 6].contains(module) { calendar.timeZone = TimeZone(secondsFromGMT: 0)! }
        let firstDate = Date(timeIntervalSince1970: Double(from) / 1000)
        let daily = [4, 5, 6].contains(module)
        var month = daily ? calendar.startOfDay(for: firstDate) : calendar.date(from: calendar.dateComponents([.year, .month], from: firstDate))!
        var requests: [CatalogRequest] = []
        while Int64(month.timeIntervalSince1970 * 1000) <= through {
            try Task.checkCancellation()
            let endMonth = calendar.date(byAdding: daily ? .day : .month, value: 10, to: month)!
            let end = min(through, Int64(endMonth.timeIntervalSince1970 * 1000) - 1)
            let begin = Int64(month.timeIntervalSince1970 * 1000)
            let eligible = instruments.filter { instrument in
                ranges[instrument.id, default: []].contains { $0.from <= end && $0.through >= begin }
            }
            for chunk in stride(from: 0, to: eligible.count, by: Self.archiveFamilyLimit) {
                let group = Array(eligible[chunk..<min(chunk + Self.archiveFamilyLimit, eligible.count)])
                let families = group.map { $0.id.replacingOccurrences(of: "-SWAP", with: "") }.joined(separator: ",")
                let url = Self.url("/public/market-data-history", [("module", String(module)), ("instType", "SWAP"), ("instFamilyList", families), ("dateAggrType", daily ? "daily" : "monthly"), ("begin", String(begin)), ("end", String(end))])
                requests.append(.init(url: url, instruments: group, from: begin, through: end))
            }
            month = endMonth
        }
        var result: [ResearchSource] = [], pending: [CatalogRequest] = []
        var completed = 0
        for request in requests {
            if !refresh, let cached = try store.get(request.cacheID, as: CachedCatalog.self) {
                result += try catalogSources(Data(cached.json.utf8), request: request, module: module, kind: kind, refresh: false, from: from, through: through)
                completed += 1
            } else { pending.append(request) }
        }
        await progress(.init(kind: kind, completed: completed, total: requests.count, message: "Checking \(kind) archive catalog · \(completed)/\(requests.count) pages · \(pending.count) network requests remaining", waitingForResponse: !pending.isEmpty))
        let transport = transport
        let reporter = ResearchCatalogReporter(kind: kind, total: requests.count, completed: completed, pending: pending.count, progress: progress)
        // Network reads run concurrently; parsing and SQLite writes stay sequential.
        try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            var next = 0
            func enqueue() {
                let index = next, url = pending[index].url
                group.addTask { (index, try await transport.get(url, onRetry: { await reporter.retrying($0) })) }
                next += 1
            }
            for _ in 0..<min(8, pending.count) { enqueue() }
            while let (index, data) = try await group.next() {
                let request = pending[index]
                result += try catalogSources(data, request: request, module: module, kind: kind, refresh: refresh, from: from, through: through)
                try store.put(request.cacheID, kind: "catalog", CachedCatalog(json: String(decoding: data, as: UTF8.self)))
                if next < pending.count { enqueue() }
                let formatter = DateFormatter(); formatter.timeZone = calendar.timeZone; formatter.dateFormat = "yyyy-MM-dd"; formatter.locale = Locale(identifier: "en_US_POSIX")
                let dates = formatter.string(from: Date(timeIntervalSince1970: Double(request.from) / 1000)) + " to " + formatter.string(from: Date(timeIntervalSince1970: Double(request.through) / 1000))
                await reporter.finished(dates: dates)
            }
        }
        return result
    }
    private func catalogSources(_ data: Data, request: CatalogRequest, module: Int, kind: String, refresh: Bool, from: Int64, through: Int64) throws -> [ResearchSource] {
        var result: [ResearchSource] = []
        for case let top as [String: Any] in try rows(data) {
            for case let detail as [String: Any] in top["details"] as? [Any] ?? [] {
                for case let file as [String: Any] in detail["groupDetails"] as? [Any] ?? [] {
                    guard let filename = file["filename"] as? String, let download = file["url"] as? String else { continue }
                    let instrument = request.instruments.first { filename.hasPrefix($0.id + "-") }?.id ?? (detail["instFamily"] as? String).map { $0 + "-SWAP" }
                    guard let instrument, request.instruments.contains(where: { $0.id == instrument }) else { continue }
                    let period = Self.fileRange(filename, module: module) ?? ResearchRange(from: request.from, through: request.through)
                    if period.through < from || period.from > through { continue }
                    result.append(ResearchSource(id: researchHash(download + (refresh ? UUID().uuidString : "")), instrument: instrument, kind: kind, from: period.from, through: period.through, url: download, filename: filename, sizeBytes: (file["sizeMB"] as? String).flatMap(Double.init).map { Int64($0 * 1_000_000) }, archive: true, module: module))
                }
            }
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
    func plan(_ spec: StudySpec, refresh: Bool = false, catalogProgress: @escaping @Sendable (ResearchCatalogProgress) async -> Void = { _ in }, progress: @escaping @Sendable (ResearchPlanningProgress) async -> Void) async throws -> DataPlan {
        let spec = try spec.excludingSpread()
        try spec.validate()
        
        // Check for cached plan if not refreshing
        var cacheSpec = spec
        cacheSpec.name = ""
        cacheSpec.instruments.sort()
        let cacheID = "plan-cache:\(ResearchVersion.parser):\(ResearchVersion.engine):" + researchHash(try researchJSON(cacheSpec))
        let radarStamp = try radarSignature()
        let completedThrough = min(spec.through + 48 * hourMS, researchNow() / hourMS * hourMS - hourMS)
        if !refresh {
            if let cached = try store.get(cacheID, as: CachedPlan.self),
               cached.radarSignature == radarStamp, cached.completedThrough == completedThrough,
               cached.createdAt >= researchNow() - 24 * 3600 * 1000 { // 24 hour cache validity
                await progress(.init(stage: "saving", unit: "steps", completed: 1, total: 1, message: "Using cached data plan from \(formatCacheAge(cached.createdAt))"))
                var plan = cached.plan
                plan.id = UUID().uuidString; plan.spec = spec; plan.createdAt = researchNow()
                try store.put(plan.id, kind: "plan", plan)
                return plan
            }
        }
        
        await progress(.init(stage: "registry", unit: "steps", completed: 0, total: 1, message: "Reading local instrument metadata; requesting OKX metadata if needed…"))
        let registry = try await instruments(through: spec.through, refresh: refresh, onRetry: { delay in
            await progress(.init(stage: "registry", unit: "steps", completed: 0, total: 1,
                                 message: "Temporary request failure or OKX rate limit · waiting to retry instrument metadata automatically.", retryAt: researchNow() + Int64(delay * 1_000)))
        })
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
        try await importRadar(inputs, from: max(0, first - Int64(warmup + 1) * hourMS), through: last, progress: progress)
        plan.unknownInstruments = Array(Set(registry.filter { !$0.verified || $0.listedAt == nil }.map(\.id) + spec.instruments.filter { id in !chosen.contains { $0.id == id } })).sorted()
        plan.warnings += ["Historic eligibility is limited to instruments with verified metadata. Archive-only symbols without verified classification or listing dates are reported separately.", "Hourly OI has limited public coverage. Full and partial Opportunity scores are reported separately."]
        if rules.contains(where: \.hasLiveBTC) { plan.warnings.append("Hourly approximation of live BTC rules: check at the completed hourly close and execute at the next hourly open. Intrahour trigger times are not reconstructed.") }
        let metrics = Set(rules.flatMap { $0.metrics }), scoreInputs = spec.kind == "score" || metrics.contains { $0.hasPrefix("opportunity") }
        let needFlow = scoreInputs || !metrics.isDisjoint(with: ["buy", "sell", "takerRatio", "buyVsSell"])
        let needOI = scoreInputs || !metrics.isDisjoint(with: ["oiUSD", "oiChange", "oiTrend"])
        let btcMetrics = Set(rules.flatMap { $0.btcRequirements?.metrics ?? [] })
        func needs(_ kind: String, _ id: String) -> Bool {
            let target = chosen.contains { $0.id == id }
            let reference = id == btcReferenceID && rules.contains(where: \.referencesBTC)
            switch kind {
            case "candle": return true
            case "oi": return target && needOI || reference && (btcMetrics.contains { $0.hasPrefix("opportunity") } || !btcMetrics.isDisjoint(with: ["oiUSD", "oiChange", "oiTrend"]))
            case "taker": return target && needFlow || reference && (btcMetrics.contains { $0.hasPrefix("opportunity") } || !btcMetrics.isDisjoint(with: ["buy", "sell", "buyVsSell", "takerRatio"]))
            case "spread": return false
            default: return target && spec.costs != nil
            }
        }
        let recent = researchNow() / hourMS * hourMS - 60 * 24 * hourMS
        let oldEnd = min(last, recent - hourMS)
        let earliestInput = max(0, first - Int64(warmup + 1) * hourMS)
        let checks = inputs.compactMap { instrument -> ResearchInputCheck? in
            let begin = max(first - Int64(warmup + 1) * hourMS, instrument.listedAt! / hourMS * hourMS)
            guard begin <= last else { return nil }
            return .init(instrument: instrument.id, range: .init(from: begin, through: last), kinds: ["candle", "oi", "taker", "funding", "mark"].filter { needs($0, instrument.id) })
        }
        let localInputs = try await store.inputGapsWithProgress(checks, refresh: refresh, progress: progress)
        var catalogs: [Int: [ResearchSource]] = [:]
        // Batch within the catalog family limit; cached complete periods need no catalog requests.
        for (module, kind, end) in [(2, "candle", oldEnd), (1, "taker", oldEnd), (3, "funding", oldEnd)] where earliestInput <= end {
            var ranges: [String: [ResearchRange]] = [:]
            let candidates = inputs.filter { needs(kind, $0.id) }
            for instrument in candidates {
                try Task.checkCancellation()
                let begin = max(earliestInput, instrument.listedAt! / hourMS * hourMS)
                guard begin <= end else { continue }
                ranges[instrument.id] = localInputs[instrument.id]?.missing[kind]?.compactMap { range in
                    let clipped = ResearchRange(from: max(begin, range.from), through: min(end, range.through))
                    return clipped.from <= clipped.through ? clipped : nil
                } ?? []
            }
            let missing = inputs.filter { !ranges[$0.id, default: []].isEmpty }
            if !missing.isEmpty {
                catalogs[module] = try await archiveSources(module: module, kind: kind, instruments: missing, ranges: ranges, from: earliestInput, through: end, refresh: refresh, progress: catalogProgress)
            }
        }
        func published(_ module: Int, _ id: String, _ from: Int64, _ through: Int64) -> [ResearchSource] {
            catalogs[module, default: []].filter { $0.instrument == id && $0.through >= from && $0.from <= through }
        }
        var sourceCounter = ResearchPlanningCounter(stage: "sources", unit: "instruments", total: inputs.count)
        await progress(sourceCounter.update(0, "Building download ranges from verified local checks…"))
        for (index, instrument) in inputs.enumerated() {
            try Task.checkCancellation()
            let begin = max(first - Int64(warmup + 1) * hourMS, instrument.listedAt! / hourMS * hourMS)
            guard begin <= last else { continue }
            plan.requestedHours += Int((last - begin) / hourMS) + 1
            plan.cachedHours += localInputs[instrument.id]?.cachedHours ?? 0
            let missingPrices = localInputs[instrument.id]?.missing["candle"] ?? []
            for range in missingPrices {
                var archives: [ResearchSource] = []
                if range.from <= oldEnd { archives = published(2, instrument.id, range.from, min(range.through, oldEnd)) }
                plan.sources += archives
                // REST also covers older periods when an archive is not published.
                let archiveRanges = archives.map { ResearchRange(from: $0.from, through: $0.through) }
                for gap in Self.subtract(range, covered: archiveRanges) { plan.sources.append(restSource(instrument.id, kind: "candle", gap, refresh: refresh)) }
            }
            for kind in ["oi", "taker", "funding", "mark"] where needs(kind, instrument.id) {
                let ranges = localInputs[instrument.id]?.missing[kind] ?? []
                for range in ranges {
                    if ["taker", "funding"].contains(kind), range.from <= oldEnd {
                        let module = kind == "taker" ? 1 : 3
                        let archives = published(module, instrument.id, range.from, min(range.through, oldEnd))
                        plan.sources += archives
                        if archives.isEmpty { plan.warnings.append("\(instrument.id): no \(kind) archive is available for part of the requested range; those inputs remain Unknown.") }
                    }
                    let restBegin = ["oi", "taker", "funding"].contains(kind) ? max(range.from, kind == "funding" ? recent - 30 * 24 * hourMS : recent) : range.from
                    if restBegin <= range.through { plan.sources.append(restSource(instrument.id, kind: kind, .init(from: restBegin, through: range.through), refresh: refresh)) }
                }
            }
            if sourceCounter.shouldReport(index + 1) {
                await progress(sourceCounter.update(index + 1, "Download ranges planned · \(instrument.id)", instrument: instrument.id))
            }
        }
        if !refresh {
            plan.sources += try store.objects("source", as: ResearchSource.self).filter { source in
                source.parser != ResearchVersion.parser && needs(source.kind, source.instrument) && source.through >= earliestInput && source.from <= last && inputs.contains(where: { $0.id == source.instrument })
            }
        }
        plan.sources = Array(Dictionary(plan.sources.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }).values).sorted { ($0.instrument, $0.kind, $0.from) < ($1.instrument, $1.kind, $1.from) }
        var cacheCounter = ResearchPlanningCounter(stage: "cache", unit: "sources", total: plan.sources.count)
        await progress(cacheCounter.update(0, "Checking cached source files concurrently…"))
        let savedSources = try Dictionary(uniqueKeysWithValues: store.objects("source", as: ResearchSource.self).filter { $0.rawHash != nil }.map { ($0.id, $0) })
        let cachedURLs = plan.sources.map { source in savedSources[source.id].map { store.rawURL($0) } }
        var cachedCompleted = 0
        try await ResearchLocalScan.run(cachedURLs, operation: { _, url in
            url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        }) { index, cached in
            plan.sources[index].cached = cached
            cachedCompleted += 1
            if cacheCounter.shouldReport(cachedCompleted) {
                await progress(cacheCounter.update(cachedCompleted, "Cached sources checked · \(cachedCompleted)/\(plan.sources.count)"))
            }
        }
        plan.warnings = Array(Set(plan.warnings)).sorted()
        plan.coverage = try await store.coverageWithProgress(inputs, from: max(0, first-Int64(warmup+1)*hourMS), through: last, progress: progress)
        plan = try plan.excludingSpread()
        await progress(.init(stage: "saving", unit: "steps", completed: 0, total: 1, message: "Saving the verified data plan and checkpoint…"))
        try store.put(plan.id, kind: "plan", plan)
        
        // Cache the plan for future requests with the same spec
        try store.put(cacheID, kind: "planCache", CachedPlan(plan: plan, createdAt: researchNow(), radarSignature: radarStamp, completedThrough: completedThrough))
        
        return plan
    }
    
    private func formatCacheAge(_ timestamp: Int64) -> String {
        let seconds = (researchNow() - timestamp) / 1000
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }
    private struct CachedPlan: Codable { var plan: DataPlan; var createdAt: Int64; var radarSignature: String; var completedThrough: Int64 }
    private func radarSignature() throws -> String {
        guard let radarURL else { return "absent" }
        return try [radarURL, URL(fileURLWithPath: radarURL.path + "-wal")].map { url in
            guard FileManager.default.fileExists(atPath: url.path) else { return url.path + ":absent" }
            let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            return "\(url.path):\(values.fileSize ?? 0):\(values.contentModificationDate?.timeIntervalSince1970 ?? 0)"
        }.joined(separator: "|")
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
    func acquire(_ source: ResearchSource, instruments: [ResearchInstrument], isolation: isolated (any Actor)? = #isolation, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void = { _ in }) async throws -> ResearchSource {
        guard !ResearchSpreadPolicy.excludes(source) else { throw FilterError("Research no longer prepares bid/ask spread or order book archives. Review the updated data plan.") }
        var source = source
        let file = store.rawURL(source)
        let filename = source.filename, instrument = source.instrument
        await progress(.init(stage: "checking", filename: filename, instrument: instrument))
        if try store.isPrepared(source, instruments: instruments) {
            return try store.get(source.id, as: ResearchSource.self) ?? source
        }
        if !(try store.rawIsComplete(source)) {
            if source.archive {
                // Native transfers promote a synchronized .part file only on
                // completion. Reuse it if a stop occurred before hash metadata
                // was committed; SHA-256 and archive CRC checks still follow.
                if !FileManager.default.fileExists(atPath: file.path) {
                    await progress(.init(stage: "connecting", filename: filename, instrument: instrument, totalBytes: source.sizeBytes))
                    try await transport.download(URL(string: source.url)!, to: file) { transfer in
                        let rate = transfer.bytesPerSecond.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
                        let remaining = transfer.totalBytes.flatMap { total in rate.map { Double(max(0, total - transfer.receivedBytes)) / $0 } }
                        await progress(.init(stage: "downloading", filename: filename, instrument: instrument, receivedBytes: transfer.receivedBytes, totalBytes: transfer.totalBytes, bytesPerSecond: rate, fileRemainingSeconds: remaining, retryAt: transfer.retryAt))
                    }
                }
            }
            else { try await fetchREST(source, file: file, progress: progress) }
            await progress(.init(stage: "verifying", filename: filename, instrument: instrument))
            source.rawHash = try hashFile(file)
            try store.put(source.id, kind: "source", source)
        } else if let saved = try store.get(source.id, as: ResearchSource.self) {
            await progress(.init(stage: "verifying", filename: filename, instrument: instrument))
            if try hashFile(file) != saved.rawHash {
                // Retain the damaged input, then fetch a fresh copy.
                try FileManager.default.moveItem(at: file, to: file.appendingPathExtension("rejected-\(UUID())"))
                source.rawHash = nil; try store.put(source.id, kind: "source", source)
                return try await acquire(source, instruments: instruments, progress: progress)
            }
            source.rawHash = saved.rawHash
        }
        return source
    }
    func prepare(_ input: ResearchSource, instruments: [ResearchInstrument], requiredRange: ResearchRange? = nil, isolation: isolated (any Actor)? = #isolation, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void = { _ in }) async throws {
        let source = try await acquire(input, instruments: instruments, progress: progress)
        if try !store.isPrepared(source, instruments: instruments) {
            await progress(.init(stage: "importing", filename: source.filename, instrument: source.instrument))
        }
        let imported = try importAcquired(source, instruments: instruments)
        try await finishImport(imported, instruments: instruments, requiredRange: requiredRange, progress: progress)
    }
    // Synchronous CPU work is isolated from REST gap repair. The pipeline can
    // immediately reuse its parser slot while a verified import is finalized.
    func importAcquired(_ source: ResearchSource, instruments: [ResearchInstrument]) throws -> ResearchImportResult {
        if try store.isPrepared(source, instruments: instruments) {
            return .init(source: source, alreadyPrepared: true)
        }
        var source = source
        let file = store.rawURL(source), filename = source.filename
        var archiveAccepted = true
        if source.archive {
            let importer = ResearchArchiveImporter(store: store, source: source, instruments: instruments)
            let encountered: [String]
            do { encountered = try importer.run(file: file); source.warnings = importer.warnings }
            catch let error as ResearchArchiveError {
                guard source.kind == "candle" else { throw error }
                try store.rejectArchiveCandles(source)
                archiveAccepted = false; encountered = []
                source.warnings = importer.warnings + ["\(filename): \(error.localizedDescription) Confirmed REST history was requested automatically; the archive was retained."]
            }
            for id in encountered where !instruments.contains(where: { $0.id == id }) {
                if try store.get("instrument:\(id)", as: ResearchInstrument.self) == nil {
                    try store.put("instrument:\(id)", kind: "instrument", ResearchInstrument(id: id, verified: false, source: source.url, observedAt: researchNow()))
                }
            }
        } else { try parseREST(source, file: file) }
        source.parser = ResearchVersion.parser
        // Save the verified import before repairing gaps. A transient REST
        // failure can then resume without parsing the archive again.
        try store.finishPreparation(source, instruments: instruments, cover: !source.archive)
        return .init(source: source, accepted: archiveAccepted)
    }
    func finishImport(_ imported: ResearchImportResult, instruments: [ResearchInstrument], requiredRange: ResearchRange? = nil, isolation: isolated (any Actor)? = #isolation, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void = { _ in }) async throws {
        var source = imported.source, archiveAccepted = imported.accepted
        let remaining = try await fillCandleGaps(source, instruments: instruments, requiredRange: requiredRange, progress: progress)
        if imported.alreadyPrepared { return }
        if !remaining.isEmpty {
            archiveAccepted = false
            source.warnings = (source.warnings ?? []) + ["\(source.filename): \(remaining.reduce(0) { $0 + $1.hours }) hourly candles remain unavailable after checking confirmed OKX history; affected inputs remain Unknown and archive coverage was not marked complete."]
        }
        try store.finishPreparation(source, instruments: instruments, cover: archiveAccepted)
    }
    @discardableResult
    private func fillCandleGaps(_ source: ResearchSource, instruments: [ResearchInstrument], requiredRange: ResearchRange?, isolation: isolated (any Actor)? = #isolation, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void) async throws -> [ResearchRange] {
        guard source.archive, source.kind == "candle" else { return [] }
        let metadata = instruments.first { $0.id == source.instrument }
        let range = requiredRange ?? .init(from: source.from, through: source.through)
        let from = max(source.from, range.from, metadata?.listedAt.map { ($0 + hourMS - 1) / hourMS * hourMS } ?? source.from)
        let through = min(source.through, range.through, researchNow() / hourMS * hourMS - hourMS, metadata?.delistedAt.map { $0 / hourMS * hourMS - hourMS } ?? source.through)
        for gap in try store.missingConfirmedCandles(source.instrument, from: from, through: through) {
            await progress(.init(stage: "recovering", filename: source.filename, instrument: source.instrument,
                                 recovery: "Checking missing archive hours against confirmed OKX history automatically."))
            let fallback = restSource(source.instrument, kind: "candle", gap, refresh: source.refresh)
            try await prepare(fallback, instruments: instruments, progress: progress)
        }
        return try store.missingConfirmedCandles(source.instrument, from: from, through: through)
    }
    private func fetchREST(_ source: ResearchSource, file: URL, isolation: isolated (any Actor)? = #isolation, progress: @escaping @Sendable (ResearchPreparationProgress) async -> Void) async throws {
        // Each fetched page is fixed immediately. A restart reuses all completed
        // pages rather than refetching a partially prepared multi-year range.
        var cursor = source.through + hourMS, pages: [ResearchRawPage] = []
        var received: Int64 = 0
        while cursor > source.from {
            try Task.checkCancellation()
            await progress(.init(stage: "fetching", filename: source.filename, instrument: source.instrument, receivedBytes: received, pages: pages.count, fraction: min(1, Double(source.through + hourMS - cursor) / Double(max(hourMS, source.through + hourMS - source.from)))))
            var components = URLComponents(string: source.url)!
            let key = ["oi", "taker"].contains(source.kind) ? "end" : "after"
            components.queryItems = components.queryItems?.map { $0.name == key ? URLQueryItem(name: key, value: String(cursor)) : $0 }
            let url = components.url!, pageID = "page:" + researchHash(url.absoluteString + (source.refresh ? source.id : ""))
            let page = store.directory.appendingPathComponent("Raw/\(researchHash(pageID)).page")
            let data: Data
            if FileManager.default.fileExists(atPath: page.path) { data = try Data(contentsOf: page) }
            else {
                let received = received, count = pages.count
                let fraction = min(1, Double(source.through + hourMS - cursor) / Double(max(hourMS, source.through + hourMS - source.from)))
                data = try await transport.get(url, onRetry: { delay in
                    await progress(.init(stage: "fetching", filename: source.filename, instrument: source.instrument, receivedBytes: received, pages: count, fraction: fraction, retryAt: researchNow() + Int64(delay * 1_000)))
                })
                _ = try rows(data); try data.write(to: page, options: .atomic)
            }
            let record = ResearchRawPage(path: page.path, digest: researchHash(data), sourceID: source.id)
            pages.append(record)
            received += Int64(data.count)
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
        await progress(.init(stage: "fetching", filename: source.filename, instrument: source.instrument, receivedBytes: received, pages: pages.count, fraction: 1))
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
