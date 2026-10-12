import Foundation

let hourMS: Int64 = 3_600_000
let candleLookback = 250
let chartHours = 96
let breakoutLookbackHours = 48
let breakoutSearchHours = 48

struct Candle: Codable, Sendable {
    let hour: Int64
    let open: Double?
    let high: Double
    let low: Double
    let close: Double
    let confirmed: Bool
    let quoteVolume: Double?
    let baseVolume: Double?

    init?(_ values: [String]) {
        guard values.count >= 9, let hour = Int64(values[0]), hour % hourMS == 0,
              let open = Double(values[1]),
              let high = Double(values[2]), let low = Double(values[3]),
              let close = Double(values[4]), let base = Double(values[6]),
              let quote = Double(values[7]), ["0", "1"].contains(values[8]),
              high.isFinite, low.isFinite, close.isFinite, base.isFinite, quote.isFinite,
              low > 0, high >= low, (low...high).contains(open), (low...high).contains(close), base >= 0, quote >= 0 else { return nil }
        self.hour = hour; self.open = open; self.high = high; self.low = low; self.close = close
        confirmed = values[8] == "1"; quoteVolume = quote; baseVolume = base
    }

    init(hour: Int64, high: Double, low: Double, close: Double, quoteVolume: Double?, baseVolume: Double?, open: Double? = nil, confirmed: Bool = true) {
        self.hour = hour; self.open = open; self.high = high; self.low = low; self.close = close
        self.confirmed = confirmed; self.quoteVolume = quoteVolume; self.baseVolume = baseVolume
    }
}

func historicalPage(_ rows: [Any], before: Int64) -> [Candle] {
    rows.compactMap { ($0 as? [String]).flatMap(Candle.init) }.filter { $0.confirmed && $0.hour < before }
}

/// History used for an EMA reading: seed with SMA(period) at the start of the window, then
/// iterate. A 5x window leaves (1 - 2/(n+1))^(4n) ≈ e^-8 of the seed error, so closed-hour
/// (Research/strategy) readings converge to the long-running live EMA instead of a 50-step SMA.
func emaWarmupHours(_ period: Int) -> Int { max(candleLookback, period * 5) }

/// `closes` must be contiguous and in ascending time order.
func windowedEMA<C: Collection>(_ closes: C, period n: Int) -> Double? where C.Element == Double {
    guard n > 0, closes.count >= n else { return nil }
    let alpha = 2 / Double(n + 1)
    var value = closes.prefix(n).reduce(0, +) / Double(n)
    for close in closes.dropFirst(n) { value += (close - value) * alpha }
    return value.isFinite && value > 0 ? value : nil
}

func updatedEMA200(_ previous: Double?, close: Double?) -> Double? {
    guard let previous, let close, previous.isFinite, close.isFinite, previous > 0, close > 0 else { return nil }
    return previous + (close - previous) * (2.0 / 201.0)
}

enum EMA200Signal: String {
    case long = "Long"
    case short = "Short"
    case unsure = "Unsure"
}

func ema200Signal(_ candle: Candle?, _ ema: Double?) -> EMA200Signal? {
    guard let candle, !candle.confirmed, let open = candle.open, let ema,
          open.isFinite, candle.close.isFinite, ema.isFinite,
          open > 0, candle.close > 0, ema > 0 else { return nil }
    if min(open, candle.close) > ema { return .long }
    if max(open, candle.close) < ema { return .short }
    return .unsure
}

func candleBodyRelation(_ open: Double?, _ close: Double?, _ reference: Double?) -> String? {
    guard let open, let close, let reference, open.isFinite, close.isFinite, reference.isFinite else { return nil }
    if min(open, close) > reference { return "above" }
    if max(open, close) < reference { return "below" }
    if open < reference && close > reference { return "cross-up" }
    if open > reference && close < reference { return "cross-down" }
    return "touching"
}

func percentChange(_ current: Double?, _ previous: Double?) -> Double? {
    guard let current, let previous, current.isFinite, previous.isFinite else { return nil }
    if previous == 0 {
        return current == 0 ? 0 : current > 0 ? .infinity : -.infinity
    }
    let difference = current - previous
    // Opposite-sign finite values can overflow their difference even when D is finite.
    let change = difference.isFinite ? difference / abs(previous) : current / abs(previous) - previous / abs(previous)
    return change * 100
}

func percentageSnapshot(_ value: Double?) -> Any {
    guard let value, !value.isNaN else { return NSNull() }
    // Preserve infinities through the WebKit bridge and JSON snapshots.
    if value.isInfinite { return value > 0 ? "Infinity" : "-Infinity" }
    return value
}

func completedHistoryHours(at hour: Int64, since listedAt: Int64?, limit: Int) -> Int {
    guard limit > 0 else { return 0 }
    guard let listedAt, listedAt >= 0 else { return limit }
    // A contract listed mid-hour has a partial first candle at that hour's start.
    let firstHour = listedAt / hourMS * hourMS
    guard firstHour < hour else { return 0 }
    return Int(min(Int64(limit), (hour - firstHour) / hourMS))
}

struct BreakEvent: Equatable, Sendable {
    let hour: Int64
    let hoursAgo: Int
    let priorHour: Int64
    let priorAgeHours: Int
    let priorPrice: Double
    let live: Bool
}

enum BreakResult: Equatable, Sendable {
    case event(BreakEvent)
    case none
    case insufficientHistory
    case loading

    var snapshot: [String: Any] {
        switch self {
        case .event(let event):
            return ["status": "event", "hour": event.hour, "hoursAgo": event.hoursAgo,
                    "priorHour": event.priorHour, "priorAgeHours": event.priorAgeHours,
                    "priorPrice": event.priorPrice, "live": event.live]
        case .none: return ["status": "none"]
        case .insufficientHistory: return ["status": "insufficient-history"]
        case .loading: return ["status": "loading"]
        }
    }
}

func recentExtremesBreaks(_ bars: [Int64: Candle], _ hour: Int64, listedAt: Int64? = nil,
                         lookbackHours: Int = breakoutLookbackHours, searchHours: Int = breakoutSearchHours) -> (highBreakout: BreakResult, lowBreakdown: BreakResult) {
    guard lookbackHours > 0,
          completedHistoryHours(at: hour, since: listedAt, limit: lookbackHours) == lookbackHours else {
        return (.insufficientHistory, .insufficientHistory)
    }
    var highBreakout: BreakResult?, lowBreakdown: BreakResult?
    for age in 0..<max(0, searchHours) {
        let candidateHour = hour - Int64(age) * hourMS
        // Do not shorten the comparison window for newly listed contracts.
        guard completedHistoryHours(at: candidateHour, since: listedAt, limit: lookbackHours) == lookbackHours else { break }
        guard let candidate = bars[candidateHour], age == 0 || candidate.confirmed else {
            return (highBreakout ?? .loading, lowBreakdown ?? .loading)
        }
        var high = -Double.infinity, low = Double.infinity
        var highHour = candidateHour, lowHour = candidateHour
        for offset in 1...lookbackHours {
            let priorHour = candidateHour - Int64(offset) * hourMS
            guard let prior = bars[priorHour], prior.confirmed else {
                // An unknown newer candidate could supersede any older event.
                return (highBreakout ?? .loading, lowBreakdown ?? .loading)
            }
            if prior.high > high { high = prior.high; highHour = priorHour }
            if prior.low < low { low = prior.low; lowHour = priorHour }
        }
        if highBreakout == nil, candidate.high > high {
            highBreakout = .event(BreakEvent(hour: candidateHour, hoursAgo: age, priorHour: highHour,
                                           priorAgeHours: Int((candidateHour - highHour) / hourMS), priorPrice: high, live: !candidate.confirmed))
        }
        if lowBreakdown == nil, candidate.low < low {
            lowBreakdown = .event(BreakEvent(hour: candidateHour, hoursAgo: age, priorHour: lowHour,
                                           priorAgeHours: Int((candidateHour - lowHour) / hourMS), priorPrice: low, live: !candidate.confirmed))
        }
        if highBreakout != nil, lowBreakdown != nil { break }
    }
    return (highBreakout ?? .none, lowBreakdown ?? .none)
}

// Current-candle filters compare against completed hours only. A history gap is
// unavailable, never evidence that a contract has not broken an extreme.
func priorExtremes(_ bars: [Int64: Candle], _ hour: Int64, hours: Int) -> (high: Double?, low: Double?) {
    guard hours > 0 else { return (nil, nil) }
    var high = -Double.infinity, low = Double.infinity
    for offset in 1...hours {
        guard let bar = bars[hour - Int64(offset) * hourMS], bar.confirmed else { return (nil, nil) }
        high = max(high, bar.high)
        low = min(low, bar.low)
    }
    return (high, low)
}

func rocMaroc(_ bars: [Int64: Candle], _ hour: Int64, _ rocPeriod: Int, _ marocPeriod: Int) -> (Double?, Double?) {
    guard (1...100).contains(rocPeriod), (1...100).contains(marocPeriod) else { return (nil, nil) }
    var values: [Double] = []
    for offset in 0..<marocPeriod {
        guard let current = bars[hour - Int64(offset) * hourMS],
              let previous = bars[hour - Int64(offset + rocPeriod) * hourMS],
              (offset == 0 || current.confirmed), previous.confirmed,
              let change = percentChange(current.close, previous.close) else {
            return (values.first, nil)
        }
        values.append(change)
    }
    let average = values.reduce(0) { $0 + $1 / Double(marocPeriod) }
    return (values.first, average.isNaN ? nil : average)
}

func vwap14(_ bars: [Int64: Candle], _ hour: Int64) -> Double? {
    var quote = 0.0, base = 0.0
    for age in (0..<14).reversed() {
        guard let bar = bars[hour - Int64(age) * hourMS],
              (age == 0 || bar.confirmed), let volume = bar.baseVolume, let quoteVolume = bar.quoteVolume else { return nil }
        quote += quoteVolume; base += volume
    }
    return base > 0 ? quote / base : nil
}

func rsi(_ bars: [Int64: Candle], _ hour: Int64, _ period: Int, historyHours: Int = candleLookback) -> Double? {
    var closes: [Double] = []
    for age in 0...historyHours {
        guard let bar = bars[hour - Int64(age) * hourMS], age == 0 || bar.confirmed else { break }
        closes.append(bar.close)
    }
    guard closes.count > period else { return nil }
    closes.reverse()
    let changes = zip(closes.dropFirst(), closes).map(-)
    var gain = changes.prefix(period).reduce(0) { $0 + max($1, 0) } / Double(period)
    var loss = changes.prefix(period).reduce(0) { $0 + max(-$1, 0) } / Double(period)
    for change in changes.dropFirst(period) {
        gain = (gain * Double(period - 1) + max(change, 0)) / Double(period)
        loss = (loss * Double(period - 1) + max(-change, 0)) / Double(period)
    }
    return gain + loss > 0 ? 100 * gain / (gain + loss) : 50
}

func logBB(_ bars: [Int64: Candle], _ hour: Int64) -> (Double?, Double?, Double?) {
    var logCloses: [Double] = []
    for age in 0..<20 {
        guard let bar = bars[hour - Int64(age) * hourMS], age == 0 || bar.confirmed,
              bar.close > 0 else { return (nil, nil, nil) }
        logCloses.append(log(bar.close))
    }
    let middle = logCloses.reduce(0, +) / 20
    let width = 2 * sqrt(logCloses.reduce(0) { $0 + pow($1 - middle, 2) } / 20)
    let upper = exp(middle + width), center = exp(middle), lower = exp(middle - width)
    guard upper.isFinite, center.isFinite, lower.isFinite,
          upper > 0, center > 0, lower > 0 else { return (nil, nil, nil) }
    return (upper, center, lower)
}

func logBBBandWidth(_ upper: Double?, _ middle: Double?, _ lower: Double?) -> Double? {
    guard let upper, let middle, let lower,
          upper.isFinite, middle.isFinite, lower.isFinite,
          middle > 0, lower > 0, upper >= lower else { return nil }
    let width = (upper - lower) / middle * 100
    return width.isFinite ? width : nil
}

enum LogBBAboveBand: String {
    case upper, middle, lower, below
}

func logBBAboveBand(_ price: Double?, _ upper: Double?, _ middle: Double?, _ lower: Double?) -> LogBBAboveBand? {
    guard let price, let upper, let middle, let lower,
          price.isFinite, upper.isFinite, middle.isFinite, lower.isFinite,
          price > 0, lower > 0, upper >= middle, middle >= lower else { return nil }
    if price > upper { return .upper }
    if price > middle { return .middle }
    if price > lower { return .lower }
    return .below
}

struct BandWidthExpansion: Equatable, Sendable {
    let hours: Int
    let complete: Bool

    var snapshot: [String: Any] { ["hours": hours, "complete": complete] }
}

func logBBExpansion(_ bars: [Int64: Candle], _ hour: Int64, listedAt: Int64? = nil) -> BandWidthExpansion? {
    func width(at time: Int64) -> Double? {
        let (upper, middle, lower) = logBB(bars, time)
        return logBBBandWidth(upper, middle, lower)
    }
    guard var current = width(at: hour) else { return nil }
    var time = hour, hours = 0
    while true {
        // The first valid 20-candle band has no earlier Band Width to compare.
        if let listedAt, listedAt >= 0,
           completedHistoryHours(at: time, since: listedAt, limit: 20) < 20 {
            return BandWidthExpansion(hours: hours, complete: true)
        }
        let previousHour = time - hourMS
        guard bars[previousHour]?.confirmed == true, let previous = width(at: previousHour) else {
            // Missing history cannot establish the start of an ongoing expansion.
            return hours > 0 ? BandWidthExpansion(hours: hours, complete: false) : nil
        }
        // Equal rolling windows can differ slightly due to floating-point summation.
        let tolerance = max(1, current, previous) * 1e-12
        guard current - previous > tolerance else {
            return BandWidthExpansion(hours: hours, complete: true)
        }
        hours += 1
        current = previous
        time = previousHour
    }
}
