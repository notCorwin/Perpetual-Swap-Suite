import Foundation
import XCTest
@testable import PerpetualRadar

private actor LegacyCredentialFixture: GatewayCredentials {
    private(set) var reads = 0
    var failure: Bool
    let delay: Duration
    let key: String?
    init(key: String? = "legacy-secret", failure: Bool = false, delay: Duration = .zero) {
        self.key = key; self.failure = failure; self.delay = delay
    }
    func read() async throws -> String? {
        reads += 1
        try await Task.sleep(for: delay)
        if failure { throw GatewayError("Legacy authorization canceled.") }
        return key
    }
    func write(_ key: String) { XCTFail("New keys must never be written to Keychain.") }
    func remove() { XCTFail("Removal must not require Keychain authorization.") }
    func allowRetry() { failure = false }
}

@MainActor
final class GatewayCredentialTests: XCTestCase {
    private var directory: URL!
    private var url: URL { directory.appendingPathComponent("Credentials/ai-gateway.json") }
    private let body = "{\"model\":\"fixture\",\"messages\":[]}"

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("GatewayCredentials-\(UUID())")
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    func testMigrationAuthorizesRepeatedAnalysesAndUpdatedAppWithoutReopeningKeychain() async throws {
        let legacy = LegacyCredentialFixture()
        let settings = GatewaySettings(credentials: FileGatewayCredentials(url: url, legacy: legacy))
        let snapshot = try await settings.snapshot()
        XCTAssertEqual(snapshot["hasAPIKey"] as? Bool, true)
        XCTAssertFalse(String(describing: snapshot).contains("legacy-secret"))
        for _ in 0..<4 {
            let request = try await settings.authorizedRequest(body: body)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer legacy-secret")
        }
        // A new instance represents a new app process/bundle after an update.
        let deniedLegacy = LegacyCredentialFixture(failure: true)
        let updated = GatewaySettings(credentials: FileGatewayCredentials(url: url, legacy: deniedLegacy))
        let request = try await updated.authorizedRequest(body: body)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer legacy-secret")
        let reads = await legacy.reads, updateReads = await deniedLegacy.reads
        XCTAssertEqual(reads, 1); XCTAssertEqual(updateReads, 0)
    }

    func testSavingReplacementAndRemovalPersistAcrossUpdatesWithoutImportingOldKey() async throws {
        let legacy = LegacyCredentialFixture(failure: true)
        let settings = GatewaySettings(credentials: FileGatewayCredentials(url: url, legacy: legacy))
        _ = try await settings.handle(["action": "save", "model": "fixture", "apiKey": "new-secret"])
        _ = try await settings.handle(["action": "save", "model": "fixture", "apiKey": "replacement"])
        let updated = GatewaySettings(credentials: FileGatewayCredentials(url: url, legacy: legacy))
        let request = try await updated.authorizedRequest(body: body)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer replacement")
        _ = try await updated.handle(["action": "removeKey"])
        let reopened = GatewaySettings(credentials: FileGatewayCredentials(url: url, legacy: legacy))
        let snapshot = try await reopened.snapshot()
        XCTAssertEqual(snapshot["hasAPIKey"] as? Bool, false)
        do { _ = try await reopened.authorizedRequest(body: body); XCTFail("Removed key must not authorize requests.") }
        catch { XCTAssertEqual(error.localizedDescription, "Configure a Gateway API Key to analyze charts.") }
        let reads = await legacy.reads
        XCTAssertEqual(reads, 0)
    }

    func testConcurrentFirstReadsShareMigration() async throws {
        let legacy = LegacyCredentialFixture(delay: .milliseconds(30))
        let credentials = FileGatewayCredentials(url: url, legacy: legacy)
        async let first = credentials.read()
        async let second = credentials.read()
        async let third = credentials.read()
        let keys = try await [first, second, third]
        XCTAssertEqual(keys, ["legacy-secret", "legacy-secret", "legacy-secret"])
        let reads = await legacy.reads
        XCTAssertEqual(reads, 1)
    }

    func testCanceledMigrationCanRetryWithoutLosingKey() async throws {
        let legacy = LegacyCredentialFixture(failure: true)
        let credentials = FileGatewayCredentials(url: url, legacy: legacy)
        do { _ = try await credentials.read(); XCTFail("Canceled authorization must report failure.") }
        catch { XCTAssertEqual(error.localizedDescription, "Legacy authorization canceled.") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        await legacy.allowRetry()
        let retried = try await credentials.read()
        XCTAssertEqual(retried, "legacy-secret")
    }

    func testReplacementAndRemovalWinOverPendingMigration() async throws {
        for remove in [false, true] {
            let legacy = LegacyCredentialFixture(delay: .milliseconds(40))
            let location = directory.appendingPathComponent("\(remove)/ai-gateway.json")
            let credentials = FileGatewayCredentials(url: location, legacy: legacy)
            let pending = Task { try await credentials.read() }
            while await legacy.reads == 0 { await Task.yield() }
            if remove { try await credentials.remove() }
            else { try await credentials.write("replacement") }
            let value = try await pending.value
            XCTAssertEqual(value, remove ? nil : "replacement")
            let reopened = FileGatewayCredentials(url: location, legacy: legacy)
            let restored = try await reopened.read()
            XCTAssertEqual(restored, value)
        }
    }

    func testFilePermissionsProtectInitialAndReplacementWrites() async throws {
        let credentials = FileGatewayCredentials(url: url, legacy: nil)
        for key in ["first", "replacement"] {
            try await credentials.write(key)
            let file = try FileManager.default.attributesOfItem(atPath: url.path)
            let folder = try FileManager.default.attributesOfItem(atPath: url.deletingLastPathComponent().path)
            XCTAssertEqual((file[.posixPermissions] as? NSNumber)?.intValue, 0o600)
            XCTAssertEqual((folder[.posixPermissions] as? NSNumber)?.intValue, 0o700)
            let restored = try await FileGatewayCredentials(url: url, legacy: nil).read()
            XCTAssertEqual(restored, key)
            let files = try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)
            XCTAssertEqual(files, ["ai-gateway.json"])
        }
    }

    func testCorruptLocalRecordDoesNotReimportLegacyAndCanBeReplaced() async throws {
        let legacy = LegacyCredentialFixture()
        let credentials = FileGatewayCredentials(url: url, legacy: legacy)
        try await credentials.write("original")
        try Data("broken".utf8).write(to: url)
        do { _ = try await credentials.read(); XCTFail("Corrupt local records must report failure.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("save a new key")) }
        let reads = await legacy.reads
        XCTAssertEqual(reads, 0)
        try await credentials.write("recovered")
        let restored = try await credentials.read()
        XCTAssertEqual(restored, "recovered")
    }
}
