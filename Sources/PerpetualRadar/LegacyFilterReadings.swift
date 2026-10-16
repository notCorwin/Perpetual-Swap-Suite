import Foundation

// Preserve the original list's default indicator readings when the engine evaluates
// the live hour. Historical hours and custom periods use the same native primitives.
enum LegacyFilterReadings {
    static func from(_ row: [String: Any]) -> [String: FilterScalar] {
        let m = row["filterMetrics"] as? [String: Any] ?? [:]
        func n(_ value: Any?) -> Double? {
            let number = (value as? NSNumber)?.doubleValue ?? (value as? String).flatMap(Double.init)
            return number?.isNaN == false ? number : nil
        }
        func scalar(_ x: Double?, _ field: String) -> FilterScalar { x.map(FilterScalar.number) ?? .unknown("\(field) is unavailable in the live snapshot.") }
        func finite(_ x: Double?) -> Double? { x?.isFinite == true ? x : nil }
        func relation(_ a: Double?, _ b: Double?) -> FilterScalar { guard let a, let b else { return .unknown("A comparison operand is unavailable.") }; return .text(a > b ? "above" : a < b ? "below" : "equal") }
        func percent(_ a: Double?, _ b: Double?) -> Double? { guard let a, let b, a.isFinite, b.isFinite, b > 0 else { return nil }; return (a - b) / b * 100 }
        var result: [String: FilterScalar] = [:]
        for key in ["rsi6", "rsi12", "rsi24", "roc", "maroc", "rocChange", "marocChange", "buy", "sell", "takerRatio", "oiChange", "priceChange"] { let value = n(row[key]); result[key] = scalar(["rsi6", "rsi12", "rsi24", "buy", "sell", "takerRatio"].contains(key) ? finite(value) : value, key) }
        let close = n(m["liveClose"]), open = n(m["liveOpen"]), ema = n(m["ema200"]), previousEMA = n(m["previousEMA200"])
        result["price"] = scalar(finite(close), "Live price"); result["Close"] = result["price"]; result["Open"] = scalar(finite(open), "Open")
        result["High"] = scalar(finite(n(row["currentHigh"])), "High"); result["Low"] = scalar(finite(n(row["currentLow"])), "Low")
        result["liveVolume"] = scalar(finite(n(m["liveVolumeUSDT"])), "Volume"); result["Volume"] = result["liveVolume"]
        for (key, value) in [("emaSlope", percent(ema, previousEMA)), ("emaDistance", percent(close, ema)), ("bodyChange", percent(close, open)), ("candleRange", percent(n(row["currentHigh"]), n(row["currentLow"]))), ("vwapDistance", percent(close, n(m["vwap14"]))) ] { result[key] = scalar(value, key) }
        for (key, value) in [("emaTrend", result["emaSlope"]?.number), ("oiTrend", result["oiChange"]?.number)] { result[key] = value.map { .text($0 > 0 ? "rising" : $0 < 0 ? "falling" : "flat") } ?? .unknown("\(key) is unavailable.") }
        result["emaBody"] = candleBodyRelation(open, close, ema).map(FilterScalar.text) ?? .unknown("Body or EMA200 is unavailable.")
        result["priceEMA"] = relation(close, ema); result["candleDirection"] = relation(close, open)
        result["rsi6vs12"] = relation(n(row["rsi6"]), n(row["rsi12"])); result["rsi12vs24"] = relation(n(row["rsi12"]), n(row["rsi24"]))
        result["rocVsMaroc"] = relation(n(row["roc"]), n(row["maroc"])); result["buyVsSell"] = relation(n(row["buy"]), n(row["sell"]))
        result["oiUSD"] = scalar(finite(n(m["oiUSD"])).map { $0 / 1_000_000 }, "OI")
        result["turnover"] = scalar(n(row["turnover24hUSDT"]).map { $0 / 1_000_000 }, "Turnover"); result["spread"] = scalar(finite(n(m["spreadPercent"])), "Spread")
        for (key, band) in [("priceUpper", "bbUpper"), ("priceMiddle", "bbMiddle"), ("priceLower", "bbLower")] { result[key] = relation(close, n(m[band])) }
        result["highUpper"] = relation(finite(n(row["currentHigh"])), finite(n(m["bbUpper"])))
        result["lowLower"] = relation(finite(n(row["currentLow"])), finite(n(m["bbLower"])))
        for (key, band) in [("bodyUpper", "bbUpper"), ("bodyLower", "bbLower")] {
            result[key] = candleBodyRelation(open, close, n(m[band])).map(FilterScalar.text) ?? .unknown("Body or Log BB is unavailable in the live snapshot.")
        }
        result["bbZone"] = (row["logBBAboveBand"] as? String).map(FilterScalar.text) ?? .unknown("Log BB is unavailable.")
        result["bbWidth"] = scalar(logBBBandWidth(n(m["bbUpper"]), n(m["bbMiddle"]), n(m["bbLower"])), "Bandwidth")
        let expansion = row["logBBExpansion"] as? [String: Any]
        result["bbExpansion"] = scalar(n(expansion?["hours"]), "Expansion")
        result["bbExpansionComplete"] = (expansion?["complete"] as? Bool).map { .text($0 ? "complete" : "partial") } ?? .unknown("Expansion history is unavailable.")
        result["priceVWAP"] = relation(close, n(m["vwap14"]))
        for hours in [48, 96] {
            for high in [true, false] {
                let title = high ? "High" : "Low", suffix = "\(hours)", prior = finite(n(m["prior\(title)\(suffix)"]))
                for wick in [true, false] {
                    let key = (wick ? title.lowercased() : "close\(title)") + suffix, current = finite(wick ? n(row["current\(title)"]) : close)
                    result[key] = current.flatMap { a in prior.map { b in .text((high ? a > b : a < b) ? "yes" : "no") } } ?? .unknown("Breakout reference history is unavailable.")
                }
                let field = high ? "highBreakout" : "lowBreakdown", event = row[field + (hours == 96 ? "96" : "")] as? [String: Any]
                let status = event?["status"] as? String
                result["recent\(title)\(suffix)"] = status == "event" ? .text("yes") : status == "none" ? .text("no") : .unknown("Breakout history is incomplete.")
                result[title.lowercased() + suffix + "Age"] = scalar(status == "event" ? n(event?["hoursAgo"]) : nil, "Breakout age")
                if hours == 48 { result[high ? "highPriorAge" : "lowPriorAge"] = scalar(status == "event" ? n(event?["priorAgeHours"]) : nil, "Previous \(title.lowercased()) age") }
            }
        }
        let opportunity = row["opportunity"] as? [String: Any]
        for (key, field) in [("opportunityStatus", "status"), ("opportunityDirection", "direction"), ("opportunitySetup", "setup")] {
            if let opportunity { result[key] = (opportunity[field] as? String).map(FilterScalar.text) ?? .unknown("Opportunity has no \(field).") }
        }
        if let opportunity { result["opportunityScore"] = scalar(n(opportunity["score"]), "Opportunity score") }
        return result
    }
}
