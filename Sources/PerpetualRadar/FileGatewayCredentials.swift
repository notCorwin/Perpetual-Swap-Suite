import Darwin
import Foundation

/// The user's credential record outlives app bundles and their ad hoc signatures.
/// An empty record is authoritative too: removing a key must not restore the
/// legacy Keychain value after a restart or an update.
actor FileGatewayCredentials: GatewayCredentials {
    private struct Record: Codable {
        var version = 1
        let apiKey: String?
    }

    static var defaultURL: URL {
        let support = MonitorRuntime.storeURL?.deletingLastPathComponent()
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("PerpetualRadar", isDirectory: true)
        return support.appendingPathComponent("Credentials", isDirectory: true)
            .appendingPathComponent("ai-gateway.json")
    }

    private let url: URL
    private let legacy: (any GatewayCredentialReader)?
    private var migration: Task<Void, Error>?

    init(url: URL = FileGatewayCredentials.defaultURL,
         legacy: (any GatewayCredentialReader)? = MonitorRuntime.testChannel == nil ? KeychainGatewayCredentials() : nil) {
        self.url = url
        self.legacy = legacy
    }

    func read() async throws -> String? {
        if let record = try load() { return record.apiKey }
        // Settings and multiple analyses may arrive while the one-time native
        // authorization is pending. Share the whole migration, including commit.
        if let migration {
            try await migration.value
            return try load()?.apiKey
        }
        let task = Task { try await migrate() }
        migration = task
        defer { migration = nil }
        try await task.value
        return try load()?.apiKey
    }

    func write(_ key: String) throws { try persist(Record(apiKey: key)) }
    func remove() throws { try persist(Record(apiKey: nil)) }

    private func migrate() async throws {
        let key: String?
        do { key = try await legacy?.read() }
        catch {
            // A replacement or removal saved while authorization was pending
            // wins, even if the user subsequently cancels the old prompt.
            if try load() != nil { return }
            throw error
        }
        guard try load() == nil else { return }
        try persist(Record(apiKey: key))
    }

    private func prepareDirectory() throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    private func load() throws -> Record? {
        do {
            try prepareDirectory()
            let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard descriptor >= 0 else {
                if errno == ENOENT { return nil }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                  info.st_uid == getuid(), fchmod(descriptor, 0o600) == 0 else {
                throw GatewayError("Invalid local credential file.")
            }
            let record = try JSONDecoder().decode(Record.self, from: handle.readToEnd() ?? Data())
            guard record.version == 1 else { throw GatewayError("Unsupported credential record.") }
            return record
        } catch {
            throw GatewayError("Cannot read the locally saved Gateway API Key. Check the credential file or save a new key in Configure analysis.")
        }
    }

    private func persist(_ record: Record) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".ai-gateway-\(UUID()).tmp")
        do {
            try prepareDirectory()
            let data = try JSONEncoder().encode(record)
            // Create with 0600 before writing any bytes. Foundation's atomic
            // write can create a replacement with the process's default mode.
            let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
            try handle.write(contentsOf: data)
            try handle.synchronize()
            guard rename(temporary.path, url.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } catch {
            throw GatewayError("Cannot save the Gateway API Key locally. Check access to the app's Application Support folder.")
        }
    }
}
