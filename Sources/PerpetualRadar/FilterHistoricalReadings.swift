import Foundation

// Owned by one calculation worker and discarded when its immutable input
// window changes. It is never shared between simultaneously executing workers.
final class FilterHistoricalReadings: @unchecked Sendable {
    private var values: [String: FilterScalar] = [:]
    private var events: [String: (highBreakout: BreakResult, lowBreakdown: BreakResult)] = [:]
    private var timestamps: [Int64: String] = [:]
    private let formatter = ISO8601DateFormatter()
    private struct RangeKey: Hashable { var hour: Int64; var hours: Int }
    struct Extremes {
        var high = -Double.infinity, low = Double.infinity
        var highHour: Int64, lowHour: Int64
        var complete = true
    }
    private var ranges: [RangeKey: Extremes] = [:]

    func prior(_ bars: [Int64: Candle], _ hour: Int64, hours: Int) -> Extremes {
        let key = RangeKey(hour: hour, hours: hours)
        if let saved = ranges[key] { return saved }
        var result = Extremes(highHour: hour, lowHour: hour)
        for offset in 1...hours {
            let priorHour = hour-Int64(offset)*hourMS
            guard let bar = bars[priorHour], bar.confirmed else { result.complete = false; break }
            if bar.high > result.high { result.high = bar.high; result.highHour = priorHour }
            if bar.low < result.low { result.low = bar.low; result.lowHour = priorHour }
        }
        ranges[key] = result; return result
    }

    func scalar(_ key: String, anchor: Bool, _ calculate: () -> FilterScalar) -> FilterScalar {
        let scoped = key + (anchor ? "|anchor" : "|history")
        if let value = values[scoped] { return value }
        let value = calculate()
        // Some unknown reasons include the evaluator's decision time. Preserve
        // their exact explanation by rebuilding them in the requesting context.
        if value.reason == nil { values[scoped] = value }
        return value
    }

    func breaks(_ key: String, _ calculate: () -> (highBreakout: BreakResult, lowBreakdown: BreakResult)) -> (highBreakout: BreakResult, lowBreakdown: BreakResult) {
        if let value = events[key] { return value }
        let value = calculate(); events[key] = value; return value
    }

    func timestamp(_ hour: Int64) -> String {
        if let value = timestamps[hour] { return value }
        let value = formatter.string(from: Date(timeIntervalSince1970: Double(hour) / 1_000))
        timestamps[hour] = value; return value
    }
}
