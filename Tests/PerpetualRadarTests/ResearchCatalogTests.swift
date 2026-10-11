import XCTest
@testable import PerpetualRadar

private actor ResearchCatalogTransport: ResearchTransport {
    private var requests: [URL] = []
    private var rejectNext: Bool
    init(rejectNext: Bool = false) { self.rejectNext = rejectNext }

    func get(_ url: URL) async throws -> Data {
        requests.append(url)
        guard url.path.hasSuffix("market-data-history") else { throw FilterError("Unexpected catalog fixture request.") }
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

    func download(_ url: URL, to destination: URL) async throws { throw FilterError("Planning must not download archives.") }
    func urls() -> [URL] { requests }
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
            for (module, kind) in [(1, "taker"), (2, "candle"), (3, "funding"), (4, "spread")] {
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
            XCTAssertGreaterThan(periods.keys.filter { $0.hasPrefix("4:") }.count, 1, "Daily archives must span multiple date windows.")
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
}
