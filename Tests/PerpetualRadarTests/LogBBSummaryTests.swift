import XCTest
@testable import PerpetualRadar

final class LogBBSummaryTests: XCTestCase {
    private func bars(_ prices: [Double], live: Bool = false) -> [Int64: Candle] {
        Dictionary(uniqueKeysWithValues: prices.enumerated().map { index, price in
            let time = Int64(index) * hourMS
            let confirmed = live && index == prices.count - 1 ? "0" : "1"
            return (time, Candle([String(time), String(price), String(price), String(price), String(price), "1", "1", "100", confirmed])!)
        })
    }

    func testLivePriceShowsOnlyTheHighestBandStrictlyBelowIt() {
        XCTAssertEqual(logBBAboveBand(121, 120, 100, 80), .upper)
        XCTAssertEqual(logBBAboveBand(120, 120, 100, 80), .middle)
        XCTAssertEqual(logBBAboveBand(101, 120, 100, 80), .middle)
        XCTAssertEqual(logBBAboveBand(100, 120, 100, 80), .lower)
        XCTAssertEqual(logBBAboveBand(81, 120, 100, 80), .lower)
        XCTAssertEqual(logBBAboveBand(80, 120, 100, 80), .below)
        XCTAssertEqual(logBBAboveBand(79, 120, 100, 80), .below)
        XCTAssertEqual(logBBAboveBand(100, 100, 100, 100), .below)
        XCTAssertEqual(logBBAboveBand(101, 100, 100, 100), .upper)
        XCTAssertNil(logBBAboveBand(nil, 120, 100, 80))
        XCTAssertNil(logBBAboveBand(100, nil, 100, 80))
        XCTAssertNil(logBBAboveBand(100, 120, nil, 80))
        XCTAssertNil(logBBAboveBand(100, 120, 100, nil))
        XCTAssertNil(logBBAboveBand(.nan, 120, 100, 80))
        XCTAssertNil(logBBAboveBand(100, .infinity, 100, 80))
        XCTAssertNil(logBBAboveBand(100, 80, 100, 120))
    }

    func testExpansionCountsConsecutiveHoursAndResetsOnFlatOrShrinkingWidth() throws {
        let prices = Array(repeating: 100.0, count: 21) + [110, 120, 130]
        let series = bars(prices)
        XCTAssertEqual(logBBExpansion(series, 20 * hourMS), BandWidthExpansion(hours: 0, complete: true))
        for hours in 1...3 {
            XCTAssertEqual(logBBExpansion(series, Int64(20 + hours) * hourMS), BandWidthExpansion(hours: hours, complete: true))
        }
        // Replacing an older 100 with another 100 leaves the rolling window equal.
        XCTAssertEqual(logBBExpansion(bars(prices + [100]), 24 * hourMS), BandWidthExpansion(hours: 0, complete: true))
        let shrinking = bars(prices + [103])
        let prior = logBB(shrinking, 23 * hourMS), current = logBB(shrinking, 24 * hourMS)
        XCTAssertLessThan(try XCTUnwrap(logBBBandWidth(current.0, current.1, current.2)), try XCTUnwrap(logBBBandWidth(prior.0, prior.1, prior.2)))
        XCTAssertEqual(logBBExpansion(shrinking, 24 * hourMS), BandWidthExpansion(hours: 0, complete: true))
    }

    func testLiveHourCanExtendOrResetTheRunButPriorHoursMustBeConfirmed() throws {
        let prices = Array(repeating: 100.0, count: 21) + [110, 120, 130]
        var series = bars(prices, live: true)
        XCTAssertEqual(logBBExpansion(series, 23 * hourMS), BandWidthExpansion(hours: 3, complete: true))
        series[23 * hourMS] = bars(Array(prices.dropLast()) + [100], live: true)[23 * hourMS]
        XCTAssertEqual(logBBExpansion(series, 23 * hourMS), BandWidthExpansion(hours: 0, complete: true))
        let previousHour = 22 * hourMS
        series = bars(prices, live: true)
        series[previousHour] = try XCTUnwrap(Candle([String(previousHour), "120", "120", "120", "120", "1", "1", "100", "0"]))
        XCTAssertNil(logBBExpansion(series, 23 * hourMS))
    }

    func testMissingHistoryDoesNotInventZeroOrAnExactDuration() {
        XCTAssertNil(logBBExpansion(bars(Array(repeating: 100.0, count: 19)), 18 * hourMS))
        XCTAssertNil(logBBExpansion(bars(Array(repeating: 100.0, count: 20)), 19 * hourMS))
        var series = bars(Array(repeating: 100.0, count: 61) + [110, 120, 130])
        series.removeValue(forKey: 40 * hourMS)
        XCTAssertEqual(logBBExpansion(series, 63 * hourMS), BandWidthExpansion(hours: 3, complete: false))
        series.removeValue(forKey: 60 * hourMS)
        XCTAssertNil(logBBExpansion(series, 63 * hourMS))
    }

    func testListingBoundaryMakesTheFirstValidBandAndLongRunsExact() {
        XCTAssertEqual(logBBExpansion(bars(Array(repeating: 100.0, count: 20)), 19 * hourMS, listedAt: hourMS / 2), BandWidthExpansion(hours: 0, complete: true))
        let prices = (0..<600).map { exp(0.00001 * pow(Double($0), 2)) }
        let series = bars(prices)
        XCTAssertEqual(logBBExpansion(series, 599 * hourMS, listedAt: 0), BandWidthExpansion(hours: 580, complete: true))
        XCTAssertEqual(logBBExpansion(series, 599 * hourMS), BandWidthExpansion(hours: 580, complete: false))
        let snapshot = logBBExpansion(series, 599 * hourMS, listedAt: 0)!.snapshot
        XCTAssertEqual(snapshot["hours"] as? Int, 580)
        XCTAssertEqual(snapshot["complete"] as? Bool, true)
    }

    func testExpansionIsIndependentOfPriceScaleAndFlatWindowRounding() {
        let prices = Array(repeating: 100.0, count: 21) + [110, 120, 130]
        for scale in [0.000001, 1.0, 1_000_000.0] {
            XCTAssertEqual(logBBExpansion(bars(prices.map { $0 * scale }), 23 * hourMS), BandWidthExpansion(hours: 3, complete: true))
            let alternating = (0..<40).map { ($0.isMultiple(of: 2) ? 100.0 : 130.0) * scale }
            XCTAssertEqual(logBBExpansion(bars(alternating), 39 * hourMS), BandWidthExpansion(hours: 0, complete: true))
        }
    }
}
