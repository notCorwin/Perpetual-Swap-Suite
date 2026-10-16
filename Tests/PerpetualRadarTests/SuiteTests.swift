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
    private func profile(universe: String = "1 < 2", setup: String = "Close >= 100") throws -> StrategyProfile {
        .init(name: "Bullish Setup", universeJSON: try json(universe), phaseRules: ["bullishSetup": try json(setup)])
    }
    @MainActor
    func testCollectorStartupIsRecoveringRatherThanPaused() async throws {
        let radar = try Radar(storeURL: directory().appendingPathComponent("radar.sqlite3"))
        var response = try await radar.suiteRequest(["mode": "radar", "action": "inventory"])
        XCTAssertEqual(response["paused"] as? Bool, false)
        XCTAssertEqual(response["recovering"] as? Bool, true)

        try radar.setMonitoringPaused(true)
        response = try await radar.suiteRequest(["mode": "radar", "action": "inventory"])
        XCTAssertEqual(response["paused"] as? Bool, true)
        XCTAssertEqual(response["recovering"] as? Bool, false)
    }
    @MainActor
    func testRadarEvaluationReturnsMaterializedSnapshotWithoutBlockingTheRequest() async throws {
        let radar = try Radar(storeURL: directory().appendingPathComponent("radar.sqlite3"))
        let now = Int64(Date().timeIntervalSince1970 * 1000), current = now / hourMS * hourMS
        try radar.initializeMarkets(
            instruments: [["instId": "BTC-USDT-SWAP", "state": "live", "instCategory": "1", "settleCcy": "USDT"]],
            tickers: [["instId": "BTC-USDT-SWAP", "last": "100", "volCcy24h": "1000", "ts": String(now)]])
        radar.updateCandle("BTC-USDT-SWAP", [String(current), "100", "101", "99", "100", "1", "1", "100", "0"])

        let first = try await radar.suiteRequest(["mode": "radar", "action": "evaluate"])
        XCTAssertEqual(first["evaluationPending"] as? Bool, true)
        XCTAssertEqual((first["confirmed"] as? [Any])?.count, 0)

        var materialized: [String: Any] = [:]
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(10))
            materialized = try await radar.suiteRequest(["mode": "radar", "action": "evaluate"])
            if (materialized["confirmed"] as? [Any])?.count == 1 { break }
        }
        XCTAssertEqual((materialized["confirmed"] as? [Any])?.count, 1)
        XCTAssertEqual((materialized["provisional"] as? [Any])?.count, 1)
        XCTAssertEqual(materialized["evaluationPending"] as? Bool, false)
    }
    func testBuiltInDefaultStrategyMatchesSpecificationAndCannotBeChangedOrDeleted() throws {
        let store = try Store(url: directory().appendingPathComponent("radar.sqlite3"))
        try store.initializeSharedSuiteLibrary()
        let builtIn = try XCTUnwrap(store.suiteProfiles("radar").first)
        XCTAssertEqual(builtIn.id, defaultStrategyID)
        XCTAssertEqual(builtIn.name, "Default Strategy")
        XCTAssertEqual(try store.selectedSuiteProfile("radar")?.id, defaultStrategyID)
        let rules = try builtIn.compiled()
        XCTAssertEqual(rules[0].formula, #"named("Universe", all(named("24h trading volume ≥ 10M USDT", (turnover >= 10)), named("Live Open Interest is increasing", (oiTrend == "rising")), named("Trading history ≥ 6 months", (ListingAgeMonths >= 6)), named("Live Bollinger Bandwidth is expanding", (bbExpansion > 0))))"#)
        for condition in ["(ROC(9) > 0)", "(change(ROC(9), 1) > 0)", "(Price > EMA(200))",
                          #"(High > LogBB(20, 2, "upper"))"#, #"(High > PriorExtreme(48, "high"))"#, "(RSI(24) < 70)"] {
            XCTAssertTrue(rules[1].formula.contains(condition), condition)
        }
        var changed = builtIn; changed.name = "Changed"
        XCTAssertThrowsError(try store.saveSuiteProfile(changed))
        XCTAssertThrowsError(try store.manageSuite(["action": "delete", "profileID": defaultStrategyID], mode: "radar"))
        XCTAssertNotEqual(try store.saveSuiteProfile(builtIn, copy: true).id, defaultStrategyID)
    }
    func testBullishSetupSavesWithOnlyUniverseAndSetupAndRejectsEmptyOrPositionRules() throws {
        let store = try Store(url: directory().appendingPathComponent("radar.sqlite3"))
        let saved = try store.saveSuiteProfile(profile())
        XCTAssertEqual(saved.revision, 1)
        XCTAssertEqual(Set(saved.phaseRules.keys), ["bullishSetup"])
        XCTAssertEqual(try saved.compiled().count, 2)
        var invalid = saved; invalid.phaseRules["bullishSetup"] = FilterConfigV2().json
        XCTAssertThrowsError(try store.saveSuiteProfile(invalid))
        for source in ["LongReturn > 0", "ShortReturn > 0"] {
            XCTAssertThrowsError(try FilterCompiler.compile(source: source))
        }
        XCTAssertEqual(try store.suiteProfiles("radar").first?.revision, 1)
        let copy = try store.saveSuiteProfile(saved, copy: true)
        XCTAssertNotEqual(copy.id, saved.id)
        XCTAssertEqual(copy.phaseRules, saved.phaseRules)
        XCTAssertThrowsError(try store.manageSuite(["action": "open"], mode: "radar"))
    }
    func testUniverseGatesBullishSetupAndUnknownInputsRemainExplicit() async throws {
        let worker = SuiteEvaluationWorker(), p = try profile(universe: "Close > 100", setup: "Close > 0")
        let candle = Candle(hour: hour, high: 90, low: 90, close: 90, quoteVolume: 1, baseVolume: 1, open: 90)
        let market = FilterMarketData(id: ResearchFixture.instrument.id, hour: hour + hourMS, now: hour + hourMS + 1_000, candles: [hour: candle], stats: [:], quotes: [:])
        let reading = try await worker.evaluate([market], profile: p, forming: false, available: true, detail: market.id)[0]
        XCTAssertEqual(reading.action, "Wait")
        XCTAssertEqual(reading.phases["bullishSetup"]?.result, "true")
        XCTAssertEqual(try strategyObservation(profile: p, readings: [reading]).results[market.id + "|Bullish Setup"], .no)
        XCTAssertNotNil(reading.universeTraceJSON); XCTAssertNotNil(reading.phases["bullishSetup"]?.traceJSON)
        let paused = try await worker.evaluate([market], profile: p, forming: false, available: false)[0]
        XCTAssertEqual(paused.action, "Unknown")
        XCTAssertEqual(try strategyObservation(profile: p, readings: [paused]).results[market.id + "|Bullish Setup"], .unknown)
    }
    func testSharedLibraryRevisionsActivationDraftIsolationAndFrozenStudy() throws {
        let directory = directory()
        let radar = try Store(url: directory.appendingPathComponent("radar.sqlite3")), research = try Store(url: radar.url)
        let saved = try radar.saveSuiteProfile(profile())
        _ = try research.manageSuite(["action":"select","profileID":saved.id],mode:"research")
        XCTAssertEqual(try radar.selectedSuiteProfile("radar")?.id,saved.id)
        XCTAssertEqual(try research.suiteProfiles("research").first?.id,saved.id)
        let frozen = saved
        var edited = saved; edited.mode = "research"; edited.phaseRules["bullishSetup"] = try json("Close < 100")
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
    func testExistingModeLibrariesConsolidateWithoutChangingVersions() throws {
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
        XCTAssertEqual(shared.count,3); XCTAssertEqual(Set(shared.map(\.id)),[defaultStrategyID,live.id,historical.id])
        XCTAssertEqual(shared.first(where: {$0.id == historical.id})?.revision,5)
        XCTAssertEqual(try radar.selectedSuiteProfile("research")?.id,live.id)
        XCTAssertNotEqual(shared[0].name,shared[1].name)
        try radar.initializeSharedSuiteLibrary(researchURL: research.url)
        XCTAssertEqual(try radar.suiteProfiles("radar").count,3)
    }
    func testProvisionalRetractionConfirmedCloseBaselineDedupAndUnknownRecovery() async throws {
        let p = try profile(setup: "Close > 100")
        let worker = SuiteEvaluationWorker(), now = hour+hourMS
        var market = FilterMarketData(id: ResearchFixture.instrument.id,hour: now,now: now+1_000,candles: [hour: Candle(hour: hour,high: 111,low: 90,close: 110,quoteVolume: 1,baseVolume: 1,open: 90),now: Candle(hour: now,high: 120,low: 110,close: 120,quoteVolume: 1,baseVolume: 1,open: 110,confirmed: false)],stats: [:],quotes: [:])
        var live = try await worker.evaluate([market],profile: p,forming: true,available: true)
        let closed = try await worker.evaluate([market],profile: p,forming: false,available: true)
        XCTAssertEqual(live[0].phases["bullishSetup"]?.result,"true"); XCTAssertEqual(closed[0].phases["bullishSetup"]?.result,"true")
        market.candles[now] = Candle(hour: now,high: 120,low: 90,close: 90,quoteVolume: 1,baseVolume: 1,open: 110,confirmed: false)
        live = try await worker.evaluate([market],profile: p,forming: true,available: true)
        XCTAssertEqual(live[0].phases["bullishSetup"]?.result,"false")
        let after = try await worker.evaluate([market],profile: p,forming: false,available: true)
        XCTAssertEqual(after[0].phases["bullishSetup"]?.result,closed[0].phases["bullishSetup"]?.result)
        var tracker = FilterMembershipTracker(); let key = market.id+"|Bullish Setup"
        func sample(_ truth: FilterTruth,revision: Int=1) -> FilterObservation { .init(configuration: p.id+"|r\(revision)",universe: [key],results: [key: truth]) }
        XCTAssertTrue(tracker.consume(sample(.yes)).isEmpty); XCTAssertTrue(tracker.consume(sample(.no)).count == 1)
        XCTAssertTrue(tracker.consume(sample(.unknown)).isEmpty); XCTAssertEqual(tracker.consume(sample(.yes)).count,1)
        XCTAssertTrue(tracker.consume(sample(.yes)).isEmpty); XCTAssertTrue(tracker.consume(sample(.unknown)).isEmpty); XCTAssertTrue(tracker.consume(sample(.yes)).isEmpty)
        XCTAssertTrue(tracker.consume(sample(.yes,revision: 2)).isEmpty)
    }
    func testSuiteBTCConfirmationIgnoresFormingPricesAndProvisionalCooldowns() async throws {
        XCTAssertThrowsError(try FilterCompiler.compile(source: #"BTC(ShortReturn, "live") > 0"#))
        let p = try profile(setup: #"cooldown(BTC(ROC(1), "live") > 5, 2)"#)
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
        let live = try await worker.evaluate([own],profile:p,forming:true,available:true)
        let closed = try await worker.evaluate([own],profile:p,forming:false,available:true)
        XCTAssertEqual(live[0].phases["bullishSetup"]?.result,"true")
        XCTAssertEqual(closed[0].phases["bullishSetup"]?.result,"false")
        reference.candles[now] = Candle(hour:now,high:120,low:100,close:100,quoteVolume:1,baseVolume:1,open:100,confirmed:false)
        own.referenceBTC = FilterReferenceSnapshot(market:reference,receivedAt:own.now)
        let retracted = try await worker.evaluate([own],profile:p,forming:true,available:true)
        let unchanged = try await worker.evaluate([own],profile:p,forming:false,available:true)
        XCTAssertEqual(retracted[0].phases["bullishSetup"]?.result,"false","A provisional match must not seed confirmed cooldown memory.")
        XCTAssertEqual(unchanged[0].phases["bullishSetup"]?.result,"false")
    }
}
