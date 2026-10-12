import XCTest
@testable import PerpetualRadar

private struct ResearchHTTPReply: Sendable {
    var status = 200
    var headers: [String: String] = [:]
    var data = Data(#"{"code":"0","data":[]}"#.utf8)
    var error: URLError.Code?
}

private final class ResearchHTTPFixture: @unchecked Sendable {
    let host: String
    private let lock = NSLock()
    private var recorded: [(URLRequest, ContinuousClock.Instant)] = []
    private let reply: @Sendable (URLRequest, Int) -> ResearchHTTPReply
    init(host: String = UUID().uuidString.lowercased() + ".research.test", reply: @escaping @Sendable (URLRequest, Int) -> ResearchHTTPReply) {
        self.host = host; self.reply = reply
    }
    func respond(_ request: URLRequest) -> ResearchHTTPReply {
        let ordinal = lock.withLock { recorded.append((request, .now)); return recorded.count }
        return reply(request, ordinal)
    }
    var requests: [(URLRequest, ContinuousClock.Instant)] { lock.withLock { recorded } }
    var url: URL { URL(string: "https://\(host)/api/v5/public/market-data-history?module=2")! }
}

private final class ResearchHTTPProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var fixtures: [String: ResearchHTTPFixture] = [:]
    static func register(_ fixture: ResearchHTTPFixture) { lock.withLock { fixtures[fixture.host] = fixture } }
    static func remove(_ fixture: ResearchHTTPFixture) { _ = lock.withLock { fixtures.removeValue(forKey: fixture.host) } }
    override class func canInit(with request: URLRequest) -> Bool { lock.withLock { fixtures[request.url?.host ?? ""] != nil } }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let fixture = Self.lock.withLock({ Self.fixtures[request.url!.host!] }) else { return }
        let reply = fixture.respond(request)
        if let error = reply.error { client?.urlProtocol(self, didFailWithError: URLError(error)); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private actor ResearchRetryRecorder {
    var delays: [Double] = []
    var catalogs: [ResearchCatalogProgress] = []
    func retry(_ delay: Double) { delays.append(delay) }
    func catalog(_ update: ResearchCatalogProgress) { catalogs.append(update) }
    func hasRetry() -> Bool { !delays.isEmpty }
}

final class ResearchRequestTests: XCTestCase {
    private func session(_ fixture: ResearchHTTPFixture) -> URLSession {
        ResearchHTTPProtocol.register(fixture)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResearchHTTPProtocol.self]
        return URLSession(configuration: configuration)
    }
    private func limiter(interval: Duration = .milliseconds(5), backoff: Double = 0.01, cap: Double = 0.02) -> ResearchRequestLimiter {
        ResearchRequestLimiter(interval: interval, initialBackoff: backoff, maximumBackoff: cap, jitter: 0)
    }

    func testRepeatedHTTPAndEnvelopeRateLimitsRecoverWithoutManualResume() async throws {
        let fixture = ResearchHTTPFixture { _, ordinal in
            guard ordinal <= 8 else { return .init() }
            return ordinal.isMultiple(of: 2) ? .init(data: Data(#"{"code":"50011","msg":"Rate limit reached","data":[]}"#.utf8)) : .init(status: 429, headers: ["Retry-After": "invalid"], data: Data("throttled".utf8))
        }
        let session = session(fixture), recorder = ResearchRetryRecorder()
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture) }
        let transport = OKXResearchTransport(session: session, limiter: limiter())
        let data = try await transport.get(fixture.url, onRetry: { await recorder.retry($0) })
        XCTAssertEqual(data, ResearchHTTPReply().data)
        let requests = fixture.requests, delays = await recorder.delays
        XCTAssertEqual(requests.count, 9, "Even prolonged rate limiting must recover automatically, without an attempt limit.")
        XCTAssertTrue(requests.allSatisfy { $0.0.url == fixture.url }, "Retry the same page, preserving its query and cursor.")
        XCTAssertEqual(delays.count, 8)
        for pair in zip(requests, requests.dropFirst()) {
            XCTAssertGreaterThanOrEqual(researchSeconds(pair.0.1.duration(to: pair.1.1)), 0.008, "Backoff must delay the next network request.")
        }
        XCTAssertGreaterThan(delays.last!, delays.first!)
        XCTAssertLessThanOrEqual(delays.max()!, 0.021, "Backoff should stop growing while automatic retries continue.")
    }

    func testConcurrentTransportsShareAdmissionAndRateLimitCooldown() async throws {
        let fixture = ResearchHTTPFixture { _, ordinal in ordinal == 1 ? .init(status: 429) : .init() }
        let session = session(fixture), recorder = ResearchRetryRecorder(), requestLimiter = limiter(interval: .milliseconds(20), backoff: 0.12, cap: 0.12)
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture) }
        let first = OKXResearchTransport(session: session, limiter: requestLimiter), second = OKXResearchTransport(session: session, limiter: requestLimiter)
        let initial = Task { try await first.get(fixture.url, onRetry: { await recorder.retry($0) }) }
        let deadline = ContinuousClock.now + .seconds(2)
        while !(await recorder.hasRetry()), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        let reported = await recorder.hasRetry(); XCTAssertTrue(reported)
        try await withThrowingTaskGroup(of: Data.self) { group in
            for index in 0..<8 {
                let transport = index.isMultiple(of: 2) ? first : second
                group.addTask { try await transport.get(fixture.url) }
            }
            for try await data in group { XCTAssertEqual(data, ResearchHTTPReply().data) }
        }
        let initialData = try await initial.value
        XCTAssertEqual(initialData, ResearchHTTPReply().data)
        let requests = fixture.requests
        XCTAssertEqual(requests.count, 10)
        XCTAssertGreaterThanOrEqual(researchSeconds(requests[0].1.duration(to: requests[1].1)), 0.11, "Every transport must honor the cooldown, including new requests.")
        for pair in zip(requests.dropFirst(), requests.dropFirst(2)) {
            XCTAssertGreaterThanOrEqual(researchSeconds(pair.0.1.duration(to: pair.1.1)), 0.015, "Queued requests must stay paced when cooldown ends.")
        }
    }

    func testRetryAfterSecondsAndHTTPDateDelayActualRequests() async throws {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        for header in ["1", formatter.string(from: Date(timeIntervalSince1970: ceil(Date().timeIntervalSince1970) + 3))] {
            let fixture = ResearchHTTPFixture { _, ordinal in ordinal == 1 ? .init(status: 429, headers: ["Retry-After": header]) : .init() }
            let session = session(fixture), recorder = ResearchRetryRecorder()
            defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture) }
            let transport = OKXResearchTransport(session: session, limiter: limiter())
            _ = try await transport.get(fixture.url, onRetry: { await recorder.retry($0) })
            let requests = fixture.requests, delays = await recorder.delays
            XCTAssertEqual(requests.count, 2)
            XCTAssertGreaterThanOrEqual(delays[0], 0.9)
            XCTAssertGreaterThanOrEqual(researchSeconds(requests[0].1.duration(to: requests[1].1)), delays[0] - 0.02)
        }
    }

    func testCancellationInterruptsRateLimitWaitImmediately() async throws {
        let fixture = ResearchHTTPFixture { _, _ in .init(status: 429, headers: ["Retry-After": "30"]) }
        let session = session(fixture), recorder = ResearchRetryRecorder()
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture) }
        let transport = OKXResearchTransport(session: session, limiter: limiter())
        let work = Task { try await transport.get(fixture.url, onRetry: { await recorder.retry($0) }) }
        let deadline = ContinuousClock.now + .seconds(2)
        while !(await recorder.hasRetry()), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        let reported = await recorder.hasRetry(); XCTAssertTrue(reported)
        let started = ContinuousClock.now
        work.cancel()
        do { _ = try await work.value; XCTFail("Cancellation must stop automatic retry.") }
        catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
        XCTAssertLessThan(started.duration(to: .now), .milliseconds(500))
        XCTAssertEqual(fixture.requests.count, 1)
    }

    func testPermanentHTTPFailureIsNotRetried() async throws {
        for status in [400, 401, 403, 404, 501, 505] {
            let fixture = ResearchHTTPFixture { _, _ in .init(status: status) }
            let session = session(fixture)
            defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture) }
            let transport = OKXResearchTransport(session: session, limiter: limiter())
            do { _ = try await transport.get(fixture.url); XCTFail("A permanent HTTP error must stop the request.") }
            catch { XCTAssertTrue(error.localizedDescription.contains("HTTP \(status)")) }
            XCTAssertEqual(fixture.requests.count, 1)
        }
    }

    func testNetworkFailuresAndServerErrorsRetryTheSameRequestAutomatically() async throws {
        let fixture = ResearchHTTPFixture { _, ordinal in
            switch ordinal {
            case 1: return .init(error: .timedOut)
            case 2: return .init(error: .networkConnectionLost)
            case 3: return .init(error: .notConnectedToInternet)
            case 4: return .init(status: 503)
            case 5: return .init(status: 408)
            default: return .init()
            }
        }
        let session = session(fixture), recorder = ResearchRetryRecorder()
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture) }
        let transport = OKXResearchTransport(session: session, limiter: limiter())
        let data = try await transport.get(fixture.url, onRetry: { await recorder.retry($0) })
        XCTAssertEqual(data, ResearchHTTPReply().data)
        XCTAssertEqual(fixture.requests.count, 6)
        XCTAssertTrue(fixture.requests.allSatisfy { $0.0.url == fixture.url })
        let delays = await recorder.delays
        XCTAssertEqual(delays.count, 5)
        XCTAssertTrue(delays.allSatisfy { $0 > 0 })
    }

    func testTruncatedArchiveResumesItsPartialBytesAutomatically() async throws {
        let payload = Data(repeating: 42, count: 65_540), offset = 65_536
        let fixture = ResearchHTTPFixture { _, ordinal in
            ordinal == 1 ? .init(headers: ["ETag": "fixture", "Content-Length": String(payload.count)], data: payload.prefix(offset)) :
                .init(status: 206, headers: ["ETag": "fixture", "Content-Length": "4", "Content-Range": "bytes \(offset)-65539/65540"], data: payload.dropFirst(offset))
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchTruncated-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("archive.zip"), session = session(fixture), recorder = ResearchRetryRecorder()
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture); try? FileManager.default.removeItem(at: directory) }
        let transport = OKXResearchTransport(session: session, limiter: limiter())
        try await transport.download(fixture.url, to: destination) { update in
            if let retryAt = update.retryAt { await recorder.retry(Double(retryAt)) }
        }
        XCTAssertEqual(try Data(contentsOf: destination), payload)
        XCTAssertEqual(fixture.requests.count, 2)
        XCTAssertEqual(fixture.requests.last?.0.value(forHTTPHeaderField: "Range"), "bytes=\(offset)-")
        XCTAssertEqual(fixture.requests.last?.0.value(forHTTPHeaderField: "If-Range"), "fixture")
        let reported = await recorder.hasRetry(); XCTAssertTrue(reported)
    }

    func testArchiveRateLimitPreservesResumeHeadersAndPartialBytes() async throws {
        let payload = Data(repeating: 42, count: 64)
        let fixture = ResearchHTTPFixture { _, ordinal in
            ordinal == 1 ? .init(status: 429, data: Data("throttled".utf8)) : .init(status: 206, headers: ["ETag": "fixture", "Content-Length": "60", "Content-Range": "bytes 4-63/64"], data: payload.dropFirst(4))
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchRetry-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("archive.zip"), part = destination.appendingPathExtension("part")
        try payload.prefix(4).write(to: part)
        try "fixture".write(to: part.appendingPathExtension("validator"), atomically: true, encoding: .utf8)
        let session = session(fixture), recorder = ResearchRetryRecorder()
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture); try? FileManager.default.removeItem(at: directory) }
        let transport = OKXResearchTransport(session: session, limiter: limiter())
        try await transport.download(fixture.url, to: destination) { update in
            if let retryAt = update.retryAt { await recorder.retry(Double(retryAt)) }
        }
        XCTAssertEqual(try Data(contentsOf: destination), payload)
        XCTAssertEqual(fixture.requests.count, 2)
        for (request, _) in fixture.requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=4-")
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Range"), "fixture")
        }
        let reported = await recorder.hasRetry(); XCTAssertTrue(reported)
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
    }

    func testCatalogPlanningAutomaticallyRecoversAndReusesOnlySuccessfulPages() async throws {
        let fixture = ResearchHTTPFixture(host: "www.okx.com") { _, ordinal in ordinal <= 2 ? .init(status: 429, data: Data("throttled".utf8)) : .init() }
        let session = session(fixture), recorder = ResearchRetryRecorder()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchCatalogRetry-\(UUID())")
        defer { session.invalidateAndCancel(); ResearchHTTPProtocol.remove(fixture); try? FileManager.default.removeItem(at: directory) }
        let store = try ResearchStore(directory: directory), spec = try ResearchFixture.spec("Close > 0")
        for index in 0..<11 {
            let instrument = ResearchInstrument(id: "TEST\(index)-USDT-SWAP", listedAt: ResearchFixture.hour - 400 * hourMS, verified: true, source: "fixture", observedAt: researchNow())
            try store.put("instrument:\(instrument.id)", kind: "instrument", instrument)
        }
        let transport = OKXResearchTransport(session: session, limiter: limiter())
        let provider = ResearchDataProvider(store: store, transport: transport, radarURL: directory.appendingPathComponent("absent"))
        let plan = try await provider.plan(spec, catalogProgress: { await recorder.catalog($0) }) { _ in }
        let requests = fixture.requests, updates = await recorder.catalogs
        XCTAssertEqual(plan.instruments.count, 11)
        XCTAssertTrue(updates.contains { $0.retryAt != nil && $0.waitingForResponse })
        XCTAssertEqual(updates.last?.completed, updates.last?.total)
        XCTAssertNil(updates.last?.retryAt)
        XCTAssertEqual(requests.count, (updates.last?.total ?? 0) + 2)
        for pair in zip(updates, updates.dropFirst()) { XCTAssertLessThanOrEqual(pair.0.completed, pair.1.completed) }
        _ = try await provider.plan(spec) { _ in }
        XCTAssertEqual(fixture.requests.count, requests.count, "Successful pages remain cached; throttled responses must never enter the cache.")
    }
}
