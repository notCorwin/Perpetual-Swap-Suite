import Foundation

private final class ResearchTransferCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var waiter: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation in
            let ready = lock.withLock {
                if finished { return true }
                waiter = continuation; return false
            }
            if ready { continuation.resume() }
        }
    }
    func finish() {
        let continuation = lock.withLock { finished = true; let value = waiter; waiter = nil; return value }
        continuation?.resume()
    }
}

// URLSession delivers native data buffers on a private serial delegate queue.
// Writing those buffers directly avoids an async iteration for every byte and
// keeps each transfer's disk work independent of the other parser workers.
private final class ResearchArchiveDownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let updates: AsyncThrowingStream<ResearchDownloadProgress, Error>
    private let continuation: AsyncThrowingStream<ResearchDownloadProgress, Error>.Continuation
    private let destination: URL, part: URL, validatorURL: URL
    private let existing: Int64, validator: String?
    private var handle: FileHandle?
    private(set) var response: HTTPURLResponse?
    private var failure: Error?
    private var responseOnly = false
    private var received: Int64 = 0, offset: Int64 = 0, total: Int64?
    private let started = ContinuousClock.now
    private var reported = ContinuousClock.now
    private let completion = ResearchTransferCompletion()
    func waitForCompletion() async { await completion.wait() }

    init(destination: URL, existing: Int64, validator: String?) {
        self.destination = destination; self.existing = existing; self.validator = validator
        part = destination.appendingPathExtension("part"); validatorURL = part.appendingPathExtension("validator")
        (updates, continuation) = AsyncThrowingStream.makeStream(bufferingPolicy: .bufferingNewest(1))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        do {
            guard let response = response as? HTTPURLResponse else { throw FilterError("Archive download returned an invalid response.") }
            self.response = response
            if ResearchRecovery.isRecoverable(ResearchHTTPError(status: response.statusCode, path: response.url?.path ?? "")) { responseOnly = true; completionHandler(.cancel); return }
            if response.statusCode == 416, existing > 0, validator != nil,
               response.value(forHTTPHeaderField: "Content-Range") == "bytes */\(existing)",
               (response.value(forHTTPHeaderField: "ETag") ?? response.value(forHTTPHeaderField: "Last-Modified")).map({ $0 == validator }) != false {
                try promote(); received = existing; total = existing
                responseOnly = true; emit(); completionHandler(.cancel); return
            }
            guard [200, 206].contains(response.statusCode) else { throw ResearchHTTPError(status: response.statusCode, path: response.url?.path ?? "") }
            let declaredLength = response.value(forHTTPHeaderField: "Content-Length").flatMap(Int64.init)
            total = declaredLength ?? (response.expectedContentLength > 0 ? response.expectedContentLength : nil)
            if response.statusCode == 206 {
                guard existing > 0, let range = response.value(forHTTPHeaderField: "Content-Range")?.firstMatch(of: /^bytes ([0-9]+)-([0-9]+)\/([0-9]+|\*)$/),
                      Int64(range.1) == existing, let end = Int64(range.2), end >= existing else { throw FilterError("Invalid archive continuation response.") }
                offset = existing; total = Int64(range.3) ?? declaredLength.map { $0 + existing }
            }
            if let available = try destination.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
               response.expectedContentLength > 0, available < response.expectedContentLength + 64 * 1024 * 1024 {
                throw FilterError("Not enough disk space for this archive. Free disk space, then resume.")
            }
            if offset == 0 { FileManager.default.createFile(atPath: part.path, contents: nil) }
            let handle = try FileHandle(forWritingTo: part); self.handle = handle
            if offset == 0 { try handle.truncate(atOffset: 0) } else { try handle.seekToEnd() }
            if let value = response.value(forHTTPHeaderField: "ETag") ?? response.value(forHTTPHeaderField: "Last-Modified") {
                try value.write(to: validatorURL, atomically: true, encoding: .utf8)
            }
            received = offset; emit(); completionHandler(.allow)
        } catch { failure = error; completionHandler(.cancel) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        do {
            try ResearchPressure.shared.check()
            try handle?.write(contentsOf: data)
            received += Int64(data.count)
            if reported.duration(to: .now) >= .milliseconds(250) { emit(); reported = .now }
        } catch { failure = error; dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { try? handle?.close(); handle = nil; completion.finish() }
        do {
            if let failure { throw failure }
            if responseOnly { continuation.finish(); return }
            if let error { try? handle?.synchronize(); throw error }
            guard let handle, response != nil else { throw FilterError("Archive download ended without a response.") }
            try handle.synchronize()
            if let total {
                let actual = try handle.seekToEnd()
                guard total >= 0, actual == UInt64(total) else { throw URLError(.networkConnectionLost, userInfo: [NSLocalizedDescriptionKey: "Archive transfer was incomplete: received \(actual) of \(total) bytes."]) }
            }
            try handle.close(); self.handle = nil
            try promote(); total = total ?? received
            emit(); continuation.finish()
        } catch { continuation.finish(throwing: error) }
    }

    private func promote() throws {
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        try FileManager.default.moveItem(at: part, to: destination)
        try? FileManager.default.removeItem(at: validatorURL)
    }
    private func emit() {
        let elapsed = researchSeconds(started.duration(to: .now))
        continuation.yield(.init(receivedBytes: received, totalBytes: total, bytesPerSecond: received > offset ? Double(received - offset) / max(elapsed, 0.001) : nil))
    }
}

enum ResearchArchiveDownload {
    static func transfer(_ url: URL, to destination: URL, configuration: URLSessionConfiguration, progress: @escaping @Sendable (ResearchDownloadProgress) async -> Void) async throws -> HTTPURLResponse {
        try Task.checkCancellation()
        let part = destination.appendingPathExtension("part")
        let existing = (try? part.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        let validator = try? String(contentsOf: part.appendingPathExtension("validator"), encoding: .utf8)
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if existing > 0, let validator { request.setValue("bytes=\(existing)-", forHTTPHeaderField: "Range"); request.setValue(validator, forHTTPHeaderField: "If-Range") }
        let delegate = ResearchArchiveDownloadDelegate(destination: destination, existing: existing, validator: validator)
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; queue.qualityOfService = .userInitiated
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: request)
        return try await withTaskCancellationHandler {
            task.resume()
            do {
                for try await update in delegate.updates { try Task.checkCancellation(); await progress(update) }
            } catch {
                task.cancel()
                await delegate.waitForCompletion()
                throw error
            }
            // Cancellation of an AsyncStream can end iteration before the
            // delegate closes its file. Drain it before reading/resuming .part.
            await delegate.waitForCompletion()
            try Task.checkCancellation()
            guard let response = delegate.response else { throw FilterError("Archive download returned no HTTP response.") }
            return response
        } onCancel: { task.cancel() }
    }
}
