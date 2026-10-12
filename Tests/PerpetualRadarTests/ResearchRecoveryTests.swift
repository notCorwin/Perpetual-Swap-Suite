import XCTest
import ZIPFoundation
@testable import PerpetualRadar

private actor RecoveryTransport: ResearchTransport {
    let candles: [Candle]
    let transient: Bool
    let archivePayload: Data?
    private var requests: [String: Int] = [:]
    private var downloads = 0
    init(candles: [Candle], transient: Bool = false, archivePayload: Data? = nil) {
        self.candles = candles; self.transient = transient; self.archivePayload = archivePayload
    }
    func get(_ url: URL) async throws -> Data {
        requests[url.absoluteString, default: 0] += 1
        if transient, url.absoluteString.contains("retry=1"), requests[url.absoluteString] == 1 { throw URLError(.timedOut) }
        let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value.flatMap(Int64.init) ?? .max
        let rows = candles.filter { $0.hour < cursor }.sorted { $0.hour > $1.hour }.map {
            [String($0.hour), String($0.open!), String($0.high), String($0.low), String($0.close), "1", "10", "1000", "1"]
        }
        return try JSONSerialization.data(withJSONObject: ["code": "0", "data": rows])
    }
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws {
        downloads += 1
        guard let archivePayload else { throw FilterError("Unexpected archive download") }
        try archivePayload.write(to: destination)
    }
    func counts() -> (requests: [String: Int], downloads: Int) { (requests, downloads) }
}

final class ResearchRecoveryTests: XCTestCase {
    private func store() throws -> ResearchStore {
        try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ResearchRecovery-\(UUID())"))
    }
    private func archive(_ store: ResearchStore, invalid: Bool = false, confirmed: Bool = true) throws -> ResearchSource {
        let source = ResearchSource(id: "archive", instrument: ResearchFixture.instrument.id, kind: "candle", from: ResearchFixture.hour,
                                    through: ResearchFixture.hour + hourMS, url: "https://example.com/history.zip", filename: "history.zip", archive: true, module: 2)
        let header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
        let rows = (0..<120).map { minute in
            "BTC-USDT-SWAP,100,102,\(invalid && minute == 60 ? 0 : 99),101,2,2,200,\(ResearchFixture.hour + Int64(minute) * 60_000),\(invalid || confirmed && minute < 60 ? 1 : 0)\n"
        }.joined()
        let bytes = Data((header + rows).utf8), zip = try Archive(url: store.rawURL(source), accessMode: .create)
        try zip.addEntry(with: "minutes.csv", type: .file, uncompressedSize: Int64(bytes.count), compressionMethod: .deflate) { position, count in
            bytes.subdata(in: Int(position)..<min(bytes.count, Int(position) + count))
        }
        var saved = source; saved.rawHash = researchHash(try Data(contentsOf: store.rawURL(source)))
        try store.put(saved.id, kind: "source", saved)
        return saved
    }

    func testUnconfirmedArchiveMinutesRecoverThroughConfirmedHourlyHistory() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let source = try archive(store), transport = RecoveryTransport(candles: ResearchFixture.bars(from: source.from, through: source.through))
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        try await provider.prepare(source, instruments: [ResearchFixture.instrument])
        XCTAssertTrue(try store.missingConfirmedCandles(source.instrument, from: source.from, through: source.through).isEmpty)
        let first = try XCTUnwrap(store.latest(source.instrument, kind: "candle", timestamp: source.from))
        let second = try XCTUnwrap(store.latest(source.instrument, kind: "candle", timestamp: source.through))
        XCTAssertEqual(first.candle?.baseVolume, 120)
        XCTAssertEqual(first.sources, [source.id], "Confirmed archive hours are retained without replacement.")
        XCTAssertEqual(second.candle?.baseVolume, 10)
        XCTAssertEqual(second.candle?.confirmed, true)
        XCTAssertFalse(second.sources.contains(source.id), "Unconfirmed minute candles must never become confirmed hourly inputs.")
        let saved = try XCTUnwrap(store.get(source.id, as: ResearchSource.self)), counts = await transport.counts()
        XCTAssertTrue(saved.warnings?.contains { $0.contains("60 unconfirmed minute candles") } == true)
        XCTAssertEqual(counts.requests.count, 1)
        XCTAssertEqual(counts.downloads, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.rawURL(source).path))
    }

    func testUnavailableArchiveHoursContinueWithExplicitUnknownCoverage() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let source = try archive(store, confirmed: false), transport = RecoveryTransport(candles: [])
        var plan = ResearchFixture.plan(try ResearchFixture.spec()); plan.sources = [source]
        let study = ResearchStudy(spec: plan.spec, planID: plan.id), worker = ResearchWorker(directory: store.directory, transport: transport)
        let prepared = try await worker.prepare(study, plan: plan) { _, _, _ in }
        let manifest = try XCTUnwrap(store.get(try XCTUnwrap(prepared.manifestID), as: DataManifest.self))
        XCTAssertTrue(manifest.warnings.contains { $0.contains("2 hourly candles remain unavailable") && $0.contains("Unknown") })
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_coverage WHERE source=?", [source.id]), 0)
        XCTAssertNil(try store.latest(source.instrument, kind: "candle", timestamp: source.from))
        XCTAssertEqual(try store.get("checkpoint:\(study.id)", as: Checkpoint.self)?.phase, "ready")
    }

    func testMalformedCandleArchiveUsesVerifiedRESTInputsWithoutAcceptingBadCoverage() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let source = try archive(store, invalid: true), transport = RecoveryTransport(candles: ResearchFixture.bars(from: source.from, through: source.through))
        let provider = ResearchDataProvider(store: store, transport: transport)
        try await provider.prepare(source, instruments: [ResearchFixture.instrument])
        XCTAssertTrue(try store.missingConfirmedCandles(source.instrument, from: source.from, through: source.through).isEmpty)
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_coverage WHERE source=?", [source.id]), 0)
        let saved = try XCTUnwrap(store.get(source.id, as: ResearchSource.self))
        XCTAssertTrue(saved.warnings?.contains { $0.contains("invalid archive records") && $0.contains("requested automatically") } == true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.rawURL(source).path))
        let counts = await transport.counts(); XCTAssertEqual(counts.requests.count, 1)
    }

    func testDamagedCachedArchiveIsRetainedAndReplacedAutomatically() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let source = try archive(store), payload = try Data(contentsOf: store.rawURL(source))
        try await ResearchDataProvider(store: store, transport: RecoveryTransport(candles: ResearchFixture.bars(from: source.from, through: source.through))).prepare(source, instruments: [ResearchFixture.instrument])
        try Data("damaged".utf8).write(to: store.rawURL(source))
        let transport = RecoveryTransport(candles: ResearchFixture.bars(from: source.from, through: source.through), archivePayload: payload)
        try await ResearchDataProvider(store: store, transport: transport).prepare(source, instruments: [ResearchFixture.instrument])
        XCTAssertEqual(try Data(contentsOf: store.rawURL(source)), payload)
        let files = try FileManager.default.contentsOfDirectory(at: store.rawURL(source).deletingLastPathComponent(), includingPropertiesForKeys: nil)
        XCTAssertTrue(files.contains { $0.lastPathComponent.hasPrefix("archive.zip.rejected-") })
        let counts = await transport.counts(); XCTAssertEqual(counts.downloads, 1)
        XCTAssertTrue(try store.missingConfirmedCandles(source.instrument, from: source.from, through: source.through).isEmpty)
    }

    func testRejectedStreamingArchiveRestoresEarlierIndependentCandles() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let first = ResearchFixture.hour
        let original = Candle(hour: first, high: 202, low: 199, close: 201, quoteVolume: 999, baseVolume: 999, open: 200)
        try store.write([.init(instrument: ResearchFixture.instrument.id, kind: "candle", timestamp: first, candle: original, sources: ["verified-original"])])
        var source = ResearchSource(id: "rejected-stream", instrument: ResearchFixture.instrument.id, kind: "candle", from: first,
                                    through: first + 299 * hourMS, url: "fixture", filename: "history.zip", archive: true, module: 2)
        let header = "open_time,open,high,low,close,vol_ccy,vol_quote,confirm\n"
        let rows = (0..<18_000).map { minute in
            "\(first + Int64(minute) * 60_000),100,102,\(minute == 17_999 ? 0 : 99),101,2,200,1\n"
        }.joined()
        let bytes = Data((header + rows).utf8), zip = try Archive(url: store.rawURL(source), accessMode: .create)
        try zip.addEntry(with: "minutes.csv", type: .file, uncompressedSize: Int64(bytes.count), compressionMethod: .deflate) { position, count in
            bytes.subdata(in: Int(position)..<min(bytes.count, Int(position) + count))
        }
        source.rawHash = researchHash(try Data(contentsOf: store.rawURL(source)))
        try store.put(source.id, kind: "source", source)
        try await ResearchDataProvider(store: store, transport: RecoveryTransport(candles: [])).prepare(source, instruments: [ResearchFixture.instrument])
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_heads WHERE kind='candle'"), 1, "Chunks from a rejected archive must never enter the frozen dataset, even if REST has no replacement.")
        let restored = try XCTUnwrap(store.latest(source.instrument, kind: "candle", timestamp: first))
        XCTAssertEqual(restored.candle?.baseVolume, 999)
        XCTAssertEqual(restored.sources, ["verified-original"])
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_coverage WHERE source=?", [source.id]), 0)
    }

    func testMonthlyArchiveWith41760UnconfirmedMinutesKeepsIts24VerifiedHours() throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let first: Int64 = 1_693_497_600_000
        let source = ResearchSource(id: "monthly", instrument: "1INCH-USDT-SWAP", kind: "candle", from: first, through: first + 719 * hourMS,
                                    url: "fixture", filename: "1INCH-USDT-SWAP-candlesticks-2023-09.zip", archive: true, module: 2)
        if let fixture = ProcessInfo.processInfo.environment["RADAR_RESEARCH_RECOVERY_ARCHIVE_FIXTURE"] {
            try FileManager.default.copyItem(at: URL(fileURLWithPath: fixture), to: store.rawURL(source))
        } else {
            let header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            let rows = (0..<43_200).map { minute in
                "1INCH-USDT-SWAP,0.2518,0.2519,0.2513,0.2518,2,2,0.5036,\(first + Int64(minute) * 60_000),\(minute < 1440 ? 1 : 0)\n"
            }.joined()
            let bytes = Data((header + rows).utf8), zip = try Archive(url: store.rawURL(source), accessMode: .create)
            try zip.addEntry(with: "minutes.csv", type: .file, uncompressedSize: Int64(bytes.count), compressionMethod: .deflate) { position, count in
                bytes.subdata(in: Int(position)..<min(bytes.count, Int(position) + count))
            }
        }
        var instrument = ResearchFixture.instrument; instrument.id = source.instrument; instrument.listedAt = first - hourMS
        let importer = ResearchArchiveImporter(store: store, source: source, instruments: [instrument])
        _ = try importer.run(file: store.rawURL(source))
        XCTAssertEqual(importer.rows, 43_200)
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_heads WHERE kind='candle'"), 24)
        XCTAssertTrue(importer.warnings.contains { $0.contains("41760 unconfirmed minute candles") })
    }

    @MainActor
    func testTransientSourceRetriesKeepOtherCompletedSourcesAndFinishAutomatically() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let transport = RecoveryTransport(candles: ResearchFixture.bars(from: ResearchFixture.hour, through: ResearchFixture.hour), transient: true)
        var plan = ResearchFixture.plan(try ResearchFixture.spec())
        plan.sources = (0..<2).map { index in
            let url = ResearchDataProvider.url("/market/history-candles", [("after", String(ResearchFixture.hour + hourMS)), ("retry", String(index))])
            return ResearchSource(id: "source-\(index)", instrument: ResearchFixture.instrument.id, kind: "candle", from: ResearchFixture.hour,
                                  through: ResearchFixture.hour, url: url.absoluteString, filename: "Source \(index)", archive: false)
        }
        try store.put(plan.id, kind: "plan", plan)
        let controller = try ResearchController(directory: store.directory, transport: transport)
        var busy: [Bool] = []; controller.onBusyChanged = { busy.append($0) }
        _ = try controller.prepare(planID: plan.id)
        let deadline = ContinuousClock.now + .seconds(5)
        var savedDuringRetry = false
        while controller.isBusy, ContinuousClock.now < deadline {
            if let study = try store.objects("study", as: ResearchStudy.self).first,
               let checkpoint = try store.get("checkpoint:\(study.id)", as: Checkpoint.self),
               checkpoint.completedSources == ["source-0"] {
                savedDuringRetry = true
                XCTAssertEqual(checkpoint.phase, "preparing"); XCTAssertNil(checkpoint.error)
                XCTAssertEqual(controller.status?.phase, "preparing"); XCTAssertEqual(controller.status?.error, "")
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        if controller.isBusy { try await controller.stop(); XCTFail("Automatic retry did not finish") }
        XCTAssertTrue(savedDuringRetry)
        XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
        XCTAssertEqual(controller.status?.completed, 2)
        XCTAssertEqual(busy, [true, false], "Automatic retry must not end/restart the task or release its activity.")
        let counts = await transport.counts()
        XCTAssertEqual(counts.requests[plan.sources[0].url], 1)
        XCTAssertEqual(counts.requests[plan.sources[1].url], 2)
    }

    @MainActor
    func testPauseAndCancelInterruptAutomaticRetriesWithoutRestarting() async throws {
        for cancel in [false, true] {
            let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
            let transport = RecoveryTransport(candles: [], transient: true)
            var plan = ResearchFixture.plan(try ResearchFixture.spec())
            let url = ResearchDataProvider.url("/market/history-candles", [("after", String(ResearchFixture.hour + hourMS)), ("retry", "1")])
            plan.sources = [.init(id: "retry", instrument: ResearchFixture.instrument.id, kind: "candle", from: ResearchFixture.hour,
                                  through: ResearchFixture.hour, url: url.absoluteString, filename: "Retry source", archive: false)]
            try store.put(plan.id, kind: "plan", plan)
            let controller = try ResearchController(directory: store.directory, transport: transport)
            _ = try controller.prepare(planID: plan.id)
            let deadline = ContinuousClock.now + .seconds(2)
            while controller.status?.preparation?.retryAt == nil, controller.isBusy, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
            XCTAssertNotNil(controller.status?.preparation?.retryAt)
            let started = ContinuousClock.now
            try await controller.stop(cancel: cancel)
            XCTAssertLessThan(started.duration(to: .now), .milliseconds(500))
            XCTAssertEqual(controller.status?.phase, cancel ? "cancelled" : "paused")
            let counts = await transport.counts(); XCTAssertEqual(counts.requests[url.absoluteString], 1)
            XCTAssertFalse(controller.isBusy)
        }
    }

    @MainActor
    func testStorageFailuresRemainBlockingAndDoNotStartNetworkRecovery() async throws {
        let store = try store(); defer { try? FileManager.default.removeItem(at: store.directory) }
        let source = try archive(store), transport = RecoveryTransport(candles: [])
        var plan = ResearchFixture.plan(try ResearchFixture.spec()); plan.sources = [source]
        try store.put(plan.id, kind: "plan", plan)
        try store.database.execute("CREATE TRIGGER reject_data BEFORE INSERT ON research_data BEGIN SELECT RAISE(ABORT, 'Research storage unavailable'); END")
        let controller = try ResearchController(directory: store.directory, transport: transport)
        _ = try controller.prepare(planID: plan.id)
        let deadline = ContinuousClock.now + .seconds(2)
        while controller.isBusy, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        if controller.isBusy { try await controller.stop(); XCTFail("Blocking failure did not stop") }
        XCTAssertEqual(controller.status?.phase, "failed")
        XCTAssertTrue(controller.status?.error.contains("Research storage unavailable") == true)
        let counts = await transport.counts(); XCTAssertTrue(counts.requests.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.rawURL(source).path))
        XCTAssertEqual(try store.count("SELECT COUNT(*) FROM research_coverage WHERE source=?", [source.id]), 0)
    }
}
