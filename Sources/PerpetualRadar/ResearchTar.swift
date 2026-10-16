import Foundation
import CZlib

// Reads compressed TAR members into the parser directly. No extracted file or
// uncompressed archive is placed on disk or retained in memory.
final class ResearchTar {
    private var pending = Data()
    private var remaining: Int64 = 0
    private var padding = 0
    private var name: String?
    private var ended = false
    private let begin: (String) throws -> Void
    private let consume: (Data) throws -> Void
    private let finish: () throws -> Void
    init(begin: @escaping (String) throws -> Void, consume: @escaping (Data) throws -> Void, finish: @escaping () throws -> Void) {
        self.begin = begin; self.consume = consume; self.finish = finish
    }
    func feed(_ data: Data) throws {
        pending.append(data)
        while !pending.isEmpty && !ended {
            try ResearchPressure.shared.check()
            if remaining > 0 {
                let count = min(pending.count, Int(min(remaining, Int64(Int.max))))
                if name != nil { try consume(Data(pending.prefix(count))) }
                pending.removeFirst(count); remaining -= Int64(count)
                if remaining == 0, name != nil { try finish(); name = nil }
            } else if padding > 0 {
                let count = min(padding, pending.count); pending.removeFirst(count); padding -= count
            } else {
                guard pending.count >= 512 else { break }
                let header = Array(pending.prefix(512)); pending.removeFirst(512)
                if header.allSatisfy({ $0 == 0 }) { ended = true; pending.removeAll(); break }
                func text(_ from: Int, _ through: Int) -> String { String(decoding: header[from..<through].prefix { $0 != 0 }, as: UTF8.self).trimmingCharacters(in: .whitespaces) }
                let checksum = header.enumerated().reduce(0) { $0 + ((148..<156).contains($1.offset) ? 32 : Int($1.element)) }
                let size: Int64?
                if header[124] & 0x80 != 0 {
                    // GNU/base-256 sizes are used for members larger than 8 GiB.
                    var value: UInt64 = UInt64(header[124] & 0x7f), overflow = header[124] & 0x40 != 0
                    for byte in header[125..<136] {
                        let multiplied = value.multipliedReportingOverflow(by: 256)
                        let added = multiplied.partialValue.addingReportingOverflow(UInt64(byte))
                        overflow = overflow || multiplied.overflow || added.overflow; value = added.partialValue
                    }
                    size = !overflow && value <= UInt64(Int64.max) ? Int64(value) : nil
                } else { size = Int64(text(124,136), radix: 8) }
                guard Int(text(148,156), radix: 8) == checksum, let size, size >= 0 else { throw ResearchArchiveError("Invalid TAR member header or checksum.") }
                remaining = size; padding = Int((512 - size % 512) % 512)
                if header[156] == 48 || header[156] == 0 {
                    let prefix = text(345,500), filename = (prefix.isEmpty ? "" : prefix+"/") + text(0,100)
                    name = filename; try begin(filename)
                    if size == 0 { try finish(); name = nil }
                }
            }
        }
        if ended { pending.removeAll() }
    }
    func complete() throws { guard ended, remaining == 0 else { throw ResearchArchiveError("The TAR archive is truncated.") } }
    static func readGzip(_ file: URL, consume: (Data) throws -> Void) throws {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var stream = z_stream()
        guard inflateInit2_(&stream, 32+MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw ResearchArchiveError("Cannot initialize the archive decompressor.") }
        defer { inflateEnd(&stream) }
        let output = UnsafeMutablePointer<UInt8>.allocate(capacity: 64*1024); defer { output.deallocate() }
        var ended = false
        while let bytes = try handle.read(upToCount: 64*1024), !bytes.isEmpty {
            try ResearchPressure.shared.check()
            try bytes.withUnsafeBytes { input in
                stream.next_in = UnsafeMutablePointer(mutating: input.baseAddress!.assumingMemoryBound(to: UInt8.self)); stream.avail_in = uInt(input.count)
                repeat {
                    stream.next_out = output; stream.avail_out = 64*1024
                    let code = inflate(&stream, Z_NO_FLUSH), count = 64*1024-Int(stream.avail_out)
                    if code == Z_BUF_ERROR && stream.avail_in == 0 && count == 0 { break }
                    guard code == Z_OK || code == Z_STREAM_END else { throw ResearchArchiveError("Gzip archive failed its stream or CRC check.") }
                    if count > 0 { try consume(Data(bytes: output, count: count)) }
                    if code == Z_STREAM_END { ended = true; break }
                } while stream.avail_in > 0 || stream.avail_out == 0
            }
            if ended { break }
        }
        guard ended else { throw ResearchArchiveError("The Gzip archive is truncated. Its partial file was retained.") }
    }
}
