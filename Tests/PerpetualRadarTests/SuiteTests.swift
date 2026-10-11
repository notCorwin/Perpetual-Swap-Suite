import Foundation
import XCTest
@testable import PerpetualRadar

final class SuiteTests: XCTestCase {
    private func directory() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SuiteTests-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
    private let hour = ResearchFixture.hour
    private func json(_ source: String) throws -> String { try FilterCompiler.compile(source: source).config.json }
    private func profile(universe: String = "1 < 2", setup: String = "Close >= 100", longExit: String = "LongHeldHours >= 1", reversal: String = "Close < 95", shortExit: String = "ShortHeldHours >= 1") throws -> StrategyProfile {
        .init(name: "Four phases",universeJSON: try json(universe),phaseRules: ["bullishSetup": try json(setup),"bullishExhaustion": try json(longExit),"bearishReversal": try json(reversal),"bearishExhaustion": try json(shortExit)])
    }
    private func bars(_ closes: [Double], lows: [Int:Double] = [:], opens: [Int:Double] = [:]) -> [Candle] {
        closes.enumerated().map { i,close in
            let open = opens[i] ?? (i>0 ? closes[i-1] : close)
            return Candle(hour: hour+Int64(i-1)*hourMS,high: max(open,close),low: lows[i] ?? min(open,close),close: close,quoteVolume: 10_000_000,baseVolume: 100,open: open)
        }
    }
    private func dataset(_ profile: StrategyProfile? = nil, bars: [Candle]? = nil, hours: Int = 6, execution: SuiteExecution = .init(), capital: SuiteCapitalSettings = .init(maintenanceRate: 0.005,liquidationFeeBps: 100), costs: ResearchCosts? = nil, funding: [(Int64,Double,Double?)]? = nil) throws -> (ResearchStore,ResearchStudy,DataManifest) {
        let store = try ResearchStore(directory: directory())
        let p = try profile ?? self.profile(), input = bars ?? self.bars([90,100,110,90,80,100,120])
        var spec = StudySpec(name: "Cycle",kind: "cycle",rules: p.studyRules,from: hour,through: hour+Int64(hours)*hourMS)
        spec.strategySnapshots = [p]; spec.execution = execution; spec.capital = .init(defaults: capital); spec.costs = costs
        try spec.validate(); try ResearchFixture.seed(store,bars: input)
        if let funding {
            try store.cover(.init(id: "funding",instrument: ResearchFixture.instrument.id,kind: "funding",from: hour,through: spec.through,url: "fixture",filename: "settlements",archive: false))
            for (time,rate,mark) in funding {
                var values = [ResearchDatum(instrument: ResearchFixture.instrument.id,kind: "funding",timestamp: time,rate: rate,sources: ["funding"])]
                if let mark { values.append(.init(instrument: ResearchFixture.instrument.id,kind: "mark",timestamp: time,mark: mark,sources: ["marks"])) }
                try store.write(values)
            }
        }
        let plan = ResearchFixture.plan(spec), manifest = try store.freeze(plan), study = ResearchStudy(spec: spec,planID: plan.id,manifestID: manifest.id)
        try store.put(study.id,kind: "study",study)
        return (store,study,manifest)
    }
    private func run(_ data: (ResearchStore,ResearchStudy,DataManifest)) throws -> ([SuiteTrade],StudyReport) {
        var checkpoint = Checkpoint(studyID: data.1.id,phase: "running")
        try SuiteStudyEngine.run(store: data.0,study: data.1,manifest: data.2,checkpoint: &checkpoint,progress: { _,_,_ in })
        return (try data.0.suiteTrades(data.1.id,limit: 100),try data.0.suiteReport(data.1,manifest: data.2))
    }
    func testFourPhaseValidationAtomicSaveIndependentCopiesAndActualShortSnapshots() throws {
        let directory = directory(), store = try Store(url: directory.appendingPathComponent("radar.sqlite3"))
        var p = try store.saveSuiteProfile(profile()); XCTAssertEqual(p.revision,1)
        let original = p
        _ = try store.manageSuite(["action":"draft","draft":["name":"Incomplete draft","formula":"ShortReturn >"]],mode:"radar")
        XCTAssertEqual(try store.suiteProfiles("radar").first?.phaseRules,p.phaseRules)
        XCTAssertEqual((try store.suiteInventory("radar")["draft"] as? [String:String])?["formula"],"ShortReturn >")
        XCTAssertEqual(SuiteEvaluation.relativeReturn(price:1,entry:0,direction:"Long"),"Infinity")
        var invalid = p; invalid.phaseRules["bullishSetup"] = try json("ShortReturn > 0")
        XCTAssertThrowsError(try store.saveSuiteProfile(invalid))
        invalid = p; invalid.phaseRules["bearishExhaustion"] = try json("LongHeldHours > 0")
        XCTAssertThrowsError(try invalid.compiled())
        invalid = p; invalid.phaseRules["bullishExhaustion"] = FilterConfigV2().json
        XCTAssertThrowsError(try invalid.compiled()); XCTAssertEqual(try store.suiteProfiles("radar").first?.revision,1)
        let firstCopy = try store.saveSuiteProfile(p,copy: true), secondCopy = try store.saveSuiteProfile(p,copy: true)
        XCTAssertNotEqual(firstCopy.id,p.id); XCTAssertNotEqual(firstCopy.id,secondCopy.id); XCTAssertNotEqual(firstCopy.name,secondCopy.name)
        p.phaseRules["bearishExhaustion"] = try json("ShortReturn > 5")
        p = try store.saveSuiteProfile(p); XCTAssertEqual(p.revision,2)
        XCTAssertThrowsError(try store.saveSuiteProfile(original)); XCTAssertEqual(try store.suiteProfiles("radar").first(where: {$0.id == firstCopy.id})?.phaseRules,original.phaseRules)
        var researchCopy = p; researchCopy.mode = "research"
        let researchStore = try ResearchStore(directory: directory.appendingPathComponent("research"))
        let independent = try researchStore.database.saveSuiteProfile(researchCopy,copy: true)
        XCTAssertNotEqual(independent.id,p.id); XCTAssertEqual(try store.suiteProfiles("research").count,3)
        _ = try store.manageSuite(["action":"open","profileID":p.id,"instrument":ResearchFixture.instrument.id,"direction":"Short","price":100.0,"timestamp":hour],mode: "radar")
        let record = try XCTUnwrap(store.suitePositions().first); XCTAssertEqual(record.direction,"Short"); XCTAssertEqual(record.strategy.revision,2)
        p.phaseRules["bearishExhaustion"] = try json("ShortReturn > 10"); p = try store.saveSuiteProfile(p)
        _ = try store.manageSuite(["action":"close","profileID":p.id,"instrument":ResearchFixture.instrument.id,"price":90.0,"timestamp":hour+hourMS],mode: "radar")
        let restored = try Store(url: store.url), closed = try XCTUnwrap(restored.suitePositions().first)
        XCTAssertEqual(closed.strategy.revision,2); XCTAssertEqual(closed.exitStrategy?.revision,3); XCTAssertEqual(closed.exitPrice,90); XCTAssertEqual(Double(closed.priceReturn!),0.1)
    }
    func testSharedLibraryRevisionsActivationDraftIsolationAndFrozenStudy() throws {
        let directory = directory()
        let radar = try Store(url: directory.appendingPathComponent("radar.sqlite3")), research = try Store(url: radar.url)
        let saved = try radar.saveSuiteProfile(profile())
        _ = try research.manageSuite(["action":"select","profileID":saved.id],mode:"research")
        XCTAssertEqual(try radar.selectedSuiteProfile("radar")?.id,saved.id)
        XCTAssertEqual(try research.suiteProfiles("research").first?.id,saved.id)
        let frozen = saved
        var edited = saved; edited.mode = "research"; edited.phaseRules["bearishReversal"] = try json("Close < 100")
        let raw = try JSONSerialization.jsonObject(with: Data(researchJSON(edited).utf8))
        _ = try research.manageSuite(["action":"save","profile":raw],mode:"research")
        XCTAssertEqual(try radar.selectedSuiteProfile("radar")?.revision,2)
        XCTAssertEqual(try radar.suiteProfiles("radar").first?.phaseRules,edited.phaseRules)
        XCTAssertEqual(frozen.revision,1); XCTAssertNotEqual(frozen.phaseRules,edited.phaseRules)
        XCTAssertThrowsError(try radar.saveSuiteProfile(saved))
        for mode in ["radar","research"] { _ = try radar.manageSuite(["action":"draft","draft":["name":mode+" draft"]],mode:mode) }
        XCTAssertEqual((try research.suiteInventory("research")["draft"] as? [String:String])?["name"],"research draft")
        XCTAssertEqual((try radar.suiteInventory("radar")["draft"] as? [String:String])?["name"],"radar draft")
        _ = try research.manageSuite(["action":"delete","profileID":saved.id],mode:"research")
        XCTAssertTrue(try radar.suiteProfiles("radar").isEmpty); XCTAssertNil(try radar.selectedSuiteProfile("radar"))
    }
    func testExistingModeLibrariesConsolidateWithoutChangingVersionsOrPositionIdentity() throws {
        let directory = directory()
        let radar = try Store(url: directory.appendingPathComponent("radar.sqlite3"))
        let research = try Store(url: directory.appendingPathComponent("Research/research.sqlite3"))
        var live = try profile(); live.revision = 3
        var historical = try profile(); historical.mode = "research"; historical.revision = 5
        try radar.setPreference(try researchJSON([live]),forKey:"suiteProfiles.radar")
        try radar.setPreference(live.id,forKey:"suiteSelected.radar")
        try research.setPreference(try researchJSON([historical]),forKey:"suiteProfiles.research")
        try radar.initializeSharedSuiteLibrary(researchURL: research.url)
        let shared = try radar.suiteProfiles("research")
        XCTAssertEqual(shared.count,2); XCTAssertEqual(Set(shared.map(\.id)),[live.id,historical.id])
        XCTAssertEqual(shared.first(where: {$0.id == historical.id})?.revision,5)
        XCTAssertEqual(try radar.selectedSuiteProfile("research")?.id,live.id)
        XCTAssertNotEqual(shared[0].name,shared[1].name)
        try radar.initializeSharedSuiteLibrary(researchURL: research.url)
        XCTAssertEqual(try radar.suiteProfiles("radar").count,2)
    }
    func testIndependentPhasesConflictUniverseExitsAndShortSignedReadings() async throws {
        let p = try profile(universe: "Close < 0",setup: "Close > 0",longExit: "1 < 2",reversal: "Close > 0",shortExit: "ShortReturn >= 10 AND ShortHeldHours == 2")
        let input = bars([100,90,120]), series = ResearchEngine.reconstruct(.init(candles: Dictionary(uniqueKeysWithValues: input.map { ($0.hour,$0) })))
        var context = ResearchEngine.context(instrument: ResearchFixture.instrument,hour: hour,series: series)
        context = SuiteEvaluation.positionContext(context,direction: "Short",price: 100,time: hour-hourMS)
        let traces = SuiteEvaluation.traces(context,filters: try p.compiled(),explain: true)
        XCTAssertEqual(traces[4].result,.yes); XCTAssertEqual(SuiteEvaluation.decision(traces,direction: "Short",execution: .init()).0,"Exit Short")
        XCTAssertEqual(SuiteEvaluation.decision(traces,direction: nil,execution: .init()).0,"Conflict")
        XCTAssertEqual(SuiteEvaluation.decision(traces,direction: "Long",execution: .init()).0,"Exit Long")
        XCTAssertEqual(FilterEvaluator(market: context,filter: try FilterCompiler.compile(source: "ShortReturn == 10 AND unavailable(LongReturn) AND unavailable(lag(ShortReturn, 2))")).evaluate().result,.yes)
        let evaluator = FilterEvaluator(market: context,filter: try FilterCompiler.compile(source: "ShortReturn > 0")); _ = evaluator.evaluate()
        XCTAssertFalse(evaluator.sharedReadings.keys.contains { $0.contains("ShortReturn") })
    }
    func testProvisionalRetractionConfirmedCloseBaselineDedupAndUnknownRecovery() async throws {
        let p = try profile(setup: "Close > 100",longExit: "Close < 95",reversal: "Close < 80",shortExit: "Close > 90")
        let worker = SuiteEvaluationWorker(), now = hour+hourMS
        var market = FilterMarketData(id: ResearchFixture.instrument.id,hour: now,now: now+1_000,candles: [hour: Candle(hour: hour,high: 111,low: 90,close: 110,quoteVolume: 1,baseVolume: 1,open: 90),now: Candle(hour: now,high: 120,low: 110,close: 120,quoteVolume: 1,baseVolume: 1,open: 110,confirmed: false)],stats: [:],quotes: [:])
        var live = try await worker.evaluate([market],profile: p,positions: [],forming: true,available: true)
        let closed = try await worker.evaluate([market],profile: p,positions: [],forming: false,available: true)
        XCTAssertEqual(live[0].phases["bullishSetup"]?.result,"true"); XCTAssertEqual(closed[0].phases["bullishSetup"]?.result,"true")
        market.candles[now] = Candle(hour: now,high: 120,low: 90,close: 90,quoteVolume: 1,baseVolume: 1,open: 110,confirmed: false)
        live = try await worker.evaluate([market],profile: p,positions: [],forming: true,available: true)
        XCTAssertEqual(live[0].phases["bullishSetup"]?.result,"false")
        let after = try await worker.evaluate([market],profile: p,positions: [],forming: false,available: true)
        XCTAssertEqual(after[0].phases["bullishSetup"]?.result,closed[0].phases["bullishSetup"]?.result)
        let recent = SuitePosition(strategyID: p.id,instrument: market.id,direction: "Long",enteredAt: now,entryPrice: 90,strategy: p)
        let waiting = try await worker.evaluate([market],profile: p,positions: [recent],forming: false,available: true)
        XCTAssertEqual(waiting[0].action,"Unknown")
        var tracker = FilterMembershipTracker(); let key = market.id+"|Bullish Setup"
        func sample(_ truth: FilterTruth,revision: Int=1) -> FilterObservation { .init(configuration: p.id+"|r\(revision)",universe: [key],results: [key: truth]) }
        XCTAssertTrue(tracker.consume(sample(.yes)).isEmpty); XCTAssertTrue(tracker.consume(sample(.no)).count == 1)
        XCTAssertTrue(tracker.consume(sample(.unknown)).isEmpty); XCTAssertEqual(tracker.consume(sample(.yes)).count,1)
        XCTAssertTrue(tracker.consume(sample(.yes)).isEmpty); XCTAssertTrue(tracker.consume(sample(.unknown)).isEmpty); XCTAssertTrue(tracker.consume(sample(.yes)).isEmpty)
        XCTAssertTrue(tracker.consume(sample(.yes,revision: 2)).isEmpty)
    }
    func testSuiteBTCConfirmationIgnoresFormingPricesAndProvisionalCooldowns() async throws {
        XCTAssertThrowsError(try FilterCompiler.compile(source: #"BTC(ShortReturn, "live") > 0"#))
        let p = try profile(setup: #"cooldown(BTC(ROC(1), "live") > 5, 2)"#, reversal: "1 > 2")
        let requirements = try p.hydration()
        XCTAssertTrue(requirements.referencesBTC); XCTAssertGreaterThanOrEqual(requirements.btcRequirements!.hours, 3)
        let now = hour+hourMS
        var own = FilterMarketData(id: "ETH-USDT-SWAP",hour: now,now: now+1_000,candles: [:],stats: [:],quotes: [:])
        var reference = own; reference.id = btcReferenceID
        for age in 0...5 {
            let h = now-Int64(age)*hourMS, price = age == 0 ? 120.0 : 100.0
            let c = Candle(hour:h,high:price,low:100,close:price,quoteVolume:1,baseVolume:1,open:100,confirmed:age != 0)
            reference.candles[c.hour] = c
            own.candles[c.hour] = Candle(hour:c.hour,high:100,low:100,close:100,quoteVolume:1,baseVolume:1,open:100,confirmed:c.confirmed)
        }
        own.referenceBTC = FilterReferenceSnapshot(market:reference,receivedAt:own.now)
        let worker = SuiteEvaluationWorker()
        let live = try await worker.evaluate([own],profile:p,positions:[],forming:true,available:true)
        let closed = try await worker.evaluate([own],profile:p,positions:[],forming:false,available:true)
        XCTAssertEqual(live[0].phases["bullishSetup"]?.result,"true")
        XCTAssertEqual(closed[0].phases["bullishSetup"]?.result,"false")
        reference.candles[now] = Candle(hour:now,high:120,low:100,close:100,quoteVolume:1,baseVolume:1,open:100,confirmed:false)
        own.referenceBTC = FilterReferenceSnapshot(market:reference,receivedAt:own.now)
        let retracted = try await worker.evaluate([own],profile:p,positions:[],forming:true,available:true)
        let unchanged = try await worker.evaluate([own],profile:p,positions:[],forming:false,available:true)
        XCTAssertEqual(retracted[0].phases["bullishSetup"]?.result,"false","A provisional match must not seed confirmed cooldown memory.")
        XCTAssertEqual(unchanged[0].phases["bullishSetup"]?.result,"false")
    }
    func testSuiteFrozenBTCInputsDriveOnlyTargetAccountWithoutFuturePrices() throws {
        let store = try ResearchStore(directory:FileManager.default.temporaryDirectory.appendingPathComponent("SuiteBTC-\(UUID())"))
        defer { try? FileManager.default.removeItem(at:store.directory) }
        let p = try profile(setup:#"BTC(ROC(1), "live") > 5"#,reversal:"1 > 2",shortExit:"1 > 2")
        var target = ResearchFixture.instrument; target.id = "ETH-USDT-SWAP"
        try store.put("instrument:\(target.id)",kind:"instrument",target)
        try ResearchFixture.seed(store,bars:bars([90,100,110,90,80,100,120]))
        try store.write(bars(Array(repeating:100,count:7)).map { .init(instrument:target.id,kind:"candle",timestamp:$0.hour,candle:$0,sources:["eth-source"]) })
        var spec = StudySpec(name:"BTC context cycle",kind:"cycle",rules:p.studyRules,instruments:[target.id],from:hour,through:hour+6*hourMS)
        spec.strategySnapshots=[p]; spec.execution = .init(); spec.capital = .init(defaults:.init(maintenanceRate:0.005,liquidationFeeBps:100))
        try spec.validate()
        var plan = DataPlan(spec:spec,instruments:[target],from:hour,through:spec.through,warmupHours:275)
        plan.referenceInstruments=[ResearchFixture.instrument]
        let manifest = try store.freeze(plan), study = ResearchStudy(spec:spec,planID:plan.id,manifestID:manifest.id)
        let (trades,report) = try run((store,study,manifest))
        XCTAssertEqual(trades.count,2); XCTAssertEqual(trades.map(\.instrument),[target.id,target.id])
        XCTAssertEqual(trades[0].entryTime,hour+hourMS); XCTAssertEqual(trades[0].exitTime,hour+2*hourMS)
        XCTAssertEqual(trades[1].entryTime,hour+5*hourMS); XCTAssertEqual(trades[1].status,"Open")
        XCTAssertEqual(report.suite?.accounts.map(\.instrument),[target.id])
        XCTAssertTrue(trades[0].entryEvent.sources.contains("fixture"))
        XCTAssertTrue(report.warnings.contains { $0.hasPrefix("Hourly approximation of live BTC rules") })
        // Both an in-range replacement and an unobserved future BTC hour must
        // leave the frozen entry/exit decisions and capital account unchanged.
        try store.write(bars(Array(repeating:1_000,count:8)).map { .init(instrument:btcReferenceID,kind:"candle",timestamp:$0.hour,candle:$0,sources:["replacement"]) })
        let again = try run((store,study,manifest))
        XCTAssertEqual(try trades.map(researchJSON),try again.0.map(researchJSON))
        XCTAssertEqual(report.suite?.accounts.first?.endingEquity,again.1.suite?.accounts.first?.endingEquity)
    }
    func testAllOppositeAndReentryPoliciesPendingCancellationAndConflict() throws {
        func trace(_ setup: FilterTruth,_ reversal: FilterTruth,_ exit: FilterTruth = .no,universe: FilterTruth = .yes) -> [FilterTrace] {
            [universe,setup,exit,reversal,exit].enumerated().map { .init(id: "\($0.offset)",label: "phase",result: $0.element,hour: hour,readings: [:],children: [],eventHours: []) }
        }
        for policy in ["exitThenWait","reverse","dedicatedOnly"] {
            var s = SuiteSignals(); let e = SuiteExecution(opposite: policy)
            _ = s.step(trace(.no,.no),holding: nil,execution: e,baseline: true)
            XCTAssertEqual(s.step(trace(.yes,.no),holding: nil,execution: e).enter,"Long")
            let opposite = s.step(trace(.no,.yes),holding: "Long",execution: e)
            XCTAssertEqual(opposite.exit,policy != "dedicatedOnly"); XCTAssertEqual(opposite.enter,policy == "reverse" ? "Short" : nil)
            if policy == "exitThenWait" { XCTAssertEqual(s.pending,"Short"); XCTAssertEqual(s.step(trace(.no,.yes),holding: nil,execution: e).enter,"Short") }
            XCTAssertTrue(s.step(trace(.yes,.no),holding: "Short",execution: e).exit,"Bullish Setup always exits Short.")
        }
        var s = SuiteSignals(), execution = SuiteExecution()
        XCTAssertNil(s.step(trace(.yes,.no),holding: nil,execution: execution,baseline: true).enter)
        XCTAssertNil(s.step(trace(.yes,.no),holding: nil,execution: execution).enter)
        execution.entry = "matchWhileFlat"; XCTAssertEqual(s.step(trace(.yes,.no),holding: nil,execution: execution).enter,"Long")
        _ = s.step(trace(.no,.yes),holding: "Long",execution: execution); XCTAssertNotNil(s.pending)
        XCTAssertNil(s.step(trace(.no,.unknown),holding: nil,execution: execution).enter); XCTAssertNil(s.pending)
        XCTAssertNil(s.step(trace(.yes,.yes),holding: nil,execution: execution).enter)
        XCTAssertTrue(s.step(trace(.yes,.yes),holding: "Short",execution: execution).exit)
        XCTAssertTrue(s.step(trace(.no,.no,.yes,universe: .no),holding: "Long",execution: execution).exit)
        XCTAssertNil(s.step(trace(.yes,.no,universe: .no),holding: nil,execution: execution).enter)
    }
    func testUniverseGatesReversalEntriesWithoutSuppressingHeldExitsInBothModes() {
        let execution = SuiteExecution(opposite: "reverse")
        for direction in ["Long", "Short"] {
            let opposite = direction == "Long" ? "Short" : "Long"
            for universe in [FilterTruth.yes, .no, .unknown] {
                let traces: [FilterTrace] = [universe, direction == "Long" ? .no : .yes, .no, direction == "Long" ? .yes : .no, .no]
                    .enumerated().map { .init(id: "\($0.offset)", label: "phase", result: $0.element, hour: hour, readings: [:], children: [], eventHours: []) }
                let action = SuiteEvaluation.decision(traces, direction: direction, execution: execution).0
                XCTAssertEqual(action, universe == .yes ? "Exit \(direction); then Enter \(opposite)" : "Exit \(direction)")
                var research = SuiteSignals()
                let intent = research.step(traces, holding: direction, execution: execution)
                XCTAssertTrue(intent.exit)
                XCTAssertEqual(intent.enter, universe == .yes ? opposite : nil)
            }
        }
    }
    func testCompleteCycleIndependentCompoundingHourlyCloseAndOpenEndEquity() throws {
        let data = try dataset(), (trades,report) = try run(data), account = try XCTUnwrap(report.suite?.accounts.first)
        XCTAssertEqual(data.2.engine,SuiteStudyEngine.version); XCTAssertEqual(trades.map(\.direction),["Long","Short","Long"])
        XCTAssertEqual(trades[0].entryTime,hour+hourMS); XCTAssertEqual(trades[0].exitTime,hour+2*hourMS)
        XCTAssertEqual(trades[0].profit!,1_000,accuracy: 1e-8); XCTAssertEqual(trades[1].margin,11_000,accuracy: 1e-8)
        XCTAssertEqual(trades[1].profit!,11_000/9,accuracy: 1e-8); XCTAssertEqual(trades.last?.status,"Open"); XCTAssertNil(trades.last?.exitTime)
        XCTAssertEqual(account.endingEquity,(11_000+11_000/9)*1.2,accuracy: 1e-8)
        let points = try data.0.suiteCurve(data.1.id,profile: data.1.spec.strategySnapshots![0].id,instrument: ResearchFixture.instrument.id,model: "Gross")
        XCTAssertEqual(points.count,6); XCTAssertEqual(points[0].equity,10_000,"The entry at the following open cannot affect the preceding close.")
        XCTAssertEqual(points[1].equity,11_000,accuracy: 1e-8); XCTAssertEqual(points.last?.direction,"Long")
        // Replacing cached input cannot alter the frozen experiment.
        try data.0.write(bars([900,1_000,1_100,900,800,1_000,1_200]).map { .init(instrument: ResearchFixture.instrument.id,kind: "candle",timestamp: $0.hour,candle: $0,sources: ["newer"]) })
        let again = try run(data)
        XCTAssertEqual(try trades.map(researchJSON),try again.0.map(researchJSON))
    }
    func testGrossAndNetFundingDirectionsActualMarksFeesAndMissingFundingStops() throws {
        let costs = ResearchCosts(entryFeeBps: 10,exitFeeBps: 20,slippageBps: 100)
        let settlements: [(Int64,Double,Double?)] = [(hour+2*hourMS,0.01,110),(hour+4*hourMS,0.01,80)]
        let data = try dataset(costs: costs,funding: settlements), (trades,_) = try run(data)
        let long = try XCTUnwrap(trades.first { $0.model == "Net" && $0.direction == "Long" }), short = try XCTUnwrap(trades.first { $0.model == "Net" && $0.direction == "Short" })
        XCTAssertEqual(long.entryPrice,101,accuracy: 1e-9); XCTAssertEqual(long.exitPrice!,108.9,accuracy: 1e-9)
        let quantity = 10_000/101.0, funding = quantity*110*0.01, fees = 10+quantity*108.9*0.002
        XCTAssertEqual(long.funding,funding,accuracy: 1e-8); XCTAssertEqual(long.fees,fees,accuracy: 1e-8)
        XCTAssertEqual(long.profit!,(108.9-101)*quantity-fees-funding,accuracy: 1e-8)
        XCTAssertLessThan(short.funding,0); XCTAssertEqual(short.funding,-short.quantity*80*0.01,accuracy: 1e-8)
        XCTAssertEqual(trades.first(where: { $0.model == "Gross" })?.profit,1_000)
        let missing = try dataset(costs: costs,funding: [(hour+2*hourMS,0.01,nil)]), (_,report) = try run(missing)
        let account = try XCTUnwrap(report.suite?.accounts.first { $0.model == "Net" })
        XCTAssertEqual(account.status,"Incomplete"); XCTAssertNil(account.maxDrawdown)
        let netPoints = try missing.0.suiteCurve(missing.1.id,profile: missing.1.spec.strategySnapshots![0].id,instrument: ResearchFixture.instrument.id,model: "Net")
        XCTAssertEqual(netPoints.count,1,"Net stops before a missing settlement; it never compounds a fabricated zero funding rate.")
    }
    func testLiquidationThresholdOpeningGapMarginCapAndMissingOpen() throws {
        let p = try profile(longExit: "1 > 2",shortExit: "1 > 2")
        let capital = SuiteCapitalSettings(allocation: 0.5,leverage: 10,maintenanceRate: 0.005,liquidationFeeBps: 100)
        let touch = try dataset(p,bars: bars([90,100,100,100],lows: [2:80]),hours: 3,capital: capital,costs: .init(entryFeeBps: 0,exitFeeBps: 0,slippageBps: 0),funding: [])
        let (trades,_) = try run(touch), gross = try XCTUnwrap(trades.first { $0.model == "Gross" }), net = try XCTUnwrap(trades.first { $0.model == "Net" })
        XCTAssertEqual(gross.exitPrice!,90/0.995,accuracy: 1e-8); XCTAssertEqual(net.exitPrice!,90/0.985,accuracy: 1e-8)
        XCTAssertEqual(net.liquidationFrom,hour+hourMS); XCTAssertEqual(net.liquidationThrough,hour+2*hourMS)
        XCTAssertEqual(trades.count,2,"Liquidation never automatically reverses or immediately re-enters.")
        XCTAssertTrue(net.mfeIncomplete); XCTAssertEqual(net.mae,net.priceReturn!,accuracy:1e-8)
        XCTAssertEqual(net.holdingHoursLow,0); XCTAssertEqual(net.holdingHoursHigh,1)
        let gap = try dataset(p,bars: bars([90,100,100,1],opens: [3:1]),hours: 3,capital: capital)
        let (gaps,gapReport) = try run(gap)
        XCTAssertEqual(gaps.first?.exitPrice,1); XCTAssertEqual(gaps.first?.profit,-5_000); XCTAssertEqual(gapReport.suite?.accounts.first?.endingEquity,5_000)
        var exposed = capital; exposed.leverage = 50
        let immediate = try dataset(p,bars:bars([90,100,100,100]),hours:3,capital:exposed,costs:.init(entryFeeBps:0,exitFeeBps:0,slippageBps:100))
        let (immediateTrades,immediateReport) = try run(immediate)
        let immediateNet = try XCTUnwrap(immediateTrades.first {$0.model == "Net"})
        XCTAssertEqual(immediateNet.status,"Closed"); XCTAssertEqual(immediateNet.exitPrice,100)
        XCTAssertEqual(immediateNet.entryTime,immediateNet.exitTime); XCTAssertEqual(immediateNet.funding,0)
        XCTAssertEqual(immediateReport.suite?.accounts.first {$0.model == "Net"}?.status,"Complete","An opening liquidation requires no later funding inputs.")
        var missingBars = bars([90,100,110,90]); let b = missingBars[2]; missingBars[2] = Candle(hour: b.hour,high: b.high,low: b.low,close: b.close,quoteVolume: b.quoteVolume,baseVolume: b.baseVolume,open: nil)
        let missing = try dataset(bars: missingBars,hours: 3), (_,report) = try run(missing)
        XCTAssertEqual(report.suite?.accounts.first?.status,"Incomplete")
        var invalid = SuiteCapitalSettings(); XCTAssertThrowsError(try invalid.validate(costs: nil))
        invalid.maintenanceRate = 0.5; invalid.liquidationFeeBps = 0; invalid.leverage = 2; XCTAssertThrowsError(try invalid.validate(costs: nil))
    }
    func testMonetaryProfitFactorAveragePayoffAndSeparatedExclusions() throws {
        let (store,study,manifest)=try dataset(hours:240), p=study.spec.strategySnapshots![0]
        for (i,profit,ret) in [(0,40.0,0.4),(1,10.0,0.1),(2,-25.0,-0.1)] {
            var e=try SuiteStudyEngine.event(study:study,profile:p,profileIndex:0,instrument:ResearchFixture.instrument,hour:hour+Int64(i)*hourMS,phase:.bullishSetup,traces:[],model:"Gross",role:"Entry",series:.init(),manifest:manifest)
            e.split="Observation"
            let t=SuiteTrade(id:e.id,studyID:study.id,profileID:p.id,profileName:p.name,model:"Gross",instrument:ResearchFixture.instrument.id,direction:i==2 ? "Short":"Long",entryTime:e.timestamp,entryPrice:100,margin:abs(profit/ret),quantity:1,exitTime:e.timestamp+hourMS,exitPrice:100,status:"Closed",reason:"Fixture",uncertain:false,profit:profit,returnValue:ret,holdingHoursLow:1,holdingHoursHigh:1,entryEvent:e)
            try store.saveSuiteTrade(t)
        }
        let report=try store.suiteReport(study,manifest:manifest), total=try XCTUnwrap(report.suite?.summaries.first)
        XCTAssertEqual(total.count,3); XCTAssertEqual(total.winRate!,2.0/3,accuracy:1e-12)
        XCTAssertEqual(total.payoffRatio!,2.5,accuracy:1e-12); XCTAssertEqual(total.profitFactor!,2,accuracy:1e-12)
        XCTAssertEqual(total.profit,25); XCTAssertEqual(total.averageHoursLow,1)
    }
    func testComparedSnapshotsShareMissingEntryPoolAndExitUnknownRetainsHolding() throws {
        let data=try dataset(hours:6); var study=data.1; var second=try profile(universe:"spread > 0")
        second.name="Version with missing spread"
        study.spec.strategySnapshots!.append(second);study.spec.rules=study.spec.allRules;try study.spec.validate()
        var checkpoint=Checkpoint(studyID:study.id,phase:"running")
        try SuiteStudyEngine.run(store:data.0,study:study,manifest:data.2,checkpoint:&checkpoint,progress:{_,_,_ in})
        XCTAssertTrue(try data.0.suiteTrades(study.id).isEmpty)
        XCTAssertEqual(try data.0.suiteReport(study,manifest:data.2).commonPool,0)
        let unknown=try dataset(profile(longExit:"oiUSD > 0",reversal:"1 > 2"),bars:bars([90,100,110,110,110]),hours:4)
        // Freeze a new revision with explicitly missing OI after entry.
        try unknown.0.database.execute("DELETE FROM research_heads WHERE inst=? AND kind='stat' AND ts=?",[ResearchFixture.instrument.id,hour+hourMS])
        try unknown.0.write([.init(instrument:ResearchFixture.instrument.id,kind:"stat",timestamp:hour+hourMS,stat:.init(),sources:["missing-oi"])])
        let frozen=try unknown.0.freeze(ResearchFixture.plan(unknown.1.spec))
        var c=Checkpoint(studyID:unknown.1.id,phase:"running")
        try SuiteStudyEngine.run(store:unknown.0,study:unknown.1,manifest:frozen,checkpoint:&c,progress:{_,_,_ in})
        let trade=try XCTUnwrap(unknown.0.suiteTrades(unknown.1.id).first)
        XCTAssertTrue(trade.uncertain);XCTAssertNotNil(trade.exitTime)
    }
    func testPendingOppositeActionIsPreservedAcrossEngineCheckpoint() async throws {
        let closes=(0...140).map { i in i<61 ? 90.0 : i<63 ? 110.0 : 80.0 }
        let data=try dataset(profile(longExit:"1 > 2",shortExit:"ShortHeldHours >= 1"),bars:bars(closes),hours:140)
        let directory=data.0.directory, study=data.1, manifest=data.2
        let task=Task.detached { () -> Void in
            let store=try ResearchStore(directory:directory);var c=Checkpoint(studyID:study.id,phase:"running")
            try SuiteStudyEngine.run(store:store,study:study,manifest:manifest,checkpoint:&c,progress:{_,_,_ in withUnsafeCurrentTask { $0?.cancel() }})
        }
        do { try await task.value; XCTFail("The fixture must interrupt after the first saved chunk.") } catch is CancellationError {}
        var paused=try XCTUnwrap(data.0.get("checkpoint:\(study.id)",as:Checkpoint.self))
        XCTAssertEqual(paused.suite?.wallets["Gross"]?.signals.pending,"Short")
        try SuiteStudyEngine.run(store:data.0,study:study,manifest:manifest,checkpoint:&paused,progress:{_,_,_ in})
        let trades=try data.0.suiteTrades(study.id)
        XCTAssertEqual(trades.first?.exitTime,hour+63*hourMS);XCTAssertEqual(trades[1].entryTime,hour+64*hourMS)
        let uninterrupted=try run(data).0
        XCTAssertEqual(try trades.map(researchJSON),try uninterrupted.map(researchJSON))
    }
    func testCheckpointResumeTradeCurveIdentityAndAllCSVMetadata() async throws {
        let many = bars((0...241).map { i in [90.0,100,110,90,80,100][i%6] })
        let data = try dataset(bars: many,hours: 240), directory = data.0.directory, study = data.1, manifest = data.2
        let interrupted = Task.detached { () -> Bool in
            let store = try ResearchStore(directory: directory); var c = Checkpoint(studyID: study.id,phase: "running")
            do { try SuiteStudyEngine.run(store: store,study: study,manifest: manifest,checkpoint: &c,progress: { _,_,_ in withUnsafeCurrentTask { $0?.cancel() } }); return false }
            catch is CancellationError { return true }
        }
        let didPause = try await interrupted.value; XCTAssertTrue(didPause)
        var checkpoint = try XCTUnwrap(data.0.get("checkpoint:\(study.id)",as: Checkpoint.self))
        XCTAssertNotNil(checkpoint.suite); XCTAssertNotNil(checkpoint.nextHour)
        try SuiteStudyEngine.run(store: data.0,study: study,manifest: manifest,checkpoint: &checkpoint,progress: { _,_,_ in })
        let resumedTrades = try data.0.suiteTrades(study.id,limit: 100).map(researchJSON)
        let resumedCurve = try data.0.suiteCurve(study.id,profile: study.spec.strategySnapshots![0].id,instrument: ResearchFixture.instrument.id,model: "Gross").map(researchJSON)
        let (_,report) = try run(data)
        XCTAssertEqual(resumedTrades,try data.0.suiteTrades(study.id,limit: 100).map(researchJSON))
        XCTAssertEqual(resumedCurve,try data.0.suiteCurve(study.id,profile: study.spec.strategySnapshots![0].id,instrument: ResearchFixture.instrument.id,model: "Gross").map(researchJSON))
        for kind in ["summary","events","equity"] {
            var rows: [[String]] = []; try SuiteCSV.export(store: data.0,report: report,manifest: manifest,kind: kind,write: { rows.append($0) })
            XCTAssertGreaterThan(rows.count,1); XCTAssertTrue(rows.allSatisfy { $0.count == rows[0].count })
            XCTAssertEqual(rows[1][2],manifest.digest); XCTAssertEqual(rows[1][3],SuiteStudyEngine.version)
            let decoded = try JSONDecoder().decode(StudySpec.self,from: Data(rows[1][5].utf8)); XCTAssertEqual(decoded.capital?.defaults.initial,10_000); XCTAssertEqual(decoded.strategySnapshots?.first?.phaseRules,study.spec.strategySnapshots?.first?.phaseRules)
        }
        try data.0.deleteStudy(study.id); XCTAssertTrue(try data.0.suiteTrades(study.id).isEmpty)
    }
}
