import Foundation
import XCTest
@testable import PerpetualRadar

final class LongDecisionTests: XCTestCase {
    private func strategy(entry: String = "Close > 100", exit: String = "LongHeldHours >= 3") throws -> LongStrategy {
        .init(name: "Long fixture", entryJSON: try FilterCompiler.compile(source: entry).config.json, exitJSON: try FilterCompiler.compile(source: exit).config.json)
    }
    private func directory() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("LongTests-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
    private func dataset(_ entry: String = "Close > 0", _ exit: String = "LongHeldHours >= 3", hours: Int = 240, bars: [Candle]? = nil, costs: ResearchCosts? = nil) throws -> (ResearchStore, ResearchStudy, DataManifest) {
        let store = try ResearchStore(directory: directory()), rule = try strategy(entry: entry, exit: exit), hour = ResearchFixture.hour
        var spec = StudySpec(name: "Paired Long filters",kind: "long",rules: [.init(name: "Entry",filtersJSON: rule.entryJSON),.init(name: "Exit",filtersJSON: rule.exitJSON)],from: hour,through: hour+Int64(hours)*hourMS,direction: "Long")
        spec.costs = costs; try spec.validate()
        try ResearchFixture.seed(store, bars: bars ?? ResearchFixture.bars())
        let plan = ResearchFixture.plan(spec), manifest = try store.freeze(plan), study = ResearchStudy(spec: spec,planID: plan.id,manifestID: manifest.id)
        try store.put(study.id,kind: "study",study)
        return (store,study,manifest)
    }
    func testDecisionStatesCheckEntryWhileFlatAndExitWhileHolding() {
        XCTAssertEqual(LongDecision.action(entry: .yes,exit: .yes,holding: false).0,"Enter Long")
        XCTAssertEqual(LongDecision.action(entry: .yes,exit: .unknown,holding: false).0,"Enter Long", "Position-only exits are inactive before entry.")
        XCTAssertEqual(LongDecision.action(entry: .unknown,exit: .no,holding: false).0,"Unknown")
        XCTAssertEqual(LongDecision.action(entry: .yes,exit: .no,holding: true).0,"Hold Long")
        XCTAssertEqual(LongDecision.action(entry: .unknown,exit: .yes,holding: true).0,"Exit Long")
        XCTAssertEqual(LongDecision.action(entry: .yes,exit: .unknown,holding: true).0,"Unknown")
        XCTAssertEqual(LongDecision.action(entry: .yes,exit: .yes,holding: true,available: false).0,"Unknown")
    }
    func testStrategyValidationPersistenceOptimisticRevisionAndManualPositionRecords() throws {
        let url = directory().appendingPathComponent("radar.sqlite3"), store = try Store(url: url), hour = ResearchFixture.hour
        var rule = try store.saveLongStrategy(strategy())
        XCTAssertEqual(rule.revision,1)
        XCTAssertThrowsError(try store.saveLongStrategy(strategy(entry: "LongReturn > 0")))
        var empty = try strategy(); empty.exitJSON = FilterConfigV2().json
        XCTAssertThrowsError(try store.saveLongStrategy(empty))
        try store.trackLong(strategyID: rule.id,instrument: ResearchFixture.instrument.id,price: 100,timestamp: hour,close: false)
        XCTAssertThrowsError(try store.trackLong(strategyID: rule.id,instrument: ResearchFixture.instrument.id,price: 100,timestamp: hour,close: false))
        XCTAssertThrowsError(try store.deleteLongStrategy(rule.id))
        let stale = rule; rule.exitJSON = try FilterCompiler.compile(source: "LongReturn >= 5").config.json
        rule = try store.saveLongStrategy(rule)
        XCTAssertEqual(rule.revision,2); XCTAssertThrowsError(try store.saveLongStrategy(stale))
        let restored = try Store(url: url)
        XCTAssertEqual(try restored.longPositions().first?.strategy.revision,1,"Actual entries retain their original strategy snapshot.")
        XCTAssertEqual(try restored.longStrategies().first?.revision,2)
        XCTAssertThrowsError(try store.trackLong(strategyID: rule.id,instrument: ResearchFixture.instrument.id,price: -1,timestamp: hour+hourMS,close: true))
        XCTAssertThrowsError(try store.trackLong(strategyID: rule.id,instrument: ResearchFixture.instrument.id,price: 110,timestamp: hour-hourMS,close: true))
        try store.trackLong(strategyID: rule.id,instrument: ResearchFixture.instrument.id,price: 110,timestamp: hour+hourMS,close: true)
        try store.deleteLongStrategy(rule.id)
        XCTAssertEqual(try store.longPositions().first?.exitPrice,110)
        XCTAssertEqual(try store.longPositions().first?.exitStrategy?.revision,2)
        XCTAssertEqual(try store.longPositions().first?.strategy.name,"Long fixture")
    }
    func testLiveConfirmedAndFormingClocksHistoricalOffsetsPositionMetricsAndFutureInvariance() async throws {
        let hour = ResearchFixture.hour, worker = LongDecisionWorker()
        var bars = Dictionary(uniqueKeysWithValues: ResearchFixture.bars().map { ($0.hour,$0) })
        bars[hour-hourMS] = Candle(hour: hour-hourMS,high: 112,low: 104,close: 110,quoteVolume: 10,baseVolume: 1,open: 105)
        bars[hour] = Candle(hour: hour,high: 111,low: 89,close: 90,quoteVolume: 10,baseVolume: 1,open: 110,confirmed: false)
        let original = FilterMarketData(id: ResearchFixture.instrument.id,hour: hour,now: hour+hourMS/2,listedAt: ResearchFixture.instrument.listedAt,candles: bars,stats: [:],quotes: [:],previousEMA: 1_000_000)
        let rule = try strategy(entry: "Close > 105",exit: "LongReturn >= 5")
        let closed = try await worker.evaluate([original],strategy: rule,positions: [],forming: false,available: true)
        let forming = try await worker.evaluate([original],strategy: rule,positions: [],forming: true,available: true)
        XCTAssertEqual(closed.first?.action,"Enter Long"); XCTAssertEqual(forming.first?.action,"Wait")
        XCTAssertEqual(closed.first?.price,110); XCTAssertEqual(forming.first?.price,90)
        let position = LongTrackedPosition(strategyID: rule.id,instrument: original.id,enteredAt: hour-3*hourMS,entryPrice: 100,strategy: rule)
        let held = try await worker.evaluate([original],strategy: rule,positions: [position],forming: false,available: true,detailID: original.id)
        XCTAssertEqual(held.first?.action,"Exit Long"); XCTAssertNotNil(held.first?.exitTraceJSON)
        var market = LongDecision.context(original,forming: false); market.longEnteredAt = position.enteredAt; market.longEntryPrice = 100
        let filter = try FilterCompiler.compile(source: "LongReturn > 9.99 AND LongReturn < 10.01 AND LongHeldHours == 3 AND unavailable(lag(LongReturn, 3))")
        let evaluator = FilterEvaluator(market: market,filter: filter)
        XCTAssertEqual(evaluator.evaluate().result,.yes)
        XCTAssertFalse(evaluator.sharedReadings.keys.contains { $0.contains("LongReturn") },"Position-dependent values must never leak between frozen strategy runs.")
        var changed = original; changed.candles[hour] = Candle(hour: hour,high: 100_001,low: 89,close: 100_000,quoteVolume: 10,baseVolume: 1,open: 110,confirmed: false)
        let after = try await worker.evaluate([changed],strategy: rule,positions: [],forming: false,available: true)
        XCTAssertEqual(closed.first?.entry,after.first?.entry); XCTAssertEqual(closed.first?.exit,after.first?.exit)
        var justEntered = position; justEntered.enteredAt = hour
        let waiting = try await worker.evaluate([original],strategy: rule,positions: [justEntered],forming: false,available: true)
        XCTAssertEqual(waiting.first?.action,"Unknown"); XCTAssertTrue(waiting.first?.reason.contains("first evaluated close") == true)
        let missingContract = try await worker.evaluate([],strategy: rule,positions: [position],forming: false,available: true)
        XCTAssertEqual(missingContract.first?.action,"Unknown"); XCTAssertEqual(missingContract.first?.position?.id,position.id)
        let paused = try await worker.evaluate([original],strategy: rule,positions: [position],forming: false,available: false)
        XCTAssertEqual(paused.first?.action,"Unknown"); XCTAssertEqual(paused.first?.position?.id,position.id)
    }
    func testLongPairsActualHoldingPeriodsDuplicateEntryExitPriorityAndNoEndSale() throws {
        let (store,study,manifest) = try dataset(hours: 13), hour = ResearchFixture.hour
        XCTAssertEqual(manifest.engine,LongStudyEngine.version)
        var checkpoint = Checkpoint(studyID: study.id,phase: "running")
        try LongStudyEngine.run(store: store,study: study,manifest: manifest,checkpoint: &checkpoint,progress: { _,_,_ in })
        let trades = try store.longTrades(study.id)
        XCTAssertEqual(trades.count,4); XCTAssertEqual(trades[0].entryTime,hour)
        XCTAssertEqual(trades[0].exitTime,hour+3*hourMS); XCTAssertEqual(trades[0].outcome.hours,3)
        XCTAssertEqual(trades[1].entryTime,hour+4*hourMS,"The exit hour cannot also open another Long.")
        XCTAssertEqual(trades.last?.status,"Open"); XCTAssertNil(trades.last?.exitTime)
        XCTAssertTrue(trades.last?.outcome.reason?.contains("No end-of-study sale") == true)
        XCTAssertEqual(checkpoint.longCounters?.evaluated,14)
    }
    func testVariableHoldsHandCalculatedMFEFeesSlippageAndActualFundingInterval() throws {
        let hour = ResearchFixture.hour, costs = ResearchCosts(entryFeeBps: 10,exitFeeBps: 20,slippageBps: 100)
        let bars = stride(from: hour-hourMS,to: hour+8*hourMS,by: Int(hourMS)).map { ts in
            let price = 100+Double((ts-hour)/hourMS)
            return Candle(hour: ts,high: price+2,low: price-2,close: price+0.5,quoteVolume: 100,baseVolume: 1,open: price)
        }
        let (store,study,manifest) = try dataset(hours: 8,bars: bars,costs: costs)
        // Freeze the actual settlements and marks before running, including both boundaries.
        for (timestamp,rate) in [(hour,0.9),(hour+hourMS,0.01),(hour+3*hourMS,-0.005),(hour+4*hourMS,0.8)] {
            try store.write([.init(instrument: ResearchFixture.instrument.id,kind: "funding",timestamp: timestamp,rate: rate,sources: ["settlements"]),
                             .init(instrument: ResearchFixture.instrument.id,kind: "mark",timestamp: timestamp,mark: 100,sources: ["marks"])])
        }
        try store.cover(.init(id: "funding",instrument: ResearchFixture.instrument.id,kind: "funding",from: hour,through: hour+8*hourMS,url: "fixture",filename: "funding",archive: false))
        let frozen = try store.freeze(ResearchFixture.plan(study.spec))
        var checkpoint = Checkpoint(studyID: study.id,phase: "running")
        try LongStudyEngine.run(store: store,study: study,manifest: frozen,checkpoint: &checkpoint,progress: { _,_,_ in })
        let outcome = try XCTUnwrap(store.longTrades(study.id).first?.outcome)
        XCTAssertEqual(try XCTUnwrap(outcome.gross),0.03,accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(outcome.mfe),0.04,accuracy: 1e-12); XCTAssertEqual(try XCTUnwrap(outcome.mae),-0.02,accuracy: 1e-12)
        let pe = 101.0, px = 103.0*0.99
        let expected = (px-pe)/pe - (pe*0.001+px*0.002)/pe - (100*0.01-100*0.005)/pe
        XCTAssertEqual(try XCTUnwrap(outcome.net),expected,accuracy: 1e-12)
        XCTAssertNotEqual(manifest.id,frozen.id)
        let trade = try XCTUnwrap(store.longTrades(study.id).first)
        var missingMark = LongStudyPosition(trade: trade); missingMark.fundingReason = "A settlement mark price or actual funding rate is missing."
        let unavailableNet = LongStudyEngine.close(missingMark,at: trade.exitTime!,exit: trade.exitPrice,costs: costs,ranges: [.init(from: hour,through: hour+8*hourMS)])
        XCTAssertEqual(try XCTUnwrap(unavailableNet.gross),0.03,accuracy: 1e-12); XCTAssertNil(unavailableNet.net)
        XCTAssertTrue(unavailableNet.netReason?.contains("mark price") == true)
    }
    func testTradesCrossingTimeSplitAreExcludedFromSplitStatisticsAndDelistingKeepsOpen() throws {
        let (store,study,manifest) = try dataset("Close > 0","LongHeldHours >= 160",hours: 240)
        var checkpoint = Checkpoint(studyID: study.id,phase: "running")
        try LongStudyEngine.run(store: store,study: study,manifest: manifest,checkpoint: &checkpoint,progress: { _,_,_ in })
        let trade = try XCTUnwrap(store.longTrades(study.id).first)
        XCTAssertEqual(trade.entryEvent.split,"Observation"); XCTAssertTrue(trade.crossesSplit)
        let report = try store.longReport(study,manifest: manifest,counters: checkpoint.longCounters!)
        XCTAssertEqual(report.summaries.first?.count,1)
        XCTAssertEqual(report.summaries.first(where: { $0.group == "Observation" })?.count,0)
        XCTAssertEqual(report.summaries.first(where: { $0.group == "Validation" })?.count,0)
        var delisted = manifest; delisted.instruments[0].delistedAt = manifest.from+80*hourMS
        let other = ResearchStudy(spec: study.spec,planID: study.planID,manifestID: manifest.id)
        var stopped = Checkpoint(studyID: other.id,phase: "running")
        try LongStudyEngine.run(store: store,study: other,manifest: delisted,checkpoint: &stopped,progress: { _,_,_ in })
        let retained = try XCTUnwrap(store.longTrades(other.id).first)
        XCTAssertEqual(retained.status,"Open"); XCTAssertNil(retained.exitTime)
        XCTAssertTrue(retained.outcome.reason?.contains("delisted") == true)
    }
    func testMissingExitEvaluationAndPriceGapsAreSeparateFromPrimaryClosedStatistics() throws {
        let hour = ResearchFixture.hour
        let (unknownStore,study,manifest) = try dataset("Close > 0","LongHeldHours >= 3 OR oiUSD > 0",hours: 20)
        // The fixture's positive OI would close immediately; freeze a dataset without OI instead.
        try unknownStore.database.execute("DELETE FROM research_heads WHERE kind='stat'")
        let missing = try unknownStore.freeze(ResearchFixture.plan(study.spec))
        var checkpoint = Checkpoint(studyID: study.id,phase: "running")
        try LongStudyEngine.run(store: unknownStore,study: study,manifest: missing,checkpoint: &checkpoint,progress: { _,_,_ in })
        let uncertain = try XCTUnwrap(unknownStore.longTrades(study.id).first)
        XCTAssertEqual(uncertain.status,"Uncertain"); XCTAssertEqual(uncertain.unknownHours,2)
        let report = try unknownStore.longReport(study,manifest: missing,counters: checkpoint.longCounters!)
        XCTAssertEqual(report.summaries.first?.count,0); XCTAssertGreaterThan(report.long?.uncertain ?? 0,0)
        XCTAssertNotEqual(manifest.id,missing.id)
        let bars = ResearchFixture.bars().filter { $0.hour != hour+hourMS }
        let (gapStore,gapStudy,gapManifest) = try dataset(hours: 12,bars: bars)
        checkpoint = Checkpoint(studyID: gapStudy.id,phase: "running")
        try LongStudyEngine.run(store: gapStore,study: gapStudy,manifest: gapManifest,checkpoint: &checkpoint,progress: { _,_,_ in })
        let gap = try XCTUnwrap(gapStore.longTrades(gapStudy.id).first)
        XCTAssertEqual(gap.status,"Incomplete"); XCTAssertNil(gap.outcome.gross)
        XCTAssertEqual(gap.exitTime,hour+3*hourMS,"The exit signal time is retained even if a holding price is missing.")
    }
    func testPauseResumeRestoresLongPositionAndProducesSameFrozenTrades() async throws {
        let (store,study,manifest) = try dataset("Close > 0","LongHeldHours >= 80",hours: 300), directory = store.directory
        let paused = try await Task.detached(priority: .background) {
            let workerStore = try ResearchStore(directory: directory)
            var checkpoint = Checkpoint(studyID: study.id,phase: "running")
            do {
                try LongStudyEngine.run(store: workerStore,study: study,manifest: manifest,checkpoint: &checkpoint,progress: { _,_,_ in withUnsafeCurrentTask { $0?.cancel() } })
                XCTFail("Cancellation must stop the next chunk.")
            } catch is CancellationError {}
            return try XCTUnwrap(workerStore.get("checkpoint:\(study.id)",as: Checkpoint.self))
        }.value
        XCTAssertNotNil(paused.longPosition); XCTAssertNotNil(paused.nextHour)
        var resumed = paused
        try LongStudyEngine.run(store: store,study: study,manifest: manifest,checkpoint: &resumed,progress: { _,_,_ in })
        let before = try store.longTrades(study.id,limit: 100).map { try researchJSON($0) }
        var fresh = Checkpoint(studyID: study.id,phase: "running")
        try LongStudyEngine.run(store: store,study: study,manifest: manifest,checkpoint: &fresh,progress: { _,_,_ in })
        XCTAssertEqual(before,try store.longTrades(study.id,limit: 100).map { try researchJSON($0) })
    }
    func testFrozenStrategyReportTradeCSVAndBackwardCompatibleCheckpoint() async throws {
        let (store,study,manifest) = try dataset(hours: 100), directory = store.directory
        let worker = ResearchWorker(directory: directory), report = try await worker.run(study,progress: { _,_,_ in })
        XCTAssertNotNil(report.long); XCTAssertGreaterThan(report.long?.closed ?? 0,0)
        let reader = ResearchReader(directory: directory), file = directory.appendingPathComponent("Long.csv")
        try await reader.export(studyID: study.id,kind: "events",to: file)
        let csv = try String(contentsOf: file,encoding: .utf8)
        XCTAssertTrue(csv.contains("entry_trace_json")); XCTAssertTrue(csv.contains("exit_trace_json")); XCTAssertTrue(csv.contains(manifest.digest))
        let legacy = Data("{\"studyID\":\"old\",\"phase\":\"paused\",\"completedSources\":[],\"refresh\":false,\"instrumentIndex\":0,\"episodes\":{},\"updatedAt\":1}".utf8)
        XCTAssertNil(try JSONDecoder().decode(Checkpoint.self,from: legacy).longPosition)
        try store.deleteStudy(study.id); XCTAssertEqual(try store.longTrades(study.id).count,0)
    }
}
