import XCTest
@testable import PerpetualRadar

final class BreakoutTests: XCTestCase {
    private let hour = Int64(500) * hourMS

    private func candle(_ age: Int, high: Double = 200, low: Double = 90, close: Double = 100, confirmed: Bool = true) -> Candle {
        Candle([String(hour - Int64(age) * hourMS), "100", String(high), String(low), String(close), "1", "1", "100", confirmed ? "1" : "0"])!
    }

    private func history() -> [Int64: Candle] {
        Dictionary(uniqueKeysWithValues: (0...95).map { age in
            let bar = candle(age)
            return (bar.hour, bar)
        })
    }

    private func event(_ result: BreakResult, file: StaticString = #filePath, line: UInt = #line) throws -> BreakEvent {
        let value: BreakEvent?
        if case .event(let found) = result { value = found } else { value = nil }
        return try XCTUnwrap(value, file: file, line: line)
    }

    func testLatestHighAndLowBreaksUseTheirOwnPriorExtremeAge() throws {
        var bars = history()
        bars[candle(40).hour] = candle(40, high: 220)
        bars[candle(14).hour] = candle(14, low: 80)
        bars[candle(3).hour] = candle(3, high: 225)
        bars[candle(2).hour] = candle(2, low: 75)
        let result = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(result.highBreakout), BreakEvent(hour: hour - 3 * hourMS, hoursAgo: 3,
                                                                priorHour: hour - 40 * hourMS, priorAgeHours: 37, priorPrice: 220, live: false))
        XCTAssertEqual(try event(result.lowBreakdown), BreakEvent(hour: hour - 2 * hourMS, hoursAgo: 2,
                                                                priorHour: hour - 14 * hourMS, priorAgeHours: 12, priorPrice: 80, live: false))
    }

    func testEqualHighsAndLowsAreNotBreaksButStrictExceedanceIs() throws {
        var bars = history()
        let equal = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(equal.highBreakout, .none)
        XCTAssertEqual(equal.lowBreakdown, .none)
        bars[hour] = candle(0, high: Double(200).nextUp, low: Double(90).nextDown)
        let strict = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(strict.highBreakout).hoursAgo, 0)
        XCTAssertEqual(try event(strict.lowBreakdown).hoursAgo, 0)
    }

    func testReferenceWindowIncludes48thHourAndExcludesCurrentAnd49thHour() throws {
        var bars = history()
        bars[hour] = candle(0, high: 201, low: 89)
        bars[candle(48).hour] = candle(48, high: 250, low: 70)
        bars[candle(49).hour] = candle(49, high: 1_000, low: 1)
        let belowOldest = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(belowOldest.highBreakout, .none)
        XCTAssertEqual(belowOldest.lowBreakdown, .none)
        bars[hour] = candle(0, high: 251, low: 69)
        let result = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(result.highBreakout).priorAgeHours, 48)
        XCTAssertEqual(try event(result.highBreakout).priorPrice, 250)
        XCTAssertEqual(try event(result.lowBreakdown).priorAgeHours, 48)
        XCTAssertEqual(try event(result.lowBreakdown).priorPrice, 70)
    }

    func testNewestQualifyingCandleSupersedesEarlierBreaks() throws {
        var bars = history()
        bars[candle(10).hour] = candle(10, high: 220, low: 80)
        bars[candle(3).hour] = candle(3, high: 225)
        bars[candle(2).hour] = candle(2, low: 75)
        let result = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(result.highBreakout).hoursAgo, 3)
        XCTAssertEqual(try event(result.highBreakout).priorAgeHours, 7)
        XCTAssertEqual(try event(result.lowBreakdown).hoursAgo, 2)
        XCTAssertEqual(try event(result.lowBreakdown).priorAgeHours, 8)
    }

    func testTiedPriorExtremesUseTheMostRecentOccurrence() throws {
        var bars = history()
        for age in [40, 8] { bars[candle(age).hour] = candle(age, high: 220) }
        for age in [30, 7] { bars[candle(age).hour] = candle(age, low: 80) }
        bars[candle(3).hour] = candle(3, high: 225)
        bars[candle(2).hour] = candle(2, low: 75)
        let result = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(result.highBreakout).priorHour, hour - 8 * hourMS)
        XCTAssertEqual(try event(result.highBreakout).priorAgeHours, 5)
        XCTAssertEqual(try event(result.lowBreakdown).priorHour, hour - 7 * hourMS)
        XCTAssertEqual(try event(result.lowBreakdown).priorAgeHours, 5)
    }

    func testLiveWicksPersistAfterPriceRetreatAndBecomeCompletedNextHour() throws {
        var bars = history()
        bars[hour] = candle(0, high: 220, low: 80, close: 190, confirmed: false)
        let first = recentExtremesBreaks(bars, hour)
        XCTAssertTrue(try event(first.highBreakout).live)
        XCTAssertTrue(try event(first.lowBreakdown).live)
        XCTAssertEqual(try event(first.highBreakout).hoursAgo, 0)
        bars[hour] = candle(0, high: 220, low: 80, close: 100, confirmed: false)
        let retreated = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(retreated.highBreakout, first.highBreakout)
        XCTAssertEqual(retreated.lowBreakdown, first.lowBreakdown)

        bars[hour] = candle(0, high: 220, low: 80)
        bars[hour + hourMS] = candle(-1, confirmed: false)
        let next = recentExtremesBreaks(bars, hour + hourMS)
        let nextHigh = try event(next.highBreakout), nextLow = try event(next.lowBreakdown)
        XCTAssertEqual(nextHigh.hoursAgo, 1)
        XCTAssertEqual(nextLow.hoursAgo, 1)
        XCTAssertEqual(nextHigh.priorAgeHours, 1)
        XCTAssertEqual(nextLow.priorAgeHours, 1)
        XCTAssertFalse(nextHigh.live)
        XCTAssertFalse(nextLow.live)
    }

    func testSearchIncludes47HoursAgoAndExpiresAt48HoursAgo() throws {
        var bars = history()
        bars[candle(95).hour] = candle(95, high: 210, low: 85)
        bars[candle(47).hour] = candle(47, high: 220, low: 80)
        let oldest = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(oldest.highBreakout).hoursAgo, 47)
        XCTAssertEqual(try event(oldest.highBreakout).priorAgeHours, 48)
        XCTAssertEqual(try event(oldest.lowBreakdown).hoursAgo, 47)
        bars[hour + hourMS] = candle(-1)
        let expired = recentExtremesBreaks(bars, hour + hourMS)
        XCTAssertEqual(expired.highBreakout, .none)
        XCTAssertEqual(expired.lowBreakdown, .none)
    }

    func testMissingAndUnconfirmedHistoryCannotBeSkippedToReportAnOlderEvent() {
        var complete = history()
        complete[candle(3).hour] = candle(3, high: 220, low: 80)
        for age in [0, 2, 48] {
            var bars = complete
            bars.removeValue(forKey: candle(age).hour)
            let result = recentExtremesBreaks(bars, hour)
            XCTAssertEqual(result.highBreakout, .loading)
            XCTAssertEqual(result.lowBreakdown, .loading)
        }
        complete[candle(2).hour] = candle(2, confirmed: false)
        let unconfirmed = recentExtremesBreaks(complete, hour)
        XCTAssertEqual(unconfirmed.highBreakout, .loading)
        XCTAssertEqual(unconfirmed.lowBreakdown, .loading)
    }

    func testOlderMissingHistoryDoesNotInvalidateAnAlreadyKnownDirection() throws {
        var bars = history()
        bars[hour] = candle(0, high: 220)
        bars.removeValue(forKey: candle(75).hour)
        let result = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(try event(result.highBreakout).hoursAgo, 0)
        XCTAssertEqual(result.lowBreakdown, .loading)
        bars[hour] = candle(0, low: 80)
        let reverse = recentExtremesBreaks(bars, hour)
        XCTAssertEqual(reverse.highBreakout, .loading)
        XCTAssertEqual(try event(reverse.lowBreakdown).hoursAgo, 0)
    }

    func testNewListingsRequire48CompletedCandlesWithoutShrinkingTheWindow() throws {
        var bars = history()
        bars[hour] = candle(0, high: 220, low: 80, confirmed: false)
        for listedAt in [hour - 47 * hourMS, hour, hour + hourMS] {
            let result = recentExtremesBreaks(bars, hour, listedAt: listedAt)
            XCTAssertEqual(result.highBreakout, .insufficientHistory)
            XCTAssertEqual(result.lowBreakdown, .insufficientHistory)
        }
        for listedAt in [hour - 48 * hourMS, hour - 48 * hourMS + hourMS / 2] {
            let eligible = bars.filter { $0.key >= hour - 48 * hourMS }
            let result = recentExtremesBreaks(eligible, hour, listedAt: listedAt)
            XCTAssertEqual(try event(result.highBreakout).hoursAgo, 0)
            XCTAssertEqual(try event(result.lowBreakdown).hoursAgo, 0)
        }
    }

    func testSearchStopsAtTheFirstEligibleCandleOfANewListing() throws {
        let listedAt = hour - 52 * hourMS
        var bars = history().filter { $0.key >= listedAt }
        let empty = recentExtremesBreaks(bars, hour, listedAt: listedAt)
        XCTAssertEqual(empty.highBreakout, .none)
        XCTAssertEqual(empty.lowBreakdown, .none)
        bars[candle(52).hour] = candle(52, high: 210, low: 85)
        bars[candle(4).hour] = candle(4, high: 220, low: 80)
        let result = recentExtremesBreaks(bars, hour, listedAt: listedAt)
        XCTAssertEqual(try event(result.highBreakout).hoursAgo, 4)
        XCTAssertEqual(try event(result.lowBreakdown).priorAgeHours, 48)
    }

    func testSnapshotSerializesEventsAndEveryMissingState() throws {
        let result = BreakResult.event(BreakEvent(hour: hour, hoursAgo: 0, priorHour: hour - 37 * hourMS,
                                                 priorAgeHours: 37, priorPrice: 0.5769, live: true))
        let data = try JSONSerialization.data(withJSONObject: result.snapshot)
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(decoded["status"] as? String, "event")
        XCTAssertEqual(decoded["hour"] as? Int64, hour)
        XCTAssertEqual(decoded["hoursAgo"] as? Int, 0)
        XCTAssertEqual(decoded["priorHour"] as? Int64, hour - 37 * hourMS)
        XCTAssertEqual(decoded["priorAgeHours"] as? Int, 37)
        XCTAssertEqual(decoded["priorPrice"] as? Double, 0.5769)
        XCTAssertEqual(decoded["live"] as? Bool, true)
        for (result, status) in [(BreakResult.none, "none"), (.insufficientHistory, "insufficient-history"), (.loading, "loading")] {
            let data = try JSONSerialization.data(withJSONObject: result.snapshot)
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
            XCTAssertEqual(decoded, ["status": status])
        }
    }
}
