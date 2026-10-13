import Foundation

struct MarketSnapshotInput: Sendable {
    let id: String, hour: Int64, now: Int64
    let candles: [Int64: Candle]
    var listedAt: Int64?
    var turnover: Double?
    var spreadPercent: Double?
    var quoteTimestamp: Int64 = 0
    var lastPrice: Double?
    var buy: Double?
    var sell: Double?
    var takerRatio: Double?
    var currentOI: Double?
    var currentOIUSD: Double?
    var previousOI: Double?
    var previousEMA: Double?

    func calculate(rocPeriod: Int, marocPeriod: Int) -> MarketSnapshotRow {
        let null = NSNull()
        let bars = candles
        let breaks = recentExtremesBreaks(bars, hour, listedAt: listedAt)
        let breaks96 = recentExtremesBreaks(bars, hour, listedAt: listedAt, lookbackHours: 96)
        let extremes48 = priorExtremes(bars, hour, hours: 48)
        let extremes96 = priorExtremes(bars, hour, hours: 96)
        let (upper, middle, lower) = logBB(bars, hour)
        let (roc, maroc) = rocMaroc(bars, hour, rocPeriod, marocPeriod)
        let current = bars[hour], previous = bars[hour - hourMS]
        let live = current?.confirmed == false ? current : nil
        let liveEMA = updatedEMA200(previousEMA, close: live?.close)
        let (oldRoc, oldMaroc) = previous?.confirmed == true ? rocMaroc(bars, hour - hourMS, rocPeriod, marocPeriod) : (nil, nil)
        let price = current?.close
        var result: [String: Any] = [
            "instId": id, "turnover24hUSDT": turnover as Any? ?? null, "price": price as Any? ?? null,
            "lastPrice": lastPrice as Any? ?? null,
            "priceChange": percentageSnapshot(percentChange(price, previous?.confirmed == true ? previous?.close : nil)),
            "currentLow": live?.low as Any? ?? null, "currentHigh": live?.high as Any? ?? null,
            "ema200Signal": ema200Signal(live, liveEMA)?.rawValue as Any? ?? null,
            "buy": buy as Any? ?? null, "sell": sell as Any? ?? null,
            "takerRatio": takerRatio as Any? ?? null,
            "oiChange": percentageSnapshot(percentChange(currentOI, previousOI)),
            "highBreakout": breaks.highBreakout.snapshot,
            "lowBreakdown": breaks.lowBreakdown.snapshot,
            "highBreakout96": breaks96.highBreakout.snapshot,
            "lowBreakdown96": breaks96.lowBreakdown.snapshot,
            "roc": percentageSnapshot(roc), "maroc": percentageSnapshot(maroc),
            "rocChange": percentageSnapshot(percentChange(roc, oldRoc)),
            "marocChange": percentageSnapshot(percentChange(maroc, oldMaroc)),
            "rsi6": rsi(bars, hour, 6) as Any? ?? null,
            "rsi12": rsi(bars, hour, 12) as Any? ?? null,
            "rsi24": rsi(bars, hour, 24) as Any? ?? null,
            "logBBAboveBand": logBBAboveBand(price, upper, middle, lower)?.rawValue as Any? ?? null,
            "logBBExpansion": logBBExpansion(bars, hour, listedAt: listedAt)?.snapshot as Any? ?? null,
            "filterMetrics": [
                "liveOpen": live?.open as Any? ?? null, "liveClose": live?.close as Any? ?? null,
                "ema200": liveEMA as Any? ?? null, "previousEMA200": previousEMA as Any? ?? null,
                "vwap14": vwap14(bars, hour) as Any? ?? null,
                "bbUpper": upper as Any? ?? null, "bbMiddle": middle as Any? ?? null, "bbLower": lower as Any? ?? null,
                "priorHigh48": extremes48.high as Any? ?? null, "priorLow48": extremes48.low as Any? ?? null,
                "priorHigh96": extremes96.high as Any? ?? null, "priorLow96": extremes96.low as Any? ?? null,
                "oiUSD": currentOIUSD as Any? ?? null, "spreadPercent": spreadPercent as Any? ?? null,
                "liveVolumeUSDT": live?.quoteVolume as Any? ?? null,
            ],
        ]
        let context = FilterMarketData(id: id, hour: hour, now: now, listedAt: listedAt, candles: bars,
            stats: [:], quotes: [:], current: LegacyFilterReadings.from(result), previousEMA: previousEMA)
        result["opportunity"] = FilterEvaluator(market: context, filter: CompiledFilter(config: FilterConfigV2())).opportunity(at: hour).snapshot
        return MarketSnapshotRow(fields: result)
    }

    func filterData(row: [String: Any]) -> FilterMarketData {
        .init(id: id, hour: hour, now: now, listedAt: listedAt, candles: candles,
            stats: [hour: .init(oi: currentOI, oiUSD: currentOIUSD, sell: sell, buy: buy)],
            quotes: [hour: .init(turnover: turnover, spread: spreadPercent, timestamp: quoteTimestamp)],
            current: LegacyFilterReadings.from(row), previousEMA: previousEMA)
    }
}

// The bridge payload contains only immutable JSON values (numbers, strings,
// arrays, dictionaries, and NSNull). No mutable Foundation objects cross actors.
struct MarketSnapshotRow: @unchecked Sendable {
    let fields: [String: Any]
}

actor MarketSnapshotWorker {
    func calculate(_ inputs: [MarketSnapshotInput], rocPeriod: Int, marocPeriod: Int) async throws -> [String: MarketSnapshotRow] {
        guard !inputs.isEmpty else { return [:] }
        return try await withThrowingTaskGroup(of: (String, MarketSnapshotRow).self) { group in
            // Leave cores for WebKit and cancellation delivery; snapshot work
            // otherwise completes a large obsolete generation before its
            // cancellation can be observed under a saturated process pool.
            let limit = max(1, min(inputs.count, max(2, ProcessInfo.processInfo.activeProcessorCount / 2)))
            var next = 0
            for _ in 0..<limit {
                let input = inputs[next]; next += 1
                group.addTask { try Task.checkCancellation(); return (input.id, input.calculate(rocPeriod: rocPeriod, marocPeriod: marocPeriod)) }
            }
            var rows: [String: MarketSnapshotRow] = [:]
            rows.reserveCapacity(inputs.count)
            while let (id, row) = try await group.next() {
                rows[id] = row
                if next < inputs.count {
                    let input = inputs[next]; next += 1
                    group.addTask { try Task.checkCancellation(); return (input.id, input.calculate(rocPeriod: rocPeriod, marocPeriod: marocPeriod)) }
                }
            }
            return rows
        }
    }
}
