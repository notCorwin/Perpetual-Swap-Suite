import XCTest
@testable import PerpetualRadar

final class ContractAgeFilterTests: XCTestCase {
    private func date(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)!
    }

    private func listedAt(_ value: String) -> Int64 {
        Int64((date(value).timeIntervalSince1970 * 1000).rounded())
    }

    func testSixMonthBoundaryIsInclusiveAndUsesTheListingTimeOfDay() {
        let listing = listedAt("2026-04-04T12:34:56.789Z")
        let anniversary = date("2026-10-04T12:34:56.789Z")
        XCTAssertFalse(passesContractAgeFilter(listing, enabled: true, minimumMonths: 6,
                                              now: anniversary.addingTimeInterval(-0.001)))
        XCTAssertTrue(passesContractAgeFilter(listing, enabled: true, minimumMonths: 6, now: anniversary))
        XCTAssertTrue(passesContractAgeFilter(listing - 1, enabled: true, minimumMonths: 6, now: anniversary))
        XCTAssertFalse(passesContractAgeFilter(listing + 1, enabled: true, minimumMonths: 6, now: anniversary))
    }

    func testCalendarMonthsHandleMonthEndsLeapYearsAndYearRollover() {
        for (listing, months, anniversary) in [
            ("2023-08-31T08:30:00.000Z", 6, "2024-02-29T08:30:00.000Z"),
            ("2024-08-31T08:30:00.000Z", 6, "2025-02-28T08:30:00.000Z"),
            ("2024-02-29T08:30:00.000Z", 12, "2025-02-28T08:30:00.000Z"),
            ("2026-01-31T08:30:00.000Z", 1, "2026-02-28T08:30:00.000Z"),
            ("2025-12-04T08:30:00.000Z", 6, "2026-06-04T08:30:00.000Z"),
        ] {
            let boundary = date(anniversary)
            XCTAssertFalse(passesContractAgeFilter(listedAt(listing), enabled: true, minimumMonths: months,
                                                  now: boundary.addingTimeInterval(-0.001)), listing)
            XCTAssertTrue(passesContractAgeFilter(listedAt(listing), enabled: true, minimumMonths: months,
                                                 now: boundary), listing)
        }
    }

    func testMonthsAreNotApproximatedAs180Days() {
        let now = date("2026-10-04T00:00:00.000Z")
        let listing180DaysAgo = Int64(now.addingTimeInterval(-180 * 24 * 60 * 60).timeIntervalSince1970 * 1000)
        XCTAssertFalse(passesContractAgeFilter(listing180DaysAgo, enabled: true, minimumMonths: 6, now: now))
        XCTAssertTrue(passesContractAgeFilter(listedAt("2026-04-04T00:00:00.000Z"), enabled: true,
                                             minimumMonths: 6, now: now))
    }

    func testDisabledFilterIncludesNewAndUnknownListings() {
        let now = date("2026-10-04T00:00:00.000Z")
        let young = listedAt("2026-09-04T00:00:00.000Z")
        for listing in [nil, 0, -1, young, young + 100 * 24 * hourMS] as [Int64?] {
            XCTAssertFalse(passesContractAgeFilter(listing, enabled: true, minimumMonths: 6, now: now))
            XCTAssertTrue(passesContractAgeFilter(listing, enabled: false, minimumMonths: 6, now: now))
        }
        XCTAssertTrue(passesContractAgeFilter(young, enabled: true, minimumMonths: 1, now: now))
        XCTAssertFalse(passesContractAgeFilter(young, enabled: true, minimumMonths: 2, now: now))
    }

}
