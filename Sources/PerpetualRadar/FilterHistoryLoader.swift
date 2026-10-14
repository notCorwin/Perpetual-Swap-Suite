import Foundation

protocol FilterHistoryTransport: Sendable {
    func fetch(path: String, parameters: [String: String]) async throws -> [[String]]
}

struct OKXFilterHistoryTransport: FilterHistoryTransport {
    var session: URLSession = .shared

    func fetch(path: String, parameters: [String: String]) async throws -> [[String]] {
        var parameters = parameters
        if path == "/rubik/stat/taker-volume-contract" { parameters["unit"] = "2" }
        var parts = URLComponents(string: "https://www.okx.com/api/v5" + path)!
        parts.queryItems = parameters.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: parts.url!, cachePolicy: .reloadIgnoringLocalCacheData); request.timeoutInterval = 15
        try await ResearchRequestLimiter.shared.wait(for: parts.url!)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any], payload["code"] as? String == "0", let rows = payload["data"] as? [[String]] else {
            throw FilterError("OKX history is unavailable; retrying.")
        }
        return rows
    }
}

struct FilterHistoryProgress: Sendable {
    var pending: Int, completed: Int, error: String
    var snapshot: [String: Any] { ["pending": pending, "completed": completed, "error": error] }
}

// A separate actor/SQLite connection keeps both disk reads and history requests off
// the AppKit main actor. Only confirmed exchange observations are stored.
actor FilterHistoryLoader {
    private let url: URL
    private let researchURL: URL
    private let transport: any FilterHistoryTransport
    private let requestDelay: UInt64
    private var store: Store?
    private var researchStore: ResearchStore?
    private var researchRanges: [String: (first: Int64, last: Int64, version: Int64)] = [:]
    private var candleCache: [String: [Int64: Candle]] = [:]
    private var statCache: [String: [Int64: FilterStat]] = [:]
    private var quoteCache: [String: [Int64: FilterQuote]] = [:]
    private var ranges: [String: (first: Int64, last: Int64)] = [:]
    private var statRanges: [String: (first: Int64, last: Int64)] = [:]
    private var coverageChecks: [String: (demand: String, candlesMissing: Bool, statsMissing: Bool)] = [:]
    private var queue: [String] = []
    private var jobs: [String: (market: FilterMarketData, hours: Int, stats: Bool)] = [:]
    private var running: Task<Void, Never>?
    private var processingID: String?
    private var processingHours = 0
    private var processingStats = false
    private var activeDemand: String?
    private var observedDataVersion: Int64?
    private var retries: [String: Date] = [:]
    private var candleFloor: [String: (hour: Int64, expires: Date)] = [:]
    private var statPages: [String: Date] = [:]
    private var completed = 0
    private var updatedMarkets = Set<String>()
    private var lastError = ""
    init(url: URL, researchURL: URL? = nil, transport: any FilterHistoryTransport = OKXFilterHistoryTransport(), requestDelay: UInt64 = 150_000_000) {
        self.url = url
        self.researchURL = researchURL ?? url.deletingLastPathComponent().appendingPathComponent("Research/research.sqlite3")
        self.transport = transport; self.requestDelay = requestDelay
    }
    private func database() throws -> Store {
        if let store { return store }; let db = try Store(url: url); store = db; return db
    }
    private func researchDatabase() throws -> ResearchStore? {
        guard FileManager.default.fileExists(atPath: researchURL.path) else { return nil }
        if let researchStore { return researchStore }
        let db = try ResearchStore(directory: researchURL.deletingLastPathComponent()); researchStore = db; return db
    }
    /// Copies current normalized Research heads into Radar's operational cache.
    /// Frozen manifests remain immutable; this reads only the reusable latest
    /// rows and lets Radar request solely fields that neither mode has cached.
    @discardableResult
    func importResearch(_ id: String, from: Int64, through: Int64) throws -> Int {
        guard through >= from, let research = try researchDatabase() else { return 0 }
        let version = try research.database.dataVersion()
        let previous = researchRanges[id]
        let gaps: [ResearchRange]
        if let previous, previous.version == version {
            var missing: [ResearchRange] = []
            if from < previous.first { missing.append(.init(from: from, through: min(through, previous.first - hourMS))) }
            if through > previous.last { missing.append(.init(from: max(from, previous.last + hourMS), through: through)) }
            gaps = missing.filter { $0.from <= $0.through }
        } else { gaps = [.init(from: from, through: through)] }
        guard !gaps.isEmpty else { return 0 }
        // This path needs only the current candle/stat/quote heads. Starting
        // from research_data makes SQLite inspect historical revisions before
        // joining heads and can saturate several cores on a mature cache.
        let values = try gaps.flatMap { try research.radarInputs(id, from: $0.from, through: $0.through) }
        guard !values.isEmpty else {
            researchRanges[id] = (min(from, previous?.first ?? from), max(through, previous?.last ?? through), version)
            return 0
        }
        let db = try database()
        try db.transaction {
            for value in values {
                if let candle = value.candle, candle.confirmed { try db.save(id, candle) }
                if let stat = value.stat { try db.saveChartStat(id, hour: value.timestamp, oi: stat.oi, oiUSD: stat.oiUSD, sell: stat.sell, buy: stat.buy) }
                if let quote = value.quote { try db.saveHourlyQuote(id, hour: value.timestamp, quote: quote) }
            }
        }
        researchRanges[id] = (min(from, previous?.first ?? from), max(through, previous?.last ?? through), version)
        candleCache.removeValue(forKey: id); statCache.removeValue(forKey: id); quoteCache.removeValue(forKey: id)
        ranges.removeValue(forKey: id); statRanges.removeValue(forKey: id); coverageChecks.removeValue(forKey: id)
        updatedMarkets.insert(id)
        return values.count
    }
    func prepare(_ markets: [FilterMarketData], filter: CompiledFilter) throws -> [FilterMarketData] {
        let db = try database()
        let version = try db.dataVersion()
        if let previous = observedDataVersion, previous != version {
            candleCache.removeAll(); statCache.removeAll(); quoteCache.removeAll(); ranges.removeAll(); statRanges.removeAll(); coverageChecks.removeAll()
        }
        observedDataVersion = version
        return try markets.map { original in
            try Task.checkCancellation()
            var market = original
            let first = max(0, market.hour - Int64(filter.requiredHours) * hourMS), last = market.hour - hourMS
            // Never import Research history on an interactive snapshot path.
            // A large cache can contain hundreds of thousands of rows and used
            // to keep suite evaluation inside one IPC request for minutes.
            // `hydrate` imports the same verified rows in the background before
            // making any OKX request, then publishes them through updatedMarkets.
            if ranges[market.id].map({ $0.first <= first && $0.last >= last }) != true {
                let cached = try db.candles(market.id, since: first, through: last)
                candleCache[market.id, default: [:]].merge(cached) { _, new in new }
                ranges[market.id] = (min(first, ranges[market.id]?.first ?? first), last)
            }
            market.candles = (candleCache[market.id] ?? [:]).filter { $0.key >= first && $0.key <= market.hour }
            // Closed observations on disk can have been corrected by another
            // collector since this live snapshot was captured.
            for (ts, bar) in original.candles where ts == original.hour || market.candles[ts] == nil { market.candles[ts] = bar }
            if filter.needsStats {
                let statFirst = statRanges[market.id].map { $0.first <= first && $0.last >= last ? max(first, last - hourMS) : first } ?? first
                for (ts, s) in try db.chartStats(market.id, since: statFirst, through: last) { statCache[market.id, default: [:]][ts] = FilterStat(oi: s.oi, oiUSD: s.oiUSD, sell: s.sell, buy: s.buy) }
                statRanges[market.id] = (min(first, statRanges[market.id]?.first ?? first), last)
                market.stats = (statCache[market.id] ?? [:]).filter { $0.key >= first && $0.key <= last }
                market.stats.merge(original.stats) { _, live in live }
            }
            if filter.needsQuotes {
                quoteCache[market.id, default: [:]].merge(try db.hourlyQuotes(market.id, since: first, through: last)) { _, new in new }
                market.quotes = quoteCache[market.id] ?? [:]; market.quotes.merge(original.quotes) { _, live in live }
            }
            return market
        }
    }
    func schedule(_ markets: [FilterMarketData], filter: CompiledFilter) {
        let demand = "\(filter.requiredHours)|\(filter.needsStats)|\(markets.first?.hour ?? 0)"
        if activeDemand != demand {
            // A smaller/new-hour preview no longer needs obsolete queued work.
            // An increased demand can reuse the active page before extending it.
            if processingHours > filter.requiredHours || (processingStats && !filter.needsStats) || activeDemand?.split(separator: "|").last != demand.split(separator: "|").last {
                running?.cancel(); queue.removeAll(); jobs.removeAll()
            }
            activeDemand = demand; lastError = ""
        }
        for market in markets {
            let key = "\(market.id)|\(market.hour)", retryKey = "\(key)|\(filter.requiredHours)|\(filter.needsStats)"
            if let retry = retries[retryKey], retry > Date() { continue }
            if processingID == key && processingHours >= filter.requiredHours && (processingStats || !filter.needsStats) { continue }
            if let queued = jobs[key], queued.hours >= filter.requiredHours && (queued.stats || !filter.needsStats) { continue }
            let first = max(0, market.hour - Int64(filter.requiredHours) * hourMS)
            let listing = market.listedAt.map { $0 / hourMS * hourMS } ?? first
            let availableFirst = max(first, listing, floor(market.id) ?? first)
            let coverage: (demand: String, candlesMissing: Bool, statsMissing: Bool)
            if let cached = coverageChecks[market.id], cached.demand == demand {
                coverage = cached
            } else {
                coverage = (demand,
                    stride(from: market.hour - hourMS, through: availableFirst, by: -Int(hourMS)).contains { !Self.complete(market.candles[$0]) },
                    filter.needsStats && stride(from: market.hour - hourMS, through: max(first, listing), by: -Int(hourMS)).contains { market.stats[$0]?.oi == nil || market.stats[$0]?.oiUSD == nil || market.stats[$0]?.buy == nil || market.stats[$0]?.sell == nil })
                coverageChecks[market.id] = coverage
            }
            let missingCandles = coverage.candlesMissing
            let missingStats = coverage.statsMissing
            if !missingCandles && !missingStats { continue }
            if jobs[key] == nil { queue.append(key) }
            jobs[key] = (market, max(filter.requiredHours, jobs[key]?.hours ?? 0), filter.needsStats || jobs[key]?.stats == true)
        }
        if running == nil, !queue.isEmpty { running = Task { await process() } }
    }
    func progress() -> FilterHistoryProgress { .init(pending: queue.count + (processingID == nil ? 0 : 1), completed: completed, error: lastError) }
    func waitUntilIdle() async { while let task = running { await task.value } }
    func consumeUpdatedHistory(through hour: Int64) throws -> [String: [Int64: Candle]] {
        guard !updatedMarkets.isEmpty else { return [:] }
        let db = try database(); var result: [String: [Int64: Candle]] = [:]
        for id in updatedMarkets { result[id] = try db.candles(id, since: max(0, hour - Int64(candleLookback - 1) * hourMS), through: hour) }
        updatedMarkets.removeAll(); return result
    }
    func cancel() { running?.cancel(); queue.removeAll(); jobs.removeAll() }
    private func fetch(_ path: String, _ params: [String: String]) async throws -> [[String]] {
        try Task.checkCancellation()
        if requestDelay > 0 { try await Task.sleep(nanoseconds: requestDelay) }
        return try await transport.fetch(path: path, parameters: params)
    }
    private func process() async {
        while !queue.isEmpty, !Task.isCancelled {
            let key = queue.removeFirst(); guard let job = jobs.removeValue(forKey: key) else { continue }
            processingID = key; processingHours = job.hours; processingStats = job.stats
            let retryKey = "\(key)|\(job.hours)|\(job.stats)"
            do { try await hydrate(job.market, hours: job.hours, stats: job.stats); completed += 1; lastError = ""; retries[retryKey] = Date().addingTimeInterval(300) }
            catch { if !Task.isCancelled { lastError = String(describing: error); retries[retryKey] = Date().addingTimeInterval(30) } }
            processingID = nil
        }
        running = nil
        if !queue.isEmpty { running = Task { await process() } }
    }
    private func hydrate(_ market: FilterMarketData, hours: Int, stats: Bool) async throws {
        let db = try database(), first = max(0, market.hour - Int64(hours) * hourMS), listing = market.listedAt.map { $0 / hourMS * hourMS } ?? first
        _ = try? importResearch(market.id, from: first, through: market.hour - hourMS)
        let fetchFirst = max(first, listing, floor(market.id) ?? first)
        // A smaller queued request may have just persisted a page and pruned its
        // memory. Reuse those rows before deciding which page to request next.
        var series = try db.candles(market.id, since: first, through: market.hour - hourMS)
        for (ts, bar) in candleCache[market.id] ?? [:] where series[ts] == nil { series[ts] = bar }
        for (ts, bar) in market.candles where ts == market.hour || series[ts] == nil { series[ts] = bar }
        candleCache[market.id, default: [:]].merge(series.filter { $0.value.confirmed }) { _, new in new }
        var cursor = stride(from: market.hour - hourMS, through: fetchFirst, by: -Int(hourMS)).first { !Self.complete(series[$0]) }.map { $0 + hourMS }
        while let before = cursor, before > fetchFirst {
            let rows = try await fetch("/market/history-candles", ["instId": market.id, "bar": "1H", "after": String(before), "limit": "300"])
            let bars = historicalPage(rows, before: before)
            guard let oldest = bars.map(\.hour).min(), oldest < before else {
                if !rows.isEmpty { throw FilterError("OKX returned an invalid candle page; retrying.") }
                candleFloor[market.id] = (before, Date().addingTimeInterval(300)); break
            }
            try db.saveCandles(market.id, bars)
            updatedMarkets.insert(market.id)
            for bar in bars { series[bar.hour] = bar; candleCache[market.id, default: [:]][bar.hour] = bar }
            if oldest <= fetchFirst { break }
            cursor = stride(from: oldest - hourMS, through: fetchFirst, by: -Int(hourMS)).first { !Self.complete(series[$0]) }.map { $0 + hourMS }
        }
        if stats {
            var incomplete = false
            for pageStart in stride(from: max(first, listing) / (100 * hourMS) * (100 * hourMS), through: market.hour - hourMS, by: Int(100 * hourMS)) {
                let pageEnd = min(pageStart + 99 * hourMS, market.hour - hourMS)
                for path in ["/rubik/stat/contracts/open-interest-history", "/rubik/stat/taker-volume-contract"] {
                    let pageKey = "\(market.id)|\(path)|\(pageStart)|\(pageEnd)"
                    if statPages[pageKey].map({ $0 > Date() }) == true { continue }
                    let expectedFirst = max(first, listing, pageStart)
                    let existing = try db.chartStats(market.id, since: expectedFirst, through: pageEnd)
                    var loaded = Set(existing.compactMap { timestamp, value in
                        path.contains("open-interest") ? (value.oi == nil || value.oiUSD == nil ? nil : timestamp) : (value.sell == nil || value.buy == nil ? nil : timestamp)
                    })
                    if stride(from: expectedFirst, through: pageEnd, by: Int(hourMS)).allSatisfy({ loaded.contains($0) }) {
                        statPages[pageKey] = Date().addingTimeInterval(900); continue
                    }
                    var parameters = ["instId": market.id, "period": "1H", "end": String(pageEnd + hourMS), "limit": "100"]
                    if path == "/rubik/stat/taker-volume-contract" { parameters["unit"] = "2" }
                    let values = try await fetch(path, parameters)
                    var updates: [(hour: Int64, oi: Double?, oiUSD: Double?, sell: Double?, buy: Double?)] = []
                    for value in values {
                        guard let ts = value.first.flatMap(Int64.init), ts % hourMS == 0, ts >= pageStart, ts <= pageEnd else { continue }
                        if path.contains("open-interest"), value.count >= 4,
                           let oi = Double(value[1]), let oiUSD = Double(value[3]),
                           oi.isFinite, oiUSD.isFinite, oi >= 0, oiUSD >= 0 {
                            updates.append((ts, oi, oiUSD, nil, nil))
                            statCache[market.id, default: [:]][ts, default: .init()].oi = oi
                            statCache[market.id, default: [:]][ts, default: .init()].oiUSD = oiUSD
                            updatedMarkets.insert(market.id)
                            loaded.insert(ts)
                        } else if !path.contains("open-interest"), value.count >= 3, let sell = Double(value[1]), let buy = Double(value[2]), sell.isFinite, buy.isFinite, sell >= 0, buy >= 0 {
                            updates.append((ts, nil, nil, sell, buy))
                            updatedMarkets.insert(market.id)
                            statCache[market.id, default: [:]][ts, default: .init()].sell = sell; statCache[market.id, default: [:]][ts, default: .init()].buy = buy
                            loaded.insert(ts)
                        }
                    }
                    try db.saveChartStats(market.id, updates)
                    if stride(from: expectedFirst, through: pageEnd, by: Int(hourMS)).allSatisfy({ loaded.contains($0) }) {
                        statPages[pageKey] = Date().addingTimeInterval(900)
                    } else { incomplete = true }
                }
            }
            if incomplete { throw FilterError("OKX statistics coverage is incomplete; retrying missing hours.") }
        }
        // Bound reusable memory to each request's dependency window. The durable
        // database retains older observations for later rules and chart history.
        candleCache[market.id] = candleCache[market.id]?.filter { $0.key >= first }
        statCache[market.id] = statCache[market.id]?.filter { $0.key >= first }
        quoteCache[market.id] = quoteCache[market.id]?.filter { $0.key >= first }
        if let range = ranges[market.id] { ranges[market.id] = (max(first, range.first), range.last) }
        if let range = statRanges[market.id] { statRanges[market.id] = (max(first, range.first), range.last) }
        coverageChecks.removeValue(forKey: market.id)
    }
    private static func complete(_ candle: Candle?) -> Bool { candle?.confirmed == true && candle?.open != nil && candle?.baseVolume != nil }
    private func floor(_ id: String) -> Int64? { guard let value = candleFloor[id], value.expires > Date() else { candleFloor.removeValue(forKey: id); return nil }; return value.hour }
}
