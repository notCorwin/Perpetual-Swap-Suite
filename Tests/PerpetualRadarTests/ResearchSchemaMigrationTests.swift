import XCTest
import CSQLite
@testable import PerpetualRadar

final class ResearchSchemaMigrationTests: XCTestCase {
    func testStatUnitMigrationBypassesPerRowJSONTriggersAndRestoresThem() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ResearchSchemaMigration-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let store = try ResearchStore(directory: directory)
            try store.database.transaction {
                try store.database.setPreference("4", forKey: "researchSchemaVersion")
                try store.database.execute("INSERT INTO research_data(revision,inst,kind,ts,digest,json) VALUES(1,'TEST-USDT-SWAP','stat',0,'digest','not-json')")
                try store.database.execute("INSERT INTO research_heads VALUES('TEST-USDT-SWAP','stat',0,1)")
                try store.database.execute("INSERT INTO research_objects VALUES('prepared:test','preparedSource','{}')")
                try store.database.execute("INSERT INTO research_objects VALUES('plan:test','planCache','{}')")
            }
        }

        let migrated = try ResearchStore(directory: directory)
        XCTAssertEqual(try migrated.database.preference(forKey: "researchSchemaVersion"), "5")
        var heads = 0, staleObjects = 0, triggers = Set<String>()
        try migrated.database.query("SELECT COUNT(*) FROM research_heads WHERE kind='stat'") { heads = Int(sqlite3_column_int64($0, 0)) }
        try migrated.database.query("SELECT COUNT(*) FROM research_objects WHERE kind IN ('planCache','preparedSource')") { staleObjects = Int(sqlite3_column_int64($0, 0)) }
        try migrated.database.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_DELETE'") {
            if let value = sqlite3_column_text($0, 0) { triggers.insert(String(cString: value)) }
        }
        XCTAssertEqual(heads, 0)
        XCTAssertEqual(staleObjects, 0)
        XCTAssertTrue(triggers.isSuperset(of: ["plan_cache_research_heads_DELETE", "prepared_cache_research_heads_DELETE",
                                               "plan_cache_research_coverage_DELETE", "prepared_cache_research_coverage_DELETE"]))
    }
}
