import CryptoKit
import Foundation

struct AppUpdate: Sendable {
    let name: String
    let revision: String
    let assetURL: URL
    let expectedSHA256: String
    let publishedAt: Date?

    init(
        name: String,
        revision: String,
        assetURL: URL,
        expectedSHA256: String,
        publishedAt: Date? = nil
    ) {
        self.name = name
        self.revision = revision
        self.assetURL = assetURL
        self.expectedSHA256 = expectedSHA256
        self.publishedAt = publishedAt
    }
}

enum AppUpdateError: LocalizedError, Sendable {
    case notPackaged
    case noRelease
    case network(String)
    case invalidResponse
    case downloadFailed(String)
    case rateLimited(Date)
    case invalidPackage
    case installFailed(String)
    case busy

    var errorDescription: String? {
        switch self {
        case .notPackaged:
            return "Updates require a packaged app."
        case .noRelease:
            return "No autobuild update manifest is available yet."
        case .network(let message):
            return "Could not check for updates: \(message)"
        case .invalidResponse:
            return "GitHub returned an invalid update manifest."
        case .downloadFailed(let message):
            return "Could not download the update: \(message)"
        case .rateLimited(let until):
            return "GitHub temporarily rejected update requests. Try again after \(until.formatted(date: .abbreviated, time: .shortened))."
        case .invalidPackage:
            return "The downloaded app package is invalid."
        case .installFailed(let message):
            return "Could not install the update: \(message)"
        case .busy:
            return "An update operation is already in progress."
        }
    }
}

enum AppUpdateProgress: Sendable {
    case downloading(received: Int64, total: Int64)
    case retrying(attempt: Int, total: Int)
    case installing
}

protocol AppUpdating: Sendable {
    @MainActor @discardableResult func cancel() -> Bool
    @MainActor func check(completion: @escaping AppUpdater.CheckCompletion)
    @MainActor func downloadAndInstall(
        _ update: AppUpdate,
        progress: @escaping AppUpdater.ProgressHandler,
        completion: @escaping AppUpdater.InstallCompletion
    )
}

private final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    typealias OversizedHandler = @Sendable (URLSessionDownloadTask) -> Void
    typealias Completion = @Sendable (URL?, URLResponse?, Error?) -> Void

    private let maximumBytes: Int64
    private let lock = NSLock()
    private var completions: [Int: Completion] = [:]
    var oversizedHandler: OversizedHandler?
    var progressHandler: (@Sendable (URLSessionDownloadTask, Int64, Int64) -> Void)?

    init(maximumBytes: Int64) {
        self.maximumBytes = maximumBytes
    }

    func downloadTask(in session: URLSession, request: URLRequest, resumeData: Data? = nil, completion: @escaping Completion) -> URLSessionDownloadTask {
        // Use delegate-based tasks so streaming progress and size checks run
        // before completion. The downloaded file lives only during this callback.
        let task = resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: request)
        lock.lock()
        completions[task.taskIdentifier] = completion
        lock.unlock()
        return task
    }

    private func takeCompletion(for task: URLSessionTask) -> Completion? {
        lock.lock()
        defer { lock.unlock() }
        return completions.removeValue(forKey: task.taskIdentifier)
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        takeCompletion(for: downloadTask)?(location, downloadTask.response, nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        takeCompletion(for: task)?(nil, task.response, error)
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        if totalBytesWritten > maximumBytes || totalBytesExpectedToWrite > maximumBytes {
            oversizedHandler?(downloadTask)
        } else {
            progressHandler?(downloadTask, totalBytesWritten, totalBytesExpectedToWrite)
        }
    }
}

// Network tasks are protected independently; operationGeneration and installationInProgress share generationLock.
// Installation work stays off the main actor.
final class AppUpdater: AppUpdating, @unchecked Sendable {
    // Window visibility is a UI preference; the installer reads it off the main
    // actor and forwards it only for update relaunches, not ordinary launches.
    static let backgroundRelaunchKey = "RelaunchUpdatedRadarInBackground"
    typealias CheckCompletion = @MainActor @Sendable (Result<AppUpdate?, AppUpdateError>) -> Void
    typealias InstallCompletion = @MainActor @Sendable (Result<Void, AppUpdateError>) -> Void
    typealias ProgressHandler = @MainActor @Sendable (AppUpdateProgress) -> Void
    typealias Relauncher = @Sendable (URL, URL) throws -> Void

    private static let appName = "Perpetual Swap Suite"
    private static let bundleIdentifier = "com.perpetualradar.macos"
    private static let executableName = "PerpetualRadar"
    private static let releaseURLPrefix = "https://github.com/notCorwin/Perpetual-Swap-Suite/releases/download/"
    private static let canonicalAssetURL = URL(
        string: "\(releaseURLPrefix)autobuild/Perpetual.Swap.Suite.app.tar"
    )!
    private static let manifestURL = URL(
        string: "\(releaseURLPrefix)autobuild/update.json"
    )!
    private static let retryAfterKey = "UpdateCheckRetryAfter"
    private static let maxAttempts = 3
    private static let parallelDownloadLanes = 4
    private static let minimumParallelDownloadBytes: Int64 = 4 * 1024 * 1024
    // ponytail: cap release metadata before parsing; raise only if the manifest grows.
    private static let maxReleaseMetadataBytes: Int64 = 4 * 1024 * 1024
    // ponytail: cap tar listings to bound parser memory; raise with measured package growth.
    private static let maxTarListingBytes = 4 * 1024 * 1024
    // ponytail: cap extracted regular-file bytes to limit archive bombs; raise with measured app growth.
    private static let maxExtractedPackageBytes: Int64 = 256 * 1024 * 1024
    // ponytail: reject oversized tar files before invoking tar; raise with measured release size.
    private static let maxDownloadedPackageBytes: Int64 = 256 * 1024 * 1024

    private struct Manifest: Decodable {
        let revision: String
        let assetUrl: URL
        let versionedAssetUrl: URL?
        let immutableAssetUrl: URL?
        let digest: String
        let publishedAt: Date?
        let commitDate: Date?
    }
    private let metadataSession: URLSession
    private let metadataDelegate: DownloadProgressDelegate
    private let downloadSession: URLSession
    private let downloadDelegate: DownloadProgressDelegate
    private let currentAppURL: URL
    private let relauncher: Relauncher
    private let taskLock = NSLock()
    private let generationLock = NSLock()
    private var tasks: [URLSessionTask] = []
    private var downloadProgress: (@Sendable (URLSessionDownloadTask, Int64, Int64) -> (Int64, Int64)?)?
    private var downloadProgressDelivery: (@Sendable (Int64, Int64) -> Void)?
    private var parallelCoordinator: ParallelDownloadCoordinator?
    private var reportedDownloadUnit: Int64 = -1
    private var resumableDownload: (update: AppUpdate, data: Data)?
    private var operationGeneration = 0
    private var installationInProgress = false
    private var oversizedMetadata = false
    private var oversizedDownload = false

    init(
        session: URLSession = .shared,
        currentAppURL: URL = Bundle.main.bundleURL,
        relauncher: @escaping Relauncher = AppUpdater.defaultRelauncher
    ) {
        self.currentAppURL = currentAppURL
        self.relauncher = relauncher
        let metadataDelegate = DownloadProgressDelegate(maximumBytes: Self.maxReleaseMetadataBytes)
        self.metadataDelegate = metadataDelegate
        let metadataConfiguration = session.configuration
        metadataConfiguration.timeoutIntervalForResource = min(metadataConfiguration.timeoutIntervalForResource, 60)
        let metadataQueue = OperationQueue()
        metadataQueue.name = "PerpetualRadar.UpdateMetadata"
        metadataQueue.qualityOfService = .userInitiated
        metadataQueue.maxConcurrentOperationCount = 1
        self.metadataSession = URLSession(
            configuration: metadataConfiguration,
            delegate: metadataDelegate,
            delegateQueue: metadataQueue
        )
        let downloadDelegate = DownloadProgressDelegate(maximumBytes: Self.maxDownloadedPackageBytes)
        self.downloadDelegate = downloadDelegate
        let downloadConfiguration = session.configuration
        // Let slow but active transfers finish. Individual requests still stop
        // after an extended period without network progress.
        downloadConfiguration.timeoutIntervalForResource = min(downloadConfiguration.timeoutIntervalForResource, 24 * 60 * 60)
        let downloadQueue = OperationQueue()
        downloadQueue.name = "PerpetualRadar.UpdateDownload"
        downloadQueue.qualityOfService = .userInitiated
        downloadQueue.maxConcurrentOperationCount = Self.parallelDownloadLanes
        self.downloadSession = URLSession(
            configuration: downloadConfiguration,
            delegate: downloadDelegate,
            delegateQueue: downloadQueue
        )
        metadataDelegate.oversizedHandler = { [weak self] task in
            self?.cancelOversizedMetadata(task)
        }
        downloadDelegate.oversizedHandler = { [weak self] task in
            self?.cancelOversizedDownload(task)
        }
        downloadDelegate.progressHandler = { [weak self] task, received, total in
            self?.reportDownloadProgress(task, received: received, total: total)
        }
    }

    deinit {
        metadataSession.invalidateAndCancel()
        downloadSession.invalidateAndCancel()
    }

    @MainActor
    @discardableResult
    func cancel() -> Bool {
        var shouldCancelTask = false
        generationLock.lock()
        if !installationInProgress {
            operationGeneration += 1
            shouldCancelTask = true
        }
        generationLock.unlock()
        if shouldCancelTask {
            cancelTask()
        }
        return shouldCancelTask
    }

    @MainActor
    func check(completion: @escaping CheckCompletion) {
        guard currentAppURL.pathExtension == "app" else {
            DispatchQueue.main.async {
                completion(.failure(AppUpdateError.notPackaged))
            }
            return
        }
        guard !hasTask else {
            DispatchQueue.main.async {
                completion(.failure(AppUpdateError.busy))
            }
            return
        }
        if let until = UserDefaults.standard.object(forKey: Self.retryAfterKey) as? Date,
           until > Date() {
            DispatchQueue.main.async {
                completion(.failure(AppUpdateError.rateLimited(until)))
            }
            return
        }

        check(attempt: 1, completion: completion)
    }

    private func check(
        attempt: Int,
        completion: @escaping CheckCompletion
    ) {
        let generation = currentOperationGeneration()
        var request = URLRequest(url: Self.manifestURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.setValue("PerpetualRadar", forHTTPHeaderField: "User-Agent")
        let task = metadataDelegate.downloadTask(in: metadataSession, request: request) { [weak self] location, response, error in
            guard let self else { return }
            guard self.isCurrentOperation(generation) else { return }

            if self.consumeOversizedMetadata() {
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.invalidResponse),
                    generation: generation
                )
                return
            }
            if let error {
                if self.retryIfNeeded(attempt: attempt, generation: generation, error: error, operation: {
                    self.check(attempt: attempt + 1, completion: completion)
                }) {
                    return
                }
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.network(error.localizedDescription)),
                    generation: generation
                )
                return
            }

            guard let response = response as? HTTPURLResponse else {
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.invalidResponse),
                    generation: generation
                )
                return
            }
            if let until = Self.retryDate(for: response) {
                UserDefaults.standard.set(until, forKey: Self.retryAfterKey)
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.rateLimited(until)),
                    generation: generation
                )
                return
            }
            if response.statusCode == 404 {
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.noRelease),
                    generation: generation
                )
                return
            }
            if response.expectedContentLength > Self.maxReleaseMetadataBytes {
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.invalidResponse),
                    generation: generation
                )
                return
            }
            if self.retryIfNeeded(
                attempt: attempt,
                generation: generation,
                statusCode: response.statusCode,
                operation: {
                    self.check(attempt: attempt + 1, completion: completion)
                }
            ) {
                return
            }

            let result: Result<AppUpdate?, AppUpdateError>
            if let error = Self.httpError(from: response) {
                result = .failure(error)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.retryAfterKey)
                guard let location,
                      let data = try? Data(contentsOf: location),
                      Int64(data.count) <= Self.maxReleaseMetadataBytes else {
                    self.finish(
                        completion,
                        with: .failure(AppUpdateError.invalidResponse),
                        generation: generation
                    )
                    return
                }
                result = self.parse(data: data)
            }

            self.finish(completion, with: result, generation: generation)
        }
        setTask(task)
        task.resume()
    }

    @MainActor
    func downloadAndInstall(
        _ update: AppUpdate,
        progress: @escaping ProgressHandler = { _ in },
        completion: @escaping InstallCompletion
    ) {
        guard currentAppURL.pathExtension == "app" else {
            DispatchQueue.main.async {
                completion(.failure(AppUpdateError.notPackaged))
            }
            return
        }
        guard !hasTask else {
            DispatchQueue.main.async {
                completion(.failure(AppUpdateError.busy))
            }
            return
        }
        guard Self.isExpectedAssetURL(update.assetURL, revision: update.revision) else {
            DispatchQueue.main.async {
                completion(.failure(AppUpdateError.invalidResponse))
            }
            return
        }

        downloadAndInstall(update, attempt: 1, progress: progress, completion: completion)
    }

    private func downloadAndInstall(
        _ update: AppUpdate,
        attempt: Int,
        progress: @escaping ProgressHandler,
        completion: @escaping InstallCompletion
    ) {
        let generation = currentOperationGeneration()
        var request = downloadRequest(for: update)
        request.httpMethod = "HEAD"
        let task = downloadSession.dataTask(with: request) { [weak self] _, response, _ in
            guard let self, self.isCurrentOperation(generation) else { return }
            let length = response?.expectedContentLength ?? NSURLSessionTransferSizeUnknown
            let acceptsRanges = (response as? HTTPURLResponse)?
                .value(forHTTPHeaderField: "Accept-Ranges")?.lowercased() == "bytes"
            if acceptsRanges,
               length >= Self.minimumParallelDownloadBytes,
               length <= Self.maxDownloadedPackageBytes {
                self.downloadInParallel(
                    update, totalBytes: length, attempt: attempt,
                    progress: progress, completion: completion, generation: generation
                )
            } else {
                self.downloadSingle(
                    update, attempt: attempt, progress: progress,
                    completion: completion, generation: generation
                )
            }
        }
        setTask(task)
        Task { @MainActor in
            guard self.isCurrentOperation(generation) else { return }
            progress(attempt == 1 ? .downloading(received: 0, total: 0) : .retrying(attempt: attempt, total: Self.maxAttempts))
        }
        task.resume()
    }

    private func downloadInParallel(
        _ update: AppUpdate,
        totalBytes: Int64,
        attempt: Int,
        progress: @escaping ProgressHandler,
        completion: @escaping InstallCompletion,
        generation: Int
    ) {
        let coordinator: ParallelDownloadCoordinator
        do {
            coordinator = try ParallelDownloadCoordinator(
                update: update, totalBytes: totalBytes, lanes: Self.parallelDownloadLanes
            )
        } catch {
            downloadSingle(update, attempt: attempt, progress: progress, completion: completion, generation: generation)
            return
        }

        if case .success(let location) = coordinator.completeFromCache() {
            setTasks([], coordinator: coordinator)
            publishDownloadProgress(received: totalBytes, total: totalBytes, progress: progress, generation: generation)
            installDownloadedFile(location, update: update, cache: coordinator, progress: progress, completion: completion, generation: generation)
            return
        }

        let tasks: [URLSessionDownloadTask] = coordinator.missingSegments.map { segment in
            var request = downloadRequest(for: update)
            request.setValue("bytes=\(segment.start)-\(segment.end)", forHTTPHeaderField: "Range")
            let task = downloadDelegate.downloadTask(in: downloadSession, request: request) { [weak self, weak coordinator] location, response, error in
                guard let self, let coordinator, self.isCurrentOperation(generation) else { return }
                switch coordinator.complete(index: segment.index, location: location, response: response, error: error) {
                case .waiting:
                    break
                case .success(let assembled):
                    self.installDownloadedFile(assembled, update: update, cache: coordinator, progress: progress, completion: completion, generation: generation)
                case .failure(let error):
                    self.cancelNetworkTasksForRetry()
                    if self.consumeOversizedDownload() {
                        coordinator.removeCache()
                        self.finish(completion, with: .failure(.invalidPackage), generation: generation)
                        return
                    }
                    if error is ParallelDownloadError {
                        coordinator.removeCache()
                        self.downloadSingle(update, attempt: attempt, progress: progress, completion: completion, generation: generation)
                    } else if self.retryIfNeeded(attempt: attempt, generation: generation, error: error, operation: {
                        self.downloadAndInstall(update, attempt: attempt + 1, progress: progress, completion: completion)
                    }) {
                        return
                    } else {
                        self.finish(completion, with: .failure(.downloadFailed(error.localizedDescription)), generation: generation)
                    }
                }
            }
            coordinator.register(task, for: segment.index)
            return task
        }
        setTasks(
            tasks,
            coordinator: coordinator,
            downloadProgress: { task, received, _ in coordinator.progress(for: task, received: received) },
            delivery: { [weak self] received, total in
                guard let self else { return }
                self.publishDownloadProgress(received: received, total: total, progress: progress, generation: generation)
            }
        )
        publishDownloadProgress(received: coordinator.cachedBytes, total: totalBytes, progress: progress, generation: generation)
        tasks.forEach { $0.resume() }
    }

    private func downloadSingle(
        _ update: AppUpdate,
        attempt: Int,
        progress: @escaping ProgressHandler,
        completion: @escaping InstallCompletion,
        generation: Int
    ) {
        let request = downloadRequest(for: update)
        let handler: @Sendable (URL?, URLResponse?, Error?) -> Void = { [weak self] location, response, error in
            guard let self else { return }
            guard self.isCurrentOperation(generation) else { return }

            if self.consumeOversizedDownload() {
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.invalidPackage),
                    generation: generation
                )
                return
            }
            if let error {
                self.saveResumeData((error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data, for: update)
                if self.retryIfNeeded(attempt: attempt, generation: generation, error: error, operation: {
                    self.downloadAndInstall(update, attempt: attempt + 1, progress: progress, completion: completion)
                }) {
                    return
                }
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.downloadFailed(error.localizedDescription)),
                    generation: generation
                )
                return
            }

            guard let response = response as? HTTPURLResponse else {
                self.finish(
                    completion,
                    with: .failure(
                        AppUpdateError.downloadFailed(
                            "GitHub returned an invalid release response."
                        )
                    ),
                    generation: generation
                )
                return
            }
            guard (200..<300).contains(response.statusCode) else {
                self.saveResumeData(nil, for: update)
                if let until = Self.retryDate(for: response) {
                    self.finish(completion, with: .failure(.rateLimited(until)), generation: generation)
                    return
                }
                if self.retryIfNeeded(
                    attempt: attempt,
                    generation: generation,
                    statusCode: response.statusCode,
                    operation: {
                        self.downloadAndInstall(update, attempt: attempt + 1, progress: progress, completion: completion)
                    }
                ) {
                    return
                }
                self.finish(
                    completion,
                    with: .failure(
                        AppUpdateError.downloadFailed(
                            "GitHub returned HTTP \(response.statusCode)."
                        )
                    ),
                    generation: generation
                )
                return
            }
            guard let location else {
                self.finish(
                    completion,
                    with: .failure(
                        AppUpdateError.downloadFailed(
                            "GitHub returned an empty download."
                        )
                    ),
                    generation: generation
                )
                return
            }
            if response.expectedContentLength > Self.maxDownloadedPackageBytes {
                self.finish(
                    completion,
                    with: .failure(AppUpdateError.invalidPackage),
                    generation: generation
                )
                return
            }
            self.installDownloadedFile(location, update: update, cache: nil, progress: progress, completion: completion, generation: generation)
        }
        let task = downloadDelegate.downloadTask(in: downloadSession, request: request, resumeData: resumeData(for: update), completion: handler)
        setTasks(
            [task], downloadProgress: { _, received, total in (received, total) },
            delivery: { [weak self] received, total in
                guard let self else { return }
                self.publishDownloadProgress(received: received, total: total, progress: progress, generation: generation)
            }
        )
        task.resume()
    }

    private func downloadRequest(for update: AppUpdate) -> URLRequest {
        var request = URLRequest(url: update.assetURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // This is an inactivity timeout. Active transfers may run for the much
        // longer resource timeout configured on the session.
        request.timeoutInterval = 90
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.setValue("PerpetualRadar", forHTTPHeaderField: "User-Agent")
        return request
    }

    private func publishDownloadProgress(
        received: Int64,
        total: Int64,
        progress: @escaping ProgressHandler,
        generation: Int
    ) {
        Task { @MainActor in
            guard self.isCurrentOperation(generation) else { return }
            progress(.downloading(received: received, total: total))
        }
    }

    private func installDownloadedFile(
        _ location: URL,
        update: AppUpdate,
        cache: ParallelDownloadCoordinator?,
        progress: @escaping ProgressHandler,
        completion: @escaping InstallCompletion,
        generation: Int
    ) {
        do {
            let size = (try? FileManager.default.attributesOfItem(atPath: location.path)[.size] as? NSNumber)?.int64Value
            guard Self.isPackageFileSizeAcceptable(size) else { throw AppUpdateError.invalidPackage }
            try verifySHA256(of: location, expected: update.expectedSHA256)
            saveResumeData(nil, for: update)
            guard beginInstallation(for: generation) else { return }
            Task { @MainActor in
                guard self.isCurrentOperation(generation) else { return }
                progress(.installing)
            }
            try install(downloadedFile: location, expectedRevision: update.revision)
            cache?.removeCache()
            finish(completion, with: .success(()), generation: generation)
        } catch {
            saveResumeData(nil, for: update)
            if error is AppUpdateError { cache?.removeCache() }
            finish(
                completion,
                with: .failure(error as? AppUpdateError ?? .installFailed(error.localizedDescription)),
                generation: generation
            )
        }
    }

    static func revision(in body: String?) -> String? {
        guard let body,
              let range = body.range(of: "\\b[0-9a-fA-F]{40}\\b", options: .regularExpression) else {
            return nil
        }
        return String(body[range]).lowercased()
    }

    private func parse(data: Data) -> Result<AppUpdate?, AppUpdateError> {
        let bundle = Bundle(url: currentAppURL)
        let currentRevision = bundle?.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String
        let currentCommitDate = (bundle?.object(forInfoDictionaryKey: "CFBundleSourceCommitDate") as? String)
            .flatMap { ISO8601DateFormatter().date(from: $0) }
        return Self.parse(data: data, currentRevision: currentRevision, currentCommitDate: currentCommitDate)
    }

    static func parse(data: Data, currentRevision: String?, currentCommitDate: Date? = nil) -> Result<AppUpdate?, AppUpdateError> {
        do {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            decoder.dateDecodingStrategy = .iso8601
            let manifest = try decoder.decode(Manifest.self, from: data)
            guard manifest.revision.count == 40,
                  let releaseRevision = revision(in: manifest.revision),
                  releaseRevision == manifest.revision.lowercased(),
                  Self.isCanonicalAssetURL(manifest.assetUrl),
                  Self.isExpectedAssetURL(manifest.versionedAssetUrl ?? manifest.immutableAssetUrl ?? manifest.assetUrl, revision: releaseRevision) else {
                return .failure(AppUpdateError.invalidResponse)
            }

            let expectedSHA256 = try normalizedSHA256(from: manifest.digest)
            if releaseRevision == revision(in: currentRevision) {
                return .success(nil)
            }
            // The autobuild channel is rolling; never replace a build with one whose source
            // commit is older. Builds without commit dates keep the revision-only comparison.
            if let releaseDate = manifest.commitDate, let currentCommitDate, releaseDate < currentCommitDate {
                return .success(nil)
            }
            guard let expectedSHA256 else {
                return .failure(AppUpdateError.invalidResponse)
            }
            return .success(AppUpdate(
                name: "autobuild",
                revision: releaseRevision,
                assetURL: manifest.versionedAssetUrl ?? manifest.immutableAssetUrl ?? manifest.assetUrl,
                expectedSHA256: expectedSHA256,
                publishedAt: manifest.publishedAt
            ))
        } catch {
            return .failure(AppUpdateError.invalidResponse)
        }
    }

    static func retryDate(for response: HTTPURLResponse, now: Date = Date()) -> Date? {
        guard response.statusCode == 403 || response.statusCode == 429 else { return nil }
        if let value = response.value(forHTTPHeaderField: "Retry-After") {
            if let seconds = TimeInterval(value), seconds.isFinite, seconds >= 0 {
                return now.addingTimeInterval(max(1, seconds))
            }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
            if let date = formatter.date(from: value), date > now { return date }
        }
        if response.value(forHTTPHeaderField: "X-RateLimit-Remaining") == "0",
           let value = response.value(forHTTPHeaderField: "X-RateLimit-Reset"),
           let reset = TimeInterval(value), reset.isFinite, reset > now.timeIntervalSince1970 {
            return Date(timeIntervalSince1970: reset + 1)
        }
        return now.addingTimeInterval(60)
    }

    private static func httpError(from response: URLResponse?) -> AppUpdateError? {
        guard let response = response as? HTTPURLResponse else {
            return .invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            return .network(
                "GitHub returned HTTP \(response.statusCode)."
            )
        }
        return nil
    }

    private static func normalizedSHA256(from digest: String?) throws -> String? {
        guard let digest else { return nil }
        let parts = digest.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2,
              parts[0].lowercased() == "sha256",
              parts[1].count == 64,
              parts[1].unicodeScalars.allSatisfy({
                  (48...57).contains($0.value) || (65...70).contains($0.value) || (97...102).contains($0.value)
              }) else {
            throw AppUpdateError.invalidResponse
        }
        return parts[1].lowercased()
    }

    static func archiveAppRoot(from listing: String) -> String? {
        var root: String?
        for line in listing.split(whereSeparator: \.isNewline) {
            let path = String(line)
            let components = path.split(separator: "/", omittingEmptySubsequences: true)
            guard !path.isEmpty,
                  !path.hasPrefix("/"),
                  !path.unicodeScalars.contains(where: { $0.value == 0 }),
                  !components.isEmpty,
                  !components.contains(where: { $0 == "." || $0 == ".." }),
                  let first = components.first,
                  String(first).hasSuffix(".app") else {
                return nil
            }

            let candidate = String(first)
            if let root, root != candidate {
                return nil
            }
            root = candidate
        }
        return root == "\(appName).app" ? root : nil
    }

    static func archiveContainsUnsafeEntry(in listing: String) -> Bool {
        listing.split(whereSeparator: \.isNewline).contains { line in
            guard let type = line.first else { return false }
            guard type == "-" || type == "d" else { return true }
            guard let mode = line.split(whereSeparator: \.isWhitespace).first else { return true }
            return mode.contains { character in
                character == "s" || character == "S" || character == "t" || character == "T"
            }
        }
    }

    static func archiveExceedsSizeLimit(in listing: String) -> Bool {
        var totalBytes: Int64 = 0
        for line in listing.split(whereSeparator: \.isNewline) {
            let fields = line.split(whereSeparator: \.isWhitespace)
            guard fields.count >= 5,
                  let size = Int64(fields[4]),
                  size >= 0 else {
                return true
            }
            let (newTotal, overflow) = totalBytes.addingReportingOverflow(size)
            guard !overflow, newTotal <= Self.maxExtractedPackageBytes else {
                return true
            }
            totalBytes = newTotal
        }
        return false
    }

    static func isPackageFileSizeAcceptable(_ size: Int64?) -> Bool {
        guard let size, size >= 0 else { return false }
        return size <= Self.maxDownloadedPackageBytes
    }

    static func isCanonicalAssetURL(_ url: URL) -> Bool {
        url.absoluteString == Self.canonicalAssetURL.absoluteString
    }

    static func isExpectedAssetURL(_ url: URL, revision: String) -> Bool {
        if isCanonicalAssetURL(url) { return true }
        let value = url.absoluteString
        let legacyPrefix = "\(releaseURLPrefix)build-\(revision)-"
        let legacySuffix = "/Perpetual.Swap.Suite.app.tar"
        let versionedPrefix = "\(releaseURLPrefix)autobuild/Perpetual.Swap.Suite.app.\(revision)."
        let versionedSuffix = ".tar"
        let run: Substring
        if value.hasPrefix(legacyPrefix), value.hasSuffix(legacySuffix) {
            run = value.dropFirst(legacyPrefix.count).dropLast(legacySuffix.count)
        } else if value.hasPrefix(versionedPrefix), value.hasSuffix(versionedSuffix) {
            run = value.dropFirst(versionedPrefix.count).dropLast(versionedSuffix.count)
        } else {
            return false
        }
        return run.range(of: #"^[0-9]+-[0-9]+$"#, options: .regularExpression) != nil
    }

    static func isExpectedExecutable(_ executableURL: URL, in appURL: URL) -> Bool {
        let expectedURL = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(Self.executableName)
        return executableURL.standardizedFileURL.path == expectedURL.standardizedFileURL.path
    }

    static func isExecutableRegularFile(
        atPath path: String,
        fileManager: FileManager = .default
    ) -> Bool {
        guard let attributes = try? fileManager.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular else {
            return false
        }
        return fileManager.isExecutableFile(atPath: path)
    }

    private static func containsSymbolicLink(in directory: URL) -> Bool {
        guard let enumerator = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isSymbolicLinkKey]
        ) else {
            return true
        }
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey]),
                  let isSymbolicLink = values.isSymbolicLink else {
                return true
            }
            if isSymbolicLink {
                return true
            }
        }
        return false
    }

    private static func shouldRetry(error: Error?, statusCode: Int?) -> Bool {
        if let statusCode {
            return statusCode == 408 || statusCode == 425 || statusCode == 429 || (500...599).contains(statusCode)
        }
        guard let error = error as? URLError else { return false }
        switch error.code {
        case .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
             .notConnectedToInternet, .dnsLookupFailed:
            return true
        default:
            return false
        }
    }

    private func retryIfNeeded(
        attempt: Int,
        generation: Int,
        error: Error? = nil,
        statusCode: Int? = nil,
        operation: @escaping @MainActor @Sendable () -> Void
    ) -> Bool {
        guard attempt < Self.maxAttempts, Self.shouldRetry(error: error, statusCode: statusCode) else {
            return false
        }
        let delay = 0.25 * pow(2, Double(attempt - 1))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                guard self.isCurrentOperation(generation) else { return }
                operation()
            }
        }
        return true
    }

    private func currentOperationGeneration() -> Int {
        generationLock.lock()
        defer { generationLock.unlock() }
        return operationGeneration
    }

    private func isCurrentOperation(_ generation: Int) -> Bool {
        currentOperationGeneration() == generation
    }

    private func beginInstallation(for generation: Int) -> Bool {
        generationLock.lock()
        defer { generationLock.unlock() }
        guard operationGeneration == generation else { return false }
        installationInProgress = true
        return true
    }

    private func endInstallation() {
        generationLock.lock()
        installationInProgress = false
        generationLock.unlock()
    }

    private func finish<T: Sendable>(
        _ completion: @escaping @MainActor @Sendable (Result<T, AppUpdateError>) -> Void,
        with result: Result<T, AppUpdateError>,
        generation: Int
    ) {
        Task { @MainActor in
            guard self.isCurrentOperation(generation) else { return }
            self.setTask(nil)
            self.endInstallation()
            completion(result)
        }
    }

    private var hasTask: Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        return !tasks.isEmpty || parallelCoordinator != nil
    }

    private func setTask(_ task: URLSessionTask?) {
        setTasks(task.map { [$0] } ?? [])
    }

    private func setTasks(
        _ tasks: [URLSessionTask],
        coordinator: ParallelDownloadCoordinator? = nil,
        downloadProgress: (@Sendable (URLSessionDownloadTask, Int64, Int64) -> (Int64, Int64)?)? = nil,
        delivery: (@Sendable (Int64, Int64) -> Void)? = nil
    ) {
        taskLock.lock()
        self.tasks = tasks
        parallelCoordinator = coordinator
        self.downloadProgress = downloadProgress
        downloadProgressDelivery = delivery
        reportedDownloadUnit = -1
        if tasks.isEmpty {
            oversizedMetadata = false
            oversizedDownload = false
        }
        taskLock.unlock()
    }

    private func cancelTask() {
        taskLock.lock()
        let tasks = self.tasks
        let coordinator = parallelCoordinator
        self.tasks = []
        parallelCoordinator = nil
        downloadProgress = nil
        downloadProgressDelivery = nil
        oversizedMetadata = false
        oversizedDownload = false
        taskLock.unlock()
        coordinator?.cancel()
        tasks.forEach { $0.cancel() }
    }

    private func cancelNetworkTasksForRetry() {
        taskLock.lock()
        let tasks = self.tasks
        self.tasks = []
        parallelCoordinator = nil
        downloadProgress = nil
        downloadProgressDelivery = nil
        taskLock.unlock()
        tasks.forEach { $0.cancel() }
    }

    private func reportDownloadProgress(_ task: URLSessionDownloadTask, received: Int64, total: Int64) {
        taskLock.lock()
        guard tasks.contains(where: { $0 === task }),
              let aggregate = downloadProgress?(task, received, total) else {
            taskLock.unlock()
            return
        }
        // Update menus once per percentage point (or MiB for unknown lengths),
        // rather than enqueueing a main-actor job for every network chunk.
        let unit = aggregate.1 > 0 ? aggregate.0 * 100 / aggregate.1 : aggregate.0 / (1024 * 1024)
        guard unit != reportedDownloadUnit else {
            taskLock.unlock()
            return
        }
        reportedDownloadUnit = unit
        let report = downloadProgressDelivery
        taskLock.unlock()
        report?(aggregate.0, aggregate.1)
    }

    private func saveResumeData(_ data: Data?, for update: AppUpdate) {
        taskLock.lock()
        resumableDownload = data.map { (update, $0) }
        taskLock.unlock()
    }

    private func resumeData(for update: AppUpdate) -> Data? {
        taskLock.lock()
        defer { taskLock.unlock() }
        guard let saved = resumableDownload,
              saved.update.revision == update.revision,
              saved.update.assetURL == update.assetURL,
              saved.update.expectedSHA256 == update.expectedSHA256 else {
            resumableDownload = nil
            return nil
        }
        return saved.data
    }

    private func cancelOversizedMetadata(_ task: URLSessionDownloadTask) {
        taskLock.lock()
        guard tasks.contains(where: { $0 === task }) else {
            taskLock.unlock()
            return
        }
        oversizedMetadata = true
        taskLock.unlock()
        task.cancel()
    }

    private func cancelOversizedDownload(_ task: URLSessionDownloadTask) {
        taskLock.lock()
        guard tasks.contains(where: { $0 === task }) else {
            taskLock.unlock()
            return
        }
        oversizedDownload = true
        taskLock.unlock()
        task.cancel()
    }

    private func consumeOversizedDownload() -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        let result = oversizedDownload
        oversizedDownload = false
        return result
    }

    private func consumeOversizedMetadata() -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        let result = oversizedMetadata
        oversizedMetadata = false
        return result
    }

    func install(downloadedFile: URL, expectedRevision: String) throws {
        let fileManager = FileManager.default
        let temporaryDirectory = fileManager.temporaryDirectory
            .appendingPathComponent("PerpetualRadar-update-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: temporaryDirectory) }

        let downloadedFileSize = (try? fileManager.attributesOfItem(atPath: downloadedFile.path))?[.size]
            .flatMap { ($0 as? NSNumber)?.int64Value }
        guard Self.isPackageFileSizeAcceptable(downloadedFileSize) else {
            throw AppUpdateError.invalidPackage
        }

        let extractedDirectory = temporaryDirectory.appendingPathComponent("Extracted", isDirectory: true)
        try fileManager.createDirectory(at: extractedDirectory, withIntermediateDirectories: true)
        let listing = try runTar(arguments: ["-tf", downloadedFile.path], capturingOutput: true) ?? ""
        guard let appRoot = Self.archiveAppRoot(from: listing) else {
            throw AppUpdateError.invalidPackage
        }
        let detailedListing = try runTar(arguments: ["-tvf", downloadedFile.path], capturingOutput: true) ?? ""
        guard !Self.archiveContainsUnsafeEntry(in: detailedListing),
              !Self.archiveExceedsSizeLimit(in: detailedListing) else {
            throw AppUpdateError.invalidPackage
        }
        _ = try runTar(arguments: ["-xf", downloadedFile.path, "-C", extractedDirectory.path])

        guard !Self.containsSymbolicLink(in: extractedDirectory) else {
            throw AppUpdateError.invalidPackage
        }
        let extractedApp = extractedDirectory.appendingPathComponent(appRoot, isDirectory: true)
        guard let bundle = Bundle(url: extractedApp),
              bundle.bundleIdentifier == Self.bundleIdentifier,
              bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL",
              let executable = bundle.executableURL,
              Self.isExpectedExecutable(executable, in: extractedApp),
              Self.isExecutableRegularFile(atPath: executable.path, fileManager: fileManager) else {
            throw AppUpdateError.invalidPackage
        }
        if expectedRevision != "unknown" {
            guard Self.revision(
                in: bundle.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String
            ) == expectedRevision else {
                throw AppUpdateError.invalidPackage
            }
        }
        let helperURL = extractedApp.appendingPathComponent("Contents/Library/LoginItems/\(MonitorRuntime.helperName)")
        guard let helper = Bundle(url: helperURL),
              helper.bundleIdentifier == MonitorRuntime.helperIdentifier,
              helper.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String == bundle.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String,
              let helperExecutable = helper.executableURL,
              Self.isExpectedExecutable(helperExecutable, in: helperURL),
              Self.isExecutableRegularFile(atPath: helperExecutable.path, fileManager: fileManager) else {
            throw AppUpdateError.invalidPackage
        }

        let currentApp = currentAppURL
        guard currentApp.pathExtension == "app" else {
            throw AppUpdateError.notPackaged
        }
        let stagedApp = currentApp.deletingLastPathComponent()
            .appendingPathComponent(".PerpetualRadar-update-\(UUID().uuidString).app", isDirectory: true)
        let backupApp = currentApp.deletingLastPathComponent()
            .appendingPathComponent(".PerpetualRadar-backup-\(UUID().uuidString).app", isDirectory: true)
        var backupCreated = false
        do {
            try fileManager.copyItem(at: currentApp, to: backupApp)
            backupCreated = true
            try fileManager.copyItem(at: extractedApp, to: stagedApp)
            
            // Verify Web assets exist in staged app before replacing
            let webAssets = stagedApp.appendingPathComponent("Contents/Resources/Web/index.html")
            guard fileManager.fileExists(atPath: webAssets.path) else {
                throw AppUpdateError.installFailed("Web assets missing from extracted package")
            }
            
            _ = try fileManager.replaceItemAt(
                currentApp,
                withItemAt: stagedApp,
                backupItemName: nil,
                options: []
            )
            
            // Verify Web assets still exist after replacement
            let installedWebAssets = currentApp.appendingPathComponent("Contents/Resources/Web/index.html")
            guard fileManager.fileExists(atPath: installedWebAssets.path) else {
                // Rollback and report specific failure
                throw AppUpdateError.installFailed("Web assets missing after installation - rolling back")
            }
        } catch {
            try? fileManager.removeItem(at: stagedApp)
            if backupCreated, !fileManager.fileExists(atPath: currentApp.path) {
                do {
                    try restoreBackup(at: backupApp, to: currentApp, fileManager: fileManager)
                } catch {
                    throw AppUpdateError.installFailed(
                        "Could not replace the app or restore the backup: \(error.localizedDescription)"
                    )
                }
            } else {
                try? fileManager.removeItem(at: backupApp)
            }
            throw AppUpdateError.installFailed(error.localizedDescription)
        }

        do {
            try relauncher(currentApp, backupApp)
        } catch {
            do {
                try restoreBackup(at: backupApp, to: currentApp, fileManager: fileManager)
            } catch {
                throw AppUpdateError.installFailed(
                    "Could not launch the updated app or restore the backup: \(error.localizedDescription)"
                )
            }
            throw AppUpdateError.installFailed(
                "Could not launch the updated app: \(error.localizedDescription)"
            )
        }
    }

    private func restoreBackup(at backupApp: URL, to currentApp: URL, fileManager: FileManager) throws {
        if fileManager.fileExists(atPath: currentApp.path) {
            _ = try fileManager.replaceItemAt(
                currentApp,
                withItemAt: backupApp,
                backupItemName: nil,
                options: []
            )
        } else {
            try fileManager.moveItem(at: backupApp, to: currentApp)
        }
    }

    private func verifySHA256(of file: URL, expected: String) throws {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        let actual = hasher.finalize()
            .map { String(format: "%02x", $0) }
            .joined()
        guard actual == expected else {
            throw AppUpdateError.invalidPackage
        }
    }

    private func runTar(arguments: [String], capturingOutput: Bool = false) throws -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = arguments
        let outputPipe = capturingOutput ? Pipe() : nil
        if let outputPipe {
            process.standardOutput = outputPipe
        } else {
            process.standardOutput = FileHandle.nullDevice
        }
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw AppUpdateError.invalidPackage
        }
        let outputData: Data?
        if let outputPipe {
            var data = Data()
            while true {
                let chunk = outputPipe.fileHandleForReading.readData(ofLength: 64 * 1024)
                if chunk.isEmpty {
                    break
                }
                guard data.count + chunk.count <= Self.maxTarListingBytes else {
                    process.terminate()
                    process.waitUntilExit()
                    throw AppUpdateError.invalidPackage
                }
                data.append(chunk)
            }
            outputData = data
        } else {
            outputData = nil
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw AppUpdateError.invalidPackage
        }
        guard capturingOutput else { return nil }
        guard let output = String(
            data: outputData ?? Data(),
            encoding: .utf8
        ) else {
            throw AppUpdateError.invalidPackage
        }
        return output
    }

    // Run after the current app exits so Launch Services can reuse its pinned Dock tile.
    // The helper is detached from the updater's lifetime by Process.run().
    static let defaultRelauncherScript = #"""
    ready_dir=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/PerpetualRadar-ready.XXXXXX") || exit 1
    ready_file="$ready_dir/ready"
    pid_file="$ready_dir/pid"
    trap '/bin/rm -rf "$ready_dir"' EXIT
    attempt=0
    while /bin/kill -0 "$2" 2>/dev/null; do
        if [ "$attempt" -ge 300 ]; then exit 1; fi
        attempt=$((attempt + 1))
        /bin/sleep 0.1
    done
    if [ "${PERPETUAL_RADAR_BACKGROUND:-0}" != 1 ] && [ -n "${PERPETUAL_RADAR_SUPPRESS_RELAUNCH_FILE:-}" ] && [ -f "$PERPETUAL_RADAR_SUPPRESS_RELAUNCH_FILE" ]; then
        /bin/rm -rf "$3"
        exit 0
    fi
    opener="${4:-/usr/bin/open}"
    open_app() {
        app_to_open="$1"
        shift
        if [ "${PERPETUAL_RADAR_BACKGROUND:-0}" = 1 ]; then
            monitor_app="$app_to_open/Contents/Library/LoginItems/Perpetual Swap Suite Monitor.app"
            if [ -x "$monitor_app/Contents/MacOS/PerpetualRadar" ]; then
                # An older monitor in another app copy must not absorb this
                # launch and its readiness environment. Helpers have no Dock tile.
                "$opener" -n -g -a "$monitor_app" --env "PERPETUAL_RADAR_BACKGROUND=1" "$@"
                return $?
            fi
            "$opener" -g -a "$app_to_open" --env "PERPETUAL_RADAR_BACKGROUND=1" "$@"
        else
            "$opener" -a "$app_to_open" --env "PERPETUAL_RADAR_BACKGROUND=0" "$@"
        fi
    }
    open_app "$1" --env "PERPETUAL_RADAR_PID_FILE=$pid_file" --env "PERPETUAL_RADAR_READY_FILE=$ready_file"
    launched=$?
    new_pid=
    attempt=0
    if [ "$launched" -eq 0 ]; then
        while [ "$attempt" -lt 100 ]; do
            if [ -z "$new_pid" ] && [ -s "$pid_file" ]; then
                new_pid=$(/bin/cat "$pid_file")
            fi
            if [ -f "$ready_file" ]; then
                /bin/sleep 0.2
                if [ -n "$new_pid" ] && /bin/kill -0 "$new_pid" 2>/dev/null; then
                    /bin/rm -rf "$3"
                    exit 0
                fi
                break
            fi
            if [ -n "$new_pid" ] && ! /bin/kill -0 "$new_pid" 2>/dev/null; then
                break
            fi
            attempt=$((attempt + 1))
            /bin/sleep 0.1
        done
    fi
    if [ -n "$new_pid" ]; then /bin/kill "$new_pid" 2>/dev/null || true; fi
    if [ -d "$3" ]; then
        failed_app="$1.failed-$$"
        if [ -e "$1" ]; then /bin/mv "$1" "$failed_app" || exit 1; fi
        if ! /bin/mv "$3" "$1"; then
            if [ -e "$failed_app" ]; then /bin/mv "$failed_app" "$1"; fi
            exit 1
        fi
        if [ -e "$failed_app" ]; then /bin/rm -rf "$failed_app"; fi
        open_app "$1" --env "PERPETUAL_RADAR_UPDATE_ROLLBACK=1" || true
    fi
    exit 1
    """#

    private static let defaultRelauncher: Relauncher = { appURL, backupURL in
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            defaultRelauncherScript,
            "Perpetual Swap Suite updater",
            appURL.path,
            String(ProcessInfo.processInfo.processIdentifier),
            backupURL.path,
            "/usr/bin/open"
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["PERPETUAL_RADAR_SUPPRESS_RELAUNCH_FILE"] = MonitorRuntime.updateSuppressionURL.path
        environment["PERPETUAL_RADAR_BACKGROUND"] = MonitorRuntime.defaults.bool(forKey: backgroundRelaunchKey) ? "1" : "0"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw AppUpdateError.installFailed(
                "Could not launch the updated app: \(error.localizedDescription)"
            )
        }
    }
}
