import Foundation
import ZIPFoundation

// Handles RFC 4180 quoting, BOMs, CRLF, and boundaries inside a UTF-8 character.
// No archive or CSV is materialized as a single in-memory string.
final class ResearchCSV {
    private var field: [UInt8] = [], row: [String] = []
    private var quoted = false, quotePending = false, afterCR = false
    private let consume: ([String]) throws -> Void
    init(consume: @escaping ([String]) throws -> Void) { self.consume = consume }
    private func endField() { row.append(String(decoding: field, as: UTF8.self)); field.removeAll(keepingCapacity: true) }
    private func endRow() throws {
        endField()
        if row.contains(where: { !$0.isEmpty }) { try consume(row) }
        row.removeAll(keepingCapacity: true)
    }
    func feed(_ bytes: Data) throws {
        for byte in bytes {
            guard field.count < 8 * 1024 * 1024 else { throw ResearchArchiveError("An archive row exceeds the streaming parser budget.") }
            if afterCR { afterCR = false; if byte == 10 { continue } }
            if quotePending {
                quotePending = false
                if byte == 34 { field.append(byte); continue }
                quoted = false
            }
            if quoted {
                if byte == 34 { quotePending = true } else { field.append(byte) }
            } else if byte == 34 && field.isEmpty { quoted = true }
            else if byte == 44 { endField() }
            else if byte == 10 || byte == 13 { try endRow(); afterCR = byte == 13 }
            else { field.append(byte) }
        }
    }
    func finish() throws {
        guard !quoted || quotePending else { throw ResearchArchiveError("The CSV archive ends inside a quoted field.") }
        if !field.isEmpty || !row.isEmpty { try endRow() }
    }
}

struct ResearchHourAggregate {
    var hour: Int64
    var first: Int64 = .max, last: Int64 = .min
    var open = 0.0, close = 0.0, high = 0.0, low = Double.infinity
    var base = 0.0, quote = 0.0, buy = 0.0, sell = 0.0
    var baseComplete = true, quoteComplete = true
    var minutes = Set<Int>()
    mutating func add(timestamp: Int64, open: Double, high: Double, low: Double, close: Double, base: Double?, quote: Double?) {
        if timestamp < first { first = timestamp; self.open = open }
        if timestamp >= last { last = timestamp; self.close = close }
        self.high = max(self.high, high); self.low = min(self.low, low)
        if let base { self.base += base } else { baseComplete = false }
        if let quote { self.quote += quote } else { quoteComplete = false }
        minutes.insert(Int((timestamp - hour) / 60_000))
    }
    var candle: Candle { Candle(hour: hour, high: high, low: low, close: close, quoteVolume: quoteComplete ? quote : nil, baseVolume: baseComplete ? base : nil, open: open) }
}

final class ResearchBook {
    private var bids: [String: String] = [:], asks: [String: String] = [:]
    private(set) var valid = false
    private(set) var timestamp: Int64 = 0
    private var sequence: Int64?
    func apply(_ message: [String: Any]) {
        guard let ts = Self.integer(message["ts"]), ts >= timestamp else { valid = false; return }
        if message["action"] as? String == "snapshot" { bids.removeAll(); asks.removeAll(); valid = true; sequence = nil }
        if let previous = Self.integer(message["prevSeqId"]), let sequence, previous != sequence { valid = false }
        guard valid else { timestamp = ts; return }
        func update(_ rows: Any?, _ levels: inout [String: String]) {
            guard let rows = rows as? [[Any]] else { valid = false; return }
            for row in rows {
                guard row.count >= 2 else { valid = false; return }
                let price = Self.string(row[0]), size = Self.string(row[1])
                guard let p = Double(price), let n = Double(size), p.isFinite, n.isFinite, p > 0, n >= 0 else { valid = false; return }
                if n == 0 { levels.removeValue(forKey: price) } else { levels[price] = size }
            }
        }
        update(message["bids"], &bids); update(message["asks"], &asks)
        timestamp = ts; sequence = Self.integer(message["seqId"])
        if let checksum = Self.integer(message["checksum"]), valid {
            let b = bids.keys.sorted { Double($0)! > Double($1)! }.prefix(25), a = asks.keys.sorted { Double($0)! < Double($1)! }.prefix(25)
            var parts: [String] = [], bi = Array(b), ai = Array(a)
            for index in 0..<max(bi.count, ai.count) {
                if index < bi.count { parts += [bi[index], bids[bi[index]]!] }
                if index < ai.count { parts += [ai[index], asks[ai[index]]!] }
            }
            var crc: UInt32 = .max
            for byte in parts.joined(separator: ":").utf8 {
                crc ^= UInt32(byte)
                for _ in 0..<8 { crc = crc & 1 == 1 ? (crc >> 1) ^ 0xedb88320 : crc >> 1 }
            }
            if Int64(Int32(bitPattern: ~crc)) != checksum { valid = false }
        }
    }
    var spread: Double? {
        guard valid, let bid = bids.keys.compactMap(Double.init).max(), let ask = asks.keys.compactMap(Double.init).min(), ask >= bid else { return nil }
        return (ask - bid) / (bid + (ask - bid) / 2) * 100
    }
    static func string(_ x: Any) -> String { x as? String ?? String(describing: x) }
    static func integer(_ x: Any?) -> Int64? { (x as? String).flatMap(Int64.init) ?? (x as? NSNumber)?.int64Value }
}

final class ResearchArchiveImporter {
    private let store: ResearchStore
    private let source: ResearchSource
    private let instruments: [String: ResearchInstrument]
    private var headers: [String: Int] = [:]
    private var aggregate: [String: ResearchHourAggregate] = [:]
    private var flushed = Set<String>()
    private var books: [String: ResearchBook] = [:]
    private var bookHours: [String: Int64] = [:]
    private var batch: [ResearchDatum] = []
    private(set) var rows = 0
    private var rejected = 0
    private var unconfirmed = 0
    private var encountered = Set<String>()
    private var missingBase = 0, missingQuote = 0, convertedBase = 0
    var warnings: [String] {
        var result: [String] = []
        if unconfirmed > 0 { result.append("\(source.filename): \(unconfirmed) unconfirmed minute candles were excluded; missing hours are checked against confirmed OKX history automatically.") }
        if convertedBase > 0 { result.append("\(source.filename): base-currency volume for \(convertedBase) minute candles was converted from contract volume using verified contract metadata.") }
        if missingBase > 0 { result.append("\(source.filename): base-currency volume is missing for \(missingBase) minute candles; affected volume-dependent inputs remain Unknown.") }
        if missingQuote > 0 { result.append("\(source.filename): quote-currency volume is missing for \(missingQuote) minute candles; affected VWAP and quote-volume inputs remain Unknown. OHLC prices were imported.") }
        return result
    }
    init(store: ResearchStore, source: ResearchSource, instruments: [ResearchInstrument]) {
        self.store = store; self.source = source; self.instruments = Dictionary(instruments.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }
    private func append(_ value: ResearchDatum) throws {
        batch.append(value)
        if batch.count >= 256 { try ResearchPressure.shared.check(); try store.write(batch); batch.removeAll(keepingCapacity: true) }
    }
    private func header(_ s: String) -> String { s.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") } }
    private func cell(_ row: [String], _ names: String...) -> String? {
        for name in names { if let index = headers[name], index < row.count { return row[index] } }
        return nil
    }
    private func number(_ row: [String], _ names: String...) -> Double? {
        for name in names { if let index = headers[name], index < row.count, let n = Double(row[index]), n.isFinite { return n } }; return nil
    }
    private func volume(_ row: [String], _ names: String...) throws -> Double? {
        for name in names {
            guard let index = headers[name], index < row.count else { continue }
            let text = row[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if ["", "none", "null"].contains(text.lowercased()) { continue }
            guard let value = Double(text), value.isFinite, value >= 0 else { throw ResearchArchiveError("Invalid archive volume in \(name): \(text.prefix(80)). The raw file was retained.") }
            return value
        }
        return nil
    }
    private func finishAggregate(_ id: String) throws {
        guard let value = aggregate.removeValue(forKey: id) else { return }
        let key = "\(id):\(value.hour)"
        guard !flushed.contains(key) else { throw ResearchArchiveError("Archive hours are not ordered; incomplete aggregation was rejected.") }
        flushed.insert(key)
        if source.module == 2 {
            if value.minutes.count == 60 {
                try append(.init(instrument: id, kind: "candle", timestamp: value.hour, candle: value.candle, sources: [source.id]))
            }
        } else {
            try append(.init(instrument: id, kind: "stat", timestamp: value.hour, stat: FilterStat(oi: nil, sell: value.sell, buy: value.buy), sources: [source.id]))
            if instruments[id]?.contractValue != nil, try store.latest(id, kind: "candle", timestamp: value.hour) == nil {
                try append(.init(instrument: id, kind: "candle", timestamp: value.hour, candle: value.candle, sources: [source.id]))
            }
        }
    }
    private func csv(_ row: [String]) throws {
        if headers.isEmpty { for (index, name) in row.enumerated() { headers[header(name)] = index }; return }
        // The streaming consumer checks each 64 KiB chunk, and each persisted
        // batch checks again. Avoid a shared pressure lock for every CSV row.
        if [4, 5, 6].contains(source.module ?? 0) { try bookCSV(row); return }
        let id = cell(row, "instrument_name", "instid", "instrument", "symbol") ?? source.instrument
        guard id.hasSuffix("-USDT-SWAP") else { return }
        encountered.insert(id)
        if source.instrument != "ANY", id != source.instrument { return }
        let time = cell(row, "open_time", "created_time", "funding_time", "ts", "timestamp").flatMap(Int64.init)
        guard let ts = time, ts > 0 else { rejected += 1; return }
        rows += 1
        if source.module == 3 {
            guard let rate = number(row, "funding_rate", "realizedrate") else { rejected += 1; return }
            try append(.init(instrument: id, kind: "funding", timestamp: ts, rate: rate, sources: [source.id])); return
        }
        let hour = ts / hourMS * hourMS
        if aggregate[id]?.hour != hour { try finishAggregate(id); aggregate[id] = ResearchHourAggregate(hour: hour) }
        if source.module == 2 {
            if cell(row, "confirm") == "0" { unconfirmed += 1; return }
            guard let open = number(row, "open", "o"), let high = number(row, "high", "h"), let low = number(row, "low", "l"), let close = number(row, "close", "c"),
                  low > 0, high >= low, (low...high).contains(open), (low...high).contains(close), ts % 60_000 == 0 else { rejected += 1; return }
            var base = try volume(row, "vol_ccy", "volccy")
            let quote = try volume(row, "vol_quote", "volccyquote")
            if base == nil, let metadata = instruments[id], metadata.verified,
               let contractValue = metadata.contractValue, contractValue.isFinite, contractValue > 0,
               let contracts = try volume(row, "vol", "volume"), (contracts * contractValue).isFinite {
                base = contracts * contractValue; convertedBase += 1
            }
            if base == nil { missingBase += 1 }; if quote == nil { missingQuote += 1 }
            guard !aggregate[id]!.minutes.contains(Int((ts - hour) / 60_000)) else { throw ResearchArchiveError("Duplicate minute candle in archive.") }
            aggregate[id]!.add(timestamp: ts, open: open, high: high, low: low, close: close, base: base, quote: quote)
        } else {
            guard let price = number(row, "price", "px"), let size = number(row, "size", "sz"), let side = cell(row, "side"), ["buy", "sell"].contains(side), price > 0, size >= 0 else { rejected += 1; return }
            let base = size * (instruments[id]?.contractValue ?? 0)
            aggregate[id]!.add(timestamp: ts, open: price, high: price, low: price, close: price, base: base, quote: base * price)
            // Archive trade sizes are contracts. Keep taker data in the same
            // base-currency unit as REST unit=0 and candle volCcy.
            if side == "buy" { aggregate[id]!.buy += base } else { aggregate[id]!.sell += base }
        }
    }
    private func bookCSV(_ row: [String]) throws {
        if let record = cell(row, "data", "message", "json"), record.hasPrefix("{") {
            try jsonLine(Data(record.utf8)); return
        }
        guard let bids = cell(row, "bids"), let asks = cell(row, "asks"), let time = cell(row, "ts", "timestamp", "created_time"),
              let action = cell(row, "action", "type"), ["snapshot", "update"].contains(action.lowercased()) else { throw ResearchArchiveError("Order book CSV requires a timestamp, action and bid/ask levels. Its raw file was retained.") }
        var message: [String: Any] = ["instId": cell(row, "instid", "instrument_name") ?? source.instrument, "ts": time, "action": action.lowercased(), "bids": try JSONSerialization.jsonObject(with: Data(bids.utf8)), "asks": try JSONSerialization.jsonObject(with: Data(asks.utf8))]
        for key in ["seqid", "prevseqid", "checksum"] { if let value = cell(row, key) { message[key == "seqid" ? "seqId" : key == "prevseqid" ? "prevSeqId" : "checksum"] = value } }
        try jsonLine(SafeJSON.data(message))
    }
    private func jsonLine(_ line: Data) throws {
        guard !line.isEmpty else { return }
        guard let body = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw ResearchArchiveError("Invalid order book record.") }
        let messages = body["data"] as? [[String: Any]] ?? [body]
        for var message in messages {
            let id = message["instId"] as? String ?? (body["arg"] as? [String: Any])?["instId"] as? String ?? source.instrument
            guard id == source.instrument || source.instrument == "ANY" else { continue }
            message["action"] = message["action"] ?? body["action"]
            guard let ts = ResearchBook.integer(message["ts"]) else { throw ResearchArchiveError("Order book timestamp is missing.") }
            let book = books[id] ?? ResearchBook(); books[id] = book
            let hour = ts / hourMS * hourMS
            if let previous = bookHours[id], hour > previous {
                // Sample the previous hour BEFORE consuming the next hour's update.
                if book.timestamp >= previous, let spread = book.spread {
                    try append(.init(instrument: id, kind: "quote", timestamp: previous, quote: FilterQuote(turnover: nil, spread: spread, timestamp: book.timestamp), sources: [source.id]))
                }
            }
            bookHours[id] = hour; book.apply(message); rows += 1
        }
    }
    func run(file: URL) throws -> [String] {
        var files = 0, parser: ResearchCSV?, pending = Data(), supported = false, isJSON = false
        func begin(_ name: String) {
            let name = name.lowercased()
            supported = [".csv", ".json", ".jsonl", ".txt", ".data"].contains { name.hasSuffix($0) }
            guard supported else { return }
            files += 1; headers.removeAll(); pending.removeAll()
            isJSON = [4, 5, 6].contains(source.module ?? 0) && !name.hasSuffix(".csv")
            parser = isJSON ? nil : ResearchCSV { try self.csv($0) }
        }
        func consume(_ data: Data) throws {
            guard supported else { return }
            try ResearchPressure.shared.check()
            if !isJSON { try parser?.feed(data); return }
            pending.append(data)
            while let newline = pending.firstIndex(of: 10) {
                let line = Data(pending[..<newline]); pending.removeSubrange(...newline); try jsonLine(line)
            }
            guard pending.count < 8*1024*1024 else { throw ResearchArchiveError("Order book record exceeds the streaming budget.") }
        }
        func finish() throws {
            guard supported else { return }
            if isJSON { if !pending.isEmpty { try jsonLine(pending); pending.removeAll() } }
            else { try parser?.finish(); for id in Array(aggregate.keys) { try finishAggregate(id) } }
        }
        if source.filename.hasSuffix(".tar.gz") {
            let tar = ResearchTar(begin: begin, consume: consume, finish: finish)
            try ResearchTar.readGzip(file) { try tar.feed($0) }; try tar.complete()
        } else {
            do {
                let archive = try Archive(url: file, accessMode: .read)
                for entry in archive where entry.type == .file {
                    begin(entry.path)
                    let checksum = try archive.extract(entry, bufferSize: 64*1024, consumer: consume)
                    guard checksum == entry.checksum else { throw ResearchArchiveError("ZIP archive failed its CRC check. The raw file was retained.") }
                    try finish()
                }
            } catch let error as Archive.ArchiveError {
                throw ResearchArchiveError("ZIP archive validation failed: \(error). The raw file was retained.")
            }
        }
        if [4, 5, 6].contains(source.module ?? 0), rows == 0 { throw ResearchArchiveError("The order book archive contains no valid snapshot/update records. Its format and coverage were not accepted.") }
        guard files > 0 else { throw ResearchArchiveError("Archive contains no supported market data files.") }
        guard rejected == 0 else { throw ResearchArchiveError("\(rejected) invalid archive records; the raw file was retained, and archive coverage was not accepted.") }
        for (id, book) in books {
            if let hour = bookHours[id], book.timestamp >= hour, book.timestamp < hour + hourMS, let spread = book.spread {
                try append(.init(instrument: id, kind: "quote", timestamp: hour, quote: FilterQuote(turnover: nil, spread: spread, timestamp: book.timestamp), sources: [source.id]))
            }
        }
        try store.write(batch)
        return encountered.sorted()
    }
}
