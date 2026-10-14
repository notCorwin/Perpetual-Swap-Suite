import XCTest
@testable import PerpetualRadar

final class ChartMoveSettingsTests: XCTestCase {
    @MainActor
    func testDefaultsValidatePersistAndAppearInSnapshots() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ChartMoveSettings-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("radar.sqlite3")
        var radar = try Radar(storeURL: url)
        XCTAssertTrue(radar.chartMoveLabelsVisible)
        XCTAssertEqual(radar.chartMoveEfficiencyFactor, 1)
        XCTAssertFalse(try radar.setChartMoveDefaults(efficiencyFactor: -0.1))
        XCTAssertFalse(try radar.setChartMoveDefaults(efficiencyFactor: 1.01))
        XCTAssertTrue(try radar.setChartMoveDefaults(labelsVisible: false, efficiencyFactor: 0.75))
        let snapshot = radar.snapshot(rocPeriod: 9, marocPeriod: 9)
        XCTAssertEqual(snapshot["chartMoveLabelsVisible"] as? Bool, false)
        XCTAssertEqual(snapshot["chartMoveEfficiencyFactor"] as? Double, 0.75)
        radar = try Radar(storeURL: url)
        XCTAssertFalse(radar.chartMoveLabelsVisible)
        XCTAssertEqual(radar.chartMoveEfficiencyFactor, 0.75)
    }
}
