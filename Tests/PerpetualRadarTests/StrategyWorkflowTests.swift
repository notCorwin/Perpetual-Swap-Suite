import XCTest
@testable import PerpetualRadar

final class StrategyWorkflowTests: XCTestCase {
    func testHistoricalChartLoadsOneReusableFiveHundredHourBuffer() {
        let end = Int64(2_000) * hourMS
        XCTAssertEqual(historicalChartBufferHours, 500)
        XCTAssertEqual(historicalChartBufferStart(end), end - 499 * hourMS)
        XCTAssertEqual(historicalChartBufferStart(100 * hourMS), 0)
    }
    private let hour = Int64(20_000) * hourMS
    private func rule(_ source: String) throws -> String { try FilterCompiler.compile(source: source).config.json }
    private func profile(universe: String = "Close > 0", setup: String = "Close > 100") throws -> StrategyProfile {
        .init(name: "Strategy version", universeJSON: try rule(universe), phaseRules: [
            "bullishSetup": try rule(setup)], revision: 3)
    }
    private func market(_ price: Double) -> FilterMarketData {
        let bars = Dictionary(uniqueKeysWithValues: (0...3).map { age in
            let time = hour - Int64(age) * hourMS
            return (time, Candle(hour: time, high: price, low: price, close: price, quoteVolume: 100, baseVolume: 1, open: price))
        })
        return .init(id: "BTC-USDT-SWAP", hour: hour, now: hour + hourMS, listedAt: 1, candles: bars, stats: [:], quotes: [:], historicalClose: true)
    }
    private func truth(_ json: String, market: FilterMarketData) throws -> FilterTruth {
        FilterEvaluator(market: market, filter: try FilterCompiler.compile(FilterConfigV2.decode(json))).evaluate().result
    }

    @MainActor
    func testRadarHasNoStandaloneRulesAndIgnoresOldFilterPreferences() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("StrategyWorkflow-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try Store(url: directory.appendingPathComponent("radar.sqlite3"))
        for key in ["marketFiltersJSON", "marketFiltersV2JSON", "selectedMarketFilterCombinationID"] {
            try store.setPreference("invalid former filter", forKey: key)
        }
        try store.setPreference("false", forKey: "filterNotificationsEnabled")
        let radar = try Radar(storeURL: store.url), snapshot = radar.snapshot(rocPeriod: 9, marocPeriod: 9)
        XCTAssertEqual(try radar.monitoringStrategy()?.id, defaultStrategyID)
        XCTAssertFalse(radar.notificationsEnabled, "Renaming notifications preserves the user's disabled setting.")
        try radar.setNotificationsEnabled(true)
        XCTAssertTrue(try Radar(storeURL: store.url).notificationsEnabled)
        for key in ["marketFiltersJSON", "filterConfigJSON", "marketFilterCombinations", "selectedMarketFilterCombinationID", "minimum24hTurnoverUSDT", "spreadFilterEnabled", "contractAgeFilterEnabled"] {
            XCTAssertNil(snapshot[key], key)
        }
        XCTAssertNotNil(snapshot["filterMetricsCatalog"], "Strategies retain the complete condition library.")
    }

    func testSignalStudiesGateUniverseAndIsolateReusableValuesWithTheSameNames() throws {
        let profile = try profile(universe: "let level = 100; let gate = level + 0; closed(Close > gate)", setup: "let level = 200; let gate = level + 0; Close < gate")
        var spec = StudySpec(name: "Strategy signals", rules: [], through: hour)
        spec.strategySnapshots = [profile]; spec.strategyPhase = "bullishSetup"
        let resolved = try spec.resolvingStrategyRules()
        try resolved.validate()
        XCTAssertEqual(resolved.strategySnapshots?.first?.revision, 3)
        XCTAssertEqual(resolved.direction, "Long")
        XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: market(150)), .yes)
        XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: market(50)), .no)
        XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: market(250)), .no)
        XCTAssertEqual(try spec.resolvingStrategyRules().rules[0].filtersJSON, resolved.rules[0].filtersJSON, "Projected conditions have stable identities for reproducible studies.")
    }

    func testSignalStudiesAllowUnrestrictedUniverse() throws {
        for kind in ["all", "any"] {
            var profile = try profile()
            profile.universeJSON = FilterConfigV2(root: FilterNode(kind: kind)).json
            var spec = StudySpec(name: "Unrestricted strategy signals", rules: [], through: hour)
            spec.strategySnapshots = [profile]; spec.strategyPhase = "bullishSetup"
            let resolved = try spec.resolvingStrategyRules()
            try resolved.validate()
            XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: market(150)), .yes)
            XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: market(50)), .no)
        }
    }

    func testResearchOmitsSpreadFromFrozenStrategiesAndPreservesRadarRules() throws {
        let original = try profile(universe: "turnover > 0 AND spread <= 0.15", setup: "Close > 100 AND btc(spread) <= 0.15")
        var spec = StudySpec(name: "Without spread", rules: [], through: hour)
        spec.strategySnapshots = [original]
        let resolved = try spec.resolvingStrategyRules()
        XCTAssertEqual(resolved.strategySnapshots?.first?.universeJSON, original.universeJSON)
        XCTAssertEqual(resolved.strategySnapshots?.first?.phaseRules, original.phaseRules)
        let compiled = try FilterCompiler.compile(FilterConfigV2.decode(resolved.rules[0].filtersJSON))
        XCTAssertFalse(compiled.metrics.contains("spread")); XCTAssertFalse(compiled.referencesBTC)
        var context = market(150)
        context.quotes[hour] = .init(turnover: 20_000_000, spread: 50, timestamp: hour + hourMS - 1)
        XCTAssertEqual(try truth(original.universeJSON, market: context), .no, "Radar still applies the saved spread restriction.")
        XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: context), .yes)
        context = market(50)
        context.quotes[hour] = .init(turnover: 20_000_000, spread: 50, timestamp: hour + hourMS - 1)
        XCTAssertEqual(try truth(resolved.rules[0].filtersJSON, market: context), .no, "Research still applies non-spread conditions.")
        XCTAssertEqual(resolved.excludedSpreadConditions?.count, 2)
        XCTAssertEqual(try spec.resolvingStrategyRules().rules[0].filtersJSON, resolved.rules[0].filtersJSON)
    }

    func testScoreAndComparisonRulesComeFromFrozenStrategies() throws {
        let first = try profile(universe: "Close > 100"), second = try profile(universe: "Close > 200")
        var spec = StudySpec(name: "Opportunity", kind: "score", rules: [], through: hour)
        spec.strategySnapshots = [try profile(universe: "Close > 100", setup: "Close > 200")]
        let scored = try spec.resolvingStrategyRules()
        XCTAssertEqual(scored.direction, "Long"); XCTAssertEqual(scored.sampling, "hourly")
        XCTAssertEqual(try truth(scored.rules[0].filtersJSON, market: market(150)), .no)
        XCTAssertEqual(try truth(scored.rules[0].filtersJSON, market: market(250)), .yes)
        spec.kind = "comparison"; spec.strategySnapshots = [first, second]; spec.strategyPhase = "bullishSetup"
        let comparison = try spec.resolvingStrategyRules()
        try comparison.validate()
        XCTAssertEqual(try truth(comparison.rules[0].filtersJSON, market: market(150)), .yes)
        XCTAssertEqual(try truth(comparison.rules[1].filtersJSON, market: market(150)), .no)
        spec.strategyPhase = "bearishReversal"
        XCTAssertThrowsError(try spec.resolvingStrategyRules())
        spec.strategyPhase = "bullishSetup"; spec.strategySnapshots = []; XCTAssertThrowsError(try spec.resolvingStrategyRules())
        spec.strategySnapshots = [first, second]; spec.kind = "cycle"
        XCTAssertThrowsError(try spec.resolvingStrategyRules(), "Only Bullish Setup is supported.")
    }

    func testChartBuySignalsUseOnlyCompletedInformationAndMarkEpisodeEntries() throws {
        let start = hour - 5 * hourMS
        var bars: [Int64: Candle] = [:]
        for (index, close) in [90.0, 95, 110, 120, 80, 130].enumerated() {
            let timestamp = start + Int64(index) * hourMS
            bars[timestamp] = Candle(hour: timestamp, high: close + 1, low: close - 1, close: close, quoteVolume: 100, baseVolume: 1, open: close)
        }
        let strategy = try profile(universe: "Close > 0", setup: "Close > 100")
        var context = FilterMarketData(id: "ETH-USDT-SWAP", hour: hour, now: hour + hourMS, listedAt: 1,
            candles: bars, stats: [:], quotes: [:], historicalClose: true)
        XCTAssertEqual(try strategyChartSignals(profile: strategy, market: context, from: start, through: hour).map(\.hour),
                       [start + 2 * hourMS, start + 5 * hourMS])

        // A later candle is available in memory but cannot alter an earlier decision.
        context.candles[hour] = Candle(hour: hour, high: 1_001, low: 999, close: 1_000, quoteVolume: 100, baseVolume: 1, open: 1_000)
        XCTAssertEqual(try strategyChartSignals(profile: strategy, market: context, from: start, through: start + 3 * hourMS).map(\.hour),
                       [start + 2 * hourMS])

        context.candles[start + 5 * hourMS] = Candle(hour: start + 5 * hourMS, high: 131, low: 129, close: 130,
            quoteVolume: 100, baseVolume: 1, open: 130, confirmed: false)
        XCTAssertEqual(try strategyChartSignals(profile: strategy, market: context, from: start, through: hour).map(\.hour),
                       [start + 2 * hourMS], "The forming candle must never become a historical BUY marker.")
    }

    func testRadarChartBacktestEvaluatesEveryVisibleCompletedCandle() {
        let start = radarStrategyReplayStart(chartEnd: hour)
        XCTAssertEqual(start, hour - 95 * hourMS)
        XCTAssertEqual((hour - hourMS - start) / hourMS + 1, 95, "The live chart's forming candle is monitored, not historically replayed.")
    }

    func testRadarChartBacktestProvidesRuleWarmupWithoutFutureData() throws {
        let start = hour - 1_100 * hourMS
        let bars = Dictionary(uniqueKeysWithValues: (0...1_100).map { index in
            let timestamp = start + Int64(index) * hourMS
            let close = 10 + Double(index) / 100
            return (timestamp, Candle(hour: timestamp, high: close + 1, low: close - 1, close: close, quoteVolume: 100, baseVolume: 1, open: close))
        })
        let market = FilterMarketData(id: "ETH-USDT-SWAP", hour: hour, now: hour + hourMS, listedAt: 1,
            candles: bars, stats: [:], quotes: [:], historicalClose: true)
        let strategy = try profile(universe: "Close > 0", setup: "Close > EMA(200) AND RSI(24) >= 0 AND High > PriorExtreme(48, \"high\")")
        let report = try strategyChartReplay(profile: strategy, market: market, from: hour, through: hour)
        XCTAssertGreaterThanOrEqual(report.historyHours, 1_000)
        XCTAssertEqual(report.matchedHours, 1)
        XCTAssertEqual(report.unknownHours, 0, "EMA200, RSI24 and PriorExtreme(48) must receive their required historical warm-up.")
        XCTAssertEqual(report.readings, [.init(hour: hour, result: FilterTruth.yes.rawValue, completed: true)])
    }

    func testRadarChartBacktestSeedsTheVisibleBoundaryBeforeEmittingBuy() throws {
        let prior = hour - hourMS
        let bars = [
            prior: Candle(hour: prior, high: 91, low: 89, close: 90, quoteVolume: 100, baseVolume: 1, open: 90),
            hour: Candle(hour: hour, high: 111, low: 109, close: 110, quoteVolume: 100, baseVolume: 1, open: 110),
        ]
        let market = FilterMarketData(id: "ETH-USDT-SWAP", hour: hour, now: hour + hourMS, listedAt: 1,
            candles: bars, stats: [:], quotes: [:], historicalClose: true)
        let report = try strategyChartReplay(profile: profile(), market: market, from: hour, through: hour)
        XCTAssertEqual(report.signals.map(\.hour), [hour], "A transition on the first visible candle must not be lost at the chart boundary.")
        XCTAssertEqual(report.readings.count, 1)
    }

    func testChartReplayReconstructsPastTurnoverWithoutInventingSpread() throws {
        let start = hour - 25 * hourMS
        let bars = Dictionary(uniqueKeysWithValues: (0...25).map { index in
            let timestamp = start + Int64(index) * hourMS
            return (timestamp, Candle(hour: timestamp, high: 11, low: 9, close: 10, quoteVolume: 20, baseVolume: 2, open: 10))
        })
        let market = FilterMarketData(id: "ETH-USDT-SWAP", hour: hour, now: hour + hourMS, listedAt: 1,
            candles: bars, stats: [:], quotes: [:], historicalClose: true)
        let reconstructed = try profile(universe: "turnover > 0", setup: "Close > 0")
        let report = try strategyChartReplay(profile: reconstructed, market: market, from: start, through: hour)
        XCTAssertGreaterThan(report.matchedHours, 0)
        XCTAssertGreaterThan(report.unknownHours, 0, "The first 23 hours cannot have a future-filled 24h turnover window.")

        let exactSpread = try profile(universe: "spread < 0.15", setup: "Close > 0")
        let spreadReport = try strategyChartReplay(profile: exactSpread, market: market, from: start, through: hour)
        XCTAssertEqual(spreadReport.matchedHours, 0)
        XCTAssertEqual(spreadReport.unknownHours, 26, "Historical replay must not synthesize unavailable spread snapshots.")
    }
}
