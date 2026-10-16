import Foundation

struct NativeOpportunityInput: Sendable {
    var signal: String?
    var priceChange: Double?, roc: Double?, maroc: Double?, rsi6: Double?, rsi12: Double?, rsi24: Double?, taker: Double?, oi: Double?
    var band: String?
    var expansion: BandWidthExpansion?
    var high: BreakResult = .none
    var low: BreakResult = .none
}

struct NativeOpportunity: Sendable {
    var direction: String?
    var setup: String?
    var status: String
    var score: Int?
    var components: [String: Double]?
    var reasons: [String]
    var snapshot: [String: Any] {
        ["direction": direction as Any? ?? NSNull(), "setup": setup as Any? ?? NSNull(), "status": status, "score": score as Any? ?? NSNull(),
         "components": components as Any? ?? NSNull(), "reasons": reasons]
    }
    static func evaluate(_ input: NativeOpportunityInput) -> Self {
        func finite(_ x: Double?) -> Double? { x?.isFinite == true ? x : nil }
        func range(_ x: Double?, _ min: Double, _ max: Double) -> Double? { guard let x = finite(x), x >= min, x <= max else { return nil }; return x }
        func bonus(_ x: Double?, _ cap: Double) -> Double { x.map { 10 * min(1, max(0, $0 / cap)) } ?? 0 }
        let direction = ["Long", "Short"].contains(input.signal ?? "") ? input.signal : nil
        let price = finite(input.priceChange), roc = finite(input.roc), maroc = finite(input.maroc)
        let rsi6 = range(input.rsi6, 0, 100), rsi12 = range(input.rsi12, 0, 100), rsi24 = range(input.rsi24, 0, 100)
        let band = ["below": 0, "lower": 1, "middle": 2, "upper": 3][input.band ?? ""]
        let taker = range(input.taker, -100, 100), oi = finite(input.oi)
        var missing: [String] = [], optional: [String] = []
        if direction == nil && input.signal != "Unsure" { missing.append("EMA200 is unavailable or invalid.") }
        for (label, value) in [("Price change", price), ("ROC", roc), ("MAROC", maroc), ("RSI6", rsi6), ("RSI12", rsi12), ("RSI24", rsi24)] {
            if value == nil { missing.append("\(label) is unavailable or invalid.") }
        }
        if band == nil { missing.append("Log BB position is unavailable or invalid.") }
        if input.expansion == nil || input.expansion!.hours < 0 { missing.append("Log BB expansion is unavailable or invalid.") }
        if taker == nil { optional.append("Taker imbalance is unavailable or invalid; its participation bonus is zero.") }
        if oi == nil { optional.append("OI change is unavailable or non-finite; its participation bonus is zero.") }
        guard missing.isEmpty, let price, let roc, let maroc, let rsi6, let rsi12, let rsi24, let band, let expansion = input.expansion else {
            return Self(direction: direction, setup: nil, status: "Incomplete", score: nil, components: nil, reasons: missing + optional)
        }
        guard let direction else {
            return Self(direction: nil, setup: nil, status: "Watch", score: 0,
                        components: ["trend": 0, "entry": 0, "participation": 0, "timing": 0, "penalty": 0],
                        reasons: ["The live candle body crosses or touches EMA200; direction is unclear."] + optional)
        }
        let sign: Double = direction == "Long" ? 1 : -1
        let dPrice = sign * price, dROC = sign * roc, dMAROC = sign * maroc, dTaker = taker.map { sign * $0 }
        let fast = direction == "Long" ? rsi6 : 100 - rsi6, medium = direction == "Long" ? rsi12 : 100 - rsi12, slow = direction == "Long" ? rsi24 : 100 - rsi24
        let position = direction == "Long" ? band : 3 - band, hours = expansion.hours, complete = expansion.complete
        let priceConfirms = dPrice > 0, takerConfirms = (dTaker ?? 0) > 0
        let startup = slow > 50 && dROC >= dMAROC && dMAROC > 0 && fast >= 50 && fast < 75 && medium >= 50 && medium < 70 && fast > medium && position >= 2 && complete && hours >= 1 && hours <= 3 && (priceConfirms || takerConfirms)
        let pullback = slow > 50 && dMAROC > 0 && fast >= 40 && fast <= 60 && medium >= 45 && medium <= 65 && fast <= medium && (position == 1 || position == 2) && priceConfirms && takerConfirms
        let setup: String? = startup ? "Startup" : pullback ? "Pullback" : nil
        var reasons = ["The live candle body is \(direction == "Long" ? "above" : "below") EMA200."]
        if dROC > 0 { reasons.append("ROC supports the direction.") }
        if dMAROC > 0 { reasons.append("MAROC supports the direction.") }
        if slow > 50 { reasons.append("RSI24 supports the direction.") }
        if setup == "Startup" { reasons.append("Startup: strengthening momentum with a complete 1–3h expansion.") }
        else if setup == "Pullback" { reasons.append("Pullback: RSI cooling inside Log BB with price and taker confirmation.") }
        else { reasons.append("No Startup or Pullback setup matches the live readings.") }
        if priceConfirms && takerConfirms { reasons.append("Price and taker flow both confirm the direction.") }
        else if priceConfirms || takerConfirms { reasons.append("Only \(priceConfirms ? "price" : "taker flow") confirms the direction.") }
        else { reasons.append("Neither price nor taker flow confirms the direction.") }
        if taker != nil { reasons.append(takerConfirms ? "Same-direction taker participation adds up to 10 points, capped at 20%." : "Taker flow adds no participation bonus.") }
        if let oi { reasons.append(oi > 0 ? "Rising OI value adds up to 10 points, capped at 5%; it does not determine direction." : "Flat or falling OI value adds no participation bonus.") }
        reasons += optional
        let event = direction == "Long" ? input.high : input.low
        var breakBonus = 0, expansionBonus = 0
        if case .event(let e) = event, e.hoursAgo >= 0 {
            breakBonus = e.hoursAgo <= 3 ? 10 : e.hoursAgo <= 12 ? 5 : 0
            if breakBonus > 0 { reasons.append("\(direction == "Long" ? "High breakout" : "Low breakdown") \(e.hoursAgo)h ago supports entry timing.") }
        } else if event == .loading || event == .insufficientHistory { reasons.append("Same-direction break history is incomplete; no break timing bonus.") }
        if complete {
            if setup == "Pullback" { expansionBonus = hours <= 2 ? 10 : hours <= 5 ? 5 : 0 }
            else { expansionBonus = hours >= 1 && hours <= 3 ? 10 : hours >= 4 && hours <= 6 ? 5 : 0 }
            if expansionBonus > 0 { reasons.append("A complete \(hours)h expansion supports \(setup == "Pullback" ? "pullback" : "early-entry") timing.") }
        } else { reasons.append("Expansion is a lower bound (≥ \(hours)h); no expansion timing bonus.") }
        var penalty = 0
        if fast >= 70 { penalty += 10; reasons.append("RSI6 \(direction == "Long" ? "≥ 70" : "≤ 30"): fast momentum is stretched (−10).") }
        if medium >= 65 { penalty += 10; reasons.append("RSI12 \(direction == "Long" ? "≥ 65" : "≤ 35"): medium momentum is stretched (−10).") }
        if position == 3 { penalty += 10; reasons.append("Price is \(direction == "Long" ? "above the upper" : "at or below the lower") Log BB band (−10).") }
        if hours >= 4 { penalty += 10; reasons.append("Expansion has lasted \(complete ? "" : "at least ")\(hours)h (−10).") }
        let extremeRSI = fast >= 80 && medium >= 70, stretchedBand = position == 3 && fast >= 75, extendedBand = position == 3 && hours >= 6 && medium >= 65
        let overheated = extremeRSI || stretchedBand || extendedBand
        if extremeRSI { reasons.append("RSI6 and RSI12 are extreme together: Overheated.") }
        if stretchedBand { reasons.append("An outer-band reading combines with extreme RSI6: Overheated.") }
        if extendedBand { reasons.append("Outer-band price, extended expansion and elevated RSI12 combine: Overheated.") }
        let components: [String: Double] = [
            "trend": 15 + (dROC > 0 ? 5 : 0) + (dMAROC > 0 ? 5 : 0) + (slow > 50 ? 5 : 0),
            "entry": (setup == nil ? 0 : 20) + (priceConfirms && takerConfirms ? 10 : priceConfirms || takerConfirms ? 5 : 0),
            "participation": bonus(dTaker, 20) + bonus(oi, 5), "timing": Double(breakBonus + expansionBonus), "penalty": Double(penalty)]
        let score = Int(max(0, min(100, components["trend"]! + components["entry"]! + components["participation"]! + components["timing"]! - components["penalty"]!)).rounded())
        let status = overheated ? "Overheated" : setup != nil && score >= 65 ? "Candidate" : "Watch"
        if !overheated && setup != nil && score < 65 { reasons.append("The entry setup is below the 65-point Candidate threshold.") }
        return Self(direction: direction, setup: setup, status: status, score: score, components: components, reasons: reasons)
    }
}
