import AppKit
import Foundation
import ImageIO
import XCTest
@testable import PerpetualRadar

@MainActor
private final class MemoryGatewayCredentials: GatewayCredentials {
    var key: String?
    var failure = false
    func read() throws -> String? { if failure { throw GatewayError("Keychain unavailable.") }; return key }
    func write(_ value: String) throws { if failure { throw GatewayError("Keychain unavailable.") }; key = value }
    func remove() throws { key = nil }
}

private final class GatewayFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        let data = Data("data: 中文\n\ndata: [DONE]\n\n".utf8)
        for byte in data { client?.urlProtocol(self, didLoad: Data([byte])) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class HoldingGatewayFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var stops = 0
    static func reset() { lock.withLock { stops = 0 } }
    static var stopCount: Int { lock.withLock { stops } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("data: partial\n".utf8))
        // Keep the connection open until the native client cancels it.
    }
    override func stopLoading() { Self.lock.withLock { Self.stops += 1 } }
}

@MainActor
final class AIGatewayTests: XCTestCase {
    func testSettingsPersistModelPreserveBlankKeyAndNeverReturnCredentials() async throws {
        let name = "GatewayTests-\(UUID())", defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let credentials = MemoryGatewayCredentials(), settings = GatewaySettings(credentials: credentials, defaults: defaults)
        let initial = try await settings.snapshot()
        XCTAssertEqual(initial["model"] as? String, "openai/gpt-6.1-sol")
        XCTAssertEqual(initial["hasAPIKey"] as? Bool, false)
        let saved = try await settings.handle(["action": "save", "model": " openai/gpt-6.1-sol ", "apiKey": "fixture-secret"])
        XCTAssertEqual(Set(saved.keys), ["model", "hasAPIKey"])
        XCTAssertFalse(String(describing: saved).contains("fixture-secret"))
        _ = try await settings.handle(["action": "save", "model": "other/vision-model", "apiKey": "  "])
        XCTAssertEqual(credentials.key, "fixture-secret")
        let restored = GatewaySettings(credentials: credentials, defaults: defaults)
        let restoredSnapshot = try await restored.snapshot()
        XCTAssertEqual(restoredSnapshot["model"] as? String, "other/vision-model")
        _ = try await restored.handle(["action": "save", "model": "other/vision-model", "apiKey": "replacement"])
        XCTAssertEqual(credentials.key, "replacement")
        let removed = try await restored.handle(["action": "removeKey"])
        XCTAssertEqual(removed["hasAPIKey"] as? Bool, false)
        do { _ = try await settings.handle(["action": "save", "model": " ", "apiKey": "unused"]); XCTFail("Empty model must fail.") }
        catch { XCTAssertEqual(error.localizedDescription, "Enter a model ID.") }
    }

    func testNativeRequestUsesFixedEndpointAndAddsKeyOnlyToAuthorization() async throws {
        let credentials = MemoryGatewayCredentials(), settings = GatewaySettings(credentials: credentials)
        let body = "{\"model\":\"openai/gpt-6.1-sol\",\"messages\":[],\"stream\":true}"
        do { _ = try await settings.authorizedRequest(body: body); XCTFail("Missing key must fail.") }
        catch { XCTAssertEqual(error.localizedDescription, "Configure a Gateway API Key to analyze charts.") }
        credentials.key = "fixture-secret"
        let request = try await settings.authorizedRequest(body: body)
        XCTAssertEqual(request.url?.absoluteString, "https://ai-gateway.vercel.sh/v1/chat/completions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-secret")
        XCTAssertEqual(request.httpBody, Data(body.utf8))
        do { _ = try await settings.authorizedRequest(body: "{}"); XCTFail("Invalid body must fail.") }
        catch { XCTAssertEqual(error.localizedDescription, "Invalid Gateway request.") }
        credentials.failure = true
        do { _ = try await settings.snapshot(); XCTFail("Unavailable credentials must fail.") }
        catch { XCTAssertEqual(error.localizedDescription, "Keychain unavailable.") }
    }

    func testNativeStreamForwardsUTF8BytesAndHeadersInOrder() async throws {
        let credentials = MemoryGatewayCredentials(); credentials.key = "fixture-secret"
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [GatewayFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let gateway = GatewayClient(settings: GatewaySettings(credentials: credentials), session: session)
        var received = Data(), finished = false, status = 0
        try gateway.start(id: "fixture", body: "{\"model\":\"fixture\",\"messages\":[]}", reply: { value, error in
            XCTAssertNil(error); status = (value as? [String: Any])?["status"] as? Int ?? 0
        }, emit: { event in
            XCTAssertEqual(event["id"] as? String, "fixture")
            if let base64 = event["base64"] as? String { received.append(Data(base64Encoded: base64)!) }
            if event["type"] as? String == "end" { finished = true }
        })
        let deadline = Date().addingTimeInterval(2)
        while !finished && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(finished); XCTAssertEqual(status, 200)
        XCTAssertEqual(String(data: received, encoding: .utf8), "data: 中文\n\ndata: [DONE]\n\n")
    }

    func testCancelledNativeStreamDoesNotEmitCompletionOrMoreData() async throws {
        let credentials = MemoryGatewayCredentials(); credentials.key = "fixture-secret"
        HoldingGatewayFixtureProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [HoldingGatewayFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let gateway = GatewayClient(settings: GatewaySettings(credentials: credentials), session: session)
        var events = 0
        try gateway.start(id: "cancel", body: "{\"model\":\"fixture\",\"messages\":[]}", reply: { _, _ in }, emit: { _ in
            events += 1; gateway.cancel("cancel")
        })
        let deadline = Date().addingTimeInterval(2)
        while events == 0 && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try await Task.sleep(for: .milliseconds(10))
        XCTAssertEqual(events, 1)
        XCTAssertEqual(HoldingGatewayFixtureProtocol.stopCount, 1, "Stop must close the underlying connection, not only stop consuming bytes.")
    }

    func testEncodedChartPNGKeepsOpaqueBackgroundAndPixelDimensions() throws {
        let source = NSImage(size: NSSize(width: 80, height: 40))
        source.lockFocus(); NSColor.clear.setFill(); NSRect(x: 0, y: 0, width: 80, height: 40).fill(); source.unlockFocus()
        let image = try XCTUnwrap(opaqueChartSnapshot(source, backgroundRGB: [0.1, 0.2, 0.3]))
        let png = try XCTUnwrap(chartSnapshotPNG(image))
        let url = try XCTUnwrap(png["imageDataURL"] as? String)
        let data = try XCTUnwrap(Data(base64Encoded: String(url.dropFirst("data:image/png;base64,".count))))
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: data))
        XCTAssertEqual(png["width"] as? Int, bitmap.pixelsWide)
        XCTAssertEqual(png["height"] as? Int, bitmap.pixelsHigh)
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(data as CFData, nil)!, 0, nil))
        XCTAssertEqual(decoded.colorSpace?.name, CGColorSpace.sRGB)
        // colorAt returns calibrated NSColor even for an sRGB bitmap. Its
        // components are the decoded samples; converting it applies gamma twice.
        let color = try XCTUnwrap(bitmap.colorAt(x: 0, y: 0))
        XCTAssertEqual(color.alphaComponent, 1)
        XCTAssertEqual(color.redComponent, 0.1, accuracy: 1 / 255.0)
    }
}
