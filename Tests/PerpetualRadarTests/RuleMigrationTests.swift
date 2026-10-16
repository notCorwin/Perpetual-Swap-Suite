import XCTest
@testable import PerpetualRadar

final class RuleMigrationTests: XCTestCase {
    func testMigrationPreservesSpreadBoundaryAndMakesFormerGatesVisible() throws {
        let empty = #"{"version":1,"match":"all","rules":[]}"#
        let config = try FilterConfigV2.migrate(empty, turnover: 10_000_000, spread: 0.15, ageMonths: 6)
        let compiled = try FilterCompiler.compile(config), hour = Int64(10_000) * hourMS
        XCTAssertTrue(compiled.formula.contains("1e-10"))
        let roundedBoundary = try XCTUnwrap(spreadPercent(["bidPx": "99.925", "askPx": "100.075"]))
        for spread in [roundedBoundary, 0.15 + 5e-11, 0.15 + 2e-10, nil] as [Double?] {
            let context = FilterMarketData(id: "BTC-USDT-SWAP", hour: hour, now: hour + 1, listedAt: 1, candles: [:], stats: [:], quotes: [hour: .init(turnover: 10_000_000, spread: spread, timestamp: hour + 1)])
            XCTAssertEqual(FilterEvaluator(market: context, filter: compiled).evaluate().result == .yes, spread.map { $0 <= 0.15 + 1e-10 } ?? false)
        }
        let cleared = try FilterCompiler.compile(FilterConfigV2())
        let missing = FilterMarketData(id: "USDC-USDT-SWAP", hour: hour, now: hour, listedAt: nil, candles: [:], stats: [:], quotes: [:])
        XCTAssertEqual(FilterEvaluator(market: missing, filter: cleared).evaluate().result, .yes)
    }
}
