import Foundation

let defaultMinimumContractAgeMonths = 6
let contractAgeMonthRange = 1...1200

func passesContractAgeFilter(_ listedAt: Int64?, enabled: Bool, minimumMonths: Int, now: Date = Date()) -> Bool {
    guard enabled else { return true }
    guard contractAgeMonthRange.contains(minimumMonths), let listedAt, listedAt > 0 else { return false }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let listing = Date(timeIntervalSince1970: Double(listedAt) / 1000)
    // Count calendar months from the listing date, including short months and leap years.
    guard let eligibleAt = calendar.date(byAdding: .month, value: minimumMonths, to: listing) else { return false }
    return eligibleAt <= now
}
