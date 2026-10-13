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

}
