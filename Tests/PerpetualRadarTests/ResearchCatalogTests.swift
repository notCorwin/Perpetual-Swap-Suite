import XCTest
@testable import PerpetualRadar

private actor ResearchCatalogTransport: ResearchTransport {
    private var requests: [URL] = []
    private var rejectNext: Bool
    private let instruments: [ResearchInstrument]
    private let delay: Duration
    private var active = 0, maximumActive = 0
    init(rejectNext: Bool = false, instruments: [ResearchInstrument] = [], delay: Duration = .zero) { self.rejectNext = rejectNext; self.instruments = instruments; self.delay = delay }

    func get(_ url: URL) async throws -> Data {
        requests.append(url)
        if url.path.hasSuffix("/instruments") {
            let rows = instruments.map { ["instId": $0.id, "listTime": String($0.listedAt!), "instCategory": "1", "settleCcy": "USDT"] }
            return try JSONSerialization.data(withJSONObject: ["code": "0", "data": rows])
        }
        guard url.path.hasSuffix("market-data-history") else { throw FilterError("Unexpected catalog fixture request.") }
        active += 1; maximumActive = max(maximumActive, active)
        defer { active -= 1 }
        if delay > .zero { try await Task.sleep(for: delay) }
        let parameters = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        let families = parameters["instFamilyList"]!.components(separatedBy: ",")
        if families.count > 5 || rejectNext {
            rejectNext = false
            return try JSONSerialization.data(withJSONObject: ["code": "50025", "data": [], "msg": "instFamilyList exceeds the maximum of 5"])
        }
        let daily = parameters["dateAggrType"] == "daily"
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: daily ? 0 : 8 * 3600)!
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone; formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = daily ? "yyyy-MM-dd" : "yyyy-MM"
        var date = Date(timeIntervalSince1970: Double(parameters["begin"]!)! / 1000)
        let end = Date(timeIntervalSince1970: Double(parameters["end"]!)! / 1000)
        var rows: [[String: Any]] = []
        while date <= end {
            let details = families.map { family -> [String: Any] in
                let filename = "\(family)-SWAP-\(formatter.string(from: date)).zip"
                return ["instFamily": family, "groupDetails": [["filename": filename, "url": "https://example.com/\(parameters["module"]!)/\(filename)", "sizeMB": "1"]]]
            }
            rows.append(["details": details])
            date = calendar.date(byAdding: daily ? .day : .month, value: 1, to: date)!
        }
        return try JSONSerialization.data(withJSONObject: ["code": "0", "data": rows])
    }

    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws { throw FilterError("Planning must not download archives.") }
    func urls() -> [URL] { requests }
    func concurrency() -> Int { maximumActive }
}

private actor ResearchCatalogRecorder {
    private var updates: [ResearchCatalogProgress] = []
    func append(_ update: ResearchCatalogProgress) { updates.append(update) }
    func values() -> [ResearchCatalogProgress] { updates }
}

final class ResearchCatalogTests: XCTestCase {
    private func seed(_ store: ResearchStore, count: Int) throws -> [ResearchInstrument] {
        let instruments = (0..<count).map { index in
            ResearchInstrument(id: "TEST\(index)-USDT-SWAP", listedAt: ResearchFixture.hour - 400 * hourMS, verified: true, source: "fixture", observedAt: researchNow())
        }
        for instrument in instruments { try store.put("instrument:\(instrument.id)", kind: "instrument", instrument) }
        return instruments
    }

    func testArchivePlanningRespectsFamilyLimitAndKeepsEveryInstrumentAcrossModulesAndPeriods() async throws {
        for count in [1, 5, 6, 11] {
            let store = try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ResearchCatalog-\(UUID())"))
            defer { try? FileManager.default.removeItem(at: store.directory) }
            let instruments = try seed(store, count: count), transport = ResearchCatalogTransport()
            let provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
            var spec = try ResearchFixture.spec("Close > 0 AND buy > 0 AND spread >= 0")
            spec.costs = .init(entryFeeBps: 0, exitFeeBps: 0, slippageBps: 0)
            let plan = try await provider.plan(spec) { _ in }
            let expectedIDs = Set(instruments.map(\.id))
            XCTAssertEqual(Set(plan.instruments.map(\.id)), expectedIDs)
            for (module, kind) in [(1, "taker"), (2, "candle"), (3, "funding")] {
                XCTAssertEqual(Set(plan.sources.filter { $0.archive && $0.module == module && $0.kind == kind }.map(\.instrument)), expectedIDs)
            }
            let urls = await transport.urls()
            var periods: [String: [String]] = [:]
            for url in urls {
                let parameters = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
                let families = parameters["instFamilyList"]!.components(separatedBy: ",")
                XCTAssertFalse(families.isEmpty); XCTAssertLessThanOrEqual(families.count, 5)
                let period = "\(parameters["module"]!):\(parameters["begin"]!):\(parameters["end"]!)"
                periods[period, default: []] += families
            }
            XCTAssertFalse(periods.keys.contains { $0.hasPrefix("4:") }, "Research must never query order book archives, even when a saved rule uses spread.")
            XCTAssertFalse(plan.sources.contains { $0.kind == "spread" })
            let expectedFamilies = Set(instruments.map { $0.id.replacingOccurrences(of: "-SWAP", with: "") })
            for families in periods.values {
                XCTAssertEqual(Set(families), expectedFamilies)
                XCTAssertEqual(families.count, count, "Every family must be requested exactly once per module/date window.")
            }
            let cachedPlan = try await provider.plan(spec) { _ in }
            let repeatedURLs = await transport.urls()
            XCTAssertEqual(repeatedURLs, urls, "Successful catalogs must be reused without network requests.")
            XCTAssertEqual(Set(cachedPlan.sources.map(\.id)), Set(plan.sources.map(\.id)))
        }
    }

    func testRejectedCatalogCanBeRetriedWithoutRefreshingTheCache() async throws {
        let store = try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ResearchCatalog-\(UUID())"))
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let instruments = try seed(store, count: 5), transport = ResearchCatalogTransport(rejectNext: true)
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        let spec = try ResearchFixture.spec("Close > 0")
        do {
            _ = try await provider.plan(spec) { _ in }
            XCTFail("The rejected public catalog must stop this preparation attempt.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("50025"))
        }
        let plan = try await provider.plan(spec) { _ in }
        XCTAssertEqual(Set(plan.sources.filter(\.archive).map(\.instrument)), Set(instruments.map(\.id)))
        let urls = await transport.urls()
        XCTAssertEqual(urls.count, 2, "Retry must retrieve the catalog again instead of replaying a cached error.")
        XCTAssertEqual(urls.first, urls.last)
    }

    func testPlanningQueriesOnlyMissingDateWindowsAndReportsRealCatalogProgress() async throws {
        let store = try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ResearchCatalog-\(UUID())"))
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let instruments = try seed(store, count: 1), transport = ResearchCatalogTransport(), recorder = ResearchCatalogRecorder()
        let spec = try ResearchFixture.spec("Close > 0 AND buy > 0")
        let begin = ResearchFixture.hour - 276 * hourMS, end = spec.through + 48 * hourMS
        for (kind, last) in [("candle", end), ("taker", end - 2 * hourMS)] {
            try store.cover(.init(id: kind, instrument: instruments[0].id, kind: kind, from: begin, through: last, url: "fixture", filename: "Local coverage", archive: false))
        }
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        let plan = try await provider.plan(spec, catalogProgress: { await recorder.append($0) }) { _ in }
        let urls = await transport.urls(), updates = await recorder.values()
        XCTAssertEqual(urls.count, 1, "Only the date window containing the remaining gap needs a directory request.")
        let parameters = Dictionary(uniqueKeysWithValues: URLComponents(url: urls[0], resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        XCTAssertEqual(parameters["module"], "1")
        XCTAssertGreaterThan(Int64(parameters["end"]!)!, end - 2 * hourMS)
        XCTAssertEqual(updates.first?.completed, 0); XCTAssertEqual(updates.first?.total, 1)
        XCTAssertEqual(updates.last?.completed, 1); XCTAssertEqual(updates.last?.waitingForResponse, false)
        XCTAssertEqual(updates.last?.remainingSeconds, 0)
        XCTAssertTrue(plan.sources.allSatisfy { $0.kind == "taker" })
    }

    func testSpreadIsExcludedAcrossAllDatesAndExplicitRefresh() async throws {
        let store = try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ResearchCatalog-\(UUID())"))
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let first: Int64 = 1_675_209_600_000 // 2023-02-01 UTC
        let instrument = ResearchInstrument(id: "BTC-USDT-SWAP", listedAt: first - 800 * hourMS, verified: true, source: "fixture", observedAt: researchNow())
        try store.put("instrument:\(instrument.id)", kind: "instrument", instrument)
        let transport = ResearchCatalogTransport(instruments: [instrument]), provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        var spec = try ResearchFixture.spec("spread >= 0", through: first + 24 * hourMS); spec.from = first
        let plan = try await provider.plan(spec) { _ in }
        let originalURLs = await transport.urls()
        XCTAssertFalse(originalURLs.contains { $0.query?.contains("module=4") == true })
        XCTAssertEqual(plan.from, first); XCTAssertEqual(plan.through, spec.through)
        XCTAssertTrue(plan.warnings.contains { $0.contains("excludes bid/ask spread") })
        XCTAssertFalse(plan.coverage.contains { $0.kind == "spread" })
        let refreshed = try await provider.plan(spec, refresh: true) { _ in }
        let refreshedURLs = await transport.urls()
        XCTAssertFalse(refreshedURLs.contains { $0.query?.contains("module=4") == true })
        XCTAssertFalse(refreshed.sources.contains { $0.kind == "spread" })
        XCTAssertEqual(refreshed.from, first); XCTAssertEqual(refreshed.through, spec.through)
    }

    func testCatalogConcurrencyIsBoundedAndKeepsAllFiles() async throws {
        let store = try ResearchStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ResearchCatalog-\(UUID())"))
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let instruments = try seed(store, count: 11), transport = ResearchCatalogTransport(delay: .milliseconds(20))
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: store.directory.appendingPathComponent("absent"))
        let plan = try await provider.plan(ResearchFixture.spec("Close > 0")) { _ in }
        let maximum = await transport.concurrency()
        XCTAssertEqual(maximum, 2)
        XCTAssertEqual(Set(plan.sources.filter(\.archive).map(\.instrument)), Set(instruments.map(\.id)))
    }
}
