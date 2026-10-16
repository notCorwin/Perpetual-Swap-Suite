import XCTest
import ZIPFoundation
@testable import PerpetualRadar

private final class ResearchDownloadProtocol: URLProtocol, @unchecked Sendable {
    private var stream: Task<Void, Never>?
    static let payload = Data(repeating: 42, count: 128 * 1024)
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "research-download.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let offset = Int(request.value(forHTTPHeaderField: "Range")?.dropFirst(6).dropLast() ?? "") ?? 0
        var headers = ["ETag": "fixture", "Content-Length": String(Self.payload.count - offset)]
        if offset > 0 { headers["Content-Range"] = "bytes \(offset)-\(Self.payload.count - 1)/\(Self.payload.count)" }
        if request.url!.path == "/unknown" { headers.removeValue(forKey: "Content-Length") }
        let response = HTTPURLResponse(url: request.url!, statusCode: offset > 0 ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        stream = Task {
            for start in stride(from: offset, to: Self.payload.count, by: 4096) {
                do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
                client?.urlProtocol(self, didLoad: Self.payload.subdata(in: start..<min(Self.payload.count, start + 4096)))
            }
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { stream?.cancel() }
}

private actor ResearchTransferRecorder {
    var updates: [ResearchDownloadProgress] = []
    func append(_ update: ResearchDownloadProgress) { updates.append(update) }
    func values() -> [ResearchDownloadProgress] { updates }
}

actor ResearchProgressFixtureTransport: ResearchTransport {
    private let archive: Data
    private let repeatProgress: Bool
    private var blocked = true, fail = false
    private var historyReleased = false
    init(archive: Data, repeatProgress: Bool = true) { self.archive = archive; self.repeatProgress = repeatProgress }
    func release(fail: Bool = false) { blocked = false; self.fail = fail }
    func releaseHistory() { historyReleased = true }
    func get(_ url: URL) async throws -> Data {
        while blocked { try await Task.sleep(for: .milliseconds(10)) }
        // Hold the separate planned range after archive gap repair finishes,
        // so estimates are observable without racing a very fast preparation.
        if URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "instId" }) != true {
            while !historyReleased { try await Task.sleep(for: .milliseconds(5)) }
        }
        try await Task.sleep(for: .milliseconds(50))
        return Data(#"{"code":"0","data":[]}"#.utf8)
    }
    func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws {
        await progress(.init(receivedBytes: Int64(archive.count / 2), totalBytes: Int64(archive.count), bytesPerSecond: 1000))
        while blocked {
            try await Task.sleep(for: .milliseconds(10))
            if repeatProgress { await progress(.init(receivedBytes: Int64(archive.count / 2), totalBytes: Int64(archive.count), bytesPerSecond: 1000)) }
        }
        if fail { throw FilterError("Fixture connection lost") }
        try await Task.sleep(for: .milliseconds(20))
        try archive.write(to: destination)
        await progress(.init(receivedBytes: Int64(archive.count), totalBytes: Int64(archive.count), bytesPerSecond: 1000))
    }
}

final class ResearchProgressTests: XCTestCase {
    func testCancellingAnActiveNativeDownloadSavesPartialBytesAndResumesWithoutRestarting() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchTransferCancel-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchDownloadProtocol.self]
        let session = URLSession(configuration: configuration), transport = OKXResearchTransport(session: session)
        defer { session.invalidateAndCancel() }
        let destination = directory.appendingPathComponent("resumed"), recorder = ResearchTransferRecorder()
        let url = URL(string: "https://research-download.test/cancel")!
        let download = Task { try await transport.download(url, to: destination) { await recorder.append($0) } }
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await recorder.values()).contains(where: { $0.receivedBytes > 0 }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        download.cancel()
        do { try await download.value; XCTFail("Pause must interrupt a transfer.") } catch {}
        let part = destination.appendingPathExtension("part")
        let saved = try Data(contentsOf: part)
        XCTAssertGreaterThan(saved.count, 0); XCTAssertLessThan(saved.count, ResearchDownloadProtocol.payload.count)
        let resumed = ResearchTransferRecorder()
        try await transport.download(url, to: destination) { await resumed.append($0) }
        let updates = await resumed.values()
        XCTAssertEqual(updates.first?.receivedBytes, Int64(saved.count))
        XCTAssertEqual(try Data(contentsOf: destination), ResearchDownloadProtocol.payload)
    }

    func testNativeDownloadReportsStreamingBytesUnknownLengthsAndResumedOffsets() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchTransfer-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchDownloadProtocol.self]
        let session = URLSession(configuration: configuration), transport = OKXResearchTransport(session: session)
        defer { session.invalidateAndCancel() }
        for mode in ["fresh", "resume", "unknown"] {
            let destination = directory.appendingPathComponent(mode), recorder = ResearchTransferRecorder()
            let offset = mode == "resume" ? ResearchDownloadProtocol.payload.count / 2 : 0
            if offset > 0 {
                let part = destination.appendingPathExtension("part")
                try ResearchDownloadProtocol.payload.prefix(offset).write(to: part)
                try "fixture".write(to: part.appendingPathExtension("validator"), atomically: true, encoding: .utf8)
            }
            try await transport.download(URL(string: "https://research-download.test/\(mode)")!, to: destination) { await recorder.append($0) }
            let updates = await recorder.values(), first = try XCTUnwrap(updates.first), last = try XCTUnwrap(updates.last)
            XCTAssertEqual(first.receivedBytes, Int64(offset))
            XCTAssertEqual(first.totalBytes, mode == "unknown" ? nil : Int64(ResearchDownloadProtocol.payload.count))
            XCTAssertEqual(last.receivedBytes, Int64(ResearchDownloadProtocol.payload.count))
            XCTAssertTrue(updates.contains { $0.receivedBytes > offset && $0.receivedBytes < ResearchDownloadProtocol.payload.count && ($0.bytesPerSecond ?? 0) > 0 }, "Progress must arrive before the file completes.")
            XCTAssertEqual(try Data(contentsOf: destination), ResearchDownloadProtocol.payload)
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathExtension("part").path))
        }
    }

    @MainActor
    func testPreparationShowsLiveProgressRetainsFailureAndResumesToCompletion() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchProgress-\(UUID())"), store = try ResearchStore(directory: directory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let archiveURL = directory.appendingPathComponent("fixture.zip"), archive = try Archive(url: archiveURL, accessMode: .create)
        let csv = Data("timestamp,open,high,low,close,vol,volCcy,volCcyQuote\n\(ResearchFixture.hour),100,110,90,105,1,10,1000\n".utf8)
        try archive.addEntry(with: "BTC-USDT-SWAP.csv", type: .file, uncompressedSize: Int64(csv.count), compressionMethod: .deflate) { position, count in csv.subdata(in: Int(position)..<min(csv.count, Int(position) + count)) }
        let payload = try Data(contentsOf: archiveURL), transport = ResearchProgressFixtureTransport(archive: payload, repeatProgress: false)
        var plan = ResearchFixture.plan(try ResearchFixture.spec())
        plan.sources = [
            .init(id: "archive", instrument: ResearchFixture.instrument.id, kind: "candle", from: ResearchFixture.hour, through: ResearchFixture.hour, url: "https://example.com/archive.zip", filename: "archive.zip", archive: true, module: 2),
            .init(id: "rest", instrument: ResearchFixture.instrument.id, kind: "candle", from: ResearchFixture.hour, through: ResearchFixture.hour, url: ResearchDataProvider.url("/market/history-candles", [("after", String(ResearchFixture.hour + hourMS))]).absoluteString, filename: "History range", archive: false),
        ]
        try store.put(plan.id, kind: "plan", plan)
        let controller = try ResearchController(directory: directory, transport: transport, radarURL: directory.appendingPathComponent("absent"))
        _ = try controller.prepare(planID: plan.id)
        let deadline = ContinuousClock.now + .seconds(3)
        while controller.status?.preparation?.stage != "downloading", ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        let live = try XCTUnwrap(controller.status?.preparation)
        XCTAssertEqual(controller.status?.completed, 0); XCTAssertEqual(controller.status?.total, 2)
        XCTAssertEqual(live.receivedBytes, Int64(payload.count / 2)); XCTAssertEqual(live.totalBytes, Int64(payload.count))
        XCTAssertEqual(live.bytesPerSecond, 1000); XCTAssertNotNil(live.fileRemainingSeconds)
        XCTAssertEqual(live.workers, min(ResearchLocalScan.concurrency, plan.sources.count))
        XCTAssertEqual(live.downloadLanes, 1)
        let inventory = try await controller.handle(["action": "inventory"]), job = try XCTUnwrap(inventory["job"] as? [String: Any])
        XCTAssertEqual((job["preparation"] as? [String: Any])?["stage"] as? String, "downloading")
        let activeStudy = try XCTUnwrap((inventory["studies"] as? [[String: Any]])?.first)
        XCTAssertEqual(activeStudy["active"] as? Bool, true)
        XCTAssertNotNil(activeStudy["updatedAt"])
        try await controller.stop()
        XCTAssertEqual(controller.status?.phase, "paused")
        let studyID = try XCTUnwrap(controller.status?.resultID)
        await transport.release(fail: true)
        _ = try await controller.handle(["action": "resume", "studyID": studyID])
        while controller.isBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(controller.status?.phase, "failed")
        XCTAssertTrue(controller.status?.error.contains("archive.zip") == true)
        XCTAssertTrue(controller.status?.error.contains("Fixture connection lost") == true)
        let reopened = try ResearchController(directory: directory, transport: transport)
        let saved = try await reopened.handle(["action": "inventory"]), studies = try XCTUnwrap(saved["studies"] as? [[String: Any]])
        XCTAssertEqual(studies.first?["phase"] as? String, "failed")
        XCTAssertEqual(studies.first?["active"] as? Bool, false)
        XCTAssertTrue((studies.first?["error"] as? String)?.contains("Fixture connection lost") == true)
        await transport.release()
        _ = try await controller.handle(["action": "resume", "studyID": studyID])
        var sawEstimate = false
        let readyDeadline = ContinuousClock.now + .seconds(3)
        while controller.isBusy, ContinuousClock.now < readyDeadline {
            if controller.status?.preparation?.remainingSeconds != nil {
                sawEstimate = true; await transport.releaseHistory()
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        if controller.isBusy { try await controller.stop(); XCTFail("Preparation did not finish after releasing the remaining range.") }
        XCTAssertTrue(sawEstimate)
        XCTAssertEqual(controller.status?.phase, "ready", controller.status?.error ?? "")
        XCTAssertEqual(controller.status?.completed, 2)
        XCTAssertNotNil(try store.get(studyID, as: ResearchStudy.self)?.manifestID)
        XCTAssertNil(try store.get("checkpoint:\(studyID)", as: Checkpoint.self)?.error)
    }
}
