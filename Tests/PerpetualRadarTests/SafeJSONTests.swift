import XCTest
@testable import PerpetualRadar

final class SafeJSONTests: XCTestCase {
    func testInvalidJSONValuesThrowInsteadOfTerminating() throws {
        XCTAssertEqual(try SafeJSON.data(["value": 1], options: [.sortedKeys]), Data(#"{"value":1}"#.utf8))
        XCTAssertThrowsError(try SafeJSON.data(["value": Double.nan]))
        XCTAssertThrowsError(try SafeJSON.data(["value": Double.infinity]))
        XCTAssertThrowsError(try SafeJSON.data(["value": Date()]))
        XCTAssertThrowsError(try SafeJSON.data("fragment"))
    }

    func testDuplicateStrategyReadingsDoNotTrapAndConflictsAreUnknown() throws {
        let profile = StrategyProfile(name: "Test", universeJSON: "", phaseRules: [:])
        func reading(_ result: String) -> SuiteReading {
            SuiteReading(strategyID: profile.id, revision: 0, instrument: "BTC-USDT-SWAP", hour: 0, provisional: false, universe: "true", universeTraceJSON: nil,
                         phases: ["bullishSetup": .init(result: result, hour: 0, traceJSON: nil)], action: "", reason: "", price: nil)
        }
        let same = try strategyObservation(profile: profile, readings: [reading("true"), reading("true")])
        XCTAssertEqual(same.results["BTC-USDT-SWAP|Bullish Setup"], .yes)
        let conflict = try strategyObservation(profile: profile, readings: [reading("true"), reading("false")])
        XCTAssertEqual(conflict.results["BTC-USDT-SWAP|Bullish Setup"], .unknown)
    }
}
