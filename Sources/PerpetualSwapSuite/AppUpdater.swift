import CryptoKit
import Foundation

struct AppUpdateStatus: Codable, Sendable {
    let state: String
    let currentRevision: String?
    let availableRevision: String?
    let message: String
    let relaunchRequired: Bool
}

private struct UpdateManifest: Decodable {
    let revision: String
    let assetURL: URL
    let digest: String

    enum CodingKeys: String, CodingKey {
        case revision, digest
        case assetURL = "asset_url"
    }
}

actor AppUpdater {
    private let manifestURL = URL(string: "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/autobuild/update.json")!
    private let cache: URL
    private let session: URLSession
    private var available: UpdateManifest?

    init(cache: URL, session: URLSession = .shared) { self.cache = cache; self.session = session }

    func check() async throws -> AppUpdateStatus {
        guard Bundle.main.bundleURL.pathExtension == "app" else {
            return status(state: "development", message: "Update checks require the packaged application.")
        }
        let (data, response) = try await session.data(from: manifestURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw AppUpdateError.checkFailed }
        let manifest = try JSONDecoder().decode(UpdateManifest.self, from: data)
        guard manifest.assetURL.host == "github.com" || manifest.assetURL.host == "objects.githubusercontent.com" else { throw AppUpdateError.invalidManifest }
        let current = currentRevision
        if manifest.revision == current {
            available = nil
            return status(state: "current", message: "Perpetual Swap Suite is up to date.")
        }
        available = manifest
        return .init(state: "available", currentRevision: current, availableRevision: manifest.revision, message: "A new main-branch build is available.", relaunchRequired: false)
    }

    func install() async throws -> AppUpdateStatus {
        if available == nil { _ = try await check() }
        guard let manifest = available else { return status(state: "current", message: "Perpetual Swap Suite is up to date.") }
        let (download, response) = try await session.download(from: manifest.assetURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw AppUpdateError.downloadFailed }
        guard try sha256(download).caseInsensitiveCompare(normalizedDigest(manifest.digest)) == .orderedSame else { throw AppUpdateError.digestMismatch }

        let root = cache.appendingPathComponent("Update-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let archive = root.appendingPathComponent("app.tar.gz")
        try FileManager.default.moveItem(at: download, to: archive)
        try run("/usr/bin/tar", ["-xzf", archive.path, "-C", root.path])
        let extracted = root.appendingPathComponent("Perpetual Swap Suite.app")
        let info = NSDictionary(contentsOf: extracted.appendingPathComponent("Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == "com.perpetualswapsuite.macos",
              info?["CFBundleSourceRevision"] as? String == manifest.revision,
              FileManager.default.isExecutableFile(atPath: extracted.appendingPathComponent("Contents/MacOS/PerpetualSwapSuite").path)
        else { throw AppUpdateError.invalidPackage }

        let current = Bundle.main.bundleURL.standardizedFileURL
        guard current.pathExtension == "app", FileManager.default.isWritableFile(atPath: current.deletingLastPathComponent().path) else { throw AppUpdateError.notWritable }
        let staged = current.deletingLastPathComponent().appendingPathComponent(".PerpetualSwapSuite-update-\(UUID().uuidString).app")
        try FileManager.default.copyItem(at: extracted, to: staged)
        let script = root.appendingPathComponent("install-update.sh")
        try Self.installScript.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let helper = Process()
        helper.executableURL = script
        helper.arguments = [String(ProcessInfo.processInfo.processIdentifier), current.path, staged.path]
        try helper.run()
        return .init(state: "installing", currentRevision: currentRevision, availableRevision: manifest.revision, message: "Installing update and relaunching.", relaunchRequired: true)
    }

    private var currentRevision: String? { Bundle.main.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String }
    private func status(state: String, message: String) -> AppUpdateStatus {
        .init(state: state, currentRevision: currentRevision, availableRevision: available?.revision, message: message, relaunchRequired: false)
    }
    private func normalizedDigest(_ value: String) -> String { value.lowercased().replacingOccurrences(of: "sha256:", with: "") }
    private func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw AppUpdateError.invalidPackage }
    }

    private static let installScript = """
    #!/bin/zsh
    set -euo pipefail
    pid="$1"; current="$2"; staged="$3"; backup="${current}.previous"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    rm -rf "$backup"
    mv "$current" "$backup"
    if mv "$staged" "$current" && open "$current"; then
      rm -rf "$backup"
    else
      rm -rf "$current"
      mv "$backup" "$current"
      open "$current"
      exit 1
    fi
    """
}

enum AppUpdateError: LocalizedError {
    case checkFailed, invalidManifest, downloadFailed, digestMismatch, invalidPackage, notWritable
    var errorDescription: String? {
        switch self {
        case .checkFailed: "Could not check the GitHub release manifest."
        case .invalidManifest: "The GitHub update manifest is invalid."
        case .downloadFailed: "Could not download the update."
        case .digestMismatch: "The downloaded update does not match its SHA-256 digest."
        case .invalidPackage: "The downloaded application package is invalid."
        case .notWritable: "The current application cannot be replaced in its current folder."
        }
    }
}
