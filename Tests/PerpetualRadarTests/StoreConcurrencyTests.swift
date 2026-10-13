import XCTest
import CSQLite
@testable import PerpetualRadar

final class StoreConcurrencyTests: XCTestCase, @unchecked Sendable {
    private let id = "BTC-USDT-SWAP"

    private func withDatabase(_ body: (URL) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("StoreConcurrency-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try await body(directory.appendingPathComponent("radar.sqlite3"))
    }

    private func bar(_ hour: Int64) -> Candle {
        Candle(hour: hour, high: 110, low: 90, close: 100, quoteVolume: 200, baseVolume: 2, open: 99)
    }

    private func withRawConnection<T>(_ url: URL, _ body: (OpaquePointer) throws -> T) throws -> T {
        var connection: OpaquePointer?
        let status = sqlite3_open(url.path, &connection)
        let db = try XCTUnwrap(connection)
        defer { sqlite3_close(db) }
        XCTAssertEqual(status, SQLITE_OK)
        return try body(db)
    }

    private func execute(_ sql: String, on db: OpaquePointer) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw NSError(domain: "SQLite", code: Int(sqlite3_errcode(db)),
                          userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
        }
    }

    func testReadersKeepTheirSnapshotWhileAnotherConnectionCommits() async throws {
        try await withDatabase { url in
            let reader = try Store(url: url)
            let writer = try Store(url: url)
            try writer.save(id, bar(0))
            try reader.execute("BEGIN")
            defer { try? reader.execute("ROLLBACK") }
            XCTAssertEqual(try reader.candles(id, since: 0, through: hourMS).count, 1)

            // The active reader must not block this commit, even with no waiting.
            try withRawConnection(url) { db in
                try execute("BEGIN IMMEDIATE", on: db)
                try execute("INSERT INTO candles (inst_id,hour,high,low,close,volume,base_volume,open) VALUES ('\(id)',\(hourMS),110,90,100,200,2,99)", on: db)
                try execute("COMMIT", on: db)
            }
            XCTAssertEqual(try reader.candles(id, since: 0, through: hourMS).count, 1)
            XCTAssertEqual(try writer.candles(id, since: 0, through: hourMS).count, 2)
            try reader.execute("COMMIT")
            XCTAssertEqual(try reader.candles(id, since: 0, through: hourMS).count, 2)
        }
    }

    func testWritesWaitForAnotherConnectionToFinishWithoutLosingData() async throws {
        try await withDatabase { url in
            let store = try Store(url: url)
            let locked = DispatchSemaphore(value: 0)
            let holder = Task.detached {
                let other = try Store(url: url)
                try other.transaction {
                    try other.setPreference("first", forKey: "writer")
                    locked.signal()
                    Thread.sleep(forTimeInterval: 0.2)
                }
            }
            defer { holder.cancel() }
            XCTAssertEqual(locked.wait(timeout: .now() + 5), .success)
            do {
                try store.transaction {
                    try store.save(id, bar(0))
                    try store.saveChartStat(id, hour: 0, oi: 1_000, sell: 20, buy: 30)
                    try store.setPreference("second", forKey: "writer")
                }
            } catch {
                try await holder.value
                throw error
            }
            try await holder.value
            XCTAssertEqual(try store.preference(forKey: "writer"), "second")
            XCTAssertEqual(try store.candles(id, since: 0, through: 0)[0]?.open, 99)
            XCTAssertEqual(try store.chartStats(id, since: 0)[0]?.oi, 1_000)
            XCTAssertEqual(try store.chartStats(id, since: 0)[0]?.buy, 30)
        }
    }

    func testOpeningCurrentSchemaDoesNotWaitForAnActiveWriter() async throws {
        try await withDatabase { url in
            let store = try Store(url: url)
            let locked = DispatchSemaphore(value: 0)
            let holder = Task.detached {
                let other = try Store(url: url)
                try other.transaction {
                    try other.setPreference("saved", forKey: "startup")
                    locked.signal()
                    Thread.sleep(forTimeInterval: 0.2)
                }
            }
            defer { holder.cancel() }
            XCTAssertEqual(locked.wait(timeout: .now() + 5), .success)
            do {
                let start = ContinuousClock.now
                let reopened = try Store(url: url)
                XCTAssertLessThan(start.duration(to: .now), .milliseconds(150), "Opening a reader must not acquire a write lock.")
                XCTAssertNil(try reopened.preference(forKey: "startup"), "The reader sees the last committed snapshot.")
                try await holder.value
                XCTAssertEqual(try reopened.preference(forKey: "startup"), "saved")
            } catch {
                try await holder.value
                throw error
            }
            XCTAssertEqual(try store.preference(forKey: "startup"), "saved")
        }
    }

    @MainActor
    func testRadarAndResearchReopenWhileTheirBackgroundWritersAreBusy() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ReadOnlyOpen-\(UUID())")
        let suite = "ReadOnlyOpen.\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let radarURL = directory.appendingPathComponent("radar.sqlite3"), researchDirectory = directory.appendingPathComponent("Research")
        do {
            let radar = try Radar(defaults: defaults, storeURL: radarURL)
            XCTAssertTrue(try radar.setFrostedBackground(enabled: true, opacity: 0.45))
            let research = try ResearchStore(directory: researchDirectory)
            try research.put("sentinel", kind: "test", ["value": "retained"])
        }
        let locked = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let holder = Task.detached {
            let radarWriter = try Store(url: radarURL), researchWriter = try ResearchStore(directory: researchDirectory)
            try radarWriter.transaction { try researchWriter.database.transaction {
                try radarWriter.setPreference("0.8", forKey: "frostedBackgroundOpacity")
                locked.signal()
                _ = release.wait(timeout: .now() + 10)
            } }
        }
        defer { release.signal(); holder.cancel() }
        XCTAssertEqual(locked.wait(timeout: .now() + 5), .success)
        let start = ContinuousClock.now
        let radar = try Radar(defaults: defaults, storeURL: radarURL)
        let research = try ResearchController(directory: researchDirectory)
        let inventory = try await research.handle(["action": "inventory"])
        XCTAssertNotNil(inventory["studies"])
        XCTAssertEqual(radar.frostedBackgroundOpacity, 0.45)
        XCTAssertLessThan(start.duration(to: .now), .milliseconds(500), "Existing settings and research should open without blocking behind workers.")
        release.signal(); try await holder.value
        XCTAssertEqual(try Radar(defaults: defaults, storeURL: radarURL).frostedBackgroundOpacity, 0.8)
        XCTAssertEqual(try ResearchStore(directory: researchDirectory).get("sentinel", as: [String: String].self)?["value"], "retained")
    }

    func testLegacySchemaMigratesAtomicallyAcrossConcurrentConnections() async throws {
        try await withDatabase { url in
            try withRawConnection(url) { db in
                try execute("CREATE TABLE candles (inst_id TEXT, hour INTEGER, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY(inst_id,hour)); INSERT INTO candles VALUES ('\(id)',0,110,90,100,200)", on: db)
            }
            // WAL conversion must tolerate concurrent startup. Each connection
            // rechecks legacy columns after acquiring its write lock.
            try await withThrowingTaskGroup(of: Void.self) { group in
                for index in 0..<3 {
                    group.addTask {
                        let store = try Store(url: url)
                        try store.setPreference(String(index), forKey: "connection-\(index)")
                    }
                }
                try await group.waitForAll()
            }
            let store = try Store(url: url)
            XCTAssertEqual(try store.candles(id, since: 0, through: 0)[0]?.close, 100)
            try store.save(id, bar(0))
            XCTAssertEqual(try store.candles(id, since: 0, through: 0)[0]?.open, 99)
            for index in 0..<3 {
                XCTAssertEqual(try store.preference(forKey: "connection-\(index)"), String(index))
            }
        }
    }

    func testWALUpgradeWaitsForLegacyReadersToReleaseTheirLocks() async throws {
        try await withDatabase { url in
            try withRawConnection(url) { db in
                try execute("CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO preferences VALUES ('legacy','preserved')", on: db)
            }
            let locked = DispatchSemaphore(value: 0)
            let holder = Task.detached {
                try self.withRawConnection(url) { db in
                    try self.execute("BEGIN", on: db)
                    try self.execute("SELECT value FROM preferences", on: db)
                    locked.signal()
                    Thread.sleep(forTimeInterval: 0.2)
                    try self.execute("COMMIT", on: db)
                }
            }
            defer { holder.cancel() }
            XCTAssertEqual(locked.wait(timeout: .now() + 5), .success)
            do {
                let store = try Store(url: url)
                try await holder.value
                XCTAssertEqual(try store.preference(forKey: "legacy"), "preserved")
                try store.setPreference("saved", forKey: "upgraded")
            } catch {
                try await holder.value
                throw error
            }
            XCTAssertEqual(try Store(url: url).preference(forKey: "upgraded"), "saved")
        }
    }

    func testConcurrentCollectorsPersistEveryBatchAndStatistic() async throws {
        try await withDatabase { url in
            try await withThrowingTaskGroup(of: Void.self) { group in
                for collector in 0..<3 {
                    group.addTask {
                        let store = try Store(url: url)
                        let id = "collector-\(collector)"
                        for page in 0..<4 {
                            let bars = (0..<100).map { index in
                                Candle(hour: Int64(page * 100 + index) * hourMS, high: 110, low: 90,
                                       close: 100, quoteVolume: 200, baseVolume: 2, open: 99)
                            }
                            try store.saveCandles(id, bars)
                            try store.saveChartStat(id, hour: Int64(page) * hourMS, oi: Double(collector + page))
                            XCTAssertEqual(try store.candles(id, since: 0, through: 399 * hourMS).count, (page + 1) * 100)
                        }
                    }
                }
                try await group.waitForAll()
            }
            let reopened = try Store(url: url)
            for collector in 0..<3 {
                let id = "collector-\(collector)"
                XCTAssertEqual(try reopened.candles(id, since: 0, through: 399 * hourMS).count, 400)
                XCTAssertEqual(try reopened.chartStats(id, since: 0).count, 4)
            }
        }
    }

    func testHistoryQueriesPropagateFailuresInsteadOfReturningEmptyData() async throws {
        try await withDatabase { url in
            let store = try Store(url: url)
            try store.save(id, bar(0))
            try store.saveChartStat(id, hour: 0, oi: 1_000)
            try store.saveHourlyQuote(id, hour: 0, quote: FilterQuote(turnover: 200, spread: 0.1, timestamp: 1))
            // SQLite reports integer overflow only when stepping these views.
            // Preparing the query succeeds, so every result loop must check errors.
            try store.execute("ALTER TABLE candles RENAME TO stored_candles")
            try store.execute("CREATE VIEW candles AS SELECT inst_id,abs(-9223372036854775808) AS hour,high,low,close,volume,base_volume,open FROM stored_candles")
            try store.execute("ALTER TABLE chart_stats RENAME TO stored_stats")
            try store.execute("CREATE VIEW chart_stats AS SELECT inst_id,abs(-9223372036854775808) AS hour,oi,oi_usd,sell,buy FROM stored_stats")
            try store.execute("ALTER TABLE hourly_quotes RENAME TO stored_quotes")
            try store.execute("CREATE VIEW hourly_quotes AS SELECT inst_id,abs(-9223372036854775808) AS hour,turnover,spread,quote_timestamp FROM stored_quotes")
            XCTAssertThrowsError(try store.load(hour: hourMS, ids: [id]))
            XCTAssertThrowsError(try store.chartStats(id, since: 0))
            XCTAssertThrowsError(try store.hourlyQuotes(id, since: 0, through: hourMS))

            try store.execute("DROP VIEW candles")
            try store.execute("ALTER TABLE stored_candles RENAME TO candles")
            try store.execute("INSERT INTO ema200 VALUES (?, ?, ?)", [id, Int64(0), 100.0])
            try store.execute("ALTER TABLE ema200 RENAME TO stored_ema")
            try store.execute("CREATE VIEW ema200 AS SELECT inst_id,hour,abs(-9223372036854775808) AS value FROM stored_ema")
            XCTAssertThrowsError(try store.load(hour: hourMS, ids: [id]))
        }
    }
}
