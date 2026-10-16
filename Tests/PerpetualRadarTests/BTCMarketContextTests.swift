import XCTest
@testable import PerpetualRadar

final class BTCMarketContextTests: XCTestCase {
    private let hour: Int64 = 10_000 * hourMS
    private func reprice(_ bar: Candle, _ price: Double, confirmed: Bool? = nil) -> Candle {
        Candle(hour: bar.hour, high: max(bar.high, price), low: min(bar.low, price), close: price, quoteVolume: bar.quoteVolume, baseVolume: bar.baseVolume, open: bar.open, confirmed: confirmed ?? bar.confirmed)
    }
    private func market(_ closes: [Double], id: String = "ETH-USDT-SWAP", at h: Int64? = nil, now: Int64? = nil) -> FilterMarketData {
        let h = h ?? hour
        let candles = Dictionary(uniqueKeysWithValues: closes.enumerated().map { age, price in
            let ts = h-Int64(age)*hourMS
            return (ts, Candle(hour: ts, high: price+1, low: price-1, close: price, quoteVolume: 10, baseVolume: 1, open: price, confirmed: age != 0))
        })
        return .init(id: id, hour: h, now: now ?? h+hourMS/2, listedAt: 1, candles: candles, stats: [:], quotes: [:])
    }
    private func context(_ btc: [Double], now: Int64? = nil, memory: FilterCooldownMemory? = nil) -> FilterMarketData {
        var own = market([110, 105, 100, 99], now: now)
        let reference = market(btc, id: btcReferenceID, now: own.now)
        own.referenceBTC = FilterReferenceSnapshot(market: reference, receivedAt: own.now)
        own.cooldowns = memory
        return own
    }
    private func evaluate(_ source: String, _ market: FilterMarketData, explain: Bool = true) throws -> FilterTrace {
        FilterEvaluator(market: market, filter: try FilterCompiler.compile(source: source)).evaluate(explain: explain)
    }
    private func value(_ source: String, _ market: FilterMarketData) throws -> FilterScalar {
        let filter = try FilterCompiler.compile(source: "available(\(source))")
        return FilterEvaluator(market: market, filter: filter).scalar(filter.config.root.children[0].left, at: market.hour)
    }
    private func conditionTrace(_ trace: FilterTrace) -> FilterTrace {
        trace.readingSources.isEmpty ? trace.children.map(conditionTrace).first(where: { !$0.readingSources.isEmpty }) ?? trace : trace
    }

    func testEfficiencyMeasuresNetDirectionWideRangingFlatAndHistoryGaps() throws {
        XCTAssertEqual(try value("Efficiency(4)", market([104,103,102,101,100])).number, 1)
        XCTAssertEqual(try value("Efficiency(4)", market([100,110,100,110,100])).number, 0)
        XCTAssertEqual(try value("Efficiency(4)", market(Array(repeating: 100, count: 5))).number, 0)
        XCTAssertEqual(try XCTUnwrap(value("Efficiency(4)", market([102,101,103,101,100])).number), 1.0/3, accuracy: 1e-12)
        var gap = market([104,103,102,101,100]); gap.candles.removeValue(forKey: hour-2*hourMS)
        XCTAssertNotNil(try value("Efficiency(4)", gap).reason)
    }

    func testCompilerSeparatesBTCDependenciesIncludingDefinitionsAndTimeWindows() throws {
        let filter = try FilterCompiler.compile(source: #"let efficiency = Efficiency(24); Close > 0 AND every(BTC(efficiency, "closed") <= 0.30, 3) AND BTC(oiUSD, "live") > 0"#)
        XCTAssertEqual(filter.requiredHours, 0)
        XCTAssertEqual(filter.metrics, ["Close"])
        XCTAssertFalse(filter.needsStats)
        XCTAssertTrue(filter.btcRequirements!.needsStats)
        XCTAssertEqual(filter.btcRequirements!.hours, 29)
        XCTAssertEqual(filter.btcClocks, ["closed", "live"])
        XCTAssertEqual(filter.units["efficiency"], "ratio")
        let category = try FilterCompiler.compile(source: #"BTC(oiTrend, "closed") == "rising""#)
        XCTAssertEqual(category.editorExpressions[#"BTC(oiTrend, "closed")"#]?.choices.map(\.value), ["rising", "flat", "falling"])
        XCTAssertThrowsError(try FilterCompiler.compile(source: #"BTC(Close, "daily") > 0"#))
        XCTAssertThrowsError(try FilterCompiler.compile(source: #"BTC(LongReturn, "live") < 0"#))
        XCTAssertThrowsError(try FilterCompiler.compile(source: "Efficiency(0) > 0"))
    }

    func testCrashThresholdsIntrahourRecoveryAndSharedReferenceAcrossHiddenBTC() throws {
        let source = #"BTC(ROC(1), "live") <= -2 OR BTC(ROC(3), "live") <= -4"#
        XCTAssertEqual(try evaluate(source, context([98,100,100,100])).result, .yes)
        XCTAssertEqual(try evaluate(source, context([96,96,96,100])).result, .yes)
        XCTAssertEqual(try evaluate(source, context([98.01,100,100,100])).result, .no)
        let gate = try FilterCompiler.compile(source: "Close > 0 AND NOT (\(source))")
        let risky = context([97,100,100,100])
        var another = risky; another.id = "SOL-USDT-SWAP"
        XCTAssertEqual(FilterEvaluator(market: risky, filter: gate).evaluate().result, .no)
        XCTAssertEqual(FilterEvaluator(market: another, filter: gate).evaluate().result, .no)
        let safe = context([100,100,100,100])
        XCTAssertEqual(FilterEvaluator(market: safe, filter: gate).evaluate().result, .yes)
        XCTAssertEqual(safe.id, "ETH-USDT-SWAP", "BTC is reference data, independently of the displayed target universe.")
    }

    func testLiveClosedAlignedAndOffsetsRemainIndependentOfLongClock() throws {
        let original = context([90,100,110,120,130,140])
        XCTAssertEqual(try value(#"BTC(Close, "live")"#, original).number, 90)
        XCTAssertEqual(try value(#"BTC(Close, "closed")"#, original).number, 100)
        let closed = SuiteEvaluation.context(original, forming: false)
        XCTAssertEqual(try value("BTC(Close)", closed).number, 100)
        XCTAssertEqual(try value(#"BTC(Close, "live")"#, closed).number, 90)
        XCTAssertEqual(try value(#"BTC(Close, "closed")"#, closed).number, 100)
        XCTAssertEqual(try value(#"lag(BTC(Close, "closed"), 1)"#, closed).number, 110)
        XCTAssertEqual(try value(#"BTC(lag(Close, 1), "closed")"#, closed).number, 110)
        XCTAssertEqual(try value(#"closed(BTC(Close, "live"))"#, closed).number, 100)
        XCTAssertEqual(try value(#"mean(BTC(Close, "closed"), 3)"#, closed).number, 110)
        let trace = conditionTrace(try evaluate(#"btc(lag(Close, 1), "closed") == 110"#, closed))
        let source = try XCTUnwrap(trace.readingSources.values.first?.first)
        XCTAssertEqual(source.instrument, btcReferenceID); XCTAssertEqual(source.clock, "closed")
        XCTAssertEqual(source.hour, hour-2*hourMS)
        XCTAssertTrue(trace.referenceDriven, "Function names are case insensitive in both computation and provenance.")
        let aggregate = conditionTrace(try evaluate(#"mean(abs(BTC(ROC(1), "closed")), 3) > 0"#, closed))
        XCTAssertEqual(Set(aggregate.readingSources.values.flatMap { $0 }.map(\.hour)), Set([hour-hourMS,hour-2*hourMS,hour-3*hourMS]))
        XCTAssertEqual(try evaluate(#"BTC(mean(Close, 100000000), "closed") > 0"#, closed).result, .unknown, "Missing huge lookbacks must not allocate huge provenance arrays.")
    }

    func testThirtySecondFreshnessDisconnectMissingAndKleeneIndependentExit() throws {
        var own = context([97,100,100,100]), reference = own.referenceBTC!
        own.now += 30_000
        XCTAssertEqual(try evaluate(#"BTC(ROC(1), "live") <= -2"#, own).result, .yes)
        own.now += 1
        XCTAssertEqual(try evaluate(#"BTC(ROC(1), "live") <= -2"#, own).result, .unknown)
        XCTAssertEqual(try evaluate(#"BTC(Close, "closed") == 100"#, own).result, .yes)
        own.referenceBTC = FilterReferenceSnapshot(market: reference.market, receivedAt: own.now, connected: false)
        XCTAssertEqual(try evaluate(#"BTC(Close, "live") > 0"#, own).result, .unknown)
        own.referenceBTC = nil
        XCTAssertEqual(try evaluate(#"Close > 100 OR BTC(ROC(1), "live") <= -2"#, own).result, .yes)
        XCTAssertEqual(try evaluate(#"Close > 100 AND NOT (BTC(ROC(1), "live") <= -2)"#, own).result, .unknown)
        reference = FilterReferenceSnapshot(market: reference.market, receivedAt: own.now)
        own.referenceBTC = reference
        own.hour += hourMS
        XCTAssertEqual(try value("BTC(Close)", own).reason, "BTC data is later than the evaluation boundary.")
    }

    func testRangingRequiresThreeClosedHoursAndIgnoresLiveCandleUntilRollover() throws {
        let source = #"every(BTC(Efficiency(4), "closed") <= 0.30, 3)"#
        var own = context([500,100,110,100,110,100,110,100,110])
        XCTAssertEqual(try evaluate(source, own).result, .yes)
        let btc = own.referenceBTC!.market
        var changed = btc; changed.candles[hour] = reprice(changed.candles[hour]!, 1_000)
        own.referenceBTC = FilterReferenceSnapshot(market: changed, receivedAt: own.now)
        XCTAssertEqual(try evaluate(source, own).result, .yes)
        changed.candles[hour] = reprice(changed.candles[hour]!, 1_000, confirmed: true); changed.hour += hourMS; changed.now += hourMS
        changed.candles[changed.hour] = Candle(hour: changed.hour, high: 1_001, low: 999, close: 1_000, quoteVolume: 1, baseVolume: 1, open: 1_000, confirmed: false)
        own.hour += hourMS; own.now += hourMS
        own.referenceBTC = FilterReferenceSnapshot(market: changed, receivedAt: own.now)
        XCTAssertEqual(try evaluate(source, own).result, .no)
        var gap = btc; gap.candles.removeValue(forKey: hour-6*hourMS)
        own = context([500,100,110,100,110,100,110,100,110]); own.referenceBTC = FilterReferenceSnapshot(market: gap, receivedAt: own.now)
        XCTAssertEqual(try evaluate(source, own).result, .unknown)
        XCTAssertEqual(try evaluate(source, context(Array(repeating: 100, count: 8))).result, .yes)
    }

    func testOptionalCooldownTriggersImmediatelyRetainsIntrahourMatchAndExpiresExactly() throws {
        let memory = FilterCooldownMemory(), start = hour+hourMS/4
        let filter = try FilterCompiler.compile(source: #"cooldown(BTC(ROC(1), "live") <= -2, 1)"#)
        var own = context([97,100,100,100], now: start, memory: memory)
        XCTAssertEqual(FilterEvaluator(market: own, filter: filter).evaluate().result, .yes)
        own = context([100,100,100,100], now: start+300_000, memory: memory)
        let held = FilterEvaluator(market: own, filter: filter).evaluate(explain: true).children[0]
        XCTAssertEqual(held.result, .yes)
        XCTAssertEqual(try XCTUnwrap(held.readings["Cooldown remaining"]?.number), 11.0/12, accuracy: 1e-12)
        XCTAssertEqual(try evaluate(#"cooldown(BTC(ROC(1), "live") <= -2, 0)"#, own).result, .no)
        var next = market([100,100,100,100], at: hour+hourMS, now: start+hourMS)
        next.referenceBTC = FilterReferenceSnapshot(market: market([100,100,100,100], id: btcReferenceID, at: next.hour, now: next.now), receivedAt: next.now)
        next.cooldowns = memory
        XCTAssertEqual(FilterEvaluator(market: next, filter: filter).evaluate().result, .no)
        own.referenceBTC = nil
        XCTAssertEqual(FilterEvaluator(market: own, filter: filter).evaluate().result, .yes, "A known active cooldown survives unavailable live inputs.")
        next.referenceBTC = nil
        XCTAssertEqual(FilterEvaluator(market: next, filter: filter).evaluate().result, .unknown)
        let disabled = try FilterCompiler.compile(source: #"cooldown(BTC(ROC(1), "live") <= -2, 0)"#)
        let edited = try FilterCompiler.compile(source: #"cooldown(BTC(ROC(1), "live") <= -2, 2)"#, previous: disabled.config)
        XCTAssertEqual(edited.config.root.children[0].hours, 2, "Formula edits must not restore an inactive visual default.")
    }

    func testSharedBTCCooldownObservesRiskEvenWhenContractConditionShortCircuits() throws {
        let memory = FilterCooldownMemory(), start = hour+hourMS/4
        let filter = try FilterCompiler.compile(source: #"Close < 100 AND NOT cooldown(BTC(ROC(1), "live") <= -2, 1)"#)
        let first = context([97,100,100,100], now: start, memory: memory)
        XCTAssertEqual(FilterEvaluator(market: first, filter: filter).evaluate().result, .no)
        var recovered = context([100,100,100,100], now: start+300_000, memory: memory)
        recovered.id = "SOL-USDT-SWAP"; recovered.candles[hour] = reprice(recovered.candles[hour]!, 90)
        XCTAssertEqual(FilterEvaluator(market: recovered, filter: filter).evaluate().result, .no)
        recovered.referenceBTC = nil
        let proof = FilterEvaluator(market: recovered, filter: try FilterCompiler.compile(source: "true OR BTC(Close) > 0"), referenceOnly: true).evaluate()
        XCTAssertFalse(proof.referenceDriven, "A constant match cannot be presented as a BTC risk trigger.")
    }

    func testBTCResearchClocksHaveNoFutureReadsAndCooldownUsesHourlySamples() throws {
        var btc = ResearchSeries(candles: Dictionary(uniqueKeysWithValues: ResearchFixture.bars().map { ($0.hour,$0) }))
        let h = ResearchFixture.hour
        btc.candles[h] = reprice(btc.candles[h]!, 97); btc.candles[h-hourMS] = reprice(btc.candles[h-hourMS]!, 100)
        let source = #"BTC(ROC(1), "live") <= -2 AND BTC(ROC(1), "closed") <= -2"#
        let filter = try FilterCompiler.compile(source: source)
        func run(_ series: ResearchSeries) throws -> String {
            let reference = ResearchEngine.BTCSeries(instrument: ResearchFixture.instrument, series: series)
            let own = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: h, series: series, reference: reference)
            let trace = FilterEvaluator(market: own, filter: filter).evaluate(explain: true)
            XCTAssertEqual(trace.result, .yes)
            XCTAssertEqual(conditionTrace(trace).readingSources.values.first?.first?.hour, h)
            XCTAssertEqual(conditionTrace(trace).readingSources.values.first?.first?.clock, "closed")
            return try researchHash(JSONSerialization.data(withJSONObject: trace.snapshot, options: [.sortedKeys]))
        }
        let before = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: h, series: btc, reference: .init(instrument: ResearchFixture.instrument, series: btc))
        let beforeValues = try [value(#"BTC(ROC(1), "live")"#, before), value(#"BTC(Close, "closed")"#, before)]
        let hash = try run(btc)
        for ts in btc.candles.keys where ts > h { btc.candles[ts] = reprice(btc.candles[ts]!, 50_000) }
        let after = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: h, series: btc, reference: .init(instrument: ResearchFixture.instrument, series: btc))
        XCTAssertEqual(hash, try run(btc))
        XCTAssertEqual(beforeValues, try [value(#"BTC(ROC(1), "live")"#, after), value(#"BTC(Close, "closed")"#, after)])
        btc.candles[h+hourMS] = reprice(btc.candles[h+hourMS]!, 100)
        btc.candles[h+2*hourMS] = reprice(btc.candles[h+2*hourMS]!, 100)
        let cooldown = try FilterCompiler.compile(source: #"cooldown(BTC(ROC(1), "live") <= -2, 2)"#)
        for (offset, truth) in [(0,FilterTruth.yes),(1,.yes),(2,.no)] {
            let context = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: h+Int64(offset)*hourMS, series: btc, reference: .init(instrument: ResearchFixture.instrument, series: btc))
            XCTAssertEqual(FilterEvaluator(market: context, filter: cooldown).evaluate().result, truth)
        }
    }

    func testResearchDownloadsAndFreezesBTCWithoutAddingItToSamplePopulation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("BTCResearch-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory), h = researchNow()/hourMS*hourMS-100*hourMS
        let first = h-400*hourMS, last = h+60*hourMS
        let target = ResearchInstrument(id: "ETH-USDT-SWAP", listedAt: first, verified: true, contractValue: 0.01, source: "fixture metadata", observedAt: researchNow())
        var btc = target; btc.id = btcReferenceID; btc.metadataSourceID = "btc-metadata"
        try store.put("instrument:\(target.id)", kind: "instrument", target)
        try store.put("instrument:\(btc.id)", kind: "instrument", btc)
        try store.put("btc-metadata", kind: "source", ResearchSource(id: "btc-metadata", instrument: btc.id, kind: "metadata", from: first, through: last, url: "fixture metadata", filename: "BTC metadata", archive: false))
        let bars = stride(from: first, through: last, by: Int(hourMS)).map { ts in
            Candle(hour: ts, high: 101, low: 95, close: ts == h ? 97 : 100, quoteVolume: 10, baseVolume: 1, open: 100)
        }
        try store.write(bars.map { bar in
            let flat = reprice(bar, 100)
            return ResearchDatum(instrument: target.id, kind: "candle", timestamp: flat.hour, candle: flat, sources: ["eth-candles"])
        })
        let transport = ResearchFixtureTransport(candles: bars), provider = ResearchDataProvider(store: store, transport: transport, radarURL: directory.appendingPathComponent("unused.sqlite3"))
        let spec = StudySpec(name: "BTC reference study", rules: [.init(name: "Risk", filtersJSON: try FilterCompiler.compile(source: #"BTC(ROC(1), "live") <= -2"#).config.json)], instruments: [target.id], from: h, through: h+10*hourMS, direction: "Long")
        let plan = try await provider.plan(spec) { _ in }
        XCTAssertEqual(plan.instruments.map(\.id), [target.id]); XCTAssertEqual(plan.referenceInstruments.map(\.id), [btc.id])
        XCTAssertTrue(plan.sources.contains { $0.instrument == btc.id && $0.kind == "candle" })
        XCTAssertFalse(plan.sources.contains { $0.instrument == target.id })
        XCTAssertTrue(plan.warnings.contains { $0.hasPrefix("Hourly approximation of live BTC rules") })
        for source in plan.sources { try await provider.prepare(source, instruments: plan.inputInstruments) }
        let frozen = try store.freeze(plan)
        XCTAssertTrue(frozen.sources.contains { $0.instrument == btc.id && $0.kind == "candle" })
        XCTAssertTrue(frozen.sources.contains { $0.id == "btc-metadata" })
        XCTAssertEqual(frozen.instruments.count, 1); XCTAssertEqual(frozen.referenceInstruments.count, 1)
        let reference = try XCTUnwrap(ResearchEngine.btcSeries(store: store, manifest: frozen, from: first, through: last, required: true))
        let own = ResearchEngine.context(instrument: target, hour: h, series: try store.series(target.id, from: first, through: last, manifest: frozen.id), reference: reference)
        XCTAssertEqual(try evaluate(#"BTC(ROC(1), "live") <= -2"#, own).result, .yes)
        let edited = reprice(bars.first { $0.hour == h }!, 100)
        try store.write([.init(instrument: btc.id, kind: "candle", timestamp: h, candle: edited, sources: ["later-btc-data"])])
        let newer = try store.freeze(plan)
        XCTAssertNotEqual(frozen.digest, newer.digest, "Reference input revisions participate in the frozen digest.")
        XCTAssertEqual(try store.series(btc.id, from: h, through: h, manifest: frozen.id).candles[h]?.close, 97)
        let study = ResearchStudy(spec: spec, planID: plan.id, manifestID: frozen.id)
        var checkpoint = Checkpoint(studyID: study.id, phase: "running")
        try ResearchEngine.run(store: store, study: study, manifest: frozen, checkpoint: &checkpoint, progress: { _,_,_ in })
        let count = try store.count("SELECT COUNT(DISTINCT inst) FROM research_samples WHERE study=?", [study.id])
        XCTAssertEqual(count, 1)
        let events = try store.events(study.id)
        XCTAssertTrue(events.allSatisfy { $0.instrument == target.id })
        XCTAssertTrue(events.contains { $0.sources.contains("btc-metadata") })
    }
}
