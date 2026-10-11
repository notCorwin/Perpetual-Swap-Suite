import XCTest
@testable import PerpetualRadar

final class RuleEngineTests: XCTestCase {
    func testEmptyRootIncludesAllMarketsWhileIncompleteNestedGroupsRemainInvalid() throws {
        XCTAssertEqual(try evaluate("all()").result, .yes)
        XCTAssertEqual(try evaluate("any()").result, .yes)
        XCTAssertThrowsError(try FilterCompiler.compile(source: "all(any())"))
        XCTAssertThrowsError(try FilterCompiler.compile(source: "all(NOT all())"))
        XCTAssertEqual(try evaluate("true").result, .yes)
    }
    private let hour = Int64(10_000) * hourMS
    private func market(_ closes: [Double] = [101, 100, 99]) -> FilterMarketData {
        let bars = Dictionary(uniqueKeysWithValues: closes.enumerated().map { age, close in
            let ts = hour - Int64(age) * hourMS
            return (ts, Candle(hour: ts, high: close + 1, low: max(0.1, close - 1), close: close, quoteVolume: 100, baseVolume: 1, open: close, confirmed: age != 0))
        })
        return .init(id: "BTC-USDT-SWAP", hour: hour, now: hour + hourMS / 2, listedAt: 1, candles: bars, stats: [:], quotes: [:])
    }
    private func evaluate(_ source: String, _ context: FilterMarketData? = nil, explain: Bool = false) throws -> FilterTrace {
        FilterEvaluator(market: context ?? market(), filter: try FilterCompiler.compile(source: source)).evaluate(explain: explain)
    }
    private func scalar(_ source: String, _ context: FilterMarketData? = nil) throws -> FilterScalar {
        let filter = try FilterCompiler.compile(source: "available(\(source))")
        let expression = filter.config.root.children[0].left
        return FilterEvaluator(market: context ?? market(), filter: filter).scalar(expression, at: hour)
    }
    private func eventTrace(_ trace: FilterTrace) -> FilterTrace { trace.eventHours.isEmpty ? trace.children.map(eventTrace).first { !$0.eventHours.isEmpty } ?? trace : trace }

    func testKleeneLogicAndExplicitAvailability() throws {
        for (source, expected) in [
            ("NOT (spread > 1)", FilterTruth.unknown), ("spread != 1", .unknown),
            ("spread > 1 OR Close > 100", .yes), ("spread > 1 AND Close < 100", .no),
            ("spread > 1 OR Close < 100", .unknown), ("unavailable(spread)", .yes),
            ("NOT unavailable(spread)", .no), ("available(Close)", .yes), ("all()", .yes), ("any()", .yes), ("true AND Close > 0", .yes), ("NOT true", .no),
        ] { XCTAssertEqual(try evaluate(source).result, expected, source) }
        let trace = try evaluate("available(Close)", explain: true)
        XCTAssertFalse(trace.children[0].reason.contains("not compiled"))
        XCTAssertEqual(FilterTruth.all([.unknown, .no]), .no)
        XCTAssertEqual(FilterTruth.any([.unknown, .yes]), .yes)
    }

    func testGroupedLongShortAndBothOperandExpressions() throws {
        let source = #"(Close > Open AND ROC(1) > 0) OR (Close < Open AND ROC(1) < 0)"#
        var context = market()
        context.candles[hour] = Candle(hour: hour, high: 105, low: 95, close: 101, quoteVolume: 100, baseVolume: 1, open: 99, confirmed: false)
        XCTAssertEqual(try evaluate(source, context).result, .yes)
        XCTAssertEqual(try evaluate("Close + 5 > lag(Close, 1) * 1.05", context).result, .yes)
        XCTAssertEqual(try evaluate("between(Close, lag(Close, 1), High)", context).result, .yes)
        XCTAssertEqual(try evaluate("absGte(ROC(1), 1)", context).result, .yes)
    }

    func testRelativeVolumeExcludesLiveBarFromTwentyClosedHourMean() throws {
        var context = market(Array(repeating: 100, count: 25))
        context.candles[hour] = Candle(hour: hour, high: 101, low: 99, close: 100, quoteVolume: 201, baseVolume: 1, open: 100, confirmed: false)
        let source = "Volume > multiple(mean(lag(Volume, 1), 20), 2)"
        XCTAssertEqual(try evaluate(source, context).result, .yes)
        context.candles.removeValue(forKey: hour - 20 * hourMS)
        XCTAssertEqual(try evaluate(source, context).result, .unknown)
    }

    func testPositiveBaselineMultipleRejectsDegenerateBaselinesWithoutDivision() throws {
        XCTAssertEqual(try scalar("multiple(100, 2)").number, 200)
        XCTAssertEqual(try evaluate("Close > multiple(0, 2)").result, .unknown)
        XCTAssertEqual(try evaluate("Close > multiple(-1, 2)").result, .unknown)
        XCTAssertEqual(try evaluate("Close > multiple(1e308, 2)").result, .unknown)
        XCTAssertThrowsError(try FilterCompiler.compile(source: "Close > multiple(100, 0)"))
        XCTAssertThrowsError(try FilterCompiler.compile(source: "Close > multiple(100, -2)"))
        XCTAssertThrowsError(try FilterCompiler.compile(source: "Close > multiple(100, Close)"))
    }

    func testMathUnitsHistoryOffsetsAndDivisionByZero() throws {
        XCTAssertEqual(try scalar("sum(Close, 3)").number, 300)
        XCTAssertEqual(try scalar("mean(Close, 3)").number, 100)
        XCTAssertEqual(try scalar("highest(Close, 3)").number, 101)
        XCTAssertEqual(try scalar("lowest(Close, 3)").number, 99)
        XCTAssertEqual(try XCTUnwrap(scalar("stddev(Close, 3)").number), sqrt(2.0 / 3), accuracy: 1e-10)
        XCTAssertEqual(try scalar("lag(Close, 2)").number, 99)
        XCTAssertEqual(try scalar("change(Close, 1)").number, 1)
        XCTAssertEqual(try scalar("abs(-2) + 3 * 4 / 2").number, 8)
        XCTAssertEqual(try evaluate("NOT (Close / 0 > 1)").result, .unknown)
        let compiled = try FilterCompiler.compile(source: "let ratio = Volume / mean(Volume, 20); ratio > 2 AND change(Close, 1) > 1")
        XCTAssertEqual(compiled.units["ratio"], "ratio")
        XCTAssertTrue(compiled.units.values.contains("%"))
    }

    func testNativeEditorExpressionsDescribeNestedMathAndInheritedCategoryChoices() throws {
        let compiled = try FilterCompiler.compile(source: #"let trend = closed(oiTrend); let ratio = Volume / mean(lag(Volume, 1), 20); trend == "rising" AND ratio > 2 AND abs(-ROC(9)) > 0"#)
        let ratio = try XCTUnwrap(compiled.editorExpressions["(Volume / mean(lag(Volume, 1), 20))"])
        XCTAssertEqual(ratio.kind, "binary"); XCTAssertEqual(ratio.operation, "/"); XCTAssertEqual(ratio.unit, "ratio")
        XCTAssertEqual(ratio.arguments[1].operation, "mean")
        XCTAssertEqual(ratio.arguments[1].arguments[0].operation, "lag")
        XCTAssertEqual(ratio.arguments[1].arguments[1].value, "20")
        let trend = try XCTUnwrap(compiled.editorExpressions["trend"])
        XCTAssertEqual(trend.unit, "category"); XCTAssertEqual(trend.choices.map(\.value), ["rising", "flat", "falling"])
        let offset = try XCTUnwrap(compiled.editorExpressions["closed(oiTrend)"])
        XCTAssertEqual(offset.choices.map(\.value), trend.choices.map(\.value))
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: compiled.editorExpressions.mapValues(\.snapshot)))
    }

    func testCrossingAllowsEqualityOnlyAtStartAndComparesBothSides() throws {
        XCTAssertEqual(try evaluate("crossUp(Close, Close)", market([101, 100]), explain: true).result, .no)
        XCTAssertEqual(try evaluate("crossDown(Close, Close)", market([101])).result, .unknown)
        for (closes, source, expected) in [
            ([101.0, 100], "crossUp(Close, 100)", FilterTruth.yes),
            ([100, 99], "crossUp(Close, 100)", .no), ([101, 101], "crossUp(Close, 100)", .no),
            ([99, 100], "crossDown(Close, 100)", .yes), ([100, 101], "crossDown(Close, 100)", .no),
            ([101], "crossUp(Close, 100)", .unknown),
        ] { XCTAssertEqual(try evaluate(source, market(closes)).result, expected, source) }
        XCTAssertEqual(try evaluate("crossUp(Close, lag(Close, 1))", market([101, 99, 100])).result, .yes)
    }

    func testClosedRSIThreeHoursAndLiveHourRollover() throws {
        var context = market((0..<260).map { 1000 - Double($0) })
        let source = "closed(every(RSI(14) > 50, 3))"
        XCTAssertEqual(try evaluate(source, context).result, .yes)
        context.candles.removeValue(forKey: hour - 120 * hourMS)
        XCTAssertEqual(try evaluate(source, context).result, .unknown)
        context = market([101, 100, 99])
        XCTAssertEqual(try evaluate("Close > 100 AND closed(Close == 100)", context).result, .yes)
        context.candles[hour] = Candle(hour: hour, high: 102, low: 99, close: 101, quoteVolume: 100, baseVolume: 1, open: 100)
        context.hour += hourMS; context.now += hourMS
        XCTAssertEqual(try evaluate("closed(Close > 100)", context).result, .yes)
        XCTAssertEqual(try evaluate("Close > 100", context).result, .unknown)
    }

    func testCountUsesPossibleCountsInsteadOfTreatingUnknownAsFalse() throws {
        let context = market([101, 100]) // Third hour is missing; exactly one known match.
        for (comparison, minimum, expected) in [("gte", 1, FilterTruth.yes), ("gte", 2, .unknown), ("gte", 3, .no), ("eq", 1, .unknown), ("lte", 2, .yes)] {
            XCTAssertEqual(try evaluate("count(Close > 100, 3, \"\(comparison)\", \(minimum))", context).result, expected)
        }
        XCTAssertEqual(try evaluate("every(Close > 100, 3)", context).result, .no)
        XCTAssertEqual(try evaluate("recent(Close > 100, 3)", context).result, .yes)
        XCTAssertEqual(try evaluate("recent(Close > 200, 3)", context).result, .unknown)
        // Both possible-count endpoints miss the range, but an interior count matches.
        XCTAssertEqual(try evaluate(#"count(Close > 100, 6, "between", 2, 3)"#, context).result, .unknown)
        XCTAssertEqual(try evaluate(#"count(Close > 100, 6, "between", 6, 8)"#, context).result, .no)
    }

    func testMoreThan250HoursAndFixedWindowGaps() throws {
        var context = market(Array(repeating: 100, count: 905))
        let source = "mean(lag(Close, 100), 720) == 100 AND every(Close > 0, 800)"
        let compiled = try FilterCompiler.compile(source: source)
        XCTAssertGreaterThanOrEqual(compiled.requiredHours, 820)
        XCTAssertEqual(FilterEvaluator(market: context, filter: compiled).evaluate().result, .yes)
        context.candles.removeValue(forKey: hour - 650 * hourMS)
        XCTAssertEqual(FilterEvaluator(market: context, filter: compiled).evaluate().result, .unknown)
        XCTAssertEqual(try FilterCompiler.compile(source: "Close > 0").requiredHours, 0)
    }

    func testSequenceCapturesFrozenReferenceAndEndsAtAnchor() throws {
        var context = market(Array(repeating: 100, count: 70))
        context.candles[hour - 4 * hourMS] = Candle(hour: hour - 4 * hourMS, high: 110, low: 100, close: 106, quoteVolume: 100, baseVolume: 1, open: 100)
        context.candles[hour - 2 * hourMS] = Candle(hour: hour - 2 * hourMS, high: 107, low: 100, close: 102, quoteVolume: 100, baseVolume: 1, open: 106)
        context.candles[hour - hourMS] = Candle(hour: hour - hourMS, high: 103, low: 99, close: 101, quoteVolume: 100, baseVolume: 1, open: 102)
        context.candles[hour] = Candle(hour: hour, high: 107, low: 101, close: 106, quoteVolume: 100, baseVolume: 1, open: 101, confirmed: false)
        let source = #"sequence(6, stage("break", High > PriorHigh(48), 6, capture("level", PriorHigh(48))), stage("retest", Low <= break.level, 3), stage("reclaim", crossUp(Close, break.level), 3))"#
        let trace = eventTrace(try evaluate(source, context, explain: true))
        XCTAssertEqual(trace.result, .yes)
        XCTAssertEqual(trace.eventHours.last, hour)
        XCTAssertEqual(trace.eventHours.first, hour - 4 * hourMS)
        XCTAssertEqual(trace.children[0].readings["break.level"]?.number, 101)
        XCTAssertEqual(trace.children.last?.readings["break.level"]?.number, 101)
        XCTAssertTrue(zip(trace.eventHours, trace.eventHours.dropFirst()).allSatisfy(<))
        XCTAssertEqual(try evaluate(source.replacingOccurrences(of: "sequence(6", with: "sequence(2"), context).result, .no)
        context.candles[hour] = Candle(hour: hour, high: 102, low: 99, close: 101, quoteVolume: 100, baseVolume: 1, open: 101, confirmed: false)
        XCTAssertEqual(try evaluate(source, context).result, .no)
    }

    func testPreviousLowAgeMatchesTheMarketReadingAndHistoricalBreakdown() throws {
        let row: [String: Any] = ["lowBreakdown": ["status": "event", "hoursAgo": 2, "priorAgeHours": 17]]
        XCTAssertEqual(LegacyFilterReadings.from(row)["lowPriorAge"]?.number, 17)
        var context = market(Array(repeating: 100, count: 110))
        context.candles[hour - 5 * hourMS] = Candle(hour: hour - 5 * hourMS, high: 101, low: 98, close: 100, quoteVolume: 100, baseVolume: 1, open: 100)
        context.candles[hour] = Candle(hour: hour, high: 101, low: 97, close: 100, quoteVolume: 100, baseVolume: 1, open: 100, confirmed: false)
        XCTAssertEqual(try scalar("lowPriorAge", context).number, 5)
        XCTAssertEqual(try FilterCompiler.compile(source: "lowPriorAge >= 4").requiredHours, 96)
        context.candles.removeValue(forKey: hour - 30 * hourMS)
        XCTAssertEqual(try evaluate("lowPriorAge >= 4", context).result, .unknown)
    }

    func testSequenceExploresEarlierPathsAndDifferentCapturedValues() throws {
        let context = market([105, 100, 102, 110, 100])
        let source = #"sequence(4, stage("start", Close > 100, 4, capture("level", Close)), stage("finish", Close < start.level, 4))"#
        let trace = eventTrace(try evaluate(source, context, explain: true))
        // The latest candidate cannot finish. The earlier 110-level path can.
        XCTAssertEqual(trace.result, .yes)
        XCTAssertEqual(trace.eventHours, [hour - 3 * hourMS, hour])
        XCTAssertEqual(try evaluate(#"sequence(1, stage("a", Close > 100, 1), stage("b", Close > 100, 1))"#, context).result, .no)
        XCTAssertEqual(try evaluate(#"sequence(3, stage("a", unavailable(spread), 3), stage("b", spread > 0, 3))"#, context).result, .unknown)
    }

    func testRecentFindsCompletedSequencesAndClosedFinalStage() throws {
        let context = market([90, 110, 105, 100])
        let source = #"sequence(2, stage("a", Close == 100, 2), stage("b", Close > 100, 2))"#
        XCTAssertEqual(try evaluate(source, context).result, .no)
        XCTAssertEqual(try evaluate("recent(\(source), 3)", context).result, .yes)
        let closed = source.replacingOccurrences(of: "Close > 100", with: "closed(Close > 100)")
        XCTAssertEqual(try evaluate(closed, context).result, .yes)
    }

    func testFormulaRoundTripPreservesNamesIdentityParametersAndCapturedScopes() throws {
        let source = #"let ratio = Volume / mean(lag(Volume, 1), 20); named("My rules", all(named("Volume gate", ratio > 2), closed(every(RSI(14) > 50, 3)), sequence(6, stage("break", High > PriorHigh(48), 6, capture("level", PriorHigh(48))), stage("reclaim", crossUp(Close, break.level), 6))))"#
        let original = try FilterCompiler.compile(source: source)
        XCTAssertEqual(original.units["break.level"], "USDT")
        let roundTrip = try FilterCompiler.compile(source: original.formula, previous: original.config)
        XCTAssertEqual(roundTrip.config.json, original.config.json)
        XCTAssertEqual(roundTrip.formula, original.formula)
        let edited = try FilterCompiler.compile(source: original.formula.replacingOccurrences(of: "ratio > 2", with: "ratio > 3"), previous: original.config)
        XCTAssertEqual(edited.config.root.id, original.config.root.id)
        XCTAssertEqual(edited.config.root.children[0].id, original.config.root.children[0].id)
        XCTAssertEqual(edited.config.definitions[0].id, original.config.definitions[0].id)
        var visual = original.config
        visual.root.children[0].upper = "99"
        visual.root.children[0].hours = 24
        let visualRoundTrip = try FilterCompiler.compile(source: FilterCompiler.compile(visual).formula, previous: visual)
        XCTAssertEqual(visualRoundTrip.config.json, visual.json)
    }

    func testCompilerRejectsInvalidTypesCyclesScopesAndWindows() throws {
        for source in ["", "Close >", "RSI(0) > 1", "RSI(1.5) > 1", "Close > Symbol", "Symbol + 1 > 0", "let a = b; let b = a; a > 0", "every(Close > 0, 0)", "mean(Close, 0) > 0", "unknown > 0", "LogBBUpper(20, 0) > 1", #"sequence(6, stage("a", Close > b.level, 6), stage("b", Close > 0, 6, capture("level", Close)))"#] {
            XCTAssertThrowsError(try FilterCompiler.compile(source: source), source)
        }
    }

    func testClosedQuotesRemainUnknownBeforeUpgradeAndNeverCarryForward() throws {
        var context = market()
        context.quotes[hour - hourMS] = .init(turnover: 20_000_000, spread: 0.1, timestamp: hour - 1)
        XCTAssertEqual(try evaluate("closed(turnover >= 10 AND spread <= 0.15)", context).result, .yes)
        XCTAssertEqual(try evaluate("closed(closed(turnover > 0))", context).result, .unknown)
        XCTAssertEqual(try evaluate("every(spread <= 1, 3)", context).result, .unknown)
        XCTAssertEqual(try evaluate("closed(unavailable(closed(spread)))", context).result, .yes)
    }
}
