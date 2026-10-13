import Foundation

private let api = "https://www.okx.com/api/v5"
private let publicWS = "wss://ws.okx.com:8443/ws/v5/public"
private let businessWS = "wss://ws.okx.com:8443/ws/v5/business"
private let frostedBackgroundEnabledKey = "frostedBackgroundEnabled"
private let frostedBackgroundOpacityKey = "frostedBackgroundOpacity"
private let windowBlurRadiusKey = "windowBlurRadius"
private let floatingBlurRadiusKey = "floatingBlurRadius"
private let notificationsEnabledKey = "strategyNotificationsEnabled"
private let monitoringPausedKey = "monitoringPaused"

private func numeric(_ value: Any?) -> Double? {
    let result = (value as? String).flatMap(Double.init) ?? (value as? NSNumber)?.doubleValue
    return result?.isFinite == true ? result : nil
}

func usdtTurnover24h(_ ticker: [String: Any]) -> Double? {
    guard let baseVolume = numeric(ticker["volCcy24h"]), baseVolume >= 0,
          let lastPrice = numeric(ticker["last"]), lastPrice > 0 else { return nil }
    let turnover = baseVolume * lastPrice
    return turnover.isFinite ? turnover : nil
}

func spreadPercent(_ ticker: [String: Any]) -> Double? {
    guard let bid = numeric(ticker["bidPx"]), let ask = numeric(ticker["askPx"]),
          bid > 0, ask >= bid else { return nil }
    let spread = (ask - bid) / (bid + (ask - bid) / 2) * 100
    return spread.isFinite ? spread : nil
}

private func millis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

func boundedHistoryEnd(_ requested: Int64, oldest: Int64?, exhausted: Bool, latest: Int64) -> Int64 {
    guard exhausted, let oldest else { return requested }
    return min(latest, max(requested, oldest + Int64(chartHours - 1) * hourMS))
}

private struct Market {
    let id: String
    let listedAt: Int64?
    var turnover24hUSDT: Double?
    var spreadPercent: Double?
    var quoteTimestamp: Int64 = 0
    var lastPrice: Double?
    var oiTimestamp = 0.0
    var oiUsd: Double?
    var buy: Double?
    var sell: Double?
    var takerRatio: Double?
}

@MainActor
final class Radar {
    private let store: Store
    private let session: URLSession
    private let takerPoller: TakerVolumePoller
    private let historyLoader: FilterHistoryLoader
    private let monitorHistoryLoader: FilterHistoryLoader
    private let btcHistoryLoader: FilterHistoryLoader
    private let monitorBTCHistoryLoader: FilterHistoryLoader
    private let cooldowns = FilterCooldownMemory()
    private var btcReceivedAt: Int64?
    private let filterWorker = FilterEvaluationWorker()
    private let snapshotWorker = MarketSnapshotWorker()
    private var snapshotGenerations: [String: Int] = [:]
    private var compiledFilters: [String: CompiledFilter] = [:]
    private var compiledFilterLRU: [String] = []
    private let suiteWorker = SuiteEvaluationWorker()
    private let suiteMonitorWorker = SuiteEvaluationWorker()
    private var liveHourQuotes: [String: FilterQuote] = [:]
    private var closedHourQuotes: [String: [Int64: FilterQuote]] = [:]
    private(set) var filterLibraryPreferences = FilterLibraryPreferences()
    private(set) var frostedBackgroundEnabled: Bool
    private(set) var frostedBackgroundOpacity: Double
    private(set) var windowBlurRadius: Double
    private(set) var floatingBlurRadius: Double
    private(set) var notificationsEnabled: Bool
    private(set) var monitoringPaused: Bool
    private var rows: [String: Market] = [:]
    private var marketOrder: [String] = []
    private var cachedRows: [String: [String: Any]] = [:]
    private var cachedPeriods: (roc: Int, maroc: Int)?
    private var chartRevisions: [String: Int] = [:]
    private var candles: [String: [Int64: Candle]] = [:]
    private var emaStates: [String: (Int64, Double)] = [:]
    private var candleRequests: [String: [Int64: ContinuousClock.Instant]] = [:]
    private var pendingCandleWrites: [String: Set<Int64>] = [:]
    private var oiHistory: [String: [Int64: Double]] = [:]
    private var oiHistoryRequests: [String: ContinuousClock.Instant] = [:]
    private var exhaustedCandleHistory = Set<String>()
    private var loadedStatPages: [String: ContinuousClock.Instant] = [:]
    private var takerHistory: [String: [Int64: TakerVolume]] = [:]
    private var takerRequests: [String: ContinuousClock.Instant] = [:]
    private var takerFailures = Set<String>()
    private var hour = millis() / hourMS * hourMS
    private var updatedAt: Int64?
    private var revision = 0
    private var failedPaths = Set<String>()
    private var disconnectedChannels = Set<String>()
    private var tasks: [Task<Void, Never>] = []
    private var historyTasks: [Task<Void, Never>] = []
    private var sockets: [URLSessionWebSocketTask] = []
    private var socketActivity: [String: Int64] = [:]
    private var running = false
    // Everything a closed-hour strategy reading depends on. Live ticks are not
    // part of it, so they never trigger a full-universe re-evaluation.
    private struct ClosedEvaluationKey: Equatable {
        let profile: String, revision: Int, hour: Int64, paused: Bool, universe: Set<String>, ownChanges: Int64, otherChanges: Int64
    }
    private var lastMonitorEvaluation: (key: ClosedEvaluationKey, at: ContinuousClock.Instant)?
    private var confirmedCache: (key: ClosedEvaluationKey, detail: String?, readings: [SuiteReading], at: ContinuousClock.Instant)?
    private func closedEvaluationKey(_ profile: StrategyProfile) throws -> ClosedEvaluationKey {
        ClosedEvaluationKey(profile: profile.id, revision: profile.revision, hour: hour, paused: monitoringPaused || !running,
                            universe: Set(rows.keys), ownChanges: store.totalChanges, otherChanges: try store.dataVersion())
    }
    private var refreshingInstruments = false
    private var startupError = ""
    private var observedDataVersion: Int64?

    init(defaults: UserDefaults = .standard, storeURL: URL? = nil, session: URLSession = .shared, takerTransport: (any FilterHistoryTransport)? = nil) throws {
        self.session = session
        takerPoller = TakerVolumePoller(transport: takerTransport ?? OKXFilterHistoryTransport(session: session))
        if let storeURL {
            store = try Store(url: storeURL)
        } else {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("PerpetualRadar", isDirectory: true)
            store = try Store(url: support.appendingPathComponent("radar.sqlite3"))
        }
        try store.initializeSharedSuiteLibrary(researchURL: store.url.deletingLastPathComponent().appendingPathComponent("Research/research.sqlite3"))
        frostedBackgroundEnabled = try store.preference(forKey: frostedBackgroundEnabledKey) != "false"
        let savedOpacity = (try store.preference(forKey: frostedBackgroundOpacityKey)).flatMap(Double.init) ?? 0.3
        frostedBackgroundOpacity = savedOpacity.isFinite && (0...1).contains(savedOpacity) ? savedOpacity : 0.3
        let savedWindowBlur = (try store.preference(forKey: windowBlurRadiusKey)).flatMap(Double.init) ?? 64
        let savedFloatingBlur = (try store.preference(forKey: floatingBlurRadiusKey)).flatMap(Double.init) ?? 64
        windowBlurRadius = WindowServerBlur.validRadius(savedWindowBlur) ? savedWindowBlur : 64
        floatingBlurRadius = WindowServerBlur.validRadius(savedFloatingBlur) ? savedFloatingBlur : 64
        let savedNotifications = try store.preference(forKey: notificationsEnabledKey) ?? store.preference(forKey: "filterNotificationsEnabled")
        notificationsEnabled = savedNotifications != "false"
        monitoringPaused = try store.preference(forKey: monitoringPausedKey) == "true"
        historyLoader = FilterHistoryLoader(url: store.url)
        btcHistoryLoader = FilterHistoryLoader(url: store.url)
        monitorBTCHistoryLoader = FilterHistoryLoader(url: store.url)
        monitorHistoryLoader = FilterHistoryLoader(url: store.url)
        if let saved = try store.preference(forKey: "filterLibraryPreferences") {
            filterLibraryPreferences = (try? FilterLibraryPreferences.decode(saved)) ?? FilterLibraryPreferences()
        }
        observedDataVersion = try store.dataVersion()
    }

    deinit {
        tasks.forEach { $0.cancel() }
        historyTasks.forEach { $0.cancel() }
        sockets.forEach { $0.cancel(with: .goingAway, reason: nil) }
    }

    private func touch(_ id: String? = nil) {
        updatedAt = millis(); revision &+= 1
        if let id { chartRevisions[id, default: 0] &+= 1 }
    }

    private func touch(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        updatedAt = millis(); revision &+= 1
        for id in ids { chartRevisions[id, default: 0] &+= 1 }
    }

    func setFrostedBackground(enabled: Bool? = nil, opacity: Double? = nil, windowBlur: Double? = nil, floatingBlur: Double? = nil) throws -> Bool {
        if let opacity, !opacity.isFinite || !(0...1).contains(opacity) { return false }
        if let windowBlur, !WindowServerBlur.validRadius(windowBlur) { return false }
        if let floatingBlur, !WindowServerBlur.validRadius(floatingBlur) { return false }
        let enabled = enabled ?? frostedBackgroundEnabled
        let opacity = opacity ?? frostedBackgroundOpacity
        let windowBlur = windowBlur ?? windowBlurRadius, floatingBlur = floatingBlur ?? floatingBlurRadius
        guard enabled != frostedBackgroundEnabled || opacity != frostedBackgroundOpacity || windowBlur != windowBlurRadius || floatingBlur != floatingBlurRadius else { return true }
        try store.transaction {
            try store.setPreference(String(enabled), forKey: frostedBackgroundEnabledKey)
            try store.setPreference(String(opacity), forKey: frostedBackgroundOpacityKey)
            try store.setPreference(String(windowBlur), forKey: windowBlurRadiusKey)
            try store.setPreference(String(floatingBlur), forKey: floatingBlurRadiusKey)
        }
        frostedBackgroundEnabled = enabled
        frostedBackgroundOpacity = opacity
        windowBlurRadius = windowBlur
        floatingBlurRadius = floatingBlur
        touch()
        return true
    }

    func setNotificationsEnabled(_ enabled: Bool) throws {
        guard enabled != notificationsEnabled else { return }
        try store.setPreference(String(enabled), forKey: notificationsEnabledKey)
        notificationsEnabled = enabled
        touch()
    }

    func setMonitoringPaused(_ paused: Bool) throws {
        guard paused != monitoringPaused else { return }
        try store.setPreference(String(paused), forKey: monitoringPausedKey)
        monitoringPaused = paused
        touch()
    }

    private func compiledFilter(_ value: String) throws -> CompiledFilter {
        if let cached = compiledFilters[value] {
            compiledFilterLRU.removeAll { $0 == value }; compiledFilterLRU.append(value)
            return cached
        }
        let compiled = try FilterCompiler.compile(FilterConfigV2.decode(value))
        if compiledFilters.count >= 8, let oldest = compiledFilterLRU.first {
            compiledFilters.removeValue(forKey: oldest); compiledFilterLRU.removeFirst()
        }
        compiledFilters[value] = compiled; compiledFilterLRU.append(value); return compiled
    }

    func setFilterLibraryPreferences(_ json: String) throws {
        let next = try FilterLibraryPreferences.decode(json)
        guard next != filterLibraryPreferences else { return }
        try store.setPreference(next.json, forKey: "filterLibraryPreferences")
        filterLibraryPreferences = next
        revision += 1
    }

    func compileMarketFilters(_ request: [String: Any]) -> [String: Any] {
        var metadata: [String: Any] = [:]
        do {
            var phase: SuitePhase?
            if let scope = request["suitePhase"] as? String {
                phase = SuitePhase(rawValue: scope)
                guard scope == "universe" || phase != nil else { throw FilterError("Choose a valid strategy phase.") }
                metadata["allowedMetrics"] = FilterCatalog.metrics.map(\.key)
            }
            let compiled: CompiledFilter
            if let source = request["source"] as? String { compiled = try FilterCompiler.compile(source: source, previous: (request["previousJSON"] as? String).flatMap { try? FilterConfigV2.decode($0) }) }
            else if let json = request["filtersJSON"] as? String { compiled = try compiledFilter(json) }
            else { throw FilterError("Provide a formula or strategy rule configuration.") }
            let configJSON = compiled.config.json
            if compiledFilters.count >= 8, compiledFilters[configJSON] == nil, let oldest = compiledFilterLRU.first {
                compiledFilters.removeValue(forKey: oldest); compiledFilterLRU.removeFirst()
            }
            compiledFilters[configJSON] = compiled
            compiledFilterLRU.removeAll { $0 == configJSON }; compiledFilterLRU.append(configJSON)
            if request["suitePhase"] != nil { try StrategyProfile.validateRule(compiled, phase: phase) }
            return metadata.merging(["configJSON": compiled.config.json, "formula": compiled.formula, "diagnostics": [], "requiredHours": compiled.requiredHours,
                    "units": compiled.units, "expressions": compiled.editorExpressions.mapValues(\.snapshot)]) { _, value in value }
        } catch { metadata["diagnostics"] = [String(describing: error)]; return metadata }
    }

    func suiteRequest(_ request: [String: Any]) async throws -> [String: Any] {
        let mode = request["mode"] as? String ?? "radar"
        var response = try store.manageSuite(request, mode: mode)
        let action = request["action"] as? String ?? "inventory"
        if ["save", "select", "copy", "delete"].contains(action) {
            // Strategy identity is part of every chart response. Retire cached
            // chart payloads immediately so BUY markers cannot belong to the
            // previously active revision.
            for id in rows.keys { chartRevisions[id, default: 0] &+= 1 }
            touch()
        }
        let profile: StrategyProfile?
        if action == "preview", let raw = request["profile"] {
            profile = try JSONDecoder().decode(StrategyProfile.self, from: SafeJSON.data(raw))
        } else { profile = try store.selectedSuiteProfile("radar") }
        if ["evaluate", "preview"].contains(action), let profile {
            let detail = request["instrument"] as? String
            // Drafts may share a revision with different rules; only the saved selection is cached.
            let key = action == "evaluate" ? try closedEvaluationKey(profile) : nil
            let hydration = try profile.hydration(), captured = try await calculateSnapshot(rocPeriod: 9, marocPeriod: 9)
            let prepared = try await prepareFilterMarkets(captured, filter: hydration)
            let provisional = try await suiteWorker.evaluate(prepared, profile: profile, forming: true, available: running && !monitoringPaused, detail: detail)
            let confirmed: [SuiteReading]
            if let key, let cached = confirmedCache, cached.key == key, cached.detail == detail, cached.at.duration(to: .now) < .seconds(60) {
                confirmed = cached.readings
            } else {
                confirmed = try await suiteWorker.evaluate(prepared, profile: profile, forming: false, available: running && !monitoringPaused, detail: detail)
                if let key { confirmedCache = (key, detail, confirmed, .now) }
            }
            if action == "evaluate", try store.selectedSuiteProfile("radar")?.id != profile.id || store.selectedSuiteProfile("radar")?.revision != profile.revision {
                response = try store.suiteInventory(mode)
                response["confirmed"] = []; response["provisional"] = []
                return response
            }
            func object<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: Data(researchJSON(value).utf8)) }
            response["provisional"] = try object(provisional); response["confirmed"] = try object(confirmed)
            response["rows"] = captured.response["rows"]; response["historyProgress"] = await historyLoader.progress().snapshot
            response["revision"] = captured.response["revision"]
        }
        response["paused"] = monitoringPaused || !running
        return response
    }

    private func strategyPreviewContexts(_ markets: [FilterMarketData], atClose: Bool) -> [FilterMarketData] {
        markets.map { input in
            var market = SuiteEvaluation.context(input, forming: !atClose)
            market.recordCooldowns = false
            return market
        }
    }
    private func prepareFilterMarkets(_ captured: (response: [String: Any], markets: [FilterMarketData]), filter: CompiledFilter, monitoring: Bool = false) async throws -> [FilterMarketData] {
        let loader = monitoring ? monitorHistoryLoader : historyLoader
        var prepared = try await loader.prepare(captured.markets, filter: filter)
        if running { await loader.schedule(prepared, filter: filter) }
        var reference: FilterReferenceSnapshot?
        if filter.referencesBTC {
            let sourceLoader = monitoring ? monitorBTCHistoryLoader : btcHistoryLoader
            let original = captured.markets.first { $0.id == btcReferenceID } ?? FilterMarketData(id: btcReferenceID, hour: hour, now: millis(), listedAt: rows[btcReferenceID]?.listedAt, candles: candles[btcReferenceID] ?? [:], stats: [:], quotes: [:])
            let sources = try await sourceLoader.prepare([original], filter: filter.btcHydration)
            if running { await sourceLoader.schedule(sources, filter: filter.btcHydration) }
            if let source = sources.first { reference = FilterReferenceSnapshot(market: source, receivedAt: captured.response["btcReceivedAt"] as? Int64, connected: captured.response["btcConnected"] as? Bool == true) }
        }
        for index in prepared.indices {
            prepared[index].referenceBTC = reference; prepared[index].evaluationTime = prepared[index].now; prepared[index].cooldowns = cooldowns
        }
        return prepared
    }
    func previewMarketFilters(filtersJSON: String, token: String, atClose: Bool = false, strategyID: String? = nil) async throws -> [String: Any] {
        var compiled = try compiledFilter(filtersJSON)
        if atClose {
            compiled.requiredHours += 1
            if compiled.btcClocks.contains("aligned") { compiled.btcRequirements?.hours += 1 }
        }
        for (id, closed) in try await historyLoader.consumeUpdatedHistory(through: hour - hourMS) where rows[id] != nil {
            candles[id, default: [:]].merge(closed) { _, observed in observed }
            emaStates.removeValue(forKey: id)
            invalidateSnapshot(id); touch(id)
        }
        let captured = try await calculateSnapshot(rocPeriod: 9, marocPeriod: 9)
        var response = captured.response
        let prepared = try await prepareFilterMarkets(captured, filter: compiled)
        try Task.checkCancellation()
        let results = await filterWorker.evaluate(strategyPreviewContexts(prepared, atClose: atClose), filter: compiled)
        try Task.checkCancellation()
        response["filterResults"] = results.mapValues(\.rawValue)
        response["filterToken"] = token
        response["historyProgress"] = await historyLoader.progress().snapshot
        return response
    }

    // Runs independently of WebKit, including while the window is closed or a
    // draft is being edited. Separate history demand prevents drafts from
    // cancelling the saved strategy's background hydration.
    func observeSavedStrategy() async throws -> FilterObservation? {
        guard running else { return nil }
        if let profile = try store.selectedSuiteProfile("radar") {
            let hydration = try profile.hydration(), capturedHour = hour
            for (id, closed) in try await monitorHistoryLoader.consumeUpdatedHistory(through: hour - hourMS) where rows[id] != nil {
                candles[id, default: [:]].merge(closed) { _, observed in observed }; emaStates.removeValue(forKey: id); invalidateSnapshot(id); touch(id)
            }
            let key = try closedEvaluationKey(profile)
            // Unchanged inputs produce identical readings; re-check periodically as a safety net.
            if let last = lastMonitorEvaluation, last.key == key, last.at.duration(to: .now) < .seconds(60) { return nil }
            let captured = try await calculateSnapshot(rocPeriod: 9, marocPeriod: 9)
            let prepared = try await prepareFilterMarkets(captured, filter: hydration, monitoring: true)
            let readings = try await suiteMonitorWorker.evaluate(prepared, profile: profile, forming: false, available: !monitoringPaused)
            guard capturedHour == hour, Set(prepared.map(\.id)) == Set(rows.keys),
                  try store.selectedSuiteProfile("radar")?.revision == profile.revision, try store.selectedSuiteProfile("radar")?.id == profile.id else { return nil }
            let observation = try strategyObservation(profile: profile, readings: readings)
            lastMonitorEvaluation = (key, .now)
            return observation
        }
        return FilterObservation(configuration: "no-active-strategy", universe: [], results: [:])
    }

    func monitoringStrategy() throws -> StrategyProfile? { try store.selectedSuiteProfile("radar") }

    func explainMarketFilters(instId: String, filtersJSON: String, token: String, atClose: Bool = false, strategyID: String? = nil) async throws -> [String: Any] {
        var compiled = try compiledFilter(filtersJSON)
        if atClose {
            compiled.requiredHours += 1
            if compiled.btcClocks.contains("aligned") { compiled.btcRequirements?.hours += 1 }
        }
        let captured = try await calculateSnapshot(rocPeriod: 9, marocPeriod: 9)
        guard let original = captured.markets.first(where: { $0.id == instId }) else { throw FilterError("Unknown contract.") }
        let prepared = try await prepareFilterMarkets(captured, filter: compiled)
        guard let market = prepared.first(where: { $0.id == original.id }) else { throw FilterError("Contract data is unavailable.") }
        let trace = await filterWorker.explain(strategyPreviewContexts([market], atClose: atClose)[0], filter: compiled)
        return ["instId": instId, "filterToken": token, "revision": captured.response["revision"] ?? 0, "trace": trace.snapshot]
    }

    private func getData(_ path: String, _ parameters: [String: String]) async throws -> Data {
        var parameters = parameters
        if path == "/rubik/stat/taker-volume-contract" { parameters["unit"] = "1" }
        var parts = URLComponents(string: api + path)!
        parts.queryItems = parameters.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: parts.url!, cachePolicy: .reloadIgnoringLocalCacheData)
        request.timeoutInterval = 15
        try await ResearchRequestLimiter.shared.wait(for: parts.url!)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "OKX", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid OKX response for \(path)"])
        }
        return data
    }

    private func decodeRows(_ data: Data, path: String) throws -> [Any] {
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              body["code"] as? String == "0", let rows = body["data"] as? [Any] else {
            throw NSError(domain: "OKX", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid OKX response for \(path)"])
        }
        return rows
    }

    private func get(_ path: String, _ parameters: [String: String]) async throws -> [Any] {
        try decodeRows(await getData(path, parameters), path: path)
    }

    func start() {
        guard tasks.isEmpty else { return }
        tasks.append(Task { [weak self] in await self?.bootstrap() })
    }

    func stop() {
        tasks.forEach { $0.cancel() }; tasks.removeAll()
        historyTasks.forEach { $0.cancel() }; historyTasks.removeAll()
        sockets.forEach { $0.cancel(with: .goingAway, reason: nil) }; sockets.removeAll()
        running = false; lastMonitorEvaluation = nil
        btcReceivedAt = nil
        Task { await historyLoader.cancel(); await monitorHistoryLoader.cancel(); await btcHistoryLoader.cancel(); await monitorBTCHistoryLoader.cancel() }
    }

    func resumeAfterWake() {
        guard running else { return }
        sockets.forEach { $0.cancel(with: .goingAway, reason: nil) }
        disconnectedChannels.formUnion(["tickers", "open-interest", "candle1H"])
        advanceHourIfNeeded()
        startHistoryScans()
        Task { [weak self] in await self?.refreshInstruments(); await self?.refreshTickers() }
    }

    private func bootstrap() async {
        while !Task.isCancelled {
            do {
                async let instruments = getData("/public/instruments", ["instType": "SWAP"])
                async let marketTickers = getData("/market/tickers", ["instType": "SWAP"])
                let (instrumentData, tickerData) = try await (instruments, marketTickers)
                let items = try decodeRows(instrumentData, path: "/public/instruments")
                let tickers = try decodeRows(tickerData, path: "/market/tickers")
                try initializeMarkets(instruments: items, tickers: tickers)
                disconnectedChannels.formUnion(["tickers", "open-interest", "candle1H"])
                startupError = ""; touch()
                tasks.append(Task { [weak self] in
                    guard let self else { return }
                    do {
                        for case let item as [String: Any] in try await get("/public/open-interest", ["instType": "SWAP"]) { updateOI(item) }
                    } catch { NSLog("/public/open-interest: %@", error.localizedDescription) }
                })
                startHistoryScans()
                tasks.append(Task { [weak self] in await self?.pollTakerVolumes() })
                tasks.append(Task { [weak self] in await self?.websocket(publicWS, channel: "open-interest") })
                tasks.append(Task { [weak self] in await self?.websocket(publicWS, channel: "tickers") })
                tasks.append(Task { [weak self] in await self?.websocket(businessWS, channel: "candle1H") })
                tasks.append(Task { [weak self] in await self?.pollTickers() })
                tasks.append(Task { [weak self] in await self?.pollInstruments() })
                tasks.append(Task { [weak self] in await self?.clock() })
                running = true
                return
            } catch {
                startupError = "OKX unavailable: \(error.localizedDescription). Retrying."
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }

    private func startHistoryScans() {
        historyTasks.forEach { $0.cancel() }
        historyTasks.removeAll()
        historyTasks.append(Task { [weak self] in await self?.scan("/market/candles") })
        historyTasks.append(Task { [weak self] in await self?.scan("/rubik/stat/contracts/open-interest-history") })
    }

    func initializeMarkets(instruments: [Any], tickers: [Any]) throws {
        rows = liveUSDTInstruments(instruments).mapValues { Market(id: $0.id, listedAt: $0.listedAt) }
        guard !rows.isEmpty else { throw FilterError("No live USDT perpetual swaps found") }
        marketOrder = rows.keys.sorted()
        try updateTickers(tickers)
        let cached = try store.load(hour: hour, ids: Set(rows.keys))
        candles = cached.candles; emaStates = cached.ema
    }

    private func pollTakerVolumes() async {
        while !Task.isCancelled {
            await refreshTakerVolumes()
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    func refreshTakerVolumes() async {
        await takerPoller.refresh(rows.keys.sorted()) { [weak self] response in
            await self?.receiveTakerVolumes(response)
        }
    }

    private func receiveTakerVolumes(_ response: TakerVolumeResponse) {
        guard rows[response.id] != nil, !Task.isCancelled,
              takerRequests[response.id].map({ response.requestedAt >= $0 }) ?? true else { return }
        do {
            if let error = response.error { throw FilterError(error) }
            try updateTakerVolumes(response.id, response.volumes, requestedAt: response.requestedAt)
        } catch {
            takerRequests[response.id] = response.requestedAt
            if takerFailures.insert(response.id).inserted { touch(response.id) }
            NSLog("Taker volume %@: %@", response.id, error.localizedDescription)
        }
    }

    func updateTakerVolumes(_ id: String, _ volumes: [TakerVolume], requestedAt: ContinuousClock.Instant) throws {
        guard rows[id] != nil, takerRequests[id].map({ requestedAt >= $0 }) ?? true else { return }
        let current = volumes.first { $0.hour == hour }
        let closed = volumes.filter { $0.hour < hour && takerHistory[id]?[$0.hour] != $0 }
        try store.transaction { for volume in closed {
            try store.saveChartStat(id, hour: volume.hour, sell: volume.sell, buy: volume.buy)
        } }
        for volume in closed { takerHistory[id, default: [:]][volume.hour] = volume }
        takerRequests[id] = requestedAt
        let changed = rows[id]?.buy != current?.buy || rows[id]?.sell != current?.sell
        rows[id]?.buy = current?.buy; rows[id]?.sell = current?.sell; rows[id]?.takerRatio = current?.imbalance
        let errorChanged = current == nil ? takerFailures.insert(id).inserted : takerFailures.remove(id) != nil
        // A chart fetch and the background poll share this observation. Taker
        // changes publish even when the independent OI request fails.
        if changed || !closed.isEmpty || errorChanged { invalidateSnapshot(id); touch(id) }
    }

    func updateTickers(_ tickers: [Any]) throws {
        var valid = false, changed = Set<String>()
        for case let ticker as [String: Any] in tickers {
            guard let id = ticker["instId"] as? String, let old = rows[id],
                  let price = numeric(ticker["last"]), price > 0,
                  let timestamp = (ticker["ts"] as? String).flatMap(Int64.init), timestamp > 0 else { continue }
            valid = true
            guard timestamp >= old.quoteTimestamp else { continue }
            let turnover = usdtTurnover24h(ticker), spread = spreadPercent(ticker)
            rows[id]?.turnover24hUSDT = turnover; rows[id]?.spreadPercent = spread
            rows[id]?.quoteTimestamp = timestamp; rows[id]?.lastPrice = price
            if timestamp >= hour, timestamp < hour + hourMS {
                liveHourQuotes[id] = FilterQuote(turnover: turnover, spread: spread, timestamp: timestamp)
            }
            if old.turnover24hUSDT != turnover || old.spreadPercent != spread || old.lastPrice != price || old.quoteTimestamp != timestamp { invalidateSnapshot(id); changed.insert(id) }
        }
        guard valid else { throw FilterError("No USDT swap ticker data found") }
        touch(changed)
    }

    private func pollTickers() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            if Task.isCancelled { return }
            await refreshTickers()
        }
    }

    private func pollInstruments() async {
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(300)) } catch { return }
            await refreshInstruments()
        }
    }

    private func refreshInstruments() async {
        guard running, !refreshingInstruments else { return }
        refreshingInstruments = true
        defer { refreshingInstruments = false }
        do {
            let instruments = liveUSDTInstruments(try await get("/public/instruments", ["instType": "SWAP"]))
            guard !instruments.isEmpty else { throw FilterError("No live USDT perpetual swaps found; retaining the current universe.") }
            try Task.checkCancellation()
            guard running else { return }
            let next = Set(instruments.keys), previous = Set(rows.keys)
            let added = next.subtracting(previous), removed = previous.subtracting(next)
            guard !added.isEmpty || !removed.isEmpty else { failedPaths.remove("/public/instruments"); return }
            // Read the cache before replacing membership so a database failure
            // cannot partially apply a universe refresh and create false exits.
            let cached = try (added.isEmpty ? nil : store.load(hour: hour, ids: added))
            failedPaths.remove("/public/instruments")
            for id in removed {
                rows.removeValue(forKey: id); candles.removeValue(forKey: id)
                emaStates.removeValue(forKey: id); candleRequests.removeValue(forKey: id)
                pendingCandleWrites.removeValue(forKey: id)
                oiHistory.removeValue(forKey: id); oiHistoryRequests.removeValue(forKey: id)
                liveHourQuotes.removeValue(forKey: id); closedHourQuotes.removeValue(forKey: id)
                chartRevisions.removeValue(forKey: id); snapshotGenerations.removeValue(forKey: id)
                cachedRows.removeValue(forKey: id); takerHistory.removeValue(forKey: id)
                takerRequests.removeValue(forKey: id); takerFailures.remove(id)
                exhaustedCandleHistory.remove(id)
            }
            for id in added {
                rows[id] = Market(id: id, listedAt: instruments[id]?.listedAt)
                candles[id] = cached?.candles[id]; emaStates[id] = cached?.ema[id]
            }
            marketOrder = rows.keys.sorted()
            touch()
            // Existing socket loops reconnect and subscribe to the new universe.
            sockets.forEach { $0.cancel(with: .goingAway, reason: nil) }
            disconnectedChannels.formUnion(["tickers", "open-interest", "candle1H"])
            startHistoryScans()
            await refreshTickers()
        } catch {
            if !Task.isCancelled {
                failedPaths.insert("/public/instruments")
                NSLog("/public/instruments: %@", error.localizedDescription)
            }
        }
    }

    private func refreshTickers() async {
        do {
            try updateTickers(await get("/market/tickers", ["instType": "SWAP"]))
            failedPaths.remove("/market/tickers")
        } catch {
            failedPaths.insert("/market/tickers")
            NSLog("/market/tickers: %@", error.localizedDescription)
        }
    }

    func updateOI(_ item: [String: Any]) {
        guard let id = item["instId"] as? String,
              let current = numeric(item["oi"]), current >= 0,
              let stamp = numeric(item["ts"]), let value = numeric(item["oiUsd"]), value >= 0 else { return }
        applyOI(id, value: value, timestamp: stamp)
    }

    private func applyOI(_ id: String, value: Double, timestamp: Double) {
        guard var row = rows[id], timestamp >= row.oiTimestamp else { return }
        guard row.oiTimestamp != timestamp || row.oiUsd != value else { return }
        row.oiTimestamp = timestamp; row.oiUsd = value
        rows[id] = row; invalidateSnapshot(id); touch(id)
    }

    private func currentOI(_ id: String) -> Double? {
        guard let row = rows[id], row.oiTimestamp >= Double(hour), row.oiTimestamp < Double(hour + hourMS) else { return nil }
        return row.oiUsd
    }

    @discardableResult
    func updateOIHistory(_ id: String, _ values: [Any], requestedAt: ContinuousClock.Instant) throws -> Bool {
        guard rows[id] != nil, oiHistoryRequests[id].map({ requestedAt >= $0 }) ?? true else { return false }
        var observations: [Int64: Double] = [:]
        for case let item as [String] in values {
            guard item.count >= 4, let ts = Int64(item[0]), ts >= 0, ts % hourMS == 0, ts <= hour,
                  let oi = Double(item[3]), oi.isFinite, oi >= 0 else { continue }
            observations[ts] = oi
        }
        let closed = observations.filter { $0.key < hour && oiHistory[id]?[$0.key] != $0.value }
        try store.transaction { for (ts, value) in closed { try store.saveChartStat(id, hour: ts, oi: value) } }
        for (ts, value) in closed { oiHistory[id, default: [:]][ts] = value }
        oiHistoryRequests[id] = requestedAt
        if let live = observations[hour] { applyOI(id, value: live, timestamp: Double(hour)) }
        if !closed.isEmpty { invalidateSnapshot(id); touch(id) }
        return observations[hour - hourMS] != nil
    }

    @discardableResult
    func updateCandle(_ id: String, _ values: [String], history: Bool = false, persist: Bool = true, requestedAt: ContinuousClock.Instant = .now) -> Candle? {
        guard rows[id] != nil, let bar = Candle(values), bar.hour >= hour - Int64(candleLookback) * hourMS else { return nil }
        let old = candles[id]?[bar.hour]
        guard old?.confirmed != true || bar.confirmed else { return nil }
        guard candleRequests[id]?[bar.hour].map({ requestedAt >= $0 }) ?? true else { return nil }
        // Unconfirmed volume is cumulative. A queued WebSocket frame can lag
        // a REST recovery snapshot even though it arrives afterwards.
        if !bar.confirmed, let old, let volume = old.baseVolume, let next = bar.baseVolume, next < volume { return nil }
        candleRequests[id, default: [:]][bar.hour] = requestedAt
        guard old != bar || pendingCandleWrites[id]?.contains(bar.hour) == true else { return nil }
        let settled = bar
        candles[id, default: [:]][bar.hour] = settled
        if settled.confirmed { emaStates.removeValue(forKey: id) }
        invalidateSnapshot(id)
        if settled.confirmed && persist {
            do { try store.save(id, settled); pendingCandleWrites[id]?.remove(settled.hour) }
            catch { pendingCandleWrites[id, default: []].insert(settled.hour); NSLog("Candle cache %@: %@", id, error.localizedDescription) }
        }
        touch(id)
        return settled
    }

    func updateHistoricalCandles(_ id: String, _ result: [Any], requestedAt: ContinuousClock.Instant = .now) throws {
        let previousCandles = candles[id]
        let previousRequests = candleRequests[id], previousEMA = emaStates[id]
        let previousRow = cachedRows[id]
        let previousUpdatedAt = updatedAt
        let previousRevision = revision
        let previousChartRevision = chartRevisions[id]
        var settled: [Candle] = []
        for case let values as [String] in result {
            if let bar = updateCandle(id, values, history: true, persist: false, requestedAt: requestedAt), bar.confirmed { settled.append(bar) }
        }
        do {
            try store.saveCandles(id, settled)
            for bar in settled { pendingCandleWrites[id]?.remove(bar.hour) }
        }
        catch {
            candles[id] = previousCandles
            candleRequests[id] = previousRequests; emaStates[id] = previousEMA
            cachedRows[id] = previousRow
            updatedAt = previousUpdatedAt
            revision = previousRevision
            chartRevisions[id] = previousChartRevision
            throw error
        }
    }

    private func historyReady(_ id: String) -> Bool {
        let series = candles[id] ?? [:]
        let hours = completedHistoryHours(at: hour, since: rows[id]?.listedAt, limit: candleLookback)
        return (1..<(hours + 1)).allSatisfy { series[hour - Int64($0) * hourMS]?.confirmed == true && series[hour - Int64($0) * hourMS]?.open != nil } &&
            (1..<(min(hours, 13) + 1)).allSatisfy { series[hour - Int64($0) * hourMS]?.baseVolume != nil }
    }

    private func scanMarket(_ path: String, id: String) async -> Bool {
        do {
            let requestedAt = ContinuousClock.now
            let parameters = path == "/market/candles"
                ? ["instId": id, "bar": "1H", "limit": historyReady(id) ? "2" : "251"]
                : ["instId": id, "period": "1H"]
            let result = try await get(path, parameters)
            try Task.checkCancellation()
            guard rows[id] != nil else { return true }
            if path == "/market/candles" {
                try updateHistoricalCandles(id, result, requestedAt: requestedAt)
                return historyReady(id)
            }
            return try updateOIHistory(id, result, requestedAt: requestedAt)
        } catch {
            if !Task.isCancelled { NSLog("%@ %@: %@", path, id, error.localizedDescription) }
            return false
        }
    }

    // Share endpoint admission with charts/Research, while processing healthy
    // contracts as soon as they finish. Periodic recovery also repairs missed
    // closing candles without depending on a WebSocket reconnect or UI request.
    private func scan(_ path: String) async {
        while !Task.isCancelled {
            var failed = Set<String>()
            let radar = self
            await withTaskGroup(of: (String, Bool).self) { group in
                var ids = rows.keys.sorted().makeIterator()
                func enqueue(_ id: String) {
                    group.addTask { (id, await radar.scanMarket(path, id: id)) }
                    }
                for _ in 0..<32 { if let id = ids.next() { enqueue(id) } }
                for await (id, success) in group {
                    if !success { failed.insert(id) }
                    if Task.isCancelled { group.cancelAll(); break }
                    if let id = ids.next() { enqueue(id) }
                }
            }
            if Task.isCancelled { return }
            let wasFailed = failedPaths.contains(path)
            if failed.isEmpty { failedPaths.remove(path) } else { failedPaths.insert(path) }
            if wasFailed != !failed.isEmpty { touch() }
            do { try await Task.sleep(for: .seconds(failed.isEmpty ? 30 : 10)) } catch { return }
        }
    }

    private func websocket(_ address: String, channel: String) async {
        var backoff: UInt64 = 1_000_000_000
        var connectedBefore = false
        while !Task.isCancelled {
            let socket = session.webSocketTask(with: URL(string: address)!)
            failedPaths = failedPaths.filter { !$0.hasPrefix("WebSocket \(channel) ") }
            sockets.append(socket); socket.resume()
            socketActivity[channel] = millis()
            let ping = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 20_000_000_000)
                    // A half-open connection (e.g. after a network change) never errors and never
                    // answers ping; recycle it once nothing, not even "pong", arrived for a minute.
                    if let last = self?.socketActivity[channel], millis() - last > 60_000 {
                        socket.cancel(with: .goingAway, reason: nil); return
                    }
                    try? await socket.send(.string("ping"))
                }
            }
            do {
                let args = rows.keys.sorted().map { ["channel": channel, "instId": $0] }
                var pending = Set(rows.keys)
                for start in stride(from: 0, to: args.count, by: 50) {
                    let message = ["op": "subscribe", "args": Array(args[start..<min(start + 50, args.count)])] as [String: Any]
                    let data = try SafeJSON.data(message)
                    try await socket.send(.string(String(decoding: data, as: UTF8.self)))
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
                var receivedData = false
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    socketActivity[channel] = millis()
                    guard case let .string(text) = message, text != "pong",
                          let data = text.data(using: .utf8),
                          let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    if payload["event"] as? String == "error" {
                        // A rejected argument (e.g. one delisted contract) must not drop every other
                        // subscription. Connection-level failures close the socket and throw from receive().
                        NSLog("%@ WebSocket subscription error %@: %@", channel, payload["code"] as? String ?? "", payload["msg"] as? String ?? "")
                        let rejected = (payload["arg"] as? [String: String])?["instId"] ?? "*"
                        if failedPaths.insert("WebSocket \(channel) \(rejected)").inserted { touch() }
                        continue
                    }
                    guard let arg = payload["arg"] as? [String: String], arg["channel"] == channel else { continue }
                    if payload["event"] as? String == "subscribe" || payload["data"] != nil, let id = arg["instId"] {
                        pending.remove(id)
                        if failedPaths.remove("WebSocket \(channel) \(id)") != nil { touch() }
                        if pending.isEmpty, failedPaths.remove("WebSocket \(channel) *") != nil { touch() }
                    }
                    guard let items = payload["data"] as? [Any], !items.isEmpty else { continue }
                    // Reset only after the exchange actually delivers data on this connection.
                    backoff = 1_000_000_000
                    if !receivedData {
                        receivedData = true
                        disconnectedChannels.remove(channel); touch()
                        if channel == "candle1H", connectedBefore { startHistoryScans() }
                        connectedBefore = true
                    }
                    for item in items {
                        if channel == "tickers", let value = item as? [String: Any] { try? updateTickers([value]) }
                        if channel == "open-interest", let value = item as? [String: Any] { updateOI(value) }
                        if channel == "candle1H", let id = arg["instId"], let value = item as? [String] {
                            if let _ = updateCandle(id, value), id == btcReferenceID { btcReceivedAt = millis() }
                        }
                    }
                }
            } catch {
                if !Task.isCancelled { NSLog("%@ WebSocket: %@", channel, error.localizedDescription) }
            }
            ping.cancel(); socket.cancel(with: .goingAway, reason: nil)
            sockets.removeAll { $0 === socket }
            if disconnectedChannels.insert(channel).inserted { touch() }
            try? await Task.sleep(nanoseconds: backoff + UInt64.random(in: 0...(backoff / 4)))
            backoff = min(backoff * 2, 30_000_000_000)
        }
    }

    private func clock() async {
        while !Task.isCancelled {
            let now = millis(), nextHour = (now / hourMS + 1) * hourMS
            try? await Task.sleep(for: .milliseconds(max(100, nextHour - now)))
            if advanceHourIfNeeded() { startHistoryScans() }
        }
    }

    @discardableResult
    func advanceHourIfNeeded(now: Int64 = millis()) -> Bool {
        let current = now / hourMS * hourMS
        guard current != hour else { return false }
        for (id, quote) in liveHourQuotes { closedHourQuotes[id, default: [:]][quote.timestamp / hourMS * hourMS] = quote }
        liveHourQuotes.removeAll()
        do {
            try store.transaction { for (id, quotes) in closedHourQuotes { for (ts, quote) in quotes { try store.saveHourlyQuote(id, hour: ts, quote: quote) } } }
            closedHourQuotes.removeAll()
        } catch { startupError = "Cannot save hourly quote snapshots: \(error.localizedDescription)" }
        hour = current
        invalidateSnapshots()
        for id in rows.keys { chartRevisions[id, default: 0] &+= 1 }
        for id in takerHistory.keys { takerHistory[id] = takerHistory[id]?.filter { $0.key >= hour - 100 * hourMS } }
        for id in oiHistory.keys { oiHistory[id] = oiHistory[id]?.filter { $0.key >= hour - 100 * hourMS } }
        for id in candleRequests.keys { candleRequests[id] = candleRequests[id]?.filter { $0.key >= hour - Int64(candleLookback) * hourMS } }
        for id in rows.keys {
            rows[id]?.buy = nil; rows[id]?.sell = nil; rows[id]?.takerRatio = nil
            candles[id] = candles[id]?.filter { $0.key >= hour - Int64(candleLookback) * hourMS }
        }
        emaStates = emaStates.filter { $0.value.0 >= hour - Int64(candleLookback + 1) * hourMS && $0.value.0 < hour }
        touch()
        return true
    }

    private func ema200(_ id: String, _ bars: [Int64: Candle]) -> Double? {
        let target = hour - hourMS
        var state = emaStates[id]
        if let prior = state, prior.0 < target {
            for ts in stride(from: prior.0 + hourMS, through: target, by: Int(hourMS)) {
                guard let bar = bars[ts], bar.confirmed else { state = nil; break }
                state = (ts, state!.1 + (bar.close - state!.1) * 2 / 201)
            }
        }
        if state?.0 != target {
            // Seed with the same windowed EMA used for closed-hour evaluation so live and
            // Research/strategy readings share one definition. Older persisted candles extend
            // the in-memory lookback; the seed stops at the first gap (or the listing).
            let window = emaWarmupHours(200)
            var history = bars
            if let stored = try? store.candles(id, since: max(0, target - Int64(window - 1) * hourMS), through: target) {
                history.merge(stored) { _, recorded in recorded }
            }
            var closes: [Double] = []
            for age in 0..<window {
                guard let bar = history[target - Int64(age) * hourMS], bar.confirmed else { break }
                closes.append(bar.close)
            }
            guard let seeded = windowedEMA(closes.reversed(), period: 200) else { return nil }
            state = (target, seeded)
        }
        if emaStates[id]?.0 != state?.0 || emaStates[id]?.1 != state?.1 {
            emaStates[id] = state
            do { try store.execute("INSERT OR REPLACE INTO ema200 VALUES (?,?,?)", [id, state!.0, state!.1]) }
            catch { startupError = "Cache error: \(error.localizedDescription)" }
        }
        return state?.1
    }

    private func refreshChartSource(_ id: String, path: String) async -> String? {
        let requestedAt = ContinuousClock.now
        let label = path == "/market/candles" ? "candles" : path.contains("open-interest") ? "OI" : "taker volume"
        do {
            let parameters = path == "/market/candles"
                ? ["instId": id, "bar": "1H", "limit": "251"] : ["instId": id, "period": "1H"]
            let result = try await get(path, parameters)
            try Task.checkCancellation()
            if path == "/market/candles" { try updateHistoricalCandles(id, result, requestedAt: requestedAt) }
            else if path.contains("open-interest") { try updateOIHistory(id, result, requestedAt: requestedAt) }
            else {
                try updateTakerVolumes(id, result.compactMap { ($0 as? [String]).flatMap(TakerVolume.init) }, requestedAt: requestedAt)
                if takerFailures.contains(id) { return "current-hour taker volume" }
            }
            return nil
        } catch {
            if path == "/rubik/stat/taker-volume-contract", !Task.isCancelled {
                receiveTakerVolumes(.init(id: id, requestedAt: requestedAt, volumes: [], error: error.localizedDescription))
            }
            return label
        }
    }

    func loadChart(_ id: String) async -> [String: Any] {
        guard rows[id] != nil else { return ["bars": [], "error": "Unknown contract", "revision": -1] }
        // Each child publishes immediately; a slow source cannot withhold an
        // already-completed update from snapshot polling or strategy readings.
        async let candles = refreshChartSource(id, path: "/market/candles")
        async let oi = refreshChartSource(id, path: "/rubik/stat/contracts/open-interest-history")
        async let taker = refreshChartSource(id, path: "/rubik/stat/taker-volume-contract")
        let failures = await [candles, oi, taker].compactMap { $0 }
        var result = chartSnapshot(id)
        if !failures.isEmpty { result["error"] = "Some chart data is unavailable: \(failures.joined(separator: ", "))." }
        return result
    }

    func loadHistoricalChart(_ id: String, endingAt requestedEnd: Int64) async -> [String: Any] {
        guard rows[id] != nil, requestedEnd >= 0, requestedEnd <= hour, requestedEnd % hourMS == 0 else {
            return ["bars": [], "error": "Invalid chart time", "revision": -1]
        }
        var failures: [String] = []
        var candleLoadFailed = false
        let warmupStart = max(0, requestedEnd - Int64(candleLookback - 1 + emaWarmupHours(200)) * hourMS)
        do {
            var cached = try store.candles(id, since: warmupStart, through: requestedEnd)
            for (ts, bar) in candles[id] ?? [:] where ts >= warmupStart && ts <= requestedEnd { cached[ts] = bar }
            var cursor: Int64?
            for ts in stride(from: requestedEnd, through: warmupStart, by: -Int(hourMS)) where ts < hour {
                if cached[ts]?.confirmed != true || cached[ts]?.open == nil || cached[ts]?.baseVolume == nil { cursor = ts + hourMS; break }
            }
            var pages = 0
            while let next = cursor, next > warmupStart && pages < 5 && !exhaustedCandleHistory.contains(id) {
                let rows = try await get("/market/history-candles", ["instId": id, "bar": "1H", "after": String(next), "limit": "300"])
                let fetched = historicalPage(rows, before: next)
                guard let oldest = fetched.map(\.hour).min() else { exhaustedCandleHistory.insert(id); break }
                try store.saveCandles(id, fetched)
                for bar in fetched where bar.hour >= hour - Int64(candleLookback) * hourMS { candles[id, default: [:]][bar.hour] = bar }
                emaStates.removeValue(forKey: id); invalidateSnapshot(id); touch(id)
                for bar in fetched { cached[bar.hour] = bar }
                cursor = oldest
                pages += 1
                if oldest <= warmupStart { break }
            }
        } catch { failures.append("candles"); candleLoadFailed = true }
        let oldest = (try? store.oldestCandleHour(id)) ?? nil
        let end = boundedHistoryEnd(requestedEnd, oldest: oldest, exhausted: exhaustedCandleHistory.contains(id), latest: hour)
        let first = end - Int64(candleLookback - 1) * hourMS
        for path in ["/rubik/stat/contracts/open-interest-history", "/rubik/stat/taker-volume-contract"] {
            for pageStart in stride(from: first / (Int64(chartHours) * hourMS) * Int64(chartHours) * hourMS,
                                    through: end, by: Int(chartHours) * Int(hourMS)) {
                let key = "\(id)|\(path)|\(pageStart)"
                if loadedStatPages[key].map({ $0.duration(to: .now) < .seconds(900) }) == true { continue }
                let pageEnd = pageStart + Int64(chartHours - 1) * hourMS
                do {
                    let values = try await get(path, ["instId": id, "period": "1H", "end": String(pageEnd + hourMS), "limit": "100"])
                    var loaded = Set<Int64>()
                    for case let row as [String] in values {
                        guard let stamp = row.first.flatMap(Int64.init), stamp >= pageStart, stamp <= pageEnd, stamp < hour else { continue }
                        if path.contains("open-interest"), row.count >= 4, let oi = Double(row[3]), oi.isFinite, oi >= 0 {
                            try store.saveChartStat(id, hour: stamp, oi: oi)
                            loaded.insert(stamp)
                        } else if !path.contains("open-interest"), row.count >= 3,
                                  let sell = Double(row[1]), let buy = Double(row[2]),
                                  sell.isFinite, buy.isFinite, sell >= 0, buy >= 0 {
                            try store.saveChartStat(id, hour: stamp, sell: sell, buy: buy)
                            loaded.insert(stamp)
                        }
                    }
                    if !loaded.isEmpty { invalidateSnapshot(id); touch(id) }
                    let firstExpected = max(0, pageStart, (rows[id]?.listedAt ?? 0) / hourMS * hourMS)
                    let lastExpected = min(pageEnd, hour - hourMS)
                    if firstExpected > lastExpected || stride(from: firstExpected, through: lastExpected, by: Int(hourMS)).allSatisfy({ loaded.contains($0) }) {
                        loadedStatPages[key] = .now
                    } else { failures.append(path.contains("open-interest") ? "OI coverage" : "taker volume coverage") }
                } catch { failures.append(path.contains("open-interest") ? "OI" : "taker volume") }
            }
        }
        var result = chartSnapshot(id, endingAt: end)
        result["endHour"] = end
        result["oldestHour"] = oldest as Any? ?? NSNull()
        result["historyExhausted"] = exhaustedCandleHistory.contains(id)
        result["candleLoadFailed"] = candleLoadFailed
        if !failures.isEmpty { result["error"] = "Some chart data is unavailable: \(Set(failures).sorted().joined(separator: ", "))." }
        return result
    }

    func chartSnapshot(_ id: String, sinceRevision: Int? = nil, endingAt endHour: Int64? = nil) -> [String: Any] {
        guard rows[id] != nil else { return ["bars": [], "error": "Unknown contract", "revision": -1] }
        synchronizeRecordedData()
        let chartRevision = chartRevisions[id] ?? 0
        let error = endHour == nil && takerFailures.contains(id) ? "OKX current-hour taker volume is unavailable; retrying." : ""
        if endHour == nil && sinceRevision == chartRevision {
            return ["unchanged": true, "revision": chartRevision, "error": error]
        }
        let null = NSNull()
        let end = endHour ?? hour
        let first = end - Int64(candleLookback - 1) * hourMS
        var series: [Int64: Candle]
        let stats: [Int64: (oi: Double?, sell: Double?, buy: Double?)]
        let profile = try? store.selectedSuiteProfile("radar")
        var chartReplay: StrategyChartReplay?
        do {
            let warmup = max(candleLookback, emaWarmupHours(200))
            series = try store.candles(id, since: max(0, first - Int64(warmup) * hourMS), through: end)
            for (ts, bar) in candles[id] ?? [:] where ts >= first - Int64(warmup) * hourMS && ts <= end && (ts == hour || series[ts] == nil) { series[ts] = bar }
            let dataFirst = max(0, first - Int64(warmup) * hourMS)
            stats = try store.chartStats(id, since: dataFirst, through: end)
            if let profile {
                let hydration = try profile.hydration()
                let quotes = hydration.needsQuotes ? try store.hourlyQuotes(id, since: dataFirst, through: end) : [:]
                let market = FilterMarketData(id: id, hour: end, now: end + hourMS, listedAt: rows[id]?.listedAt,
                    candles: series, stats: stats.mapValues { FilterStat(oi: $0.oi, sell: $0.sell, buy: $0.buy) }, quotes: quotes, historicalClose: true)
                var reference: FilterMarketData?
                if hydration.referencesBTC {
                    let referenceCandles = try store.candles(btcReferenceID, since: dataFirst, through: end)
                    let referenceStats = hydration.btcRequirements?.needsStats == true ? try store.chartStats(btcReferenceID, since: dataFirst, through: end) : [:]
                    let referenceQuotes = hydration.btcRequirements?.needsQuotes == true ? try store.hourlyQuotes(btcReferenceID, since: dataFirst, through: end) : [:]
                    reference = FilterMarketData(id: btcReferenceID, hour: end, now: end + hourMS, listedAt: rows[btcReferenceID]?.listedAt,
                        candles: referenceCandles, stats: referenceStats.mapValues { FilterStat(oi: $0.oi, sell: $0.sell, buy: $0.buy) }, quotes: referenceQuotes, historicalClose: true)
                }
                let replayEnd = endHour == nil ? series.filter { $0.value.open != nil }.keys.max() ?? end : end
                let confirmedThrough = min(replayEnd, hour - hourMS)
                let replayFirst = radarStrategyReplayStart(chartEnd: replayEnd)
                chartReplay = try strategyChartReplay(profile: profile, market: market, reference: reference, from: replayFirst, through: confirmedThrough)
            }
        }
        catch { return ["bars": [], "error": "Cannot read chart cache: \(error.localizedDescription)", "revision": chartRevision] }
        var seed: [Double] = []
        for age in 1...emaWarmupHours(200) {
            guard let bar = series[first - Int64(age) * hourMS], bar.confirmed else { break }
            seed.append(bar.close)
        }
        var ema: Double? = windowedEMA(seed.reversed(), period: 200)
        var chartEMA: [Int64: Double] = [:]
        if endHour == nil, let previous = ema200(id, series) {
            let alpha = 2.0 / 201.0
            let last = series[hour] == nil ? hour - hourMS : hour
            var value = series[hour].flatMap { updatedEMA200(previous, close: $0.close) } ?? previous
            for ts in stride(from: last, through: first, by: -Int(hourMS)) {
                guard let bar = series[ts] else { break }
                chartEMA[ts] = value
                value = (value - bar.close * alpha) / (1 - alpha)
            }
        }
        var output: [[String: Any]] = []
        for ts in stride(from: first, through: end, by: Int(hourMS)) {
            guard let bar = series[ts] else { ema = nil; continue }
            ema = chartEMA[ts] ?? updatedEMA200(ema, close: bar.close)
            guard let open = bar.open else { continue }
            let (roc, maroc) = rocMaroc(series, ts, 9, 9)
            let (upper, middle, lower) = logBB(series, ts)
            let stat = stats[ts]
            let oi = ts == hour ? currentOI(id) : stat?.oi
            let sell = ts == hour ? rows[id]?.sell : stat?.sell
            let buy = ts == hour ? rows[id]?.buy : stat?.buy
            output.append([
                "hour": ts, "open": open, "high": bar.high, "low": bar.low, "close": bar.close,
                "volume": bar.quoteVolume as Any? ?? null, "confirmed": bar.confirmed,
                "vwap": vwap14(series, ts) as Any? ?? null, "ema": ema as Any? ?? null,
                "logBBUpper": upper as Any? ?? null, "logBBMiddle": middle as Any? ?? null, "logBBLower": lower as Any? ?? null,
                "roc": percentageSnapshot(roc), "maroc": percentageSnapshot(maroc),
                "rsi6": rsi(series, ts, 6) as Any? ?? null,
                "rsi12": rsi(series, ts, 12) as Any? ?? null,
                "rsi24": rsi(series, ts, 24) as Any? ?? null,
                "oi": oi as Any? ?? null, "sell": sell as Any? ?? null, "buy": buy as Any? ?? null,
            ])
        }
        var result: [String: Any] = ["bars": output, "error": error, "revision": chartRevision]
        if let profile {
            result["strategy"] = ["id": profile.id, "name": profile.name, "revision": profile.revision]
            result["strategySignals"] = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(chartReplay?.signals ?? []))
            if let chartReplay { result["strategyReplay"] = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(chartReplay)) }
        }
        return result
    }

    private func invalidateSnapshot(_ id: String) {
        cachedRows.removeValue(forKey: id)
        snapshotGenerations[id, default: 0] &+= 1
    }
    private func invalidateSnapshots() {
        cachedRows.removeAll()
        for id in rows.keys { snapshotGenerations[id, default: 0] &+= 1 }
    }

    private func synchronizeRecordedData() {
        do {
            let version = try store.dataVersion()
            guard observedDataVersion != version else { return }
            guard !rows.isEmpty else { observedDataVersion = version; return }
            let recorded = try store.load(hour: hour, ids: Set(rows.keys))
            for (id, bars) in recorded.candles {
                var changed = false
                for (ts, bar) in bars where candles[id]?[ts] != bar && pendingCandleWrites[id]?.contains(ts) != true {
                    candles[id, default: [:]][ts] = bar; candleRequests[id, default: [:]][ts] = .now
                    changed = true
                }
                if changed { touch(id) }
            }
            // An external history writer may also extend the EMA seed beyond
            // the in-memory lookback, or correct an OI comparison hour.
            emaStates.removeAll(); oiHistory.removeAll(); takerHistory.removeAll(); invalidateSnapshots(); touch()
            observedDataVersion = version
        } catch {
            let error = "Cache error: \(error.localizedDescription)"
            if startupError != error { startupError = error; touch() }
        }
    }

    private struct SnapshotBatch {
        var response: [String: Any]
        var inputs: [MarketSnapshotInput] = []
        var cached: [String: [String: Any]] = [:]
        var generations: [String: Int] = [:]
        var roc = 9, maroc = 9
    }

    private func snapshotMetadata() -> [String: Any] {
        let error = !startupError.isEmpty ? startupError : pendingCandleWrites.values.contains(where: { !$0.isEmpty }) ? "Cannot persist completed candles; retrying the cache write." : !takerFailures.isEmpty ? "Some OKX current-hour taker volume is unavailable; retrying." : !failedPaths.isEmpty ? "Some OKX data is unavailable; retrying." :
            !disconnectedChannels.isEmpty ? "OKX \(disconnectedChannels.sorted()[0]) disconnected; reconnecting." : ""
        return ["rows": [[String: Any]](), "updatedAt": updatedAt as Any? ?? NSNull(), "error": error, "revision": revision,
                "btcReceivedAt": btcReceivedAt as Any? ?? NSNull(), "btcConnected": running && !disconnectedChannels.contains("candle1H"),
                "frostedBackgroundEnabled": frostedBackgroundEnabled, "frostedBackgroundOpacity": frostedBackgroundOpacity,
                "windowBlurRadius": windowBlurRadius, "floatingBlurRadius": floatingBlurRadius,
                "notificationsEnabled": notificationsEnabled,
                "filterMetricsCatalog": FilterCatalog.metrics.map(\.snapshot), "filterFunctions": FilterCatalog.functions,
                "filterFunctionCatalog": FilterCatalog.scalarFunctions.map(\.snapshot), "filterLibraryPreferences": filterLibraryPreferences.snapshot]
    }

    private func prepareSnapshot(rocPeriod: Int, marocPeriod: Int, sinceRevision: Int? = nil) -> SnapshotBatch {
        synchronizeRecordedData()
        var batch = SnapshotBatch(response: snapshotMetadata(), roc: rocPeriod, maroc: marocPeriod)
        guard (1...100).contains(rocPeriod), (1...100).contains(marocPeriod) else {
            batch.response["error"] = "Periods must be from 1 to 100."; return batch
        }
        if cachedPeriods?.roc != rocPeriod || cachedPeriods?.maroc != marocPeriod {
            invalidateSnapshots(); cachedPeriods = (rocPeriod, marocPeriod)
        } else if sinceRevision == revision {
            batch.response = ["unchanged": true, "revision": revision, "error": batch.response["error"] ?? ""]; return batch
        }
        let previousOI: [String: Double]
        do { previousOI = try store.openInterest(hour: hour - hourMS) }
        catch { startupError = "Cache error: \(error.localizedDescription)"; previousOI = [:] }
        let now = millis()
        for id in marketOrder {
            guard let row = rows[id] else { continue }
            let bars = candles[id] ?? [:]
            batch.inputs.append(.init(id: id, hour: hour, now: now, candles: bars, listedAt: row.listedAt,
                turnover: row.turnover24hUSDT, spreadPercent: row.spreadPercent, quoteTimestamp: row.quoteTimestamp,
                lastPrice: row.lastPrice,
                buy: row.buy, sell: row.sell, takerRatio: row.takerRatio,
                currentOI: currentOI(id),
                previousOI: previousOI[id], previousEMA: ema200(id, bars)))
            batch.generations[id] = snapshotGenerations[id, default: 0]
        }
        batch.cached = cachedRows
        return batch
    }

    private func finishSnapshot(_ batch: SnapshotBatch, calculated: [String: MarketSnapshotRow]) -> (response: [String: Any], markets: [FilterMarketData]) {
        var response = batch.response, output: [[String: Any]] = [], markets: [FilterMarketData] = []
        for input in batch.inputs {
            guard let row = calculated[input.id]?.fields ?? batch.cached[input.id] else { continue }
            output.append(row); markets.append(input.filterData(row: row))
            // An OI/ticker/candle update during background work must invalidate
            // this row without changing the captured response's revision.
            if calculated[input.id] != nil, snapshotGenerations[input.id, default: 0] == batch.generations[input.id], input.hour == hour,
               cachedPeriods?.roc == batch.roc, cachedPeriods?.maroc == batch.maroc { cachedRows[input.id] = row }
        }
        if response["unchanged"] == nil { response["rows"] = output }
        return (response, markets)
    }

    private func calculateSnapshot(rocPeriod: Int, marocPeriod: Int, sinceRevision: Int? = nil) async throws -> (response: [String: Any], markets: [FilterMarketData]) {
        let batch = prepareSnapshot(rocPeriod: rocPeriod, marocPeriod: marocPeriod, sinceRevision: sinceRevision)
        let missing = batch.inputs.filter { batch.cached[$0.id] == nil }
        let calculated = try await snapshotWorker.calculate(missing, rocPeriod: rocPeriod, marocPeriod: marocPeriod)
        try Task.checkCancellation()
        return finishSnapshot(batch, calculated: calculated)
    }

    func asyncSnapshot(rocPeriod: Int, marocPeriod: Int, sinceRevision: Int? = nil) async throws -> [String: Any] {
        try await calculateSnapshot(rocPeriod: rocPeriod, marocPeriod: marocPeriod, sinceRevision: sinceRevision).response
    }

    // Retain the synchronous read API for persistence clients. Interactive app
    // requests always use asyncSnapshot / calculateSnapshot above.
    func snapshot(rocPeriod: Int, marocPeriod: Int, sinceRevision: Int? = nil) -> [String: Any] {
        let batch = prepareSnapshot(rocPeriod: rocPeriod, marocPeriod: marocPeriod, sinceRevision: sinceRevision)
        let calculated = Dictionary(batch.inputs.filter { batch.cached[$0.id] == nil }.map { ($0.id, $0.calculate(rocPeriod: rocPeriod, marocPeriod: marocPeriod)) }, uniquingKeysWith: { _, last in last })
        return finishSnapshot(batch, calculated: calculated).response
    }
}
