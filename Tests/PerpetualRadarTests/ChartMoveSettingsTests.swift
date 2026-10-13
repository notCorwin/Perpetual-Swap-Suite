import XCTest
@testable import PerpetualRadar

final class ChartMoveSettingsTests: XCTestCase {
    @MainActor
    func testDefaultsValidatePersistAndAppearInSnapshots() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ChartMoveSettings-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("radar.sqlite3")
        var radar = try Radar(storeURL: url)
        XCTAssertEqual(radar.chartMovePriceSource, "highLow")
        XCTAssertEqual(radar.chartMoveObjective, "amplitude")
        XCTAssertTrue(radar.chartMoveLabelsVisible)
        XCTAssertEqual(radar.chartMoveEfficiencyFactor, 1)
        XCTAssertFalse(try radar.setChartMoveDefaults(priceSource: "invalid"))
        XCTAssertFalse(try radar.setChartMoveDefaults(objective: "invalid"))
        XCTAssertFalse(try radar.setChartMoveDefaults(efficiencyFactor: -0.1))
        XCTAssertFalse(try radar.setChartMoveDefaults(efficiencyFactor: 2.1))
        XCTAssertTrue(try radar.setChartMoveDefaults(priceSource: "close", objective: "efficiency", labelsVisible: false, efficiencyFactor: 1.5))
        let snapshot = radar.snapshot(rocPeriod: 9, marocPeriod: 9)
        XCTAssertEqual(snapshot["chartMovePriceSource"] as? String, "close")
        XCTAssertEqual(snapshot["chartMoveObjective"] as? String, "efficiency")
        XCTAssertEqual(snapshot["chartMoveLabelsVisible"] as? Bool, false)
        XCTAssertEqual(snapshot["chartMoveEfficiencyFactor"] as? Double, 1.5)
        radar = try Radar(storeURL: url)
        XCTAssertEqual(radar.chartMovePriceSource, "close")
        XCTAssertEqual(radar.chartMoveObjective, "efficiency")
        XCTAssertFalse(radar.chartMoveLabelsVisible)
        XCTAssertEqual(radar.chartMoveEfficiencyFactor, 1.5)
    }
}
