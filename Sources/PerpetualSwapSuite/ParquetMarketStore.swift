import DuckDB
import Foundation

actor ParquetMarketStore {
    struct ValidationReport: Codable, Sendable {
        let checkedFiles: Int
        let invalidFiles: [String]
        let duplicateCandles: Int
        let checkedAt: Int64
    }

    private let paths: AppPaths
    private let database: Database
    private let connection: Connection
    private let calendar = Calendar(identifier: .gregorian)

    init(paths: AppPaths) throws {
        self.paths = paths
        database = try Database(store: .file(at: paths.catalog))
        connection = try database.connect()
        try Self.execute(connection, """
            CREATE TABLE IF NOT EXISTS data_files (
                path VARCHAR PRIMARY KEY,
                instrument VARCHAR NOT NULL,
                timeframe VARCHAR NOT NULL,
                first_ts BIGINT,
                last_ts BIGINT,
                row_count BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                instrument VARCHAR NOT NULL,
                dataset VARCHAR NOT NULL,
                cursor BIGINT,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (instrument, dataset)
            );
            CREATE TABLE IF NOT EXISTS validation_runs (
                checked_at BIGINT NOT NULL,
                checked_files INTEGER NOT NULL,
                invalid_files INTEGER NOT NULL,
                duplicate_candles BIGINT NOT NULL
            );
            """)
    }

    func upsert(candles: [Candle]) throws {
        let confirmed = candles.filter(\.confirmed)
        guard !confirmed.isEmpty else { return }
        let grouped = Dictionary(grouping: confirmed) { partitionKey(for: $0) }
        for (key, values) in grouped { try rewritePartition(key: key, adding: values) }
    }

    func candles(
        instrument: String,
        timeframe: Timeframe = .fiveMinutes,
        from: Int64? = nil,
        through: Int64? = nil,
        limit: Int? = nil
    ) throws -> [Candle] {
        let files = try registeredFiles(instrument: instrument)
        guard !files.isEmpty else { return [] }
        let sources = files.map { "'\(Self.sqlLiteral($0))'" }.joined(separator: ",")
        var predicates = ["instrument = '\(Self.sqlLiteral(instrument))'"]
        if let from { predicates.append("ts >= \(from)") }
        if let through { predicates.append("ts <= \(through)") }
        let raw = """
            SELECT instrument, ts, open, high, low, close, volume_contracts, volume_base, volume_quote, confirmed
            FROM read_parquet([\(sources)], union_by_name = true)
            WHERE \(predicates.joined(separator: " AND "))
            """
        var sql: String
        if timeframe == .fiveMinutes {
            sql = "\(raw) ORDER BY ts"
        } else {
            let duration = timeframe.milliseconds
            sql = """
                SELECT instrument,
                    (floor(ts::DOUBLE / \(duration))::BIGINT * \(duration)) AS ts,
                    arg_min(open, ts) AS open, max(high) AS high, min(low) AS low, arg_max(close, ts) AS close,
                    sum(volume_contracts) AS volume_contracts, sum(volume_base) AS volume_base,
                    sum(volume_quote) AS volume_quote, bool_and(confirmed) AS confirmed
                FROM (\(raw)) source
                GROUP BY instrument, floor(ts::DOUBLE / \(duration))::BIGINT
                HAVING count(*) = \(timeframe.sourceBarCount)
                ORDER BY ts
                """
        }
        if let limit {
            sql = "SELECT * FROM (\(sql)) ordered ORDER BY ts DESC LIMIT \(max(1, limit))"
            sql = "SELECT * FROM (\(sql)) limited ORDER BY ts"
        }
        return try decodeCandles(connection.query(sql))
    }

    func coverage(instrument: String) throws -> DataCoverage {
        let values = try candles(instrument: instrument)
        guard let first = values.first, let last = values.last else {
            return .init(instrument: instrument, from: nil, through: nil, candleCount: 0, gaps: 0)
        }
        var gaps = 0
        for pair in zip(values, values.dropFirst()) where pair.1.timestamp - pair.0.timestamp != Timeframe.fiveMinutes.milliseconds {
            gaps += 1
        }
        return .init(instrument: instrument, from: first.timestamp, through: last.timestamp, candleCount: values.count, gaps: gaps)
    }

    func queryJSON(_ sql: String) throws -> [[String: AnyCodable]] {
        let trimmed = sql.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = trimmed.prefix(16).lowercased()
        guard prefix.hasPrefix("select") || prefix.hasPrefix("with") || prefix.hasPrefix("explain") else {
            throw StoreError.readOnlyQueryRequired
        }
        let result = try connection.query("SELECT to_json(row_value) FROM (SELECT t AS row_value FROM (\(trimmed)) t)")
        guard result.columnCount == 1 else { return [] }
        let values = result[0].cast(to: String.self)
        return try (0..<result.rowCount).compactMap { index in
            guard let text = values[index], let data = text.data(using: .utf8) else { return nil }
            return try JSONDecoder().decode([String: AnyCodable].self, from: data)
        }
    }

    func validate() throws -> ValidationReport {
        let result = try connection.query("SELECT path FROM data_files ORDER BY path")
        let pathsColumn = result[0].cast(to: String.self)
        var invalid = [String]()
        var duplicates = 0
        for index in 0..<result.rowCount {
            guard let path = pathsColumn[index] else { continue }
            guard FileManager.default.fileExists(atPath: path) else { invalid.append(path); continue }
            do {
                let check = try connection.query("""
                    SELECT count(*) - count(DISTINCT instrument || ':' || ts::VARCHAR)
                    FROM read_parquet('\(Self.sqlLiteral(path))')
                    """)
                duplicates += Int(check[0].cast(to: Int64.self)[0] ?? 0)
            } catch { invalid.append(path) }
        }
        let report = ValidationReport(
            checkedFiles: Int(result.rowCount), invalidFiles: invalid,
            duplicateCandles: duplicates, checkedAt: unixMilliseconds()
        )
        try Self.execute(connection, "INSERT INTO validation_runs VALUES (\(report.checkedAt), \(report.checkedFiles), \(report.invalidFiles.count), \(report.duplicateCandles))")
        return report
    }

    private struct PartitionKey: Hashable {
        let instrument: String
        let year: Int
        let month: Int
    }

    private func partitionKey(for candle: Candle) -> PartitionKey {
        let date = Date(timeIntervalSince1970: TimeInterval(candle.timestamp) / 1_000)
        let components = calendar.dateComponents(in: TimeZone(secondsFromGMT: 0)!, from: date)
        return .init(instrument: candle.instrument, year: components.year!, month: components.month!)
    }

    private func rewritePartition(key: PartitionKey, adding candles: [Candle]) throws {
        let directory = paths.candles
            .appendingPathComponent("timeframe=5m", isDirectory: true)
            .appendingPathComponent("instrument=\(key.instrument)", isDirectory: true)
            .appendingPathComponent(String(format: "year=%04d", key.year), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent(String(format: "month=%02d.parquet", key.month))
        let temporary = directory.appendingPathComponent(".\(UUID().uuidString).parquet")
        let table = "incoming_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer { try? Self.execute(connection, "DROP TABLE IF EXISTS \(table)"); try? FileManager.default.removeItem(at: temporary) }
        try Self.execute(connection, """
            CREATE TEMP TABLE \(table) (
                instrument VARCHAR, ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
                volume_contracts DOUBLE, volume_base DOUBLE, volume_quote DOUBLE, confirmed BOOLEAN
            )
            """)
        let statement = try PreparedStatement(connection: connection, query: "INSERT INTO \(table) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        for candle in candles {
            try statement.bind(candle.instrument, at: 1)
            try statement.bind(candle.timestamp, at: 2)
            try statement.bind(candle.open, at: 3)
            try statement.bind(candle.high, at: 4)
            try statement.bind(candle.low, at: 5)
            try statement.bind(candle.close, at: 6)
            try statement.bind(candle.volumeContracts, at: 7)
            try statement.bind(candle.volumeBase, at: 8)
            try statement.bind(candle.volumeQuote, at: 9)
            try statement.bind(candle.confirmed, at: 10)
            _ = try statement.execute()
        }
        let existing = FileManager.default.fileExists(atPath: target.path)
            ? "SELECT instrument, ts, open, high, low, close, volume_contracts, volume_base, volume_quote, confirmed FROM read_parquet('\(Self.sqlLiteral(target.path))', hive_partitioning = false) UNION ALL"
            : ""
        try Self.execute(connection, """
            COPY (
                SELECT instrument, ts, open, high, low, close, volume_contracts, volume_base, volume_quote, confirmed
                FROM (\(existing) SELECT * FROM \(table)) combined
                QUALIFY row_number() OVER (PARTITION BY instrument, ts ORDER BY confirmed DESC) = 1
                ORDER BY ts
            ) TO '\(Self.sqlLiteral(temporary.path))' (FORMAT PARQUET, COMPRESSION ZSTD)
            """)
        if FileManager.default.fileExists(atPath: target.path) {
            _ = try FileManager.default.replaceItemAt(target, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: target)
        }
        let stats = try connection.query("SELECT min(ts), max(ts), count(*) FROM read_parquet('\(Self.sqlLiteral(target.path))', hive_partitioning = false)")
        let first = stats[0].cast(to: Int64.self)[0] ?? 0
        let last = stats[1].cast(to: Int64.self)[0] ?? 0
        let count = stats[2].cast(to: Int64.self)[0] ?? 0
        try Self.execute(connection, """
            INSERT OR REPLACE INTO data_files VALUES (
                '\(Self.sqlLiteral(target.path))', '\(Self.sqlLiteral(key.instrument))', '5m',
                \(first), \(last), \(count), \(unixMilliseconds())
            )
            """)
    }

    private func registeredFiles(instrument: String) throws -> [String] {
        let result = try connection.query("SELECT path FROM data_files WHERE instrument = '\(Self.sqlLiteral(instrument))' AND timeframe = '5m' ORDER BY first_ts")
        let column = result[0].cast(to: String.self)
        return (0..<result.rowCount).compactMap { column[$0] }.filter { FileManager.default.fileExists(atPath: $0) }
    }

    private func decodeCandles(_ result: ResultSet) throws -> [Candle] {
        let instrument = result[0].cast(to: String.self)
        let timestamp = result[1].cast(to: Int64.self)
        let open = result[2].cast(to: Double.self)
        let high = result[3].cast(to: Double.self)
        let low = result[4].cast(to: Double.self)
        let close = result[5].cast(to: Double.self)
        let contracts = result[6].cast(to: Double.self)
        let base = result[7].cast(to: Double.self)
        let quote = result[8].cast(to: Double.self)
        let confirmed = result[9].cast(to: Bool.self)
        return (0..<result.rowCount).compactMap { index in
            guard let instrument = instrument[index], let timestamp = timestamp[index], let open = open[index],
                  let high = high[index], let low = low[index], let close = close[index], let contracts = contracts[index]
            else { return nil }
            return Candle(
                instrument: instrument, timestamp: timestamp, open: open, high: high, low: low, close: close,
                volumeContracts: contracts, volumeBase: base[index], volumeQuote: quote[index], confirmed: confirmed[index] ?? true
            )
        }
    }

    private static func sqlLiteral(_ value: String) -> String { value.replacingOccurrences(of: "'", with: "''") }
    private static func execute(_ connection: Connection, _ sql: String) throws { _ = try connection.query(sql) }
}

enum StoreError: LocalizedError {
    case readOnlyQueryRequired

    var errorDescription: String? {
        switch self {
        case .readOnlyQueryRequired: "Strategy queries must be read-only SELECT, WITH, or EXPLAIN statements."
        }
    }
}

struct AnyCodable: Codable, Sendable, Equatable {
    let value: Value

    enum Value: Codable, Sendable, Equatable {
        case null
        case bool(Bool)
        case int(Int64)
        case double(Double)
        case string(String)
        case array([AnyCodable])
        case object([String: AnyCodable])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() { self = .null }
            else if let value = try? container.decode(Bool.self) { self = .bool(value) }
            else if let value = try? container.decode(Int64.self) { self = .int(value) }
            else if let value = try? container.decode(Double.self) { self = .double(value) }
            else if let value = try? container.decode(String.self) { self = .string(value) }
            else if let value = try? container.decode([AnyCodable].self) { self = .array(value) }
            else { self = .object(try container.decode([String: AnyCodable].self)) }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .null: try container.encodeNil()
            case .bool(let value): try container.encode(value)
            case .int(let value): try container.encode(value)
            case .double(let value): try container.encode(value)
            case .string(let value): try container.encode(value)
            case .array(let value): try container.encode(value)
            case .object(let value): try container.encode(value)
            }
        }
    }

    init(from decoder: Decoder) throws { value = try Value(from: decoder) }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
