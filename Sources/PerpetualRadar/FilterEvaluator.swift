import Foundation

struct FilterStat: Codable, Sendable { var oi: Double?, sell: Double?, buy: Double? }
struct FilterQuote: Codable, Sendable {
    var turnover: Double?
    var spread: Double?
    var timestamp: Int64
}
struct FilterMarketData: Sendable {
    var id: String
    var hour: Int64
    var now: Int64
    var listedAt: Int64?
    var candles: [Int64: Candle]
    var stats: [Int64: FilterStat]
    var quotes: [Int64: FilterQuote]
    var current: [String: FilterScalar] = [:]
    var previousEMA: Double?
    var historicalClose = false
    var referenceBTC: FilterReferenceSnapshot?
    var evaluationTime: Int64?
    var cooldowns: FilterCooldownMemory?
    var recordCooldowns = true
}

final class FilterEvaluator {
    let market: FilterMarketData
    let filter: CompiledFilter
    private var cache: [String: FilterScalar] = [:]
    private var breaksCache: [String: (highBreakout: BreakResult, lowBreakdown: BreakResult)] = [:]
    private var sources: [String: [FilterReadingSource]] = [:]
    private let referenceOnly: Bool
    init(market: FilterMarketData, filter: CompiledFilter, sharedReadings: [String: FilterScalar] = [:], referenceOnly: Bool = false) { self.market = market; self.filter = filter; cache = sharedReadings; self.referenceOnly = referenceOnly }
    var sharedReadings: [String: FilterScalar] { cache.filter { $0.key.hasPrefix("metric|") || $0.key.hasPrefix("indicator|") } }
    func evaluate(explain: Bool = false) -> FilterTrace {
        let root = filter.config.root
        // BTC cooldowns describe the shared market context. Observe them even
        // when a preceding contract condition short-circuits the visible tree.
        func observe(_ node: FilterNode, at hour: Int64) {
            if node.kind == "cooldown", node.hours > 0, !filter.usesContractInput(node), filter.referencesBTC(in: node) {
                _ = rule(node, at: hour, scope: [:], explain: false); return
            }
            for child in node.children { observe(child, at: hour-(node.mode == "closed" ? hourMS : 0)) }
        }
        if market.cooldowns != nil, market.recordCooldowns { observe(root, at: market.hour) }
        if ["all", "any"].contains(root.kind), root.children.isEmpty {
            var trace = FilterTrace(id: root.id, label: root.name.isEmpty ? "All exchange markets" : root.name, result: .yes, hour: market.hour)
            trace.reason = "An empty rule tree includes every contract in the exchange universe."
            return trace
        }
        return rule(root, at: market.hour, scope: [:], explain: explain)
    }
    func scalar(_ source: String, at hour: Int64, scope: [String: FilterScalar] = [:]) -> FilterScalar {
        guard let expression = filter.expressions[source] else { return .unknown("Expression is not compiled.") }
        return expressionValue(expression, at: hour, scope: scope)
    }
    private func unknown(_ reason: String, at hour: Int64) -> FilterScalar { .unknown("\(reason) [\(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(hour) / 1000)))].") }
    private func bar(_ hour: Int64) -> Candle? {
        guard hour <= market.hour, let bar = market.candles[hour],
              market.historicalClose ? bar.confirmed : (hour == market.hour ? !bar.confirmed : bar.confirmed) else { return nil }; return bar
    }
    private func numeric(_ number: Double?, _ reason: String, at hour: Int64) -> FilterScalar { guard let number, !number.isNaN else { return unknown(reason, at: hour) }; return .number(number) }
    private func relation(_ a: FilterScalar, _ b: FilterScalar) -> FilterScalar {
        guard let a = a.number, let b = b.number else { return .unknown("A comparison operand is unavailable.") }
        return .text(a > b ? "above" : a < b ? "below" : "equal")
    }
    private func direction(_ x: FilterScalar) -> FilterScalar { guard let n = x.number else { return x }; return .text(n > 0 ? "rising" : n < 0 ? "falling" : "flat") }
    private func change(_ current: FilterScalar, _ previous: FilterScalar) -> FilterScalar {
        guard let a = current.number, let b = previous.number else { return .unknown(current.reason ?? previous.reason ?? "Change history is unavailable.") }
        return numeric(percentChange(a, b), "Change cannot be computed.", at: market.hour)
    }
    private func cached(_ key: String, _ calculate: () -> FilterScalar) -> FilterScalar {
        if let cached = cache[key] { return cached }; let value = calculate(); cache[key] = value; return value
    }
    func metric(_ name: String, at hour: Int64) -> FilterScalar {
        if referenceOnly { return .unknown("This contract input awaits its normal decision clock.") }
        guard let key = FilterCatalog.key(name) else { return .unknown("Unknown metric: \(name).") }
        if !market.historicalClose, hour == market.hour, let value = market.current[key] { return value }
        return cached("metric|\(key)|\(hour)") { read(key, at: hour) }
    }
    private func read(_ key: String, at hour: Int64) -> FilterScalar {
        func number(_ n: Double?, _ reason: String = "Hourly data is unavailable.") -> FilterScalar { numeric(n, reason, at: hour) }
        func value(_ name: String) -> FilterScalar { metric(name, at: hour) }
        func fn(_ name: String, _ args: [Double]) -> FilterScalar { indicator(name.lowercased(), args, at: hour) }
        let b = bar(hour)
        switch key {
        case "Symbol": return .text(market.id)
        case "ListingAgeMonths":
            guard let listedAt = market.listedAt, listedAt > 0 else { return unknown("Listing date is unavailable", at: hour) }
            let end = hour == market.hour ? market.now : hour + hourMS
            let start = Date(timeIntervalSince1970: Double(listedAt) / 1000), now = Date(timeIntervalSince1970: Double(end) / 1000)
            guard start <= now else { return unknown("Listing date is later than this reading", at: hour) }
            var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            var months = max(0, calendar.dateComponents([.month], from: start, to: now).month ?? 0)
            while let boundary = calendar.date(byAdding: .month, value: months + 1, to: start), boundary <= now { months += 1 }
            while months > 0, let boundary = calendar.date(byAdding: .month, value: months, to: start), boundary > now { months -= 1 }
            return .number(Double(months))
        case "price", "Close": return number(b?.close)
        case "Open": return number(b?.open)
        case "High": return number(b?.high)
        case "Low": return number(b?.low)
        case "liveVolume", "Volume": return number(b?.quoteVolume)
        case "turnover": return number(market.quotes[hour]?.turnover.map { $0 / 1_000_000 }, "24h turnover has no quote snapshot for this hour.")
        case "spread": return number(market.quotes[hour]?.spread, "Spread has no quote snapshot for this hour.")
        case "buy": return number(market.stats[hour]?.buy, "Taker buy history is unavailable.")
        case "sell": return number(market.stats[hour]?.sell, "Taker sell history is unavailable.")
        case "oiUSD": return number(market.stats[hour]?.oi.map { $0 / 1_000_000 }, "OI history is unavailable.")
        case "takerRatio":
            guard let buy = value("buy").number, let sell = value("sell").number, buy + sell > 0 else { return number(nil, "Taker imbalance requires nonzero buy or sell volume.") }
            return number((buy - sell) / (buy + sell) * 100)
        case "buyVsSell": return relation(value("buy"), value("sell"))
        case "oiChange": return change(value("oiUSD"), metric("oiUSD", at: hour - hourMS))
        case "oiTrend": return direction(value("oiChange"))
        case "priceChange": return change(value("Close"), metric("Close", at: hour - hourMS))
        case "candleDirection": return relation(value("Close"), value("Open"))
        case "bodyChange": return change(value("Close"), value("Open"))
        case "candleRange": return change(value("High"), value("Low"))
        case "emaSlope": return change(fn("ema", [200]), indicator("ema", [200], at: hour - hourMS))
        case "emaTrend": return direction(value("emaSlope"))
        case "emaDistance": return change(value("Close"), fn("ema", [200]))
        case "priceEMA": return relation(value("Close"), fn("ema", [200]))
        case "emaBody":
            return candleBodyRelation(b?.open, b?.close, fn("ema", [200]).number).map(FilterScalar.text) ?? number(nil, "Body or EMA200 is unavailable.")
        case "rsi6": return fn("rsi", [6])
        case "rsi12": return fn("rsi", [12])
        case "rsi24": return fn("rsi", [24])
        case "rsi6vs12": return relation(value("rsi6"), value("rsi12"))
        case "rsi12vs24": return relation(value("rsi12"), value("rsi24"))
        case "roc": return fn("roc", [9])
        case "maroc": return fn("maroc", [9, 9])
        case "rocVsMaroc": return relation(value("roc"), value("maroc"))
        case "rocChange": return change(value("roc"), metric("roc", at: hour - hourMS))
        case "marocChange": return change(value("maroc"), metric("maroc", at: hour - hourMS))
        case "priceUpper": return relation(value("Close"), fn("logbbupper", [20, 2]))
        case "priceMiddle": return relation(value("Close"), fn("logbbmiddle", [20, 2]))
        case "priceLower": return relation(value("Close"), fn("logbblower", [20, 2]))
        case "highUpper": return relation(value("High"), fn("logbbupper", [20, 2]))
        case "lowLower": return relation(value("Low"), fn("logbblower", [20, 2]))
        case "bodyUpper", "bodyLower":
            let band = fn(key == "bodyUpper" ? "logbbupper" : "logbblower", [20, 2]).number
            return candleBodyRelation(b?.open, b?.close, band).map(FilterScalar.text) ?? number(nil, "Body or Log BB history is unavailable.")
        case "bbZone":
            return logBBAboveBand(b?.close, fn("logbbupper", [20, 2]).number, fn("logbbmiddle", [20, 2]).number, fn("logbblower", [20, 2]).number).map { .text($0.rawValue) } ?? number(nil, "Log BB history is unavailable.")
        case "bbWidth": return number(logBBBandWidth(fn("logbbupper", [20, 2]).number, fn("logbbmiddle", [20, 2]).number, fn("logbblower", [20, 2]).number))
        case "bbExpansion", "bbExpansionComplete":
            guard let expansion = logBBExpansion(market.candles, hour, listedAt: market.listedAt) else { return number(nil, "Expansion history is unavailable.") }
            return key == "bbExpansion" ? .number(Double(expansion.hours)) : .text(expansion.complete ? "complete" : "partial")
        case "priceVWAP": return relation(value("Close"), fn("vwap", [14]))
        case "vwapDistance": return change(value("Close"), fn("vwap", [14]))
        case "high48", "high96", "low48", "low96", "closeHigh48", "closeHigh96", "closeLow48", "closeLow96":
            let isHigh = key.lowercased().contains("high"), n = key.contains("96") ? 96 : 48
            let current = key.hasPrefix("close") ? b?.close : isHigh ? b?.high : b?.low
            guard let current, let prior = fn(isHigh ? "priorhigh" : "priorlow", [Double(n)]).number else { return number(nil, "Breakout reference history is unavailable.") }
            return .text((isHigh ? current > prior : current < prior) ? "yes" : "no")
        case "recentHigh48", "recentHigh96", "recentLow48", "recentLow96", "high48Age", "high96Age", "low48Age", "low96Age", "highPriorAge", "lowPriorAge":
            let n = key.contains("96") ? 96 : 48, high = key.lowercased().contains("high"), result = extremes(at: hour, lookback: n, search: 48)
            let event = high ? result.highBreakout : result.lowBreakdown
            switch event {
            case .event(let e): return key.hasPrefix("recent") ? .text("yes") : .number(Double(key.hasSuffix("PriorAge") ? e.priorAgeHours : e.hoursAgo))
            case .none: return key.hasPrefix("recent") ? .text("no") : number(nil, "No breakout event in the search window.")
            case .loading: return number(nil, "Breakout history has a gap.")
            case .insufficientHistory: return number(nil, "Contract has insufficient listing history.")
            }
        case "opportunityStatus", "opportunityDirection", "opportunitySetup", "opportunityScore":
            let opportunity = opportunity(at: hour)
            if key == "opportunityStatus" { return .text(opportunity.status) }
            if key == "opportunityScore" { return number(opportunity.score.map(Double.init), "Opportunity is incomplete.") }
            return (key == "opportunityDirection" ? opportunity.direction : opportunity.setup).map(FilterScalar.text) ?? number(nil, "Opportunity has no matching direction or setup.")
        default: return number(nil, "Metric is unavailable.")
        }
    }
    private func extremes(at hour: Int64, lookback: Int, search: Int) -> (highBreakout: BreakResult, lowBreakdown: BreakResult) {
        let key = "\(hour)|\(lookback)|\(search)"
        if let cached = breaksCache[key] { return cached }
        let result = recentExtremesBreaks(market.candles, hour, listedAt: market.listedAt, lookbackHours: lookback, searchHours: search)
        breaksCache[key] = result; return result
    }
    func opportunity(at hour: Int64) -> NativeOpportunity {
        let body = metric("emaBody", at: hour).text
        let signal = body.map { $0 == "above" ? "Long" : $0 == "below" ? "Short" : "Unsure" }
        let expansionHours = metric("bbExpansion", at: hour).number, complete = metric("bbExpansionComplete", at: hour).text
        let events = extremes(at: hour, lookback: 48, search: 48)
        return NativeOpportunity.evaluate(.init(signal: signal, priceChange: metric("priceChange", at: hour).number, roc: metric("roc", at: hour).number,
            maroc: metric("maroc", at: hour).number, rsi6: metric("rsi6", at: hour).number, rsi12: metric("rsi12", at: hour).number, rsi24: metric("rsi24", at: hour).number,
            taker: metric("takerRatio", at: hour).number, oi: metric("oiChange", at: hour).number, band: metric("bbZone", at: hour).text,
            expansion: expansionHours.flatMap { n in complete.map { BandWidthExpansion(hours: Int(n), complete: $0 == "complete") } }, high: events.highBreakout, low: events.lowBreakdown))
    }
    private func indicator(_ name: String, _ args: [Double], at hour: Int64) -> FilterScalar {
        if referenceOnly { return .unknown("This contract indicator awaits its normal decision clock.") }
        return cached("indicator|\(name)|\(args)|\(hour)") {
            let n = Int(args[0])
            func number(_ x: Double?) -> FilterScalar { numeric(x, "\(name) requires complete hourly history.", at: hour) }
            if name == "priorhigh" || name == "priorlow" {
                let extremes = priorExtremes(market.candles, hour, hours: n); return number(name == "priorhigh" ? extremes.high : extremes.low)
            }
            if name == "breakoutage" || name == "breakdownage" {
                let events = extremes(at: hour, lookback: n, search: Int(args[1])), result = name == "breakoutage" ? events.highBreakout : events.lowBreakdown
                if case .event(let e) = result { return .number(Double(e.hoursAgo)) }
                return unknown(result == .none ? "No event in the search window" : "Breakout history is incomplete", at: hour)
            }
            if name == "roc" { return change(metric("Close", at: hour), metric("Close", at: hour - Int64(n) * hourMS)) }
            if name == "efficiency" {
                var closes: [Double] = []
                for age in 0...n {
                    if Task.isCancelled { return .unknown("Evaluation cancelled.") }
                    guard let b = bar(hour - Int64(age) * hourMS) else { return number(nil) }; closes.append(b.close)
                }
                let movement = zip(closes, closes.dropFirst()).reduce(0.0) { $0 + abs($1.0 - $1.1) }
                return number(movement == 0 ? 0 : abs(closes[0] - closes[n]) / movement)
            }
            if name == "maroc" {
                var readings: [Double] = []
                for offset in 0..<Int(args[1]) {
                    if Task.isCancelled { return .unknown("Evaluation cancelled.") }
                    guard let x = indicator("roc", [Double(n)], at: hour - Int64(offset) * hourMS).number else { return number(nil) }; readings.append(x)
                }
                return number(readings.reduce(0) { $0 + $1 / args[1] })
            }
            if name == "rsi" {
                let available = market.listedAt.map { max(0, Int((hour - $0 / hourMS * hourMS) / hourMS)) } ?? max(250, n)
                let warmup = min(max(250, n), available)
                guard warmup >= n, (0...warmup).allSatisfy({ bar(hour - Int64($0) * hourMS) != nil }) else { return number(nil) }
                return number(rsi(market.candles, hour, n, historyHours: warmup))
            }
            if name == "ema" {
                if n == 200, !market.historicalClose, let previous = market.previousEMA {
                    if hour == market.hour { return number(updatedEMA200(previous, close: bar(hour)?.close)) }
                    if hour == market.hour - hourMS { return number(previous) }
                    var value = previous
                    for ts in stride(from: market.hour - hourMS, to: hour, by: -Int(hourMS)) {
                        if Task.isCancelled { return .unknown("Evaluation cancelled.") }
                        guard let b = bar(ts) else { return number(nil) }; value = (value - b.close * 2 / 201) / (1 - 2.0 / 201)
                        guard value.isFinite, value > 0 else { return number(nil) }
                        cache["indicator|ema|[200.0]|\(ts - hourMS)"] = .number(value)
                    }
                    return number(value)
                }
                let target = hour == market.hour ? hour - hourMS : hour
                var values: [Double] = []
                let available = market.listedAt.map { max(0, Int((target - $0 / hourMS * hourMS) / hourMS) + 1) } ?? max(250, n)
                for age in 0..<min(max(250, n), available) { if Task.isCancelled { return .unknown("Evaluation cancelled.") }; guard let b = bar(target - Int64(age) * hourMS) else { return number(nil) }; values.append(b.close) }
                guard values.count >= n else { return number(nil) }; values.reverse()
                var value = values.prefix(n).reduce(0, +) / Double(n), alpha = 2 / Double(n + 1)
                for close in values.dropFirst(n) { value += (close - value) * alpha }
                if hour == market.hour { guard let b = bar(hour) else { return number(nil) }; value += (b.close - value) * alpha }
                return number(value)
            }
            var bars: [Candle] = []
            for age in (0..<n).reversed() { if Task.isCancelled { return .unknown("Evaluation cancelled.") }; guard let b = bar(hour - Int64(age) * hourMS) else { return number(nil) }; bars.append(b) }
            if name == "vwap" {
                guard bars.allSatisfy({ $0.baseVolume != nil }) else { return number(nil) }
                let base = bars.reduce(0) { $0 + $1.baseVolume! }, quote = bars.reduce(0) { $0 + $1.quoteVolume }
                return number(base > 0 ? quote / base : nil)
            }
            if name.hasPrefix("logbb") {
                let logs = bars.map { log($0.close) }, mean = logs.reduce(0, +) / Double(n), deviation = args[1] * sqrt(logs.reduce(0) { $0 + pow($1 - mean, 2) } / Double(n))
                return number(exp(mean + (name == "logbbupper" ? deviation : name == "logbblower" ? -deviation : 0)))
            }
            return number(nil)
        }
    }
    private func expressionValue(_ expr: FilterExpression, at hour: Int64, scope: [String: FilterScalar]) -> FilterScalar {
        let key = "expr|\(expr.source)|\(hour)"
        if scope.isEmpty, let value = cache[key] { return value }
        let value = rawExpression(expr, at: hour, scope: scope)
        if scope.isEmpty { cache[key] = value }
        if filter.referencesBTC {
            let provenance = expressionSources(expr, at: hour)
            if !provenance.isEmpty { sources["\(expr.source)|\(hour)"] = provenance }
        }
        return value
    }
    private func rawExpression(_ expr: FilterExpression, at hour: Int64, scope: [String: FilterScalar]) -> FilterScalar {
        func eval(_ x: FilterExpression, _ h: Int64? = nil) -> FilterScalar { expressionValue(x, at: h ?? hour, scope: scope) }
        switch expr {
        case .number(let n): return .number(n)
        case .text(let s): return .text(s)
        case .name(let name): if let captured = scope[name] { return captured }; if let def = filter.definitions[name] { return eval(def) }; return metric(name, at: hour)
        case .unary(let op, let x): let value = eval(x); guard let n = value.number else { return value }; return .number(op == "-" ? -n : n)
        case .binary(let op, let a, let b):
            let left = eval(a), right = eval(b)
            guard let a = left.number, let b = right.number else { return .unknown(left.reason ?? right.reason ?? "Arithmetic operand is unavailable.") }
            if op == "/", b == 0 { return .unknown("Division by zero.") }
            let value = op == "+" ? a + b : op == "-" ? a - b : op == "*" ? a * b : a / b
            return value.isNaN ? .unknown("Arithmetic result is undefined.") : .number(value)
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "btc" { return btcValue(args, source: expr.source, at: hour, scope: scope) }
            if f == "closed" { return eval(args[0], hour - hourMS) }
            if f == "live" { return eval(args[0]) }
            if f == "abs" { let value = eval(args[0]); return value.number.map { .number(abs($0)) } ?? value }
            if f == "multiple" {
                let baseline = eval(args[0]), multiplier = eval(args[1])
                guard let base = baseline.number, let factor = multiplier.number else { return .unknown(baseline.reason ?? multiplier.reason ?? "The baseline is unavailable.") }
                guard base > 0 else { return .unknown("The baseline must be greater than zero.") }
                let value = base * factor
                return value.isFinite ? .number(value) : .unknown("The baseline multiple is outside the supported numeric range.")
            }
            if f == "lag" { return eval(args[0], hour - Int64(try! FilterParser.integer(args[1], zero: true)) * hourMS) }
            if f == "change" { return change(eval(args[0]), eval(args[0], hour - Int64(try! FilterParser.integer(args[1])) * hourMS)) }
            if ["mean", "sum", "highest", "lowest", "stddev"].contains(f) {
                let n = try! FilterParser.integer(args[1]); var numbers: [Double] = []
                for age in 0..<n { if Task.isCancelled { return .unknown("Evaluation cancelled.") }; let value = eval(args[0], hour - Int64(age) * hourMS); guard let number = value.number else { return value }; numbers.append(number) }
                var mean = 0.0, correction = 0.0
                for number in numbers { let term = number / Double(n) - correction, next = mean + term; correction = (next - mean) - term; mean = next }
                let result = f == "mean" ? mean : f == "sum" ? numbers.reduce(0, +) : f == "highest" ? numbers.max()! : f == "lowest" ? numbers.min()! : sqrt(numbers.reduce(0) { $0 + pow($1 - mean, 2) } / Double(n))
                return result.isNaN ? .unknown("Aggregate result is undefined.") : .number(result)
            }
            return indicator(f, args.map { if case .number(let n) = $0 { return n }; return 0 }, at: hour)
        }
    }
    private func btcValue(_ args: [FilterExpression], source: String, at hour: Int64, scope: [String: FilterScalar]) -> FilterScalar {
        let clock = args.count == 2 ? (try? FilterParser.string(args[1])) ?? "aligned" : "aligned"
        guard let reference = market.referenceBTC else { return .unknown("BTC-USDT-SWAP reference data is unavailable.") }
        let snapshot = reference.market, offset = market.hour - hour
        let base = clock == "aligned" ? market.hour : clock == "closed" && !snapshot.historicalClose ? snapshot.hour - hourMS : snapshot.hour
        let target = base - offset
        let hours = readingHours(args[0], at: target)
        let provenance = Array(Set(hours)).sorted(by: >).map { h in
            FilterReadingSource(instrument: btcReferenceID, hour: h, clock: h == snapshot.hour && !snapshot.historicalClose ? "live" : "closed", updatedAt: reference.receivedAt ?? snapshot.now)
        }
        sources["\(source)|\(hour)"] = provenance
        let now = market.evaluationTime ?? market.now
        if provenance.contains(where: { $0.clock == "live" }), (!reference.connected || reference.receivedAt == nil || now - (reference.receivedAt ?? 0) > 30_000) {
            return .unknown("BTC live data is disconnected or older than 30 seconds.")
        }
        guard target <= snapshot.hour else { return .unknown("BTC data is later than the evaluation boundary.") }
        let key = filter.cooldownIdentity + "|\(clock)|\(target)|" + args[0].source
        if scope.isEmpty, let value = reference.reading(key) { return value }
        var input = snapshot
        input.current = [:]; input.referenceBTC = reference; input.cooldowns = nil; input.evaluationTime = now
        let evaluator = FilterEvaluator(market: input, filter: filter)
        let value = evaluator.expressionValue(args[0], at: target, scope: scope)
        if scope.isEmpty { reference.save(value, for: key) }
        return value
    }
    private func readingHours(_ expression: FilterExpression, at hour: Int64) -> [Int64] {
        switch expression {
        case .name(let name): return filter.definitions[name].map { readingHours($0, at: hour) } ?? [hour]
        case .unary(_, let value): return readingHours(value, at: hour)
        case .binary(_, let left, let right): return readingHours(left, at: hour) + readingHours(right, at: hour)
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "closed" { return readingHours(args[0], at: hour-hourMS) }
            if f == "lag" { return readingHours(args[0], at: hour-Int64(try! FilterParser.integer(args[1], zero: true))*hourMS) }
            if ["live", "abs", "multiple"].contains(f) { return readingHours(args[0], at: hour) }
            if ["mean", "sum", "highest", "lowest", "stddev", "change"].contains(f) {
                // The selected endpoints describe the source interval without
                // allocating one provenance record per potentially huge slot.
                let n = try! FilterParser.integer(args[1]), ages = f == "change" ? [0, n] : [0, n-1]
                return ages.flatMap { readingHours(args[0], at: hour-Int64($0)*hourMS) }
            }
            return [hour]
        default: return []
        }
    }
    private func expressionSources(_ expr: FilterExpression, at hour: Int64, visiting: Set<String> = []) -> [FilterReadingSource] {
        if let found = sources["\(expr.source)|\(hour)"] { return found }
        switch expr {
        case .name(let name): if let def = filter.definitions[name], !visiting.contains(name) { return expressionSources(def, at: hour, visiting: visiting.union([name])) }
        case .unary(_, let x): return expressionSources(x, at: hour, visiting: visiting)
        case .binary(_, let a, let b): return expressionSources(a, at: hour, visiting: visiting) + expressionSources(b, at: hour, visiting: visiting)
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "closed" { return expressionSources(args[0], at: hour-hourMS, visiting: visiting) }
            if f == "lag" { return expressionSources(args[0], at: hour-Int64(try! FilterParser.integer(args[1], zero: true))*hourMS, visiting: visiting) }
            if ["mean", "sum", "highest", "lowest", "stddev", "change"].contains(f) {
                let n = try! FilterParser.integer(args[1])
                if f == "change" { return [0,n].flatMap { expressionSources(args[0], at: hour-Int64($0)*hourMS, visiting: visiting) } }
                let prefix = args[0].source + "|", first = hour-Int64(n-1)*hourMS
                return sources.compactMap { key, values -> [FilterReadingSource]? in
                    guard key.hasPrefix(prefix), let timestamp = Int64(key.dropFirst(prefix.count)), timestamp >= first, timestamp <= hour else { return nil }
                    return values
                }.flatMap { $0 }.sorted { $0.hour > $1.hour }
            }
            return args.flatMap { expressionSources($0, at: hour, visiting: visiting) }
        default: break
        }
        return []
    }
    private func comparison(_ op: String, _ left: FilterScalar, _ right: FilterScalar, _ upper: FilterScalar = .number(0)) -> FilterTruth {
        if op == "present" { return left.reason == nil ? .yes : .no }
        if op == "missing" { return left.reason != nil ? .yes : .no }
        guard left.reason == nil else { return .unknown }
        if ["positive", "negative", "zero"].contains(op) { guard let a = left.number else { return .unknown }; return (op == "positive" ? a > 0 : op == "negative" ? a < 0 : a == 0) ? .yes : .no }
        guard right.reason == nil else { return .unknown }
        if op == "eq" || op == "neq" { let same = left == right; return (op == "eq" ? same : !same) ? .yes : .no }
        guard let a = left.number, let b = right.number else { return .unknown }
        var passes = false
        switch op {
        case "gt": passes = a > b
        case "gte": passes = a >= b
        case "lt": passes = a < b
        case "lte": passes = a <= b
        case "abs-gte": passes = abs(a) >= b
        case "abs-lte": passes = abs(a) <= b
        case "between": guard let c = upper.number else { return .unknown }; passes = a >= b && a <= c
        default: return .unknown
        }
        return passes ? .yes : .no
    }
    private func rule(_ node: FilterNode, at anchor: Int64, scope: [String: FilterScalar], explain: Bool) -> FilterTrace {
        let hour = anchor - (node.mode == "closed" ? hourMS : 0)
        var trace = FilterTrace(id: node.id, label: node.name.isEmpty ? node.formula : node.name, result: .unknown, hour: hour)
        func eval(_ source: String) -> FilterScalar { scalar(source, at: hour, scope: scope) }
        switch node.kind {
        case "all", "any", "not":
            var children: [FilterTrace] = []
            for child in node.children {
                let result = rule(child, at: hour, scope: scope, explain: explain); children.append(result)
                if !explain && ((node.kind == "all" && result.result == .no) || (node.kind == "any" && result.result == .yes)) { break }
            }
            trace.result = node.children.isEmpty ? .yes : node.kind == "not" ? children[0].result.negated : node.kind == "all" ? .all(children.map(\.result)) : .any(children.map(\.result))
            trace.referenceDriven = children.contains { $0.referenceDriven && (node.kind != "any" || $0.result == trace.result) }
            if explain { trace.children = children }
        case "condition":
            let unary = ["positive", "negative", "zero", "present", "missing"].contains(node.comparison)
            let operands = [node.left] + (unary ? [] : [node.right]) + (node.comparison == "between" ? [node.upper] : [])
            let bound = Set(scope.filter { $0.value.reason == nil }.keys)
            if referenceOnly, operands.contains(where: { filter.expressions[$0].map { filter.usesContractInput($0, bound: bound) } ?? false }) {
                trace.reason = "This comparison depends on the tracked contract's decision clock."; return trace
            }
            let left = eval(node.left), right = unary ? .number(0) : eval(node.right), upper = node.comparison == "between" ? eval(node.upper) : .number(0)
            trace.result = comparison(node.comparison, left, right, upper)
            for source in operands where filter.referencesBTC {
                if let expression = filter.expressions[source] {
                    let provenance = expressionSources(expression, at: hour)
                    if !provenance.isEmpty { trace.readingSources[source] = provenance; trace.referenceDriven = true }
                }
            }
            if explain {
                trace.readings[node.left] = left
                if !["positive", "negative", "zero", "present", "missing"].contains(node.comparison) { trace.readings[node.right] = right }
                if node.comparison == "between" { trace.readings["Maximum: \(node.upper)"] = upper }
                trace.reason = left.reason ?? right.reason ?? (node.comparison == "between" ? upper.reason : nil) ?? "Comparison evaluated at the selected hour."
            }
        case "crossup", "crossdown":
            let bound = Set(scope.filter { $0.value.reason == nil }.keys)
            if referenceOnly, [node.left, node.right].contains(where: { filter.expressions[$0].map { filter.usesContractInput($0, bound: bound) } ?? false }) {
                trace.reason = "This crossing depends on the tracked contract's decision clock."; return trace
            }
            let a = eval(node.left), b = eval(node.right), oldA = scalar(node.left, at: hour - hourMS, scope: scope), oldB = scalar(node.right, at: hour - hourMS, scope: scope)
            if let a = a.number, let b = b.number, let oldA = oldA.number, let oldB = oldB.number { trace.result = (node.kind == "crossup" ? oldA <= oldB && a > b : oldA >= oldB && a < b) ? .yes : .no }
            // Equal operands are valid expressions and must not create duplicate
            // dictionary-literal keys in the native preview or explanation.
            trace.readings[node.left] = a; trace.readings[node.right] = b
            trace.readings["Previous \(node.left)"] = oldA; trace.readings["Previous \(node.right)"] = oldB
            for source in [node.left, node.right] where filter.referencesBTC {
                guard let expression = filter.expressions[source] else { continue }
                for (key, h) in [(source, hour), ("Previous \(source)", hour-hourMS)] {
                    let provenance = expressionSources(expression, at: h)
                    if !provenance.isEmpty { trace.readingSources[key] = provenance; trace.referenceDriven = true }
                }
            }
            trace.reason = a.reason ?? b.reason ?? oldA.reason ?? oldB.reason ?? "Equality is allowed at the previous hour; the new reading must strictly cross."
        case "cooldown":
            let child = rule(node.children[0], at: hour, scope: scope, explain: explain)
            trace.result = child.result; trace.referenceDriven = child.referenceDriven
            if explain { trace.children = [child] }
            guard node.hours > 0 else { trace.reason = "Cooldown disabled (0 hours)."; return trace }
            let now = (market.evaluationTime ?? market.now) - (market.hour-hour)
            let shared = !filter.usesContractInput(node) && filter.referencesBTC(in: node)
            let key = filter.cooldownIdentity + "|\(shared ? btcReferenceID : market.id)|\(node.id)|\(shared ? "btc" : referenceOnly ? "reference" : "full")"
            var latest = market.cooldowns?.lastMatch(key, through: now)
            var missing = child.result == .unknown
            if child.result == .yes { latest = now }
            if child.result != .yes, latest == nil || latest! + Int64(node.hours)*hourMS <= now {
                for age in 1...node.hours {
                    if Task.isCancelled { trace.reason = "Evaluation cancelled."; return trace }
                    let previous = rule(node.children[0], at: hour-Int64(age)*hourMS, scope: scope, explain: false)
                    missing = missing || previous.result == .unknown
                    if previous.result == .yes { latest = now-Int64(age)*hourMS; trace.referenceDriven = trace.referenceDriven || previous.referenceDriven; break }
                }
            }
            if let latest {
                if market.recordCooldowns, hour == market.hour { market.cooldowns?.record(key, at: latest) }
                let remaining = max(0, latest+Int64(node.hours)*hourMS-now)
                trace.readings["Cooldown remaining"] = .number(Double(remaining)/Double(hourMS))
                trace.eventHours = [latest]
                if child.result == .yes || remaining > 0 { trace.result = .yes; trace.referenceDriven = trace.referenceDriven || shared }
                else { trace.result = missing ? .unknown : child.result }
                trace.reason = remaining > 0 ? "Cooldown remains active after the last match; no new trigger is delayed." : "Cooldown elapsed."
            } else { trace.result = missing ? .unknown : child.result; trace.reason = "No known trigger within the cooldown window." }
        case "every", "recent", "count":
            var yes = 0, unknown = 0, children: [FilterTrace] = []
            for age in 0..<node.hours {
                if Task.isCancelled { trace.reason = "Evaluation cancelled."; return trace }
                let result = rule(node.children[0], at: hour - Int64(age) * hourMS, scope: scope, explain: explain)
                trace.referenceDriven = trace.referenceDriven || result.referenceDriven
                if result.result == .yes { yes += 1 }; if result.result == .unknown { unknown += 1 }
                if explain { children.append(result) }
                if node.kind == "recent", result.result == .yes { trace.result = .yes; trace.eventHours = [result.hour]; break }
                if node.kind == "every", result.result == .no { trace.result = .no; break }
            }
            if node.kind == "recent", trace.result != .yes { trace.result = unknown > 0 ? .unknown : .no }
            if node.kind == "every", trace.result != .no { trace.result = unknown > 0 ? .unknown : .yes }
            if node.kind == "count" {
                let maximum = yes + unknown, threshold = FilterScalar.number(Double(node.minimum)), upper = FilterScalar.number(Double(node.upper) ?? 0)
                let low = comparison(node.comparison, .number(Double(yes)), threshold, upper), high = comparison(node.comparison, .number(Double(maximum)), threshold, upper)
                if low != high { trace.result = .unknown }
                else if ["eq", "neq"].contains(node.comparison), yes < maximum, (yes...maximum).contains(node.minimum) { trace.result = .unknown }
                else if node.comparison == "between", low == .no, Double(maximum) >= Double(node.minimum), Double(yes) <= (upper.number ?? 0) { trace.result = .unknown }
                else { trace.result = low }
                trace.readings = ["Known matches": .number(Double(yes)), "Unknown hours": .number(Double(unknown)), "Threshold": threshold]
                if node.comparison == "between" { trace.readings["Maximum count"] = upper }
            }
            if explain { trace.children = children }
            trace.reason = unknown > 0 ? "The requested window contains unavailable hourly data." : "Window includes the anchor hour and \(node.hours - 1) preceding hours."
        case "sequence": trace = sequence(node, at: hour, scope: scope, explain: explain)
        default: trace.reason = "Unrecognized rule."
        }
        return trace
    }
    private func sequence(_ node: FilterNode, at hour: Int64, scope: [String: FilterScalar], explain: Bool) -> FilterTrace {
        let target = hour - (node.children.last?.mode == "closed" ? hourMS : 0)
        var trace = FilterTrace(id: node.id, label: node.name.isEmpty ? node.formula : node.name, result: .no, hour: target)
        let firstHour = target - Int64(node.hours) * hourMS
        var uncertain: [FilterTrace] = [], uncertainTimes: [Int64] = []
        var exhaustedPaths = Set<String>()
        func search(_ index: Int, _ previous: Int64?, _ values: [String: FilterScalar], _ path: [FilterTrace], _ certainty: FilterTruth) -> Bool {
            if Task.isCancelled { return false }
            let bindings = values.keys.sorted().map { key in "\(key)=\(values[key]!.snapshot)" }.joined(separator: "|")
            let state = "\(index)|\(previous ?? -1)|\(certainty.rawValue)|\(bindings)"
            if exhaustedPaths.contains(state) { return false }
            let stage = node.children[index], last = index == node.children.count - 1
            let earliest = max(firstHour, previous.map { $0 + hourMS } ?? firstHour)
            let latest = min(target, previous.map { $0 + Int64(stage.gapHours) * hourMS } ?? target)
            guard earliest <= latest, !last || (earliest...latest).contains(target) else { return false }
            let times = last ? [target] : Array(stride(from: latest, through: earliest, by: -Int(hourMS)))
            for candidate in times {
                if Task.isCancelled { return false }
                var result = rule(stage, at: candidate + (stage.mode == "closed" ? hourMS : 0), scope: values, explain: explain)
                if result.result == .no { continue }
                if let previous, result.hour <= previous || result.hour - previous > Int64(stage.gapHours) * hourMS { continue }
                var captured = values
                for item in stage.captures {
                    let name = "\(stage.name).\(item.name)", value = scalar(item.expression, at: result.hour, scope: captured)
                    captured[name] = value; if explain { result.readings[name] = value }
                    if filter.referencesBTC, let expression = filter.expressions[item.expression] {
                        let provenance = expressionSources(expression, at: result.hour)
                        if !provenance.isEmpty { result.readingSources[name] = provenance; result.referenceDriven = true }
                    }
                }
                let nextPath = path + [result], truth = FilterTruth.all([certainty, result.result])
                if last {
                    if truth == .yes { trace.result = .yes; trace.children = nextPath; trace.eventHours = nextPath.map(\.hour); return true }
                    if uncertain.isEmpty { uncertain = nextPath; uncertainTimes = nextPath.map(\.hour) }
                } else if search(index + 1, result.hour, captured, nextPath, truth) { return true }
            }
            exhaustedPaths.insert(state)
            return false
        }
        _ = search(0, nil, scope, [], .yes)
        if trace.result != .yes, !uncertain.isEmpty { trace.result = .unknown; trace.children = uncertain; trace.eventHours = uncertainTimes }
        trace.referenceDriven = trace.children.contains(where: \.referenceDriven)
        trace.reason = trace.result == .yes ? "A complete ordered path ends at this hour. Captured values belong to their event hours." : trace.result == .unknown ? "A possible ordered path contains unavailable data." : "No ordered path satisfies the window and stage gaps."
        if !explain { trace.children = [] }
        return trace
    }
}

actor FilterEvaluationWorker {
    func evaluate(_ markets: [FilterMarketData], filter: CompiledFilter) -> [String: FilterTruth] {
        var results: [String: FilterTruth] = [:]
        for market in markets { if Task.isCancelled { break }; results[market.id] = FilterEvaluator(market: market, filter: filter).evaluate().result }
        return results
    }
    func explain(_ market: FilterMarketData, filter: CompiledFilter) -> FilterTrace { FilterEvaluator(market: market, filter: filter).evaluate(explain: true) }
}
