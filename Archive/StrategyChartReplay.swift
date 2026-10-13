// ARCHIVED: Radar strategy chart backtesting
//
// This file intentionally lives outside Sources/ and is not part of any Swift
// Package target. It is retained only as reference while Strategy backtest
// results are hidden from Radar. Do not move it into Sources/ without an
// explicit product decision to restore that feature.

import Foundation

let radarChartHours = 96

func radarStrategyReplayStart(chartEnd: Int64) -> Int64 {
    max(0, chartEnd - Int64(radarChartHours - 1) * hourMS)
}

struct StrategyChartSignal: Codable, Sendable, Equatable {
    var hour: Int64
    var price: Double
}

struct StrategyChartReplay: Codable, Sendable, Equatable {
    var fromHour: Int64
    var throughHour: Int64
    var historyHours: Int
    var completedHours = 0
    var matchedHours = 0
    var unknownHours = 0
    var signals: [StrategyChartSignal] = []
    var readings: [StrategyChartReading] = []
}

struct StrategyChartReading: Codable, Sendable, Equatable {
    var hour: Int64
    var result: String
    var completed: Bool
}

/// Replays a saved strategy one completed hour at a time. Archived and not compiled.
func strategyChartReplay(profile: StrategyProfile, market: FilterMarketData,
                          reference: FilterMarketData? = nil, from: Int64, through: Int64) throws -> StrategyChartReplay {
    let filters = try profile.compiled(), cooldowns = FilterCooldownMemory()
    let historyHours = ResearchVersion.warmup(filters)
    var output = StrategyChartReplay(fromHour: from, throughHour: through, historyHours: historyHours)
    guard from <= through else { return output }
    func rollingContext(_ input: FilterMarketData, at anchor: Int64) -> FilterMarketData {
        var result = input
        let first = max(0, anchor - Int64(historyHours) * hourMS)
        result.candles = input.candles.filter { $0.key >= first && $0.key <= anchor }
        result.stats = input.stats.filter { $0.key >= first && $0.key <= anchor }
        result.quotes = input.quotes.filter { $0.key >= first && $0.key <= anchor }
        result.historicalReadings = nil
        let recordedQuotes = result.quotes
        let series = ResearchEngine.reconstruct(.init(candles: result.candles, stats: result.stats, quotes: result.quotes))
        result.candles = series.candles; result.stats = series.stats
        result.quotes = Dictionary(uniqueKeysWithValues: series.quotes.map { hour, generated in
            (hour, FilterQuote(turnover: generated.turnover, spread: recordedQuotes[hour]?.spread, timestamp: generated.timestamp))
        })
        for (hour, recorded) in recordedQuotes where result.quotes[hour] == nil { result.quotes[hour] = recorded }
        return result
    }
    var episode = ResearchEpisode()
    let replayFrom = from >= hourMS ? from - hourMS : from
    for hour in stride(from: replayFrom, through: through, by: Int(hourMS)) {
        let baseline = hour < from
        var context = rollingContext(market, at: hour)
        context.hour = hour; context.now = hour + hourMS
        context.current = [:]; context.previousEMA = nil; context.historicalClose = true
        context.evaluationTime = context.now; context.cooldowns = cooldowns; context.recordCooldowns = true
        if let reference {
            var referenceAtClose = rollingContext(reference, at: hour)
            referenceAtClose.hour = hour; referenceAtClose.now = hour + hourMS
            referenceAtClose.current = [:]; referenceAtClose.previousEMA = nil; referenceAtClose.historicalClose = true
            referenceAtClose.evaluationTime = referenceAtClose.now; referenceAtClose.cooldowns = cooldowns
            context.referenceBTC = FilterReferenceSnapshot(market: referenceAtClose)
        } else { context.referenceBTC = nil }
        guard context.candles[hour]?.confirmed == true else {
            _ = episode.observe(.unknown)
            if !baseline {
                output.unknownHours += 1
                output.readings.append(.init(hour: hour, result: FilterTruth.unknown.rawValue, completed: false))
            }
            continue
        }
        if !baseline { output.completedHours += 1 }
        let traces = SuiteEvaluation.traces(context, filters: filters)
        let matches = FilterTruth.all([traces[0].result, SuiteEvaluation.truth(traces, .bullishSetup)])
        if !baseline, matches == .yes { output.matchedHours += 1 }
        if !baseline, matches == .unknown { output.unknownHours += 1 }
        if !baseline { output.readings.append(.init(hour: hour, result: matches.rawValue, completed: true)) }
        if episode.observe(matches, baseline: baseline) == "entry", let close = context.candles[hour]?.close, close.isFinite, close > 0 {
            output.signals.append(.init(hour: hour, price: close))
        }
    }
    return output
}

func strategyChartSignals(profile: StrategyProfile, market: FilterMarketData,
                          reference: FilterMarketData? = nil, from: Int64, through: Int64) throws -> [StrategyChartSignal] {
    try strategyChartReplay(profile: profile, market: market, reference: reference, from: from, through: through).signals
}
