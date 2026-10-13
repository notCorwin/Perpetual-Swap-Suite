import Foundation
import CSQLite

final class Store {
    private static let busyTimeoutMilliseconds: Int32 = 5_000
    private static let schemaVersion: Int64 = 1
    private var db: OpaquePointer?
    private var reusableStatements: [String: OpaquePointer] = [:]
    let url: URL

    init(url: URL) throws {
        self.url = url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        do {
            guard sqlite3_open(url.path, &db) == SQLITE_OK else { throw failure() }
            // Radar and both history loaders use independent actor-owned connections.
            // WAL lets readers proceed during writes; competing writers wait briefly.
            guard sqlite3_busy_timeout(db, Self.busyTimeoutMilliseconds) == SQLITE_OK else { throw failure() }
            try enableWriteAheadLogging()
            // Opening a current database is read-only. History readers must not
            // queue behind the writer merely to repeat already completed DDL.
            if try version() < Self.schemaVersion { try transaction {
                // A concurrent connection may have migrated while we waited.
                guard try version() < Self.schemaVersion else { return }
                try execute("CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                try execute("CREATE TABLE IF NOT EXISTS candles (inst_id TEXT, hour INTEGER, high REAL, low REAL, close REAL, volume REAL, base_volume REAL, open REAL, PRIMARY KEY(inst_id,hour))")
                try execute("CREATE TABLE IF NOT EXISTS ema200 (inst_id TEXT PRIMARY KEY, hour INTEGER, value REAL)")
                try execute("CREATE TABLE IF NOT EXISTS chart_stats (inst_id TEXT, hour INTEGER, oi REAL, sell REAL, buy REAL, PRIMARY KEY(inst_id,hour))")
                try execute("CREATE INDEX IF NOT EXISTS candles_hour ON candles(hour)")
                try execute("CREATE INDEX IF NOT EXISTS chart_stats_hour ON chart_stats(hour)")
                // Existing Python caches may predate base_volume.
                if try !columns("candles").contains("base_volume") { try execute("ALTER TABLE candles ADD COLUMN base_volume REAL") }
                if try !columns("candles").contains("open") { try execute("ALTER TABLE candles ADD COLUMN open REAL") }
                try execute("CREATE TABLE IF NOT EXISTS hourly_quotes (inst_id TEXT, hour INTEGER, turnover REAL, spread REAL, quote_timestamp INTEGER NOT NULL, PRIMARY KEY(inst_id,hour))")
                try execute("PRAGMA user_version=\(Self.schemaVersion)")
            } }
        } catch {
            sqlite3_close(db)
            db = nil
            throw error
        }
    }

    deinit {
        for statement in reusableStatements.values { sqlite3_finalize(statement) }
        sqlite3_close(db)
    }

    private func failure() -> NSError {
        NSError(domain: "SQLite", code: Int(sqlite3_errcode(db)), userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
    }

    private func statement(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw failure() }
        return stmt
    }

    private func readRows(_ stmt: OpaquePointer, _ read: () -> Void) throws {
        var status = sqlite3_step(stmt)
        while status == SQLITE_ROW {
            read()
            status = sqlite3_step(stmt)
        }
        guard status == SQLITE_DONE else { throw failure() }
    }

    private func enableWriteAheadLogging() throws {
        // Journal-mode upgrades can bypass SQLite's busy handler. Retry after
        // finalizing the statement to release our own read lock between attempts.
        // Use one deadline rather than restarting a full busy timeout on each try.
        guard sqlite3_busy_timeout(db, 0) == SQLITE_OK else { throw failure() }
        defer { sqlite3_busy_timeout(db, Self.busyTimeoutMilliseconds) }
        let deadline = ProcessInfo.processInfo.systemUptime + Double(Self.busyTimeoutMilliseconds) / 1_000
        while true {
            do {
                let current = try statement("PRAGMA journal_mode")
                var mode = ""
                do {
                    defer { sqlite3_finalize(current) }
                    try readRows(current) { mode = Store.text(current, 0) }
                }
                if mode == "wal" { return }
                let stmt = try statement("PRAGMA journal_mode=WAL")
                defer { sqlite3_finalize(stmt) }
                try readRows(stmt) { mode = Store.text(stmt, 0) }
                guard mode == "wal" else {
                    throw NSError(domain: "SQLite", code: Int(SQLITE_ERROR),
                                  userInfo: [NSLocalizedDescriptionKey: "Cannot enable SQLite write-ahead logging."])
                }
                return
            } catch let error as NSError where error.domain == "SQLite" && error.code == Int(SQLITE_BUSY) {
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { throw error }
                Thread.sleep(forTimeInterval: min(0.01, remaining))
            }
        }
    }

    private func version() throws -> Int64 {
        let stmt = try statement("PRAGMA user_version")
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw failure() }
        return sqlite3_column_int64(stmt, 0)
    }

    private func bind(_ values: [Any?], to stmt: OpaquePointer) {
        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case let text as String: sqlite3_bind_text(stmt, position, text, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let integer as Int64: sqlite3_bind_int64(stmt, position, integer)
            case let flag as Bool: sqlite3_bind_int64(stmt, position, flag ? 1 : 0)
            case let integer as Int: sqlite3_bind_int64(stmt, position, Int64(integer))
            case let integer as Int32: sqlite3_bind_int64(stmt, position, Int64(integer))
            case let double as Double: sqlite3_bind_double(stmt, position, double)
            default: sqlite3_bind_null(stmt, position)
            }
        }
    }

    func execute(_ sql: String, _ values: [Any?] = []) throws {
        try reuse(sql) { stmt in
            bind(values, to: stmt)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure() }
        }
    }

    func query(_ sql: String, _ values: [Any?] = [], read: (OpaquePointer) -> Void) throws {
        try reuse(sql) { stmt in
            bind(values, to: stmt)
            try readRows(stmt) { read(stmt) }
        }
    }

    private func reuse<T>(_ sql: String, _ action: (OpaquePointer) throws -> T) throws -> T {
        // Lease the statement out of the cache: nested queries may use the same
        // SQL while a surrounding query is still reading its rows.
        let stmt = try reusableStatements.removeValue(forKey: sql) ?? statement(sql)
        defer {
            sqlite3_reset(stmt); sqlite3_clear_bindings(stmt)
            if reusableStatements[sql] == nil, reusableStatements.count < 128 { reusableStatements[sql] = stmt }
            else { sqlite3_finalize(stmt) }
        }
        return try action(stmt)
    }

    private func columns(_ table: String) throws -> Set<String> {
        let stmt = try statement("PRAGMA table_info(\(table))")
        defer { sqlite3_finalize(stmt) }
        var names = Set<String>()
        try readRows(stmt) { names.insert(Store.text(stmt, 1)) }
        return names
    }

    /// NULL-safe text column read; `String(cString:)` on a NULL column pointer traps.
    static func text(_ stmt: OpaquePointer, _ column: Int32) -> String {
        sqlite3_column_text(stmt, column).map { String(cString: $0) } ?? ""
    }

    func preference(forKey key: String) throws -> String? {
        let stmt = try statement("SELECT value FROM preferences WHERE key=?")
        defer { sqlite3_finalize(stmt) }
        bind([key], to: stmt)
        switch sqlite3_step(stmt) {
        case SQLITE_ROW: return sqlite3_column_text(stmt, 0).map { String(cString: $0) }
        case SQLITE_DONE: return nil
        default: throw failure()
        }
    }

    func dataVersion() throws -> Int64 {
        let stmt = try statement("PRAGMA data_version"); defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw failure() }
        return sqlite3_column_int64(stmt, 0)
    }

    // Rows changed by this connection; data_version only reports other connections.
    var totalChanges: Int64 { sqlite3_total_changes64(db) }

    func setPreference(_ value: String, forKey key: String) throws {
        try execute("INSERT INTO preferences (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value])
    }

    func transaction<T>(_ action: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try action()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    func saveHourlyQuote(_ id: String, hour: Int64, quote: FilterQuote) throws {
        guard quote.timestamp >= hour, quote.timestamp < hour + hourMS else { return }
        try execute("INSERT INTO hourly_quotes (inst_id,hour,turnover,spread,quote_timestamp) VALUES (?,?,?,?,?) ON CONFLICT(inst_id,hour) DO NOTHING", [id, hour, quote.turnover, quote.spread, quote.timestamp])
    }

    func hourlyQuotes(_ id: String, since: Int64, through: Int64) throws -> [Int64: FilterQuote] {
        let stmt = try statement("SELECT hour,turnover,spread,quote_timestamp FROM hourly_quotes WHERE inst_id=? AND hour>=? AND hour<=?")
        defer { sqlite3_finalize(stmt) }; bind([id, since, through], to: stmt)
        var result: [Int64: FilterQuote] = [:]
        try readRows(stmt) {
            result[sqlite3_column_int64(stmt, 0)] = FilterQuote(turnover: sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 1),
                spread: sqlite3_column_type(stmt, 2) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 2), timestamp: sqlite3_column_int64(stmt, 3))
        }
        return result
    }

    func load(hour: Int64, ids: Set<String>) throws -> (candles: [String: [Int64: Candle]], ema: [String: (Int64, Double)]) {
        var candles: [String: [Int64: Candle]] = [:], ema: [String: (Int64, Double)] = [:]
        let candleStmt = try statement("SELECT inst_id,hour,high,low,close,volume,base_volume,open FROM candles WHERE hour >= ? AND hour < ?")
        defer { sqlite3_finalize(candleStmt) }
        bind([hour - Int64(candleLookback) * hourMS, hour], to: candleStmt)
        try readRows(candleStmt) {
            let id = Store.text(candleStmt, 0)
            guard ids.contains(id) else { return }
            let ts = sqlite3_column_int64(candleStmt, 1)
            candles[id, default: [:]][ts] = Candle(hour: ts, high: sqlite3_column_double(candleStmt, 2), low: sqlite3_column_double(candleStmt, 3), close: sqlite3_column_double(candleStmt, 4), quoteVolume: sqlite3_column_type(candleStmt, 5) == SQLITE_NULL ? nil : sqlite3_column_double(candleStmt, 5), baseVolume: sqlite3_column_type(candleStmt, 6) == SQLITE_NULL ? nil : sqlite3_column_double(candleStmt, 6), open: sqlite3_column_type(candleStmt, 7) == SQLITE_NULL ? nil : sqlite3_column_double(candleStmt, 7))
        }
        let emaStmt = try statement("SELECT inst_id,hour,value FROM ema200")
        defer { sqlite3_finalize(emaStmt) }
        try readRows(emaStmt) {
            let id = Store.text(emaStmt, 0)
            if ids.contains(id) { ema[id] = (sqlite3_column_int64(emaStmt, 1), sqlite3_column_double(emaStmt, 2)) }
        }
        return (candles, ema)
    }

    func save(_ id: String, _ bar: Candle) throws {
        guard bar.confirmed else { return }
        try execute("INSERT INTO candles (inst_id,hour,high,low,close,volume,base_volume,open) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(inst_id,hour) DO UPDATE SET base_volume=COALESCE(excluded.base_volume,candles.base_volume),open=COALESCE(excluded.open,candles.open)", [id, bar.hour, bar.high, bar.low, bar.close, bar.quoteVolume, bar.baseVolume, bar.open])
    }

    func saveCandles(_ id: String, _ bars: [Candle]) throws {
        guard !bars.isEmpty else { return }
        try transaction {
            for bar in bars { try save(id, bar) }
        }
    }

    func candles(_ id: String, since: Int64, through: Int64) throws -> [Int64: Candle] {
        let stmt = try statement("SELECT hour,high,low,close,volume,base_volume,open FROM candles WHERE inst_id=? AND hour>=? AND hour<=? ORDER BY hour")
        defer { sqlite3_finalize(stmt) }
        bind([id, since, through], to: stmt)
        var result: [Int64: Candle] = [:]
        try readRows(stmt) {
            let ts = sqlite3_column_int64(stmt, 0)
            result[ts] = Candle(hour: ts, high: sqlite3_column_double(stmt, 1), low: sqlite3_column_double(stmt, 2), close: sqlite3_column_double(stmt, 3), quoteVolume: sqlite3_column_type(stmt, 4) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 4), baseVolume: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 5), open: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 6))
        }
        return result
    }

    func oldestCandleHour(_ id: String) throws -> Int64? {
        let stmt = try statement("SELECT MIN(hour) FROM candles WHERE inst_id=? AND open IS NOT NULL")
        defer { sqlite3_finalize(stmt) }
        bind([id], to: stmt)
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw failure() }
        return sqlite3_column_type(stmt, 0) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, 0)
    }

    func saveChartStat(_ id: String, hour: Int64, oi: Double? = nil, sell: Double? = nil, buy: Double? = nil) throws {
        try execute("INSERT INTO chart_stats (inst_id,hour,oi,sell,buy) VALUES (?,?,?,?,?) ON CONFLICT(inst_id,hour) DO UPDATE SET oi=COALESCE(excluded.oi,chart_stats.oi),sell=COALESCE(excluded.sell,chart_stats.sell),buy=COALESCE(excluded.buy,chart_stats.buy)", [id, hour, oi, sell, buy])
    }

    func openInterest(hour: Int64) throws -> [String: Double] {
        let stmt = try statement("SELECT inst_id,oi FROM chart_stats WHERE hour=? AND oi IS NOT NULL")
        defer { sqlite3_finalize(stmt) }
        bind([hour], to: stmt)
        var result: [String: Double] = [:]
        try readRows(stmt) {
            result[Store.text(stmt, 0)] = sqlite3_column_double(stmt, 1)
        }
        return result
    }

    func chartStats(_ id: String, since: Int64, through: Int64 = .max) throws -> [Int64: (oi: Double?, sell: Double?, buy: Double?)] {
        let stmt = try statement("SELECT hour,oi,sell,buy FROM chart_stats WHERE inst_id=? AND hour>=? AND hour<=?")
        defer { sqlite3_finalize(stmt) }
        bind([id, since, through], to: stmt)
        var result: [Int64: (oi: Double?, sell: Double?, buy: Double?)] = [:]
        try readRows(stmt) {
            result[sqlite3_column_int64(stmt, 0)] = (
                sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 1),
                sqlite3_column_type(stmt, 2) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 2),
                sqlite3_column_type(stmt, 3) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 3))
        }
        return result
    }
}
