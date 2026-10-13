import Foundation

struct FilterMetricInfo: Sendable {
    let key: String, label: String, group: String, description: String, unit: String
    let numeric: Bool
    var snapshot: [String: Any] { ["key": key, "label": label, "group": group, "description": description, "unit": unit, "numeric": numeric,
        "choices": FilterCatalog.choices(for: key).map { ["value": $0.value, "label": $0.label] }, "aliases": FilterCatalog.searchAliases(for: key)] }
}

struct FilterFunctionInfo: Sendable {
    struct Parameter: Sendable {
        let label: String, kind: String
        var minimum: Double = 1
        var step = "1"
        var unit = "hours"
        var choices: [FilterCatalog.Choice] = []
        var snapshot: [String: Any] { ["label": label, "kind": kind, "minimum": minimum, "step": step, "unit": unit, "choices": choices.map { ["value": $0.value, "label": $0.label] }] }
    }
    let name: String, signature: String, label: String, group: String, unit: String, description: String
    let parameters: [Parameter], defaults: [String]
    var snapshot: [String: Any] { ["name": name, "label": label, "group": group, "unit": unit, "description": description,
        "parameters": parameters.map(\.snapshot), "defaults": defaults] }
}

enum FilterCatalog {
    static func searchAliases(for key: String) -> [String] {
        switch key {
        case "oiTrend": return ["OI", "open interest trend", "持仓趋势", "持仓上涨"]
        case "emaBody": return ["candle body", "实体", "K线", "above EMA", "below EMA"]
        case "highUpper": return ["high", "wick", "upper band", "最高价", "布林上轨"]
        case "lowLower": return ["low", "wick", "lower band", "最低价", "布林下轨"]
        case "bodyUpper": return ["candle body", "open close", "upper band", "实体", "布林上轨"]
        case "bodyLower": return ["candle body", "open close", "lower band", "实体", "布林下轨"]
        case "Volume", "liveVolume": return ["volume", "quote volume", "成交量", "放量"]
        case "turnover": return ["turnover", "liquidity", "成交额"]
        default: return []
        }
    }
    // The renderer builds its pickers, value blocks and help from this catalogue.
    // Adding a scalar capability must provide its editable parameter schema here.
    static let scalarFunctions: [FilterFunctionInfo] = {
        typealias P = FilterFunctionInfo.Parameter
        let period = P(label: "Period (h)", kind: "number")
        let source = P(label: "Source expression", kind: "expression", unit: "source unit")
        func indicator(_ name: String, _ signature: String, _ label: String, _ unit: String, _ parameters: [P], _ defaults: [String], _ description: String) -> FilterFunctionInfo {
            .init(name: name, signature: signature, label: label, group: "Parameterized indicators", unit: unit, description: description, parameters: parameters, defaults: defaults)
        }
        var result = [
            indicator("EMA", "EMA(n)", "EMA", "USDT", [period], ["200"], "Exponential moving average of hourly closes. The period is editable; missing hourly history is never skipped."),
            indicator("RSI", "RSI(n)", "RSI", "0–100", [period], ["14"], "Relative strength index over the selected number of hourly periods; values range from 0 to 100."),
            indicator("ROC", "ROC(n)", "ROC", "%", [period], ["9"], "Percentage price change from the close that many hours earlier."),
            indicator("Efficiency", "Efficiency(n)", "Direction efficiency", "ratio", [period], ["24"], "Absolute net close change divided by the sum of absolute hourly close changes. Complete flat history is 0; missing hours are Unknown."),
            indicator("MAROC", "MAROC(rocN, meanN)", "MAROC", "%", [P(label: "ROC period (h)", kind: "number"), P(label: "Mean period (h)", kind: "number")], ["9", "9"], "Average of hourly ROC readings, with independently editable ROC and averaging periods.")
        ]
        result += [
            indicator("LogBB", "LogBB(n, deviations, band)", "Log BB", "USDT", [period, P(label: "Deviations", kind: "number", minimum: 0, step: "any", unit: "standard deviations"), P(label: "Band", kind: "choice", unit: "band", choices: [Choice(value: "upper", label: "Upper"), Choice(value: "middle", label: "Middle"), Choice(value: "lower", label: "Lower")])], ["20", "2", "\"upper\""], "Log-price Bollinger band with editable period, deviations and band."),
            indicator("VWAP", "VWAP(n)", "VWAP", "USDT", [period], ["14"], "Volume-weighted average price over the specified hourly window."),
            indicator("PriorExtreme", "PriorExtreme(n, extreme)", "Prior extreme", "USDT", [P(label: "Reference hours", kind: "number"), P(label: "Extreme", kind: "choice", unit: "extreme", choices: [Choice(value: "high", label: "High"), Choice(value: "low", label: "Low")])], ["48", "\"high\""], "Highest high or lowest low of the previous completed hours. Excludes the evaluated candle.")
        ]
        result.append(indicator("ExtremeAge", "ExtremeAge(n, searchHours, direction)", "Extreme event age", "hours", [P(label: "Reference hours", kind: "number"), P(label: "Search hours", kind: "number"), P(label: "Direction", kind: "choice", unit: "direction", choices: [Choice(value: "breakout", label: "High breakout"), Choice(value: "breakdown", label: "Low breakdown")])], ["48", "48", "\"breakout\""], "Hours since the latest strict high breakout or low breakdown in the editable search window. No event or insufficient history is Unknown."))
        func transform(_ name: String, _ label: String, _ unit: String, _ parameters: [P], _ defaults: [String], _ description: String) -> FilterFunctionInfo {
            .init(name: name, signature: "\(name)(x\(parameters.count > 1 ? ", n" : ""))", label: label, group: "Expression functions", unit: unit, description: description, parameters: parameters, defaults: defaults)
        }
        result.append(transform("abs", "Absolute value", "source unit", [source], ["Price"], "Magnitude of a numeric value; keeps the source unit."))
        for (name, label) in [("mean", "Mean"), ("sum", "Sum"), ("highest", "Highest"), ("lowest", "Lowest"), ("stddev", "Standard deviation")] {
            result.append(transform(name, label, "source unit", [source, P(label: "Window hours", kind: "number")], ["Volume", "20"], "Includes the evaluated hour and preceding hourly slots. Add a one-hour offset to use only previous closed candles. Any missing slot makes this value Unknown."))
        }
        result += [
            transform("multiple", "Positive baseline multiple", "source unit", [source, P(label: "Multiplier", kind: "number", minimum: Double.leastNonzeroMagnitude, step: "any", unit: "× baseline")], ["mean(lag(Volume, 1), 20)", "2"], "Multiplies a strictly positive baseline by a positive constant. A zero, negative or unavailable baseline is Unknown."),
            transform("lag", "Historical offset", "source unit", [source, P(label: "Offset hours", kind: "number", minimum: 0)], ["Volume", "1"], "Reads the source that many hours before the rule's evaluation hour."),
            transform("change", "Change rate", "%", [source, P(label: "Offset hours", kind: "number")], ["Price", "1"], "Percentage change from the earlier value, divided by its absolute value."),
            transform("relativeChange", "Relative change", "%", [source, P(label: "Baseline expression", kind: "expression", unit: "source unit")], ["Close", "Open"], "Percentage difference between two editable values: (current − baseline) / |baseline| × 100%."),
            transform("closed", "Previous closed hour", "source unit", [source], ["Price"], "Shifts this value one hour before the rule's anchor. A parent Closed anchor also applies."),
            transform("live", "Current evaluation hour", "source unit", [source], ["Price"], "Reads at the rule's current anchor; it does not cancel a parent's Closed anchor.")
        ]
        result.append(.init(name: "BTC", signature: "BTC(expression, clock)", label: "BTC reference", group: "BTC Market Context", unit: "source unit",
            description: "Reads BTC-USDT-SWAP independently of the filtered contract. Aligned follows the decision hour; Live uses the forming BTC hour; Closed uses the latest completed BTC hour. Explicit offsets apply once. Live data older than 30 seconds is Unknown.",
            parameters: [source, P(label: "BTC clock", kind: "choice", unit: "clock", choices: [.init(value: "aligned", label: "Aligned with decision"), .init(value: "live", label: "Live BTC hour"), .init(value: "closed", label: "Latest closed BTC hour")])], defaults: ["ROC(1)", "\"aligned\""]))
        return result
    }()
    struct Choice: Sendable { let value: String, label: String }
    static func choices(for key: String) -> [Choice] {
        switch key {
        case "emaTrend", "oiTrend": return [.init(value: "rising", label: "Rising"), .init(value: "flat", label: "Flat"), .init(value: "falling", label: "Falling")]
        case "emaBody": return [.init(value: "above", label: "Entire body above"), .init(value: "below", label: "Entire body below"), .init(value: "cross-up", label: "Crossing upward"), .init(value: "cross-down", label: "Crossing downward"), .init(value: "touching", label: "Touching EMA200")]
        case "bodyUpper", "bodyLower": return [.init(value: "above", label: "Entire body above"), .init(value: "below", label: "Entire body below"), .init(value: "cross-up", label: "Crossing upward"), .init(value: "cross-down", label: "Crossing downward"), .init(value: "touching", label: key == "bodyUpper" ? "Touching upper band" : "Touching lower band")]
        case "candleDirection": return [.init(value: "above", label: "Bullish"), .init(value: "below", label: "Bearish"), .init(value: "equal", label: "Doji")]
        case "priceEMA", "rsi6vs12", "rsi12vs24", "rocVsMaroc", "buyVsSell", "priceUpper", "priceMiddle", "priceLower", "highUpper", "lowLower", "priceVWAP": return [.init(value: "above", label: "Above / greater"), .init(value: "equal", label: "Equal"), .init(value: "below", label: "Below / less")]
        case "high48", "high96", "closeHigh48", "closeHigh96", "low48", "low96", "closeLow48", "closeLow96", "recentHigh48", "recentHigh96", "recentLow48", "recentLow96": return [.init(value: "yes", label: "Yes"), .init(value: "no", label: "No")]
        case "bbZone": return [.init(value: "upper", label: "Above upper"), .init(value: "middle", label: "Middle < price ≤ upper"), .init(value: "lower", label: "Lower < price ≤ middle"), .init(value: "below", label: "At / below lower")]
        case "bbExpansionComplete": return [.init(value: "complete", label: "Complete"), .init(value: "partial", label: "Lower bound (≥)")]
        case "opportunityStatus": return ["Candidate", "Watch", "Overheated", "Incomplete"].map { .init(value: $0, label: $0) }
        case "opportunityDirection": return ["Long", "Short"].map { .init(value: $0, label: $0) }
        case "opportunitySetup": return ["Startup", "Pullback"].map { .init(value: $0, label: $0) }
        default: return []
        }
    }
    static let metrics: [FilterMetricInfo] = [
        .init(key: "emaTrend", label: "EMA200 trend", group: "EMA & candle", description: "EMA200 at the selected hour compared with the preceding hour's EMA200.", unit: "category", numeric: false),
        .init(key: "emaSlope", label: "EMA200 hourly slope (%)", group: "EMA & candle", description: "Percentage change of EMA200 from the preceding hour's EMA200.", unit: "%", numeric: true),
        .init(key: "emaBody", label: "Candle body vs EMA200", group: "EMA & candle", description: "Selected hourly open and close only; wicks do not affect this relation. Touching includes equality at either end.", unit: "category", numeric: false),
        .init(key: "priceEMA", label: "Price vs EMA200", group: "EMA & candle", description: "Selected hourly close compared with EMA200 at that hour.", unit: "category", numeric: false),
        .init(key: "emaDistance", label: "Distance from EMA200 (%)", group: "EMA & candle", description: "Signed (selected hourly close − EMA200) / EMA200 × 100%.", unit: "%", numeric: true),
        .init(key: "candleDirection", label: "Candle direction", group: "EMA & candle", description: "Selected hourly close compared with its open.", unit: "category", numeric: false),
        .init(key: "bodyChange", label: "Body change (%)", group: "EMA & candle", description: "Signed change from selected hourly open to selected hourly close; excludes wicks.", unit: "%", numeric: true),
        .init(key: "candleRange", label: "High–low range (%)", group: "EMA & candle", description: "(Selected hourly high − selected hourly low) / selected hourly low × 100%.", unit: "%", numeric: true),
        .init(key: "rsi6", label: "RSI6", group: "RSI", description: "RSI at the selected hour over 6 one-hour periods; 0–100.", unit: "0–100", numeric: true),
        .init(key: "rsi12", label: "RSI12", group: "RSI", description: "RSI at the selected hour over 12 one-hour periods; 0–100.", unit: "0–100", numeric: true),
        .init(key: "rsi24", label: "RSI24", group: "RSI", description: "RSI at the selected hour over 24 one-hour periods; 0–100.", unit: "0–100", numeric: true),
        .init(key: "rsi6vs12", label: "RSI6 vs RSI12", group: "RSI", description: "Compare the fast and medium RSI readings.", unit: "category", numeric: false),
        .init(key: "rsi12vs24", label: "RSI12 vs RSI24", group: "RSI", description: "Compare the medium and slow RSI readings.", unit: "category", numeric: false),
        .init(key: "roc", label: "ROC9 (%)", group: "Momentum", description: "9-hour price change. Use Positive / Negative and Absolute value ≥ as separate conditions.", unit: "%", numeric: true),
        .init(key: "maroc", label: "MAROC9 (%)", group: "Momentum", description: "Mean of nine hourly ROC9 readings, in percent.", unit: "%", numeric: true),
        .init(key: "rocVsMaroc", label: "ROC vs MAROC", group: "Momentum", description: "Compare the current ROC and MAROC readings.", unit: "category", numeric: false),
        .init(key: "rocChange", label: "ROC hourly change (%)", group: "Momentum", description: "(ROC − previous ROC) / |previous ROC| × 100%.", unit: "%", numeric: true),
        .init(key: "marocChange", label: "MAROC hourly change (%)", group: "Momentum", description: "(MAROC − previous MAROC) / |previous MAROC| × 100%.", unit: "%", numeric: true),
        .init(key: "high48", label: "Wick breaks 48h high", group: "Breakouts", description: "Selected hourly high strictly exceeds the previous 48 completed hourly highs. A retreat does not undo a wick break.", unit: "category", numeric: false),
        .init(key: "high96", label: "Wick breaks 96h high", group: "Breakouts", description: "Selected hourly high strictly exceeds the previous 96 completed hourly highs.", unit: "category", numeric: false),
        .init(key: "closeHigh48", label: "Close above 48h high", group: "Breakouts", description: "Selected hourly close is still strictly above the previous 48 completed hourly highs.", unit: "category", numeric: false),
        .init(key: "closeHigh96", label: "Close above 96h high", group: "Breakouts", description: "Selected hourly close is still strictly above the previous 96 completed hourly highs.", unit: "category", numeric: false),
        .init(key: "low48", label: "Wick breaks 48h low", group: "Breakouts", description: "Selected hourly low strictly falls below the previous 48 completed hourly lows.", unit: "category", numeric: false),
        .init(key: "low96", label: "Wick breaks 96h low", group: "Breakouts", description: "Selected hourly low strictly falls below the previous 96 completed hourly lows.", unit: "category", numeric: false),
        .init(key: "closeLow48", label: "Close below 48h low", group: "Breakouts", description: "Selected hourly close is still strictly below the previous 48 completed hourly lows.", unit: "category", numeric: false),
        .init(key: "closeLow96", label: "Close below 96h low", group: "Breakouts", description: "Selected hourly close is still strictly below the previous 96 completed hourly lows.", unit: "category", numeric: false),
        .init(key: "recentHigh48", label: "Recent 48h high breakout", group: "Breakouts", description: "At least one 48h high breakout in the selected hour or previous 47 hours. Loading or insufficient history is unavailable.", unit: "category", numeric: false),
        .init(key: "recentHigh96", label: "Recent 96h high breakout", group: "Breakouts", description: "At least one 96h high breakout in the selected hour or previous 47 hours.", unit: "category", numeric: false),
        .init(key: "recentLow48", label: "Recent 48h low breakdown", group: "Breakouts", description: "At least one 48h low breakdown in the selected hour or previous 47 hours.", unit: "category", numeric: false),
        .init(key: "recentLow96", label: "Recent 96h low breakdown", group: "Breakouts", description: "At least one 96h low breakdown in the selected hour or previous 47 hours.", unit: "category", numeric: false),
        .init(key: "high48Age", label: "48h breakout age (h)", group: "Breakouts", description: "Hours since the latest 48h high breakout, within the 48h search window. The selected hour is 0; no event is unavailable.", unit: "hours", numeric: true),
        .init(key: "high96Age", label: "96h breakout age (h)", group: "Breakouts", description: "Hours since the latest 96h high breakout, within the 48h search window. The selected hour is 0.", unit: "hours", numeric: true),
        .init(key: "low48Age", label: "48h breakdown age (h)", group: "Breakouts", description: "Hours since the latest 48h low breakdown. The selected hour is 0; no event is unavailable.", unit: "hours", numeric: true),
        .init(key: "low96Age", label: "96h breakdown age (h)", group: "Breakouts", description: "Hours since the latest 96h low breakdown. The selected hour is 0.", unit: "hours", numeric: true),
        .init(key: "highPriorAge", label: "Previous high age at break (h)", group: "Breakouts", description: "Age of the previous 48h high at the latest breakout; tied highs use the most recent occurrence.", unit: "hours", numeric: true),
        .init(key: "lowPriorAge", label: "Previous low age at break (h)", group: "Breakouts", description: "Age of the previous 48h low at the latest breakdown; tied lows use the most recent occurrence.", unit: "hours", numeric: true),
        .init(key: "buyVsSell", label: "Buy vs Sell", group: "Participation", description: "Compare selected-hour taker buy and sell base-currency volumes, including zero volumes.", unit: "category", numeric: false),
        .init(key: "takerRatio", label: "Taker imbalance (%)", group: "Participation", description: "(Buy − Sell) / (Buy + Sell) × 100%; −100 to 100.", unit: "%", numeric: true),
        .init(key: "buy", label: "Taker Buy (base currency)", group: "Participation", description: "Selected-hour taker buy volume in the contract's base currency (OKX unit=0).", unit: "base currency", numeric: true),
        .init(key: "sell", label: "Taker Sell (base currency)", group: "Participation", description: "Selected-hour taker sell volume in the contract's base currency (OKX unit=0).", unit: "base currency", numeric: true),
        .init(key: "oiTrend", label: "OI Trend", group: "Open interest", description: "Open-interest contracts at the selected hour compared with the preceding hourly contracts; rising / flat / falling.", unit: "category", numeric: false),
        .init(key: "oiChange", label: "OI hourly change (%)", group: "Open interest", description: "Change in OI contracts: (OI − previous OI) / |previous OI| × 100%; unaffected by price-only changes.", unit: "%", numeric: true),
        .init(key: "oiUSD", label: "Open interest (M USD)", group: "Open interest", description: "Open interest at the selected hour in millions of USD.", unit: "M USD", numeric: true),
        .init(key: "priceUpper", label: "Price vs Log BB upper", group: "Bands & VWAP", description: "Selected hourly close compared with the 20h upper log-price Bollinger band. Equality is explicit.", unit: "category", numeric: false),
        .init(key: "priceMiddle", label: "Price vs Log BB middle", group: "Bands & VWAP", description: "Selected hourly close compared with the 20h middle log-price Bollinger band.", unit: "category", numeric: false),
        .init(key: "priceLower", label: "Price vs Log BB lower", group: "Bands & VWAP", description: "Selected hourly close compared with the 20h lower log-price Bollinger band.", unit: "category", numeric: false),
        .init(key: "highUpper", label: "High vs Log BB upper", group: "Bands & VWAP", description: "Selected hourly high compared with the 20h upper log-price Bollinger band (2 standard deviations). Includes the upper wick; equality is explicit.", unit: "category", numeric: false),
        .init(key: "lowLower", label: "Low vs Log BB lower", group: "Bands & VWAP", description: "Selected hourly low compared with the 20h lower log-price Bollinger band (2 standard deviations). Includes the lower wick; equality is explicit.", unit: "category", numeric: false),
        .init(key: "bodyUpper", label: "Candle body vs Log BB upper", group: "Bands & VWAP", description: "Selected hourly open and close compared with the 20h upper log-price Bollinger band (2 standard deviations). Wicks do not affect this relation. Touching includes equality at either end.", unit: "category", numeric: false),
        .init(key: "bodyLower", label: "Candle body vs Log BB lower", group: "Bands & VWAP", description: "Selected hourly open and close compared with the 20h lower log-price Bollinger band (2 standard deviations). Wicks do not affect this relation. Touching includes equality at either end.", unit: "category", numeric: false),
        .init(key: "bbZone", label: "Log BB price zone", group: "Bands & VWAP", description: "Matches the list's highest band strictly below the selected hourly close. Equality belongs to the lower zone.", unit: "category", numeric: false),
        .init(key: "bbWidth", label: "Log BB bandwidth (%)", group: "Bands & VWAP", description: "(Upper − Lower) / Middle × 100% for the selected hour's 20h bands.", unit: "%", numeric: true),
        .init(key: "bbExpansion", label: "Known bandwidth expansion (h)", group: "Bands & VWAP", description: "Known consecutive hours of expanding bandwidth. A ≥ reading is a lower bound: use Expansion history = Complete for an exact duration.", unit: "hours", numeric: true),
        .init(key: "bbExpansionComplete", label: "Expansion history", group: "Bands & VWAP", description: "Complete identifies the start of the expansion run; Lower bound means older history is unavailable.", unit: "category", numeric: false),
        .init(key: "priceVWAP", label: "Price vs VWAP14", group: "Bands & VWAP", description: "Selected hourly close compared with the volume-weighted average price over 14 hours.", unit: "category", numeric: false),
        .init(key: "vwapDistance", label: "Distance from VWAP14 (%)", group: "Bands & VWAP", description: "Signed (selected hourly close − VWAP14) / VWAP14 × 100%.", unit: "%", numeric: true),
        .init(key: "price", label: "Price (USDT)", group: "Market & opportunity", description: "Selected hourly close in USDT.", unit: "USDT", numeric: true),
        .init(key: "priceChange", label: "Hourly price change (%)", group: "Market & opportunity", description: "Selected hourly close compared with the previous completed hourly close.", unit: "%", numeric: true),
        .init(key: "turnover", label: "Estimated 24h turnover (M USDT)", group: "Market & opportunity", description: "24-hour base volume valued at the latest USDT price, in millions. This estimate differs from the sum of actual trade notionals. Closed snapshots accumulate from the v2 upgrade; earlier hours are Unknown.", unit: "M USDT", numeric: true),
        .init(key: "spread", label: "Bid–ask spread (%)", group: "Market & opportunity", description: "Ticker spread in percent at the selected hour. Closed snapshots accumulate from the v2 upgrade; earlier hours are Unknown.", unit: "%", numeric: true),
        .init(key: "liveVolume", label: "Candle volume (USDT)", group: "Market & opportunity", description: "Selected hourly candle's quote volume in USDT; live hours use accumulated volume.", unit: "USDT", numeric: true),
        .init(key: "opportunityStatus", label: "Opportunity status", group: "Market & opportunity", description: "Ranking classification at the selected hour. Scores are unchanged by filtering.", unit: "category", numeric: false),
        .init(key: "opportunityDirection", label: "Opportunity direction", group: "Market & opportunity", description: "EMA200 body direction used by Opportunity. Unclear direction is unavailable.", unit: "category", numeric: false),
        .init(key: "opportunitySetup", label: "Opportunity setup", group: "Market & opportunity", description: "Startup or Pullback; no matching setup is unavailable.", unit: "category", numeric: false),
        .init(key: "opportunityScore", label: "Opportunity score", group: "Market & opportunity", description: "Score at the selected hour, 0–100. Incomplete markets have no score.", unit: "number", numeric: true),
        .init(key: "Symbol", label: "Contract symbol", group: "Universe", description: "OKX instrument ID; no hidden symbol exclusions.", unit: "text", numeric: false),
        .init(key: "ListingAgeMonths", label: "Listing age (months)", group: "Universe", description: "Completed Gregorian calendar months in UTC since listing.", unit: "months", numeric: true),
        .init(key: "Open", label: "Candle open", group: "Candle", description: "Hourly candle opening price.", unit: "USDT", numeric: true),
        .init(key: "High", label: "Candle high", group: "Candle", description: "Hourly candle high.", unit: "USDT", numeric: true),
        .init(key: "Low", label: "Candle low", group: "Candle", description: "Hourly candle low.", unit: "USDT", numeric: true),
        .init(key: "Close", label: "Candle close", group: "Candle", description: "Live or completed hourly close.", unit: "USDT", numeric: true),
        .init(key: "Volume", label: "Quote volume", group: "Candle", description: "Hourly quote volume in USDT.", unit: "USDT", numeric: true),
    ]
    static let fields = Set(metrics.map(\.key))
    static let numericFields = Set(metrics.filter(\.numeric).map(\.key))
    static let aliases = ["price": "price", "close": "Close", "open": "Open", "high": "High", "low": "Low", "volume": "Volume", "symbol": "Symbol", "listingagemonths": "ListingAgeMonths", "oi": "oiUSD", "buy": "buy", "sell": "sell"]
    static func key(_ name: String) -> String? { fields.contains(name) ? name : aliases[name.lowercased()] ?? metrics.first { $0.key.lowercased() == name.lowercased() }?.key }
    static let functions = scalarFunctions.map(\.signature) + ["all(...)", "any(...)", "NOT condition", "between(x, min, max)", "absGte(x, threshold)", "absLte(x, threshold)", "positive(x)", "negative(x)", "zero(x)", "available(x)", "unavailable(x)", "every(condition, hours)", "recent(condition, hours)", "cooldown(condition, hours)", "count(condition, hours, \"gt\", minimum)", "crossUp(left, right)", "crossDown(left, right)", "sequence(hours, stage(\"break\", condition, gapHours, capture(\"level\", expression)), stage(\"retest\", condition, gapHours))"]
}
