import XCTest
@testable import PerpetualRadar

final class BollingerFilterTests: XCTestCase {
    private let hour = Int64(10_000) * hourMS
    private let fields = ["highUpper", "lowLower", "bodyUpper", "bodyLower"]

    private func market(open: Double? = 100, close: Double = 100) -> FilterMarketData {
        var candles = Dictionary(uniqueKeysWithValues: (0...21).map { age in
            let time = hour - Int64(age) * hourMS, price = age.isMultiple(of: 2) ? 90.0 : 110.0
            return (time, Candle(hour: time, high: price + 1, low: price - 1, close: price, quoteVolume: 100, baseVolume: 1, open: price, confirmed: age != 0))
        })
        candles[hour] = Candle(hour: hour, high: 1_000, low: 0.01, close: close, quoteVolume: 100, baseVolume: 1, open: open, confirmed: false)
        return .init(id: "BTC-USDT-SWAP", hour: hour, now: hour + hourMS / 2, listedAt: 1, candles: candles, stats: [:], quotes: [:])
    }

    private func evaluate(_ source: String, _ market: FilterMarketData) throws -> FilterTruth {
        FilterEvaluator(market: market, filter: try FilterCompiler.compile(source: source)).evaluate().result
    }

    private func band(_ name: String, _ market: FilterMarketData) throws -> Double {
        let filter = try FilterCompiler.compile(source: "available(LogBB(20, 2, \"\(name)\"))")
        let value = FilterEvaluator(market: market, filter: filter).scalar(filter.config.root.children[0].left, at: hour)
        return try XCTUnwrap(value.number)
    }

    func testWicksCompareTheirOwnExtremesAndPreserveStrictEquality() throws {
        var context = market()
        let upper = try band("upper", context), lower = try band("lower", context)
        for (offset, relation) in [(1.0, "above"), (0.0, "equal"), (-1.0, "below")] {
            context.candles[hour] = Candle(hour: hour, high: upper + offset, low: lower + offset, close: 100, quoteVolume: 100, baseVolume: 1, open: 100, confirmed: false)
            XCTAssertEqual(try evaluate("highUpper == \"\(relation)\" AND lowLower == \"\(relation)\"", context), .yes)
        }
        XCTAssertEqual(try evaluate(#"highUpper != "above" AND lowLower == "below" AND priceUpper == "below" AND priceLower == "above""#, context), .yes)
        context = market()
        XCTAssertEqual(try evaluate(#"highUpper == "above" AND lowLower == "below" AND bodyUpper == "below" AND bodyLower == "above""#, context), .yes, "Wicks crossing the bands must not change the body relation.")
    }

    func testBodiesClassifyBothBandsUsingOpenCloseAndTouchingEitherEndpoint() throws {
        for (open, close, expected) in [(180.0, 200.0, "above"), (40.0, 30.0, "below"), (20.0, 200.0, "cross-up"), (200.0, 30.0, "cross-down")] {
            let context = market(open: open, close: close)
            XCTAssertEqual(try evaluate("bodyUpper == \"\(expected)\" AND bodyLower == \"\(expected)\"", context), .yes, "\(open) → \(close)")
        }
        for (field, name) in [("bodyUpper", "upper"), ("bodyLower", "lower")] {
            for close in [30.0, 200.0] {
                let reference = try band(name, market(close: close))
                XCTAssertEqual(try evaluate("\(field) == \"touching\"", market(open: reference, close: close)), .yes, "An open on the band is a touch, not a strict crossing.")
            }
        }
        var flat = market(open: 1, close: 1)
        flat.candles = flat.candles.mapValues { candle in
            Candle(hour: candle.hour, high: 2, low: 0.5, close: 1, quoteVolume: 100, baseVolume: 1, open: 1, confirmed: candle.confirmed)
        }
        for open in [0.5, 1.0, 2.0] {
            flat.candles[hour] = Candle(hour: hour, high: 2, low: 0.5, close: 1, quoteVolume: 100, baseVolume: 1, open: open, confirmed: false)
            XCTAssertEqual(try evaluate(#"bodyUpper == "touching" AND bodyLower == "touching""#, flat), .yes, "A close on the band includes a flat doji.")
        }
    }

    func testClosedRulesUseTheClosedCandleAndItsBandsAndRequestTheirHistory() throws {
        var context = market(open: 900, close: 200)
        context.candles[hour - hourMS] = Candle(hour: hour - hourMS, high: 50, low: 20, close: 30, quoteVolume: 100, baseVolume: 1, open: 40)
        let source = #"bodyUpper == "above" AND bodyLower == "above" AND closed(bodyUpper == "below" AND bodyLower == "below" AND highUpper == "below")"#
        XCTAssertEqual(try evaluate(source, context), .yes)
        for field in fields {
            XCTAssertEqual(try FilterCompiler.compile(source: "available(\(field))").requiredHours, 20, field)
            XCTAssertEqual(try FilterCompiler.compile(source: "closed(available(\(field)))").requiredHours, 21, field)
            XCTAssertEqual(try FilterCompiler.compile(source: "closed(every(available(\(field)), 3))").requiredHours, 24, field)
        }
        // This slot belongs to the closed band's window, but is outside the live band's window.
        context.candles.removeValue(forKey: hour - 20 * hourMS)
        XCTAssertEqual(try evaluate(#"bodyUpper == "above" AND bodyLower == "above""#, context), .yes)
        XCTAssertEqual(try evaluate(source, context), .unknown)
    }

    func testMissingHistoryOrOpenStaysUnknownEvenForNegatedRelations() throws {
        var context = market()
        context.candles.removeValue(forKey: hour - 19 * hourMS)
        for field in fields {
            XCTAssertEqual(try evaluate("\(field) != \"above\"", context), .unknown, field)
            XCTAssertEqual(try evaluate("unavailable(\(field))", context), .yes, field)
        }
        context = market(open: nil)
        XCTAssertEqual(try evaluate("available(highUpper) AND available(lowLower)", context), .yes)
        XCTAssertEqual(try evaluate("unavailable(bodyUpper) AND unavailable(bodyLower)", context), .yes)
        context.candles.removeValue(forKey: hour)
        for field in fields { XCTAssertEqual(try evaluate("unavailable(\(field))", context), .yes, field) }
    }

    func testLiveSnapshotReadingsMatchHistoricalEvaluationAndExposeVisualChoices() throws {
        for (open, close) in [(180.0, 200.0), (40.0, 30.0), (20.0, 200.0), (200.0, 30.0)] {
            let context = market(open: open, close: close)
            let input = MarketSnapshotInput(id: context.id, hour: hour, now: context.now, candles: context.candles, listedAt: context.listedAt)
            let row = input.calculate(rocPeriod: 9, marocPeriod: 9).fields
            let live = input.filterData(row: row)
            for field in fields {
                let expected = try XCTUnwrap(FilterEvaluator(market: context, filter: CompiledFilter(config: FilterConfigV2())).metric(field, at: hour).text)
                XCTAssertEqual(live.current[field]?.text, expected, "\(field): \(open) → \(close)")
                let filter = try FilterCompiler.compile(source: "let relation = \(field); relation == \"\(expected)\"")
                XCTAssertEqual(FilterEvaluator(market: live, filter: filter).evaluate().result, .yes)
                let choices = try XCTUnwrap(filter.editorExpressions["relation"]).choices.map(\.value)
                XCTAssertEqual(choices, FilterCatalog.choices(for: field).map(\.value))
                XCTAssertEqual(choices.count, field.hasPrefix("body") ? 5 : 3)
            }
        }
        var context = market()
        context.candles.removeValue(forKey: hour - 19 * hourMS)
        let input = MarketSnapshotInput(id: context.id, hour: hour, now: context.now, candles: context.candles)
        let live = input.filterData(row: input.calculate(rocPeriod: 9, marocPeriod: 9).fields)
        for field in fields { XCTAssertNotNil(live.current[field]?.reason, field) }
    }
}
