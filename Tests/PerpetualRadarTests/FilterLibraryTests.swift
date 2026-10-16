import XCTest
@testable import PerpetualRadar

final class FilterLibraryTests: XCTestCase {
    func testEveryScalarCapabilityProvidesValidEditableDefaultsAndNativeHelp() throws {
        XCTAssertEqual(Set(FilterCatalog.scalarFunctions.map(\.name)).count, FilterCatalog.scalarFunctions.count)
        for info in FilterCatalog.scalarFunctions {
            XCTAssertEqual(info.parameters.count, info.defaults.count, info.name)
            XCTAssertFalse(info.description.isEmpty, info.name)
            XCTAssertFalse(info.label.isEmpty, info.name)
            let source = "available(\(info.name)(\(info.defaults.joined(separator: ", "))))"
            let compiled = try FilterCompiler.compile(source: source)
            let tree = try XCTUnwrap(compiled.editorExpressions["\(info.name)(\(info.defaults.joined(separator: ", ")))"], info.name)
            XCTAssertEqual(tree.arguments.count, info.parameters.count, info.name)
        }
        XCTAssertTrue(FilterCatalog.searchAliases(for: "oiTrend").contains("持仓趋势"))
    }
    @MainActor
    func testFavoritesRecentAndLayoutPersistAndWriteFailuresRollBack() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "FilterLibrary-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("radar.sqlite3"), radar = try Radar(defaults: defaults, storeURL: url)
        let value = FilterLibraryPreferences(favorites: ["preset:oi", "metric:Volume"], recent: ["preset:body"], layout: "guided")
        try radar.setFilterLibraryPreferences(value.json)
        XCTAssertEqual(try Radar(defaults: defaults, storeURL: url).filterLibraryPreferences, value)
        let revision = try XCTUnwrap(radar.snapshot(rocPeriod: 9, marocPeriod: 9)["revision"] as? Int)
        let blocker = try Store(url: url)
        try blocker.execute("CREATE TRIGGER reject_library_write BEFORE UPDATE ON preferences WHEN NEW.key='filterLibraryPreferences' BEGIN SELECT RAISE(ABORT,'Fixture write failure'); END")
        XCTAssertThrowsError(try radar.setFilterLibraryPreferences(FilterLibraryPreferences().json))
        XCTAssertEqual(radar.filterLibraryPreferences, value)
        XCTAssertEqual(try blocker.preference(forKey: "filterLibraryPreferences"), value.json)
        XCTAssertEqual(radar.snapshot(rocPeriod: 9, marocPeriod: 9, sinceRevision: revision)["unchanged"] as? Bool, true)
        try blocker.execute("DROP TRIGGER reject_library_write")
        XCTAssertThrowsError(try radar.setFilterLibraryPreferences(#"{"favorites":["a","a"],"recent":[],"layout":"guided"}"#))
        XCTAssertEqual(radar.filterLibraryPreferences, value)
        try radar.setFilterLibraryPreferences(FilterLibraryPreferences().json)
        XCTAssertEqual(try Radar(defaults: defaults, storeURL: url).filterLibraryPreferences, FilterLibraryPreferences())
    }
}
