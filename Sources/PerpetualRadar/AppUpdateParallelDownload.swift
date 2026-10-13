import Foundation

enum ParallelDownloadError: Error {
    case unsupportedRanges
    case invalidSegment
}

final class ParallelDownloadCoordinator: @unchecked Sendable {
    struct Segment {
        let index: Int
        let start: Int64
        let end: Int64
        var length: Int64 { end - start + 1 }
    }

    enum Completion {
        case waiting
        case success(URL)
        case failure(Error)
    }

    private let lock = NSLock()
    private let totalBytes: Int64
    private let segments: [Segment]
    private let directory: URL
    private var taskIndexes: [Int: Int] = [:]
    private var receivedByIndex: [Int: Int64] = [:]
    private var completeIndexes = Set<Int>()
    private var finished = false

    init(update: AppUpdate, totalBytes: Int64, lanes: Int = 4) throws {
        self.totalBytes = totalBytes
        let count = max(1, min(lanes, Int(totalBytes)))
        let width = (totalBytes + Int64(count) - 1) / Int64(count)
        segments = (0..<count).compactMap { index in
            let start = Int64(index) * width
            guard start < totalBytes else { return nil }
            return Segment(index: index, start: start, end: min(totalBytes - 1, start + width - 1))
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let root = caches.appendingPathComponent("PerpetualRadar/Updates", isDirectory: true)
        let cacheName = "\(update.revision)-\(update.expectedSHA256)"
        directory = root.appendingPathComponent(cacheName, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let staleBefore = Date().addingTimeInterval(-7 * 24 * 60 * 60)
        for stale in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            where stale.lastPathComponent != cacheName {
            let modified = (try? FileManager.default.attributesOfItem(atPath: stale.path)[.modificationDate]) as? Date
            if modified.map({ $0 < staleBefore }) ?? false { try? FileManager.default.removeItem(at: stale) }
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for segment in segments {
            let url = partURL(segment.index)
            let size = Self.fileSize(url)
            if size == segment.length {
                completeIndexes.insert(segment.index)
                receivedByIndex[segment.index] = segment.length
            } else if size != nil {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    var missingSegments: [Segment] {
        lock.lock(); defer { lock.unlock() }
        return segments.filter { !completeIndexes.contains($0.index) }
    }

    var cachedBytes: Int64 {
        lock.lock(); defer { lock.unlock() }
        return receivedByIndex.values.reduce(0, +)
    }

    func register(_ task: URLSessionDownloadTask, for index: Int) {
        lock.lock(); taskIndexes[task.taskIdentifier] = index; lock.unlock()
    }

    func progress(for task: URLSessionDownloadTask, received: Int64) -> (Int64, Int64)? {
        lock.lock(); defer { lock.unlock() }
        guard !finished, let index = taskIndexes[task.taskIdentifier],
              let segment = segments.first(where: { $0.index == index }) else { return nil }
        receivedByIndex[index] = min(max(0, received), segment.length)
        return (receivedByIndex.values.reduce(0, +), totalBytes)
    }

    func complete(index: Int, location: URL?, response: URLResponse?, error: Error?) -> Completion {
        lock.lock()
        guard !finished, let segment = segments.first(where: { $0.index == index }) else {
            lock.unlock(); return .waiting
        }
        if let error {
            finished = true; lock.unlock(); return .failure(error)
        }
        guard let response = response as? HTTPURLResponse,
              response.statusCode == 206,
              Self.validContentRange(response.value(forHTTPHeaderField: "Content-Range"), segment: segment, total: totalBytes),
              let location,
              Self.fileSize(location) == segment.length else {
            finished = true; lock.unlock(); return .failure(ParallelDownloadError.unsupportedRanges)
        }
        let destination = partURL(index)
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            finished = true; lock.unlock(); return .failure(error)
        }
        completeIndexes.insert(index)
        receivedByIndex[index] = segment.length
        guard completeIndexes.count == segments.count else { lock.unlock(); return .waiting }
        finished = true
        lock.unlock()
        do { return .success(try assemble()) }
        catch { return .failure(error) }
    }

    func completeFromCache() -> Completion {
        lock.lock()
        guard !finished, completeIndexes.count == segments.count else { lock.unlock(); return .waiting }
        finished = true; lock.unlock()
        do { return .success(try assemble()) }
        catch { return .failure(error) }
    }

    func cancel() {
        lock.lock(); finished = true; lock.unlock()
    }

    func removeCache() { try? FileManager.default.removeItem(at: directory) }

    private func partURL(_ index: Int) -> URL {
        directory.appendingPathComponent("part-\(index)")
    }

    private func assemble() throws -> URL {
        let output = directory.appendingPathComponent("assembled.tar")
        try? FileManager.default.removeItem(at: output)
        FileManager.default.createFile(atPath: output.path, contents: nil)
        let writer = try FileHandle(forWritingTo: output)
        defer { try? writer.close() }
        for segment in segments.sorted(by: { $0.index < $1.index }) {
            let reader = try FileHandle(forReadingFrom: partURL(segment.index))
            while true {
                let data = try reader.read(upToCount: 1024 * 1024) ?? Data()
                if data.isEmpty { break }
                try writer.write(contentsOf: data)
            }
            try reader.close()
        }
        guard Self.fileSize(output) == totalBytes else { throw ParallelDownloadError.invalidSegment }
        return output
    }

    private static func fileSize(_ url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
    }

    private static func validContentRange(_ value: String?, segment: Segment, total: Int64) -> Bool {
        value?.lowercased() == "bytes \(segment.start)-\(segment.end)/\(total)"
    }
}
