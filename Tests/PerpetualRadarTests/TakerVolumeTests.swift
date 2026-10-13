import Foundation
import XCTest
@testable import PerpetualRadar

private final class TakerChartProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, hour = Int64(Date().timeIntervalSince1970 * 1000) / hourMS * hourMS
        let data: [[String]]
        let code: String
        if url.path.hasSuffix("taker-volume-contract") {
            let parameters = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let baseCurrency = parameters.contains { $0.name == "unit" && $0.value == "0" }
            code = baseCurrency && request.cachePolicy == .reloadIgnoringLocalCacheData ? "0" : "1"
            data = [[String(hour), "200", "380"], [String(hour - hourMS), "250", "500"]]
        } else if url.path.hasSuffix("/candles") {
            code = "0"
            data = [[String(hour), "100", "110", "90", "105", "1", "1", "100", "0"]]
        } else { code = "50011"; data = [] } // OI fails independently.
        let body = try! JSONSerialization.data(withJSONObject: ["code": code, "data": data])
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private actor SlowContractTransport: FilterHistoryTransport {
    let hour: Int64
    init(hour: Int64) { self.hour = hour }
    func fetch(path: String, parameters: [String: String]) async throws -> [[String]] {
        guard path == "/rubik/stat/taker-volume-contract", parameters["unit"] == "0", parameters["period"] == "1H", parameters["limit"] == "2" else { throw FilterError("Incorrect Taker request") }
        if parameters["instId"] == "AAA-USDT-SWAP" { try await Task.sleep(for: .seconds(60)) }
        if parameters["instId"] == "BAD-USDT-SWAP" { throw FilterError("Contract temporarily unavailable") }
        return [[String(hour), "200", "380"]]
    }
}

@MainActor
final class TakerVolumeTests: XCTestCase {
    private let id = "BTC-USDT-SWAP"
    private var hour: Int64 { Int64(Date().timeIntervalSince1970 * 1000) / hourMS * hourMS }

    private func radar(url: URL, session: URLSession = .shared) throws -> Radar {
        let radar = try Radar(storeURL: url, session: session)
        try radar.initializeMarkets(instruments: [["instId": id, "state": "live", "instCategory": "1", "settleCcy": "USDT"]],
            tickers: [["instId": id, "volCcy24h": "1000", "last": "100", "ts": String(hour)]])
        radar.updateCandle(id, [String(hour), "100", "110", "90", "105", "1", "1", "100", "0"])
        return radar
    }
    private func row(_ radar: Radar) throws -> [String: Any] {
        try XCTUnwrap((radar.snapshot(rocPeriod: 9, marocPeriod: 9)["rows"] as? [[String: Any]])?.first)
    }
    private func latest(_ snapshot: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap((snapshot["bars"] as? [[String: Any]])?.last)
    }
    private func volumes(sell: String, buy: String, at timestamp: Int64? = nil) -> [TakerVolume] {
        [TakerVolume([String(timestamp ?? hour), sell, buy])!]
    }

    func testOfficialSellBuyOrderAndImbalanceArePreserved() throws {
        let value = try XCTUnwrap(TakerVolume([String(hour), "200", "380"]))
        XCTAssertEqual(value.sell, 200); XCTAssertEqual(value.buy, 380)
        XCTAssertEqual(try XCTUnwrap(value.imbalance), 180.0 / 580 * 100, accuracy: 0.000001)
        XCTAssertNil(TakerVolume([String(hour + 1), "200", "380"]))
        XCTAssertNil(TakerVolume([String(hour), "NaN", "380"]))
        XCTAssertNil(TakerVolume([String(hour), "200", "-1"]))
        XCTAssertNil(TakerVolume([String(hour), "0", "0"])?.imbalance)
    }

    func testNewerObservationsUpdateTableChartAndRulesAndLateResponsesCannotRegressThem() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Taker-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let radar = try radar(url: directory.appendingPathComponent("radar.sqlite3")), request = ContinuousClock.now
        try radar.updateTakerVolumes(id, volumes(sell: "300", buy: "100"), requestedAt: request)
        let oldRevision = try XCTUnwrap(radar.chartSnapshot(id)["revision"] as? Int)
        try radar.updateTakerVolumes(id, volumes(sell: "200", buy: "380"), requestedAt: request + .milliseconds(1))
        let current = try row(radar), chart = radar.chartSnapshot(id, sinceRevision: oldRevision)
        XCTAssertNil(chart["unchanged"])
        XCTAssertEqual(current["buy"] as? Double, 380)
        XCTAssertEqual(try latest(chart)["buy"] as? Double, current["buy"] as? Double)
        XCTAssertEqual(try latest(chart)["sell"] as? Double, current["sell"] as? Double)
        let input = MarketSnapshotInput(id: id, hour: hour, now: hour + 1, candles: [:], buy: 380, sell: 200, takerRatio: current["takerRatio"] as? Double)
        let filter = try FilterCompiler.compile(source: "buy > sell AND takerRatio > 0")
        XCTAssertEqual(FilterEvaluator(market: input.filterData(row: current), filter: filter).evaluate().result, .yes)
        try radar.updateTakerVolumes(id, volumes(sell: "900", buy: "1"), requestedAt: request)
        XCTAssertEqual(try row(radar)["buy"] as? Double, 380)
        XCTAssertEqual(try latest(radar.chartSnapshot(id))["sell"] as? Double, 200)
    }

    func testChartTakerRefreshPublishesDespiteOIFailureAndDoesNotPersistLiveValues() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Taker-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TakerChartProtocol.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let url = directory.appendingPathComponent("radar.sqlite3"), radar = try radar(url: url, session: session)
        try radar.updateTakerVolumes(id, volumes(sell: "300", buy: "100"), requestedAt: .now)
        let oldRevision = try XCTUnwrap(radar.chartSnapshot(id)["revision"] as? Int)
        let chart = await radar.loadChart(id)
        XCTAssertTrue((chart["error"] as? String)?.contains("OI") == true)
        XCTAssertGreaterThan(try XCTUnwrap(chart["revision"] as? Int), oldRevision)
        XCTAssertEqual(try latest(chart)["buy"] as? Double, 380)
        XCTAssertEqual(try row(radar)["buy"] as? Double, 380)
        let saved = try Store(url: url).chartStats(id, since: hour - hourMS, through: hour)
        XCTAssertEqual(saved[hour - hourMS]?.buy, 500)
        XCTAssertNil(saved[hour], "Dynamic current-hour Taker data must remain in memory.")
    }

    func testClosedHourCorrectionsPersistAndMissingCurrentHourDoesNotReuseOlderVolume() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Taker-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("radar.sqlite3"), radar = try radar(url: url), request = ContinuousClock.now
        try radar.updateTakerVolumes(id, volumes(sell: "1", buy: "2") + volumes(sell: "100", buy: "200", at: hour - hourMS), requestedAt: request)
        try radar.updateTakerVolumes(id, volumes(sell: "150", buy: "250", at: hour - hourMS), requestedAt: request + .milliseconds(1))
        XCTAssertEqual(try Store(url: url).chartStats(id, since: hour - hourMS)[hour - hourMS]?.buy, 250)
        XCTAssertTrue(try row(radar)["buy"] is NSNull)
        XCTAssertTrue(try latest(radar.chartSnapshot(id))["sell"] is NSNull)
        XCTAssertTrue((radar.chartSnapshot(id)["error"] as? String)?.contains("taker volume") == true)
    }

    func testHealthyContractsAndFailuresArriveBeforeASlowContractAndPollingCanBeCancelled() async {
        let healthy = expectation(description: "Healthy contract publishes without waiting for the slow contract")
        let failure = expectation(description: "Independent contract failure is reported")
        let poller = TakerVolumePoller(transport: SlowContractTransport(hour: hour), concurrency: 2)
        let task = Task {
            await poller.refresh(["AAA-USDT-SWAP", "BAD-USDT-SWAP", id]) { response in
                if response.id == "BAD-USDT-SWAP", response.error != nil { failure.fulfill() }
                if response.id == "BTC-USDT-SWAP", response.volumes.first?.buy == 380 { healthy.fulfill() }
            }
        }
        await fulfillment(of: [healthy, failure], timeout: 2)
        task.cancel()
        await task.value
    }
}
