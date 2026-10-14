import Foundation

let fiveMinuteMS: Int64 = 5 * 60 * 1_000

/// Radar receives only OKX 5-minute candles. Every visible timeframe is either
/// that source series or a deterministic local aggregation of it.
enum CandleTimeframe: String, CaseIterable, Codable, Sendable {
    case fiveMinutes = "5m"
    case fifteenMinutes = "15m"
    case oneHour = "1H"

    var milliseconds: Int64 {
        switch self {
        case .fiveMinutes: fiveMinuteMS
        case .fifteenMinutes: 3 * fiveMinuteMS
        case .oneHour: hourMS
        }
    }

    var sourceCount: Int { Int(milliseconds / fiveMinuteMS) }
    var label: String { self == .oneHour ? "1h" : rawValue }

    func start(containing timestamp: Int64) -> Int64 {
        timestamp / milliseconds * milliseconds
    }

    init?(requestValue: String?) {
        switch requestValue?.lowercased() {
        case nil, "", "1h": self = .oneHour
        case "5m", "5min": self = .fiveMinutes
        case "15m", "15min": self = .fifteenMinutes
        default: return nil
        }
    }

    init?(milliseconds: Int64) {
        guard let value = Self.allCases.first(where: { $0.milliseconds == milliseconds }) else { return nil }
        self = value
    }
}

private func summedVolume(_ bars: [Candle], _ value: (Candle) -> Double?) -> Double? {
    var total = 0.0
    for bar in bars {
        guard let amount = value(bar) else { return nil }
        total += amount
    }
    return total.isFinite ? total : nil
}

/// Builds one naturally aligned candle. Completed buckets require every 5m
/// component. Only the latest/forming bucket may be emitted partially, and it
/// must still begin at the natural boundary and contain no gaps.
func aggregateFiveMinuteCandle(_ source: [Int64: Candle], startingAt start: Int64,
                               timeframe: CandleTimeframe, allowIncomplete: Bool = false) -> Candle? {
    guard start >= 0, start % timeframe.milliseconds == 0 else { return nil }
    if timeframe == .fiveMinutes {
        guard let bar = source[start] else { return nil }
        return bar
    }
    var bars: [Candle] = []
    for index in 0..<timeframe.sourceCount {
        let timestamp = start + Int64(index) * fiveMinuteMS
        guard let bar = source[timestamp] else {
            guard allowIncomplete, !bars.isEmpty else { return nil }
            // A partial live bucket is valid only when all observations after
            // the missing slot are also absent. Never bridge an internal gap.
            let remainder = (index + 1)..<timeframe.sourceCount
            guard remainder.allSatisfy({ source[start + Int64($0) * fiveMinuteMS] == nil }) else { return nil }
            break
        }
        bars.append(bar)
    }
    guard !bars.isEmpty, let open = bars[0].open else { return nil }
    let complete = bars.count == timeframe.sourceCount
    let confirmed = complete && bars.allSatisfy(\.confirmed)
    guard allowIncomplete || confirmed else { return nil }
    return Candle(hour: start,
                  high: bars.map(\.high).max()!,
                  low: bars.map(\.low).min()!,
                  close: bars.last!.close,
                  quoteVolume: summedVolume(bars, \.quoteVolume),
                  baseVolume: summedVolume(bars, \.baseVolume),
                  open: open,
                  confirmed: confirmed)
}

/// Aggregates a source window without inventing historical partial candles.
/// `includeIncompleteLatest` is intended for the one currently forming bucket.
func aggregateFiveMinuteCandles(_ source: [Int64: Candle], timeframe: CandleTimeframe,
                                includeIncompleteLatest: Bool = false) -> [Int64: Candle] {
    guard !source.isEmpty else { return [:] }
    if timeframe == .fiveMinutes { return source }
    let latestBucket = timeframe.start(containing: source.keys.max()!)
    let starts = Set(source.keys.map(timeframe.start(containing:)))
    var result: [Int64: Candle] = [:]
    for start in starts {
        if let bar = aggregateFiveMinuteCandle(source, startingAt: start, timeframe: timeframe,
                                               allowIncomplete: includeIncompleteLatest && start == latestBucket) {
            result[start] = bar
        }
    }
    return result
}
