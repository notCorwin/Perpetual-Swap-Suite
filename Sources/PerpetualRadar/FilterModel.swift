import Foundation

enum FilterTruth: String, Codable, Hashable, Sendable {
    case yes = "true", no = "false", unknown
    var negated: Self { self == .unknown ? .unknown : self == .yes ? .no : .yes }
    static func all(_ values: [Self]) -> Self { values.contains(.no) ? .no : values.contains(.unknown) ? .unknown : .yes }
    static func any(_ values: [Self]) -> Self { values.contains(.yes) ? .yes : values.contains(.unknown) ? .unknown : .no }
}

struct FilterDefinition: Codable, Equatable, Sendable {
    var id = UUID().uuidString
    var name: String
    var expression: String
}

struct FilterNode: Codable, Equatable, Sendable {
    var id = UUID().uuidString
    var kind = "all"
    var name = ""
    var mode = "live"
    var children: [FilterNode] = []
    var left = "Price"
    var comparison = "gt"
    var right = "0"
    var upper = "0"
    var hours = 3
    var minimum = 1
    var gapHours = 6
    var captures: [FilterDefinition] = []

    enum CodingKeys: String, CodingKey { case id, kind, name, mode, children, left, comparison, right, upper, hours, minimum, gapHours, captures }
    init(kind: String = "all", name: String = "", children: [FilterNode] = [], left: String = "Price", comparison: String = "gt", right: String = "0", upper: String = "0", mode: String = "live", hours: Int = 3, minimum: Int = 1, gapHours: Int = 6, captures: [FilterDefinition] = []) {
        self.kind = kind; self.name = name; self.children = children; self.left = left; self.comparison = comparison; self.right = right; self.upper = upper
        self.mode = mode; self.hours = hours; self.minimum = minimum; self.gapHours = gapHours; self.captures = captures
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        kind = try c.decode(String.self, forKey: .kind)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "live"
        children = try c.decodeIfPresent([FilterNode].self, forKey: .children) ?? []
        left = try c.decodeIfPresent(String.self, forKey: .left) ?? "Price"
        comparison = try c.decodeIfPresent(String.self, forKey: .comparison) ?? "gt"
        right = try c.decodeIfPresent(String.self, forKey: .right) ?? "0"
        upper = try c.decodeIfPresent(String.self, forKey: .upper) ?? "0"
        hours = try c.decodeIfPresent(Int.self, forKey: .hours) ?? 3
        minimum = try c.decodeIfPresent(Int.self, forKey: .minimum) ?? 1
        gapHours = try c.decodeIfPresent(Int.self, forKey: .gapHours) ?? 6
        captures = try c.decodeIfPresent([FilterDefinition].self, forKey: .captures) ?? []
    }
}

struct FilterConfigV2: Codable, Equatable, Sendable {
    var version = 2
    var root = FilterNode()
    var definitions: [FilterDefinition] = []
    init(root: FilterNode = FilterNode(), definitions: [FilterDefinition] = []) { self.root = root; self.definitions = definitions }
    var json: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try! encoder.encode(self), as: UTF8.self)
    }
    static func decode(_ json: String) throws -> Self {
        let config = try JSONDecoder().decode(Self.self, from: Data(json.utf8))
        guard config.version == 2 else { throw FilterError("Unsupported strategy rule configuration version.") }
        return config
    }
    static func migrate(_ json: String, turnover: Int, spread: Double?, ageMonths: Int?, excludeStablecoin: Bool = true) throws -> Self {
        if let config = try? decode(json) { return config }
        guard let data = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], data["version"] as? Int == 1,
              let match = data["match"] as? String, ["all", "any"].contains(match), let rules = data["rules"] as? [[String: String]] else {
            throw FilterError("Invalid legacy filter configuration.")
        }
        var base = [FilterNode(kind: "condition", name: "Minimum 24h turnover", left: "turnover", comparison: "gte", right: String(Double(turnover) / 1_000_000))]
        // Preserve the former gate's rounding tolerance as editable formula text,
        // rather than introducing a hidden exception in numeric comparisons.
        if let spread { base.append(FilterNode(kind: "condition", name: "Maximum spread", left: "spread", comparison: "lte", right: "\(spread) + 1e-10")) }
        if let ageMonths { base.append(FilterNode(kind: "condition", name: "Minimum listing age", left: "ListingAgeMonths", comparison: "gte", right: String(ageMonths))) }
        if excludeStablecoin { base.append(FilterNode(kind: "condition", name: "Excluded symbol", left: "Symbol", comparison: "neq", right: "\"USDC-USDT-SWAP\"")) }
        let conditions = try rules.map { rule -> FilterNode in
            guard let id = rule["id"], let field = rule["field"], let op = rule["operator"], let value = rule["value"], let upper = rule["upper"], FilterCatalog.fields.contains(field) else { throw FilterError("Invalid legacy condition.") }
            let numeric = FilterCatalog.numericFields.contains(field)
            var node = FilterNode(kind: "condition", left: field, comparison: op, right: numeric ? (value.isEmpty ? "0" : value) : formulaQuote(value), upper: upper.isEmpty ? "0" : upper)
            node.id = id
            return node
        }
        var groups = [FilterNode(name: "Universe", children: base)]
        if !conditions.isEmpty { groups.append(FilterNode(kind: match, name: "Indicator conditions", children: conditions)) }
        return Self(root: FilterNode(children: groups))
    }
}

struct FilterError: Error, CustomStringConvertible, LocalizedError, Sendable {
    var message: String
    var offset: Int?
    init(_ message: String, offset: Int? = nil) { self.message = message; self.offset = offset }
    var description: String { offset.map { "\(message) (character \($0 + 1))" } ?? message }
    var errorDescription: String? { description }
}

func formulaQuote(_ text: String) -> String {
    String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
}

enum FilterScalar: Hashable, Sendable {
    case number(Double), text(String), unknown(String)
    var number: Double? { if case .number(let n) = self { return n }; return nil }
    var text: String? { if case .text(let s) = self { return s }; return nil }
    var reason: String? { if case .unknown(let s) = self { return s }; return nil }
    var snapshot: Any { switch self { case .number(let n): return percentageSnapshot(n); case .text(let s): return s; case .unknown: return NSNull() } }
    var display: String { switch self { case .number(let n): return n.isInfinite ? n > 0 ? "+∞" : "−∞" : String(format: "%.8g", n); case .text(let s): return s; case .unknown(let s): return "Unknown: \(s)" } }
}

struct FilterTrace: Sendable {
    var id: String
    var label: String
    var result: FilterTruth
    var hour: Int64
    var readings: [String: FilterScalar] = [:]
    var reason = ""
    var children: [FilterTrace] = []
    var eventHours: [Int64] = []
    var readingSources: [String: [FilterReadingSource]] = [:]
    var referenceDriven = false
    var snapshot: [String: Any] {
        ["id": id, "label": label, "result": result.rawValue, "hour": hour, "readings": readings.mapValues(\.display), "reason": reason,
         "children": children.map(\.snapshot), "eventHours": eventHours,
         "readingSources": readingSources.mapValues { $0.map(\.snapshot) }, "referenceDriven": referenceDriven]
    }
}
