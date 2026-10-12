import XCTest
import ZIPFoundation
@testable import PerpetualRadar

actor ResearchFixtureTransport: ResearchTransport {
    var requests: [String] = []
    var downloads = 0
    var delay: Duration = .zero
    var failAt: Int?
    let candles: [Candle]
    init(candles: [Candle] = [], delay: Duration = .zero) { self.candles = candles; self.delay = delay }
    func get(_ url: URL) async throws -> Data {
        requests.append(url.absoluteString)
        if requests.count == failAt { throw FilterError("Interrupted fixture download") }
        if delay > .zero { try await Task.sleep(for: delay) }
        let params = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        let rows: [Any]
        if url.path.hasSuffix("history-candles") {
            let cursor = Int64(params["after"]!)!
            rows = candles.filter { $0.hour < cursor }.sorted { $0.hour > $1.hour }.prefix(300).map {
                [String($0.hour), String($0.open!), String($0.high), String($0.low), String($0.close), "1", String($0.baseVolume!), String($0.quoteVolume!), "1"]
            }
        } else if url.path.hasSuffix("market-data-history") { rows = [] }
        else { throw FilterError("Unexpected fixture request \(url.path)") }
        return try JSONSerialization.data(withJSONObject: ["code": "0", "data": rows])
    }
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws { downloads += 1; throw FilterError("No archive download is expected.") }
    func counts() -> (Int, Int) { (requests.count, downloads) }
    func setFailure(_ index: Int?) { failAt = index }
    func urls() -> [String] { requests }
}

enum ResearchFixture {
    static let hour: Int64 = 1_750_000_000_000 / hourMS * hourMS
    static let instrument = ResearchInstrument(id: "BTC-USDT-SWAP", listedAt: hour - 900 * hourMS, verified: true, contractValue: 0.01, source: "OKX captured public instrument metadata", observedAt: researchNow())
    static func bars(from: Int64 = hour - 400 * hourMS, through: Int64 = hour + 300 * hourMS) -> [Candle] {
        stride(from: from, through: through, by: Int(hourMS)).map { ts in
            let price = 100 + sin(Double((ts - hour) / hourMS) / 8) * 5
            return Candle(hour: ts, high: price + 2, low: price - 2, close: price + 0.2, quoteVolume: price * 10, baseVolume: 10, open: price)
        }
    }
    static func spec(_ source: String = "Close > 100", kind: String = "filter", through: Int64 = hour + 240 * hourMS) throws -> StudySpec {
        .init(name: "Fixture study", kind: kind, rules: [.init(name: "Original rules", filtersJSON: try FilterCompiler.compile(source: source).config.json)], from: hour, through: through, direction: "Long")
    }
    static func seed(_ store: ResearchStore, bars: [Candle] = bars()) throws {
        try store.put("instrument:\(instrument.id)", kind: "instrument", instrument)
        try store.write(bars.map { .init(instrument: instrument.id, kind: "candle", timestamp: $0.hour, candle: $0, sources: ["fixture"]) })
        try store.write(bars.map { .init(instrument: instrument.id, kind: "stat", timestamp: $0.hour, stat: .init(oi: 1_000_000 + Double(($0.hour-hour)/hourMS), sell: 40, buy: 60), sources: ["fixture"]) })
    }
    static func plan(_ spec: StudySpec) -> DataPlan { .init(spec: spec, instruments: [instrument], from: spec.from ?? hour, through: spec.through, warmupHours: 275) }
}

final class ResearchTests: XCTestCase {
    private func store() throws -> ResearchStore { try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("Research-\(UUID())")) }
    private func evaluate(_ source: String, hour: Int64, series: ResearchSeries) throws -> FilterTrace {
        FilterEvaluator(market: ResearchEngine.context(instrument: ResearchFixture.instrument, hour: hour, series: ResearchEngine.reconstruct(series)), filter: try FilterCompiler.compile(source: source)).evaluate(explain: true)
    }
    func testHourlyCloseLiveClosedAndFutureInvarianceIncludingSequenceCaptures() throws {
        let hour = ResearchFixture.hour
        var series = ResearchSeries(candles: Dictionary(uniqueKeysWithValues: ResearchFixture.bars().map { ($0.hour, $0) }))
        series.candles[hour] = Candle(hour: hour, high: 120, low: 90, close: 110, quoteVolume: 100, baseVolume: 1, open: 100)
        series.candles[hour-hourMS] = Candle(hour: hour-hourMS, high: 102, low: 98, close: 100, quoteVolume: 100, baseVolume: 1, open: 100)
        let sources = ["Close == 110 AND closed(Close == 100)", "lag(turnover, 100) > 0", "available(EMA(200)) AND available(RSI(24))",
                       #"sequence(4, stage("start", Close < 105, 4, capture("level", High)), stage("finish", Close > start.level, 4))"#]
        let filters = try sources.map { try FilterCompiler.compile(source: $0) }
        func hashes(_ input: ResearchSeries) throws -> [String] {
            let context = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: hour, series: ResearchEngine.reconstruct(input))
            return try filters.map { try researchHash(JSONSerialization.data(withJSONObject: FilterEvaluator(market: context, filter: $0).evaluate(explain: true).snapshot, options: [.sortedKeys])) }
        }
        let before = try hashes(series)
        for ts in series.candles.keys where ts > hour {
            series.candles[ts] = Candle(hour: ts, high: 1_100, low: 900, close: 1_000, quoteVolume: 1_000_000, baseVolume: 100, open: 990)
        }
        let after = try hashes(series)
        XCTAssertEqual(before, after)
        XCTAssertEqual(try evaluate(sources[0], hour: hour, series: series).result, .yes)
        var context = ResearchEngine.context(instrument: ResearchFixture.instrument, hour: hour, series: ResearchEngine.reconstruct(series))
        context.previousEMA = 1_000_000
        let filter = try FilterCompiler.compile(source: "EMA(200) < 200")
        XCTAssertEqual(FilterEvaluator(market: context, filter: filter).evaluate().result, .yes, "Historical EMA must ignore the present-day live EMA seed.")
        series.candles.removeValue(forKey: hour-120*hourMS)
        XCTAssertEqual(try evaluate("available(RSI(24))", hour: hour, series: series).result, .no)
        XCTAssertEqual(try evaluate("RSI(24) > 50", hour: hour, series: series).result, .unknown)
    }
    func testTurnoverUsesCompletePast24BaseVolumesAndPriceWithoutQuoteVolumeSubstitution() throws {
        let hour = ResearchFixture.hour
        var series = ResearchSeries(candles: Dictionary(uniqueKeysWithValues: ResearchFixture.bars().map { ($0.hour, $0) }))
        let built = ResearchEngine.reconstruct(series)
        XCTAssertEqual(try XCTUnwrap(built.quotes[hour-100*hourMS]?.turnover), 240 * series.candles[hour-100*hourMS]!.close, accuracy: 1e-8)
        series.candles.removeValue(forKey: hour-12*hourMS)
        XCTAssertNil(ResearchEngine.reconstruct(series).quotes[hour]?.turnover)
    }
    func testMissingRealizedFundingRateKeepsGrossAndDisablesOnlyAffectedNetHorizons() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        let start = ResearchFixture.hour
        try store.write([.init(instrument: ResearchFixture.instrument.id, kind: "funding", timestamp: start+3*hourMS, sources: ["unrealized"])])
        let source = ResearchSource(id: "unrealized", instrument: ResearchFixture.instrument.id, kind: "funding", from: start, through: start+48*hourMS, url: "fixture", filename: "fixture", archive: false)
        try store.cover(source)
        let series = try store.series(source.instrument, from: start, through: start+48*hourMS), costs = ResearchCosts(entryFeeBps: 0, exitFeeBps: 0, slippageBps: 0)
        let short = ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 1, series: series, costs: costs)
        let affected = ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 3, series: series, costs: costs)
        XCTAssertNotNil(short.net)
        XCTAssertNotNil(affected.gross); XCTAssertNil(affected.net); XCTAssertTrue(affected.netReason?.contains("actual funding rate") == true)
    }
    func testEpisodesKeepUnknownSeparateAndNeverRepeatAnEntryAcrossMissingHours() {
        var episode = ResearchEpisode()
        XCTAssertNil(episode.observe(.yes, baseline: true))
        XCTAssertNil(episode.observe(.unknown))
        XCTAssertNil(episode.observe(.yes))
        XCTAssertNil(episode.observe(.no))
        XCTAssertEqual(episode.observe(.yes), "entry")
        XCTAssertNil(episode.observe(.no))
        XCTAssertNil(episode.observe(.unknown))
        XCTAssertEqual(episode.observe(.yes), "uncertain")
        XCTAssertNil(episode.observe(.yes))
    }
    func testHandCalculatedLongShortReturnsEveryHorizonCostsAndVariableFundingIntervals() throws {
        let start = ResearchFixture.hour
        var series = ResearchSeries()
        for i in 0...49 {
            let price = 100 + Double(i)
            series.candles[start+Int64(i)*hourMS] = Candle(hour: start+Int64(i)*hourMS, high: price+2, low: price-2, close: price, quoteVolume: 1, baseVolume: 1, open: price)
        }
        series.fundingCoverage = [.init(from: start, through: start+48*hourMS)]
        series.funding = [ResearchFunding(timestamp: start, rate: 0.8, mark: 100),
                          .init(timestamp: start+hourMS, rate: 0.001, mark: 101),
                          .init(timestamp: start+3*hourMS, rate: -0.002, mark: 103),
                          .init(timestamp: start+7*hourMS, rate: 0.003, mark: 107),
                          .init(timestamp: start+48*hourMS, rate: 0.004, mark: 148)]
        let costs = ResearchCosts(entryFeeBps: 5, exitFeeBps: 8, slippageBps: 10)
        for side in ["Long", "Short"] {
            let sign = side == "Long" ? 1.0 : -1.0
            for hours in ResearchVersion.horizons {
                let outcome = ResearchEngine.outcome(timestamp: start, direction: side, hours: hours, series: series, costs: costs)
                XCTAssertEqual(try XCTUnwrap(outcome.gross), sign * Double(hours) / 100, accuracy: 1e-12)
                let pe = 100 * (1+sign*0.001), px = (100+Double(hours)) * (1-sign*0.001)
                let funding = series.funding.filter { $0.timestamp > start && $0.timestamp <= start+Int64(hours)*hourMS }.reduce(0.0) { $0 + $1.rate*$1.mark! }
                let expected = sign*(px-pe)/pe - (pe*0.0005+px*0.0008)/pe - sign*funding/pe
                XCTAssertEqual(try XCTUnwrap(outcome.net), expected, accuracy: 1e-12)
                XCTAssertEqual(try XCTUnwrap(outcome.mfe), side == "Long" ? Double(hours+1)/100 : 0.02, accuracy: 1e-12)
                XCTAssertEqual(try XCTUnwrap(outcome.mae), side == "Long" ? -0.02 : -Double(hours+1)/100, accuracy: 1e-12)
            }
        }
        let zero = ResearchCosts(entryFeeBps: 0, exitFeeBps: 0, slippageBps: 0)
        XCTAssertNotNil(ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 1, series: series, costs: zero).net)
        series.funding[1].mark = nil
        let missingMark = ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 1, series: series, costs: zero)
        XCTAssertNotNil(missingMark.gross); XCTAssertNil(missingMark.net)
        series.candles.removeValue(forKey: start+2*hourMS)
        XCTAssertNil(ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 3, series: series, costs: nil).gross)
        XCTAssertNotNil(ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 1, series: series, costs: nil).gross)
        XCTAssertNil(ResearchEngine.outcome(timestamp: start, direction: "Long", hours: 48, series: .init(), costs: nil).gross)
    }
    func testPermanentCacheZeroDownloadsExpansionOnlyGapsAndRawPageReplay() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let from = researchNow()/hourMS*hourMS - 500*hourMS
        let instrument = ResearchInstrument(id: "BTC-USDT-SWAP", listedAt: from, verified: true, contractValue: 0.01, source: "fixture", observedAt: researchNow())
        try store.put("instrument:\(instrument.id)", kind: "instrument", instrument)
        let bars = ResearchFixture.bars(from: from, through: from+450*hourMS), transport = ResearchFixtureTransport(candles: bars)
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent.sqlite3"))
        var spec = try ResearchFixture.spec("Close > 0", through: from+360*hourMS); spec.from = from+280*hourMS
        let plan = try await provider.plan(spec) { _ in }
        XCTAssertEqual(plan.sources.count, 1)
        try await provider.prepare(plan.sources[0], instruments: [instrument])
        let count = await transport.counts()
        let repeatPlan = try await provider.plan(spec) { _ in }
        XCTAssertTrue(repeatPlan.sources.isEmpty)
        let observedCounts = await transport.counts()
        XCTAssertEqual(observedCounts.0, count.0)
        spec.through += 10*hourMS
        let expanded = try await provider.plan(spec) { _ in }
        XCTAssertEqual(expanded.sources.count, 1)
        XCTAssertEqual(expanded.sources[0].from, plan.sources[0].through+hourMS)
        // Force a parser revision on the coverage index while retaining originals.
        try store.database.execute("DELETE FROM research_coverage")
        try store.database.execute("DELETE FROM research_heads")
        try await provider.prepare(plan.sources[0], instruments: [instrument])
        let replayCounts = await transport.counts()
        XCTAssertEqual(replayCounts.0, count.0)
        XCTAssertEqual(replayCounts.1, 0)
        XCTAssertNotNil(try store.latest(instrument.id, kind: "candle", timestamp: from+300*hourMS))
    }
    func testFrozenVersionIsolationReplayResumeAndPinnedCleanup() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        let spec = try ResearchFixture.spec(), plan = ResearchFixture.plan(spec), manifest = try store.freeze(plan)
        let study = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        try store.put(study.id, kind: "study", study)
        var checkpoint = Checkpoint(studyID: study.id, phase: "running")
        try ResearchEngine.run(store: store, study: study, manifest: manifest, checkpoint: &checkpoint) { _,_,_ in }
        let before = try researchJSON(store.events(study.id, limit: 100)), report = try store.report(study, manifest: manifest)
        XCTAssertGreaterThan(report.summaries.first { $0.group == "All signals" }?.count ?? 0, 0)
        let replacement = Candle(hour: ResearchFixture.hour+2*hourMS, high: 1100, low: 900, close: 1000, quoteVolume: 10000, baseVolume: 100, open: 990)
        try store.write([.init(instrument: ResearchFixture.instrument.id, kind: "candle", timestamp: replacement.hour, candle: replacement, sources: ["new-version"])])
        XCTAssertNotEqual(try store.freeze(plan).digest, manifest.digest)
        XCTAssertNotEqual(try store.series(ResearchFixture.instrument.id, from: replacement.hour, through: replacement.hour, manifest: manifest.id).candles[replacement.hour]?.close, 1000)
        // Resume from a durable midpoint after removing only subsequent output.
        let midpoint = ResearchFixture.hour+63*hourMS
        try store.database.execute("DELETE FROM research_samples WHERE study=? AND ts>=?", [study.id, midpoint+hourMS])
        try store.database.execute("DELETE FROM research_outcomes WHERE study=? AND ts>=?", [study.id, midpoint+hourMS])
        try store.database.execute("DELETE FROM research_events WHERE study=? AND ts>=?", [study.id, midpoint+hourMS])
        // A clean deterministic rerun must retain exactly the same frozen events.
        checkpoint = Checkpoint(studyID: study.id, phase: "running")
        try ResearchEngine.run(store: store, study: study, manifest: manifest, checkpoint: &checkpoint) { _,_,_ in }
        XCTAssertEqual(try researchJSON(store.events(study.id, limit: 100)), before)
        _ = try store.cleanCache()
        XCTAssertEqual(try researchJSON(store.events(study.id, limit: 100)), before)
        XCTAssertFalse(try store.data(ResearchFixture.instrument.id, from: ResearchFixture.hour, through: ResearchFixture.hour, manifest: manifest.id).isEmpty)
    }
    func testInterruptedRESTPreparationReusesCompletedPagesAndManualRefreshMakesNewInputs() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let start = researchNow()/hourMS*hourMS - 700*hourMS, bars = ResearchFixture.bars(from: start, through: start+699*hourMS)
        let transport = ResearchFixtureTransport(candles: bars), provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        let url = ResearchDataProvider.url("/market/history-candles", [("instId", "BTC-USDT-SWAP"), ("bar", "1H"), ("after", String(start+700*hourMS)), ("limit", "300")])
        let source = ResearchSource(id: "pages", instrument: "BTC-USDT-SWAP", kind: "candle", from: start, through: start+699*hourMS, url: url.absoluteString, filename: "fixture", archive: false)
        await transport.setFailure(2)
        do { try await provider.prepare(source, instruments: [ResearchFixture.instrument]); XCTFail("The second page must interrupt preparation.") } catch {}
        let before = await transport.counts()
        XCTAssertEqual(before.0, 2)
        await transport.setFailure(nil)
        try await provider.prepare(source, instruments: [ResearchFixture.instrument])
        let after = await transport.counts(), urls = await transport.urls()
        XCTAssertEqual(after.0, 4, "The completed first page is reused; only two remaining pages are downloaded.")
        XCTAssertEqual(urls.filter { $0 == urls[0] }.count, 1)
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_heads WHERE kind='candle'"), 700)
        var refresh = source; refresh.id = "refreshed"; refresh.refresh = true
        try await provider.prepare(refresh, instruments: [ResearchFixture.instrument])
        let refreshed = await transport.counts()
        XCTAssertEqual(refreshed.0, 7, "An explicit refresh retrieves fresh pages under a separate immutable source revision.")
        _ = try store.cleanCache()
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(at: store.directory.appendingPathComponent("Raw"), includingPropertiesForKeys: nil).isEmpty)
    }
    func testFundingCoverageStaysFrozenWhenCurrentCoverageChanges() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let spec = try ResearchFixture.spec(), plan = ResearchFixture.plan(spec)
        let source = ResearchSource(id: "funding", instrument: ResearchFixture.instrument.id, kind: "funding", from: ResearchFixture.hour, through: ResearchFixture.hour+48*hourMS, url: "fixture", filename: "actual funding", archive: false, rawHash: "fixture")
        try store.put(source.id, kind: "source", source); try store.cover(source)
        let frozen = try store.freeze(plan)
        var updated = source; updated.from += 24*hourMS
        try store.cover(updated)
        XCTAssertEqual(try store.series(source.instrument, from: source.from, through: source.through, manifest: frozen.id).fundingCoverage.first?.from, source.from)
        XCTAssertEqual(try store.series(source.instrument, from: source.from, through: source.through).fundingCoverage.first?.from, updated.from)
    }
    func testHourlySamplingKeepsUncertainOnsetsSeparateFromPrimaryStatistics() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        try store.database.execute("DELETE FROM research_heads WHERE inst=? AND kind='candle' AND ts=?", [ResearchFixture.instrument.id, ResearchFixture.hour+7*hourMS])
        var spec = try ResearchFixture.spec("Close > 104"); spec.sampling = "hourly"
        let plan = ResearchFixture.plan(spec), manifest = try store.freeze(plan), study = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        var cp = Checkpoint(studyID: study.id, phase: "running")
        try ResearchEngine.run(store: store, study: study, manifest: manifest, checkpoint: &cp) { _,_,_ in }
        let events = try store.events(study.id, limit: 100), report = try store.report(study, manifest: manifest)
        XCTAssertEqual(events.first { $0.timestamp == ResearchFixture.hour+9*hourMS }?.entry, "uncertain")
        XCTAssertEqual(events.first { $0.timestamp == ResearchFixture.hour+10*hourMS }?.entry, "hourly")
        XCTAssertEqual(report.uncertain, 1)
        XCTAssertEqual(report.summaries.first { $0.group == "Uncertain entries · Excluded" && $0.hours == 1 }?.count, 1)
        XCTAssertNil(report.summaries.first { $0.group == "Uncertain entries · Excluded" && $0.hours == 1 }?.intervalLow)
    }
    func testComparisonUsesCommonKnownPoolAndKeepsDelistedEligibilityPointInTime() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        var spec = try ResearchFixture.spec(kind: "comparison")
        spec.rules.append(.init(name: "OI rule", filtersJSON: try FilterCompiler.compile(source: "oiUSD > 0").config.json))
        try store.database.execute("DELETE FROM research_heads WHERE kind='stat' AND ts=? AND inst=?", [ResearchFixture.hour+hourMS, ResearchFixture.instrument.id])
        var plan = ResearchFixture.plan(spec)
        plan.instruments[0].delistedAt = ResearchFixture.hour+150*hourMS
        let manifest = try store.freeze(plan), study = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        var cp = Checkpoint(studyID: study.id, phase: "running")
        try ResearchEngine.run(store: store, study: study, manifest: manifest, checkpoint: &cp) { _,_,_ in }
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_samples WHERE study=? AND ts=? AND entry='outsidePool'", [study.id, ResearchFixture.hour+2*hourMS]), 2)
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_samples WHERE study=? AND ts>=?", [study.id, plan.instruments[0].delistedAt]), 0)
        XCTAssertFalse(ResearchInstrument(id: "X-USDT-SWAP", verified: false, source: "unverified archive", observedAt: 0).eligible(at: ResearchFixture.hour))
    }
    func testBootstrapThresholdsScoreCohortsAndPurgedTimeSplits() throws {
        var bootstrap = ResearchBootstrap(), repeatBootstrap = ResearchBootstrap()
        let blocks = (0..<8).map { (Double($0)*0.01, 4) }
        XCTAssertEqual(bootstrap.interval(blocks)?.0, repeatBootstrap.interval(blocks)?.0)
        XCTAssertNil(bootstrap.interval(Array(blocks.prefix(7))))
        let first = ResearchFixture.hour, through = first+1000*hourMS
        XCTAssertEqual(ResearchEngine.split(timestamp: first+551*hourMS, from: first, through: through), "Observation")
        XCTAssertEqual(ResearchEngine.split(timestamp: first+552*hourMS, from: first, through: through), "Purged")
        XCTAssertEqual(ResearchEngine.split(timestamp: first+600*hourMS, from: first, through: through), "Validation")
        XCTAssertEqual(ResearchEngine.split(timestamp: first+800*hourMS, from: first, through: through), "Holdout")
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        var spec = try ResearchFixture.spec(kind: "score")
        spec.rules.append(spec.rules[0]); let plan = ResearchFixture.plan(spec), manifest = try store.freeze(plan), study = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        for (rule, score, complete, gross) in [(0, 80, true, 0.1), (0, 80, false, -0.1), (1, 70, true, 0.2)] {
            try store.saveSample(study: study.id, rule: rule, instrument: "BTC-USDT-SWAP", timestamp: first+Int64(complete ? 1 : 2)*hourMS, truth: .yes, direction: "Long", entry: "hourly",
                opportunity: .init(direction: "Long", setup: "Startup", status: "Candidate", score: score, components: [:], reasons: []), complete: complete, split: "Observation", outcomes: [.init(hours: 1, gross: gross)], event: nil)
        }
        let report = try store.report(study, manifest: manifest)
        XCTAssertEqual(report.summaries.first { $0.group == "All signals" && $0.ruleIndex == 0 }?.mean, 0.1)
        XCTAssertEqual(report.summaries.first { $0.group == "Score · Partial · 80–100" }?.mean, -0.1)
        XCTAssertEqual(report.summaries.first { $0.group == "Score · Full · ≥65" && $0.ruleIndex == 1 }?.mean, 0.2)
        XCTAssertEqual(report.summaries.first { $0.group == "Score · Full · ≥65" && $0.ruleIndex == 0 }?.median, 0.1)
    }
    private func zip(_ store: ResearchStore, content: String, name: String = "fixture.csv") throws -> URL {
        let file = store.directory.appendingPathComponent("\(UUID()).zip"), bytes = Data(content.utf8), archive = try Archive(url: file, accessMode: .create)
        try archive.addEntry(with: name, type: .file, uncompressedSize: Int64(bytes.count), compressionMethod: .deflate) { position, count in bytes.subdata(in: Int(position)..<min(bytes.count, Int(position)+count)) }
        return file
    }
    func testStreamingArchivesAggregateOnly60ConfirmedMinutesAndPreserveFundingUTC8Dates() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let hour = ResearchFixture.hour
        let header = "\u{feff}instrument_name 合约,open_time,open,high,low,close,vol_ccy,vol_quote,confirm\r\n"
        let rows = (0..<119).map { "BTC-USDT-SWAP,\(hour+Int64($0)*60_000),100,102,99,101,2,200,1\r\n" }.joined()
        let source = ResearchSource(id: "minutes", instrument: "BTC-USDT-SWAP", kind: "candle", from: hour, through: hour+hourMS, url: "fixture", filename: "fixture.zip", archive: true, module: 2)
        _ = try ResearchArchiveImporter(store: store, source: source, instruments: [ResearchFixture.instrument]).run(file: zip(store, content: header+rows))
        XCTAssertEqual(try store.latest("BTC-USDT-SWAP", kind: "candle", timestamp: hour)?.candle?.baseVolume, 120)
        XCTAssertNil(try store.latest("BTC-USDT-SWAP", kind: "candle", timestamp: hour+hourMS))
        XCTAssertEqual(ResearchDataProvider.fileRange("BTC-USDT-SWAP-candles-2024-09.zip")?.from, 1_725_148_800_000-8*hourMS)
        XCTAssertEqual(ResearchDataProvider.fileRange("BTC-USDT-SWAP-books-2024-09.zip", module: 4)?.from, 1_725_148_800_000)
        var decoded: [[String]] = []
        let csv = ResearchCSV { decoded.append($0) }
        for byte in Data("a,\"quote \"\" text\",中文\r\nb,\"two\nlines\",c".utf8) { try csv.feed(Data([byte])) }
        try csv.finish()
        XCTAssertEqual(decoded, [["a", "quote \" text", "中文"], ["b", "two\nlines", "c"]])
    }
    func testLegacyMonthlyCandlesKeepOHLCAndUnknownQuoteVolume() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let first: Int64 = 1_630_425_600_000
        let header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\r\n"
        let rows = (0..<120).map { "BTC-USDT-SWAP,100,102,99,101,10,None,None,\(first + Int64($0) * 60_000),1\r\n" }.joined()
        let external = ProcessInfo.processInfo.environment["RADAR_RESEARCH_ARCHIVE_FIXTURE"].map { URL(fileURLWithPath: $0) }
        let file = try external ?? zip(store, content: header + rows)
        let last = first + Int64(external == nil ? 1 : 719) * hourMS
        var instrument = ResearchFixture.instrument; instrument.listedAt = first - 100 * hourMS
        let source = ResearchSource(id: "legacy", instrument: instrument.id, kind: "candle", from: first, through: last, url: "fixture", filename: "BTC-USDT-SWAP-candlesticks-2021-09.zip", archive: true, module: 2, rawHash: researchHash(try Data(contentsOf: file)))
        try FileManager.default.copyItem(at: file, to: store.rawURL(source))
        try store.put(source.id, kind: "source", source)
        let transport = ResearchFixtureTransport(), provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        try await provider.prepare(source, instruments: [instrument])
        let series = try store.series(instrument.id, from: first, through: last)
        XCTAssertEqual(series.candles.count, external == nil ? 2 : 720)
        XCTAssertTrue(series.candles.values.allSatisfy { $0.open != nil && $0.high >= $0.low && $0.baseVolume != nil && $0.quoteVolume == nil })
        if external == nil {
            XCTAssertEqual(try XCTUnwrap(series.candles[first]?.baseVolume), 6, accuracy: 1e-9)
            XCTAssertEqual(series.candles[first]?.open, 100); XCTAssertEqual(series.candles[first]?.close, 101)
        }
        let context = ResearchEngine.context(instrument: instrument, hour: last, series: ResearchEngine.reconstruct(series))
        XCTAssertEqual(FilterEvaluator(market: context, filter: try FilterCompiler.compile(source: "Close > 0")).evaluate().result, .yes)
        XCTAssertEqual(FilterEvaluator(market: context, filter: try FilterCompiler.compile(source: "Volume > 0")).evaluate().result, .unknown)
        XCTAssertEqual(FilterEvaluator(market: context, filter: try FilterCompiler.compile(source: "VWAP(2) > 0")).evaluate().result, .unknown)
        XCTAssertTrue(try store.missing(instrument.id, kind: "candle", from: first, through: last).isEmpty)
        let saved = try XCTUnwrap(store.get(source.id, as: ResearchSource.self))
        XCTAssertTrue(saved.warnings?.contains { $0.contains("quote-currency volume is missing") } == true)
        let manifest = try store.freeze(.init(spec: try ResearchFixture.spec(), instruments: [instrument], from: first, through: last, warmupHours: 0, sources: [source]))
        XCTAssertTrue(manifest.warnings.contains { $0.contains("OHLC prices were imported") })
        let counts = await transport.counts()
        XCTAssertEqual(counts.1, 0, "Retry must reuse the already downloaded archive.")
    }
    func testMissingArchiveVolumesStayUnknownWithoutVerifiedConversionAndMalformedValuesFail() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let hour = ResearchFixture.hour
        let header = "open_time,open,high,low,close,vol,vol_ccy,vol_quote,confirm\n"
        let rows = (0..<60).map { "\(hour + Int64($0) * 60_000),100,102,99,101,10,None,None,1\n" }.joined()
        var instrument = ResearchFixture.instrument; instrument.contractValue = nil
        let source = ResearchSource(id: "missing", instrument: instrument.id, kind: "candle", from: hour, through: hour, url: "fixture", filename: "fixture.zip", archive: true, module: 2)
        _ = try ResearchArchiveImporter(store: store, source: source, instruments: [instrument]).run(file: zip(store, content: header + rows))
        let candle = try XCTUnwrap(store.latest(instrument.id, kind: "candle", timestamp: hour)?.candle)
        XCTAssertNil(candle.baseVolume); XCTAssertNil(candle.quoteVolume)
        XCTAssertThrowsError(try ResearchArchiveImporter(store: store, source: source, instruments: [instrument]).run(file: zip(store, content: header + rows.replacingOccurrences(of: "None,None", with: "None,broken")))) { error in
            XCTAssertTrue(error.localizedDescription.contains("Invalid archive volume in vol_quote"))
        }
    }
    func testBookSnapshotsUpdatesSequenceGapsAndNoNextHourLeak() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let hour = ResearchFixture.hour
        let records: [[String: Any]] = [
            ["instId": "BTC-USDT-SWAP", "ts": String(hour+hourMS-1), "action": "snapshot", "seqId": 1, "bids": [["100","1"]], "asks": [["102","1"]]],
            ["instId": "BTC-USDT-SWAP", "ts": String(hour+hourMS), "action": "snapshot", "seqId": 2, "bids": [["100","1"]], "asks": [["110","1"]]],
            ["instId": "BTC-USDT-SWAP", "ts": String(hour+2*hourMS-1), "action": "update", "seqId": 4, "prevSeqId": 99, "bids": [], "asks": []]
        ]
        let content = try records.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }.joined(separator: "\n")
        let source = ResearchSource(id: "book", instrument: "BTC-USDT-SWAP", kind: "spread", from: hour, through: hour+hourMS, url: "fixture", filename: "fixture.zip", archive: true, module: 4)
        _ = try ResearchArchiveImporter(store: store, source: source, instruments: [ResearchFixture.instrument]).run(file: zip(store, content: content, name: "books.jsonl"))
        XCTAssertEqual(try XCTUnwrap(store.latest("BTC-USDT-SWAP", kind: "quote", timestamp: hour)?.quote?.spread), 2.0/101*100, accuracy: 1e-12)
        XCTAssertNil(try store.latest("BTC-USDT-SWAP", kind: "quote", timestamp: hour+hourMS))
    }
    func testNativeGzipTAROrderBooksValidateCRCAndReadRealArchiveRecordShape() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let hour = ResearchFixture.hour
        let records: [[String: Any]] = [
            ["instId": "BTC-USDT-SWAP", "ts": hour+59_998, "action": "update", "bids": [["100","1","1"]], "asks": [["102","1","1"]]],
            ["instId": "BTC-USDT-SWAP", "ts": hour+60_000, "action": "snapshot", "bids": [["100","2","1"]], "asks": [["102","3","2"]]],
            ["instId": "BTC-USDT-SWAP", "ts": hour+hourMS, "action": "update", "bids": [["100","0","0"], ["99","1","1"]], "asks": []]
        ]
        let contents = try records.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }.joined(separator: "\n")
        let member = "BTC-USDT-SWAP-L2orderbook-400lv-2024-09-02.data", file = store.directory.appendingPathComponent("books.tar.gz")
        try contents.write(to: store.directory.appendingPathComponent(member), atomically: true, encoding: .utf8)
        let tar = Process(); tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-czf", file.path, "-C", store.directory.path, member]
        tar.environment = ["COPYFILE_DISABLE": "1"]; tar.standardOutput = FileHandle.nullDevice; tar.standardError = FileHandle.nullDevice
        try tar.run(); tar.waitUntilExit(); XCTAssertEqual(tar.terminationStatus, 0)
        let source = ResearchSource(id: "tar-book", instrument: "BTC-USDT-SWAP", kind: "spread", from: hour, through: hour+hourMS, url: "fixture", filename: "books.tar.gz", archive: true, module: 4)
        _ = try ResearchArchiveImporter(store: store, source: source, instruments: [ResearchFixture.instrument]).run(file: file)
        XCTAssertEqual(try XCTUnwrap(store.latest(source.instrument, kind: "quote", timestamp: hour)?.quote?.spread), 2.0/101*100, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(store.latest(source.instrument, kind: "quote", timestamp: hour+hourMS)?.quote?.spread), 3.0/100.5*100, accuracy: 1e-12)
        XCTAssertEqual(ResearchDataProvider.fileRange("BTC-USDT-SWAP-L2orderbook-400lv-2024-09-02.tar.gz", module: 4)?.from, 1_725_235_200_000)
        let original = try Data(contentsOf: file)
        var corrupted = original; corrupted[corrupted.count-8] ^= 0xff; try corrupted.write(to: file)
        XCTAssertThrowsError(try ResearchTar.readGzip(file) { _ in })
        try original.dropLast(8).write(to: file)
        XCTAssertThrowsError(try ResearchTar.readGzip(file) { _ in })
    }
    func testLargeBookTARMemberSizeIsStreamedWithoutAllocatingItsDeclaredSize() throws {
        var header = Data(repeating: 0, count: 512)
        header.replaceSubrange(0..<10, with: Data("books.data".utf8))
        header[124] = 0x80; header[131] = 2 // Binary 8 GiB, without an 8 GiB allocation.
        header[156] = 48
        for i in 148..<156 { header[i] = 32 }
        let checksum = header.reduce(0) { $0+Int($1) }, field = String(format: "%06o", checksum)
        header.replaceSubrange(148..<154, with: Data(field.utf8)); header[154] = 0
        var consumed = 0, name = ""
        let tar = ResearchTar(begin: { name = $0 }, consume: { consumed += $0.count }, finish: {})
        try tar.feed(header); try tar.feed(Data(repeating: 1, count: 64*1024))
        XCTAssertEqual(name, "books.data"); XCTAssertEqual(consumed, 64*1024)
        XCTAssertThrowsError(try tar.complete(), "The member remains incomplete until all declared bytes arrive.")
    }
    @MainActor
    func testPlanningCheckpointManualResumeAndUnfinishedInputsSurviveCacheCleanup() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        let spec = try ResearchFixture.spec("buy >= 0")
        try store.database.execute("DELETE FROM research_heads WHERE kind='stat'")
        let slow = try ResearchController(directory: store.directory, transport: ResearchFixtureTransport(delay: .seconds(5)), radarURL: store.directory.appendingPathComponent("absent"))
        _ = try slow.plan(spec)
        try await Task.sleep(for: .milliseconds(30)); try await slow.stop()
        let saved = try XCTUnwrap(store.objects("study", as: ResearchStudy.self).first)
        XCTAssertEqual(try store.get("checkpoint:\(saved.id)", as: Checkpoint.self)?.phase, "paused")
        let reopened = try ResearchController(directory: store.directory, transport: ResearchFixtureTransport(), radarURL: store.directory.appendingPathComponent("absent"))
        XCTAssertFalse(reopened.isBusy)
        _ = try await reopened.handle(["action": "resume", "studyID": saved.id])
        while reopened.isBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(reopened.status?.phase, "planned", reopened.status?.error ?? "")
        XCTAssertEqual(try store.objects("study", as: ResearchStudy.self).count, 1)
        let resumed = try XCTUnwrap(store.get(saved.id, as: ResearchStudy.self))
        _ = try store.cleanCache()
        XCTAssertNotNil(try store.latest(ResearchFixture.instrument.id, kind: "candle", timestamp: ResearchFixture.hour))
        _ = try reopened.prepare(planID: resumed.planID)
        while reopened.isBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(reopened.status?.phase, "ready", reopened.status?.error ?? "")
        XCTAssertEqual(reopened.status?.resultID, saved.id)
        try store.deleteStudy(saved.id); _ = try store.cleanCache()
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_heads"), 0)
    }
    @MainActor
    func testControllerReturnsImmediateTaskIDsPauseResumeCancelAndCSVExports() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        try ResearchFixture.seed(store)
        let spec = try ResearchFixture.spec(), plan = ResearchFixture.plan(spec)
        try store.put(plan.id, kind: "plan", plan)
        let controller = try ResearchController(directory: store.directory, transport: ResearchFixtureTransport(), radarURL: store.directory.appendingPathComponent("absent"))
        let start = ContinuousClock.now, job = try controller.prepare(planID: plan.id)
        XCTAssertFalse(job.isEmpty); XCTAssertLessThan(start.duration(to: .now), .seconds(1))
        while controller.isBusy { try await Task.sleep(for: .milliseconds(10)) }
        let studyID = try XCTUnwrap(controller.status?.resultID)
        _ = try controller.run(studyID: studyID); try await controller.stop()
        XCTAssertEqual(controller.status?.phase, "paused")
        _ = try await controller.handle(["action": "resume", "studyID": studyID])
        while controller.isBusy { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(controller.status?.phase, "completed", controller.status?.error ?? "")
        XCTAssertThrowsError(try controller.run(studyID: studyID))
        let reader = ResearchReader(directory: store.directory), summary = store.directory.appendingPathComponent("summary.csv"), events = store.directory.appendingPathComponent("events.csv")
        try await reader.export(studyID: studyID, kind: "summary", to: summary)
        try await reader.export(studyID: studyID, kind: "events", to: events)
        XCTAssertTrue(try String(contentsOf: summary, encoding: .utf8).contains("data_digest"))
        XCTAssertTrue(try String(contentsOf: events, encoding: .utf8).contains("trace_json"))
        let event = try XCTUnwrap(store.events(studyID).first)
        let chart = try await reader.chart(eventID: event.id, endingAt: nil)
        XCTAssertFalse(chart.bars.isEmpty)
        _ = try controller.prepare(planID: plan.id); try await controller.stop(cancel: true)
        if let cancelledID = controller.status?.resultID {
            do { _ = try await controller.handle(["action": "resume", "studyID": cancelledID]); XCTFail("Cancelled tasks must not resume.") } catch {}
        }
    }
}
