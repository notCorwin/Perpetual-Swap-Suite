import XCTest
@testable import PerpetualRadar

final class RuleCompatibilityTests: XCTestCase {
    private func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue ?? (value as? String).flatMap(Double.init) }
    private func event(_ value: Any?) -> BreakResult {
        let item = value as? [String: Any] ?? [:]
        switch item["status"] as? String {
        case "loading": return .loading
        case "insufficient-history": return .insufficientHistory
        case "event": return .event(.init(hour: Int64(number(item["hour"])!), hoursAgo: Int(number(item["hoursAgo"])!), priorHour: Int64(number(item["priorHour"])!), priorAgeHours: Int(number(item["priorAgeHours"])!), priorPrice: number(item["priorPrice"])!, live: item["live"] as? Bool == true))
        default: return .none
        }
    }
    func testAllLegacyReadingsAndOpportunityMatchFrozenWebFixtures() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/filter-compatibility.json")
        let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
        XCTAssertEqual(fixtures.count, 172)
        for fixture in fixtures {
            let row = try XCTUnwrap(fixture["row"] as? [String: Any]), expected = try XCTUnwrap(fixture["readings"] as? [String: Any])
            let readings = LegacyFilterReadings.from(row), id = fixture["id"]!
            for (key, value) in expected {
                if value is NSNull { XCTAssertNotNil(readings[key]?.reason, "\(id): \(key)") }
                else if let numeric = number(value) {
                    let actual = try XCTUnwrap(readings[key]?.number, "\(id): \(key)")
                    if numeric.isInfinite { XCTAssertEqual(actual, numeric, "\(id): \(key)") }
                    else { XCTAssertEqual(actual, numeric, accuracy: 1e-9, "\(id): \(key)") }
                } else { XCTAssertEqual(readings[key]?.text, value as? String, "\(id): \(key)") }
            }
            let expansion = row["logBBExpansion"] as? [String: Any]
            let result = NativeOpportunity.evaluate(.init(signal: row["ema200Signal"] as? String, priceChange: number(row["priceChange"]), roc: number(row["roc"]), maroc: number(row["maroc"]), rsi6: number(row["rsi6"]), rsi12: number(row["rsi12"]), rsi24: number(row["rsi24"]), taker: number(row["takerRatio"]), oi: number(row["oiChange"]), band: row["logBBAboveBand"] as? String,
                expansion: expansion.map { .init(hours: Int(number($0["hours"])!), complete: $0["complete"] as? Bool == true) }, high: event(row["highBreakout"]), low: event(row["lowBreakdown"])))
            let original = try XCTUnwrap(row["opportunity"] as? [String: Any])
            XCTAssertEqual(result.direction, original["direction"] as? String, "\(id)")
            XCTAssertEqual(result.setup, original["setup"] as? String, "\(id)")
            XCTAssertEqual(result.status, original["status"] as? String, "\(id)")
            XCTAssertEqual(result.score, number(original["score"]).map(Int.init), "\(id)")
            XCTAssertEqual(result.reasons, original["reasons"] as? [String], "\(id)")
            if let parts = original["components"] as? [String: Double] { for (key, value) in parts { XCTAssertEqual(try XCTUnwrap(result.components?[key]), value, accuracy: 1e-9, "\(id): \(key)") } }
            else { XCTAssertNil(result.components, "\(id)") }
        }
    }
}
