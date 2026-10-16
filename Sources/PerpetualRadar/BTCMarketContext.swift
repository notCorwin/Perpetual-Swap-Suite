import Foundation

let btcReferenceID = "BTC-USDT-SWAP"

struct FilterSourceRequirements: Sendable {
    var hours = 0
    var metrics = Set<String>()
    var needsStats: Bool { metrics.contains { ["oiUSD", "oiChange", "oiTrend", "buy", "sell", "buyVsSell", "takerRatio"].contains($0) || $0.hasPrefix("opportunity") } }
    var needsQuotes: Bool { !metrics.isDisjoint(with: ["turnover", "spread"]) }
}

// One immutable reference is shared by every contract in a captured evaluation.
// The locked cache contains only readings from this exact reference revision.
final class FilterReferenceSnapshot: @unchecked Sendable {
    let market: FilterMarketData
    let receivedAt: Int64?
    let connected: Bool
    private let lock = NSLock()
    private var values: [String: FilterScalar] = [:]
    init(market: FilterMarketData, receivedAt: Int64? = nil, connected: Bool = true) {
        self.market = market; self.receivedAt = receivedAt; self.connected = connected
    }
    func reading(_ key: String) -> FilterScalar? { lock.withLock { values[key] } }
    func save(_ value: FilterScalar, for key: String) { lock.withLock { values[key] = value } }
}

final class FilterCooldownMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var matches: [String: Int64] = [:]
    func lastMatch(_ key: String, through timestamp: Int64) -> Int64? {
        lock.withLock { matches[key].flatMap { $0 <= timestamp ? $0 : nil } }
    }
    func record(_ key: String, at timestamp: Int64) {
        lock.withLock { matches[key] = max(matches[key] ?? timestamp, timestamp) }
    }
}

struct FilterReadingSource: Sendable {
    var instrument: String
    var hour: Int64
    var clock: String
    var updatedAt: Int64
    var snapshot: [String: Any] { ["instrument": instrument, "hour": hour, "clock": clock, "updatedAt": updatedAt] }
}

extension CompiledFilter {
    func usesContractInput(_ expression: FilterExpression, visiting: Set<String> = [], bound: Set<String> = []) -> Bool {
        switch expression {
        case .number, .text: return false
        case .name(let name):
            if bound.contains(name) { return false }
            if let definition = definitions[name], !visiting.contains(name) { return usesContractInput(definition, visiting: visiting.union([name]), bound: bound) }
            return true
        case .unary(_, let value): return usesContractInput(value, visiting: visiting, bound: bound)
        case .binary(_, let left, let right): return usesContractInput(left, visiting: visiting, bound: bound) || usesContractInput(right, visiting: visiting, bound: bound)
        case .call(let name, let arguments):
            let function = name.lowercased()
            if function == "btc" { return false }
            if ["closed", "live", "abs", "multiple", "lag", "change", "mean", "sum", "highest", "lowest", "stddev"].contains(function) { return usesContractInput(arguments[0], visiting: visiting, bound: bound) }
            return true
        }
    }
    func usesContractInput(_ node: FilterNode) -> Bool {
        let operands = ["condition", "crossup", "crossdown"].contains(node.kind) ? [node.left, node.right, node.upper] : []
        return (operands + node.captures.map(\.expression)).contains { source in expressions[source].map { usesContractInput($0) } ?? false }
            || node.children.contains { usesContractInput($0) }
    }
    func referencesBTC(in node: FilterNode) -> Bool {
        func contains(_ expression: FilterExpression) -> Bool {
            switch expression {
            case .name(let name): return definitions[name].map(contains) ?? false
            case .unary(_, let value): return contains(value)
            case .binary(_, let left, let right): return contains(left) || contains(right)
            case .call(let name, let args): return name.lowercased() == "btc" || args.contains(where: contains)
            default: return false
            }
        }
        let operands = ["condition", "crossup", "crossdown"].contains(node.kind) ? [node.left, node.right, node.upper] : []
        return (operands + node.captures.map(\.expression)).contains { expressions[$0].map(contains) ?? false }
            || node.children.contains { referencesBTC(in: $0) }
    }
    var referencesBTC: Bool { btcRequirements != nil }
    var hasLiveBTC: Bool { !btcClocks.isDisjoint(with: ["live", "aligned"]) }
    var btcHydration: CompiledFilter {
        var result = self
        let need = btcRequirements ?? .init()
        result.requiredHours = need.hours; result.metrics = need.metrics
        result.needsStats = need.needsStats; result.needsQuotes = need.needsQuotes
        result.btcRequirements = nil; result.btcClocks = []
        return result
    }
    mutating func mergeRequirements(_ other: CompiledFilter) {
        requiredHours = max(requiredHours, other.requiredHours)
        metrics.formUnion(other.metrics); needsStats = needsStats || other.needsStats; needsQuotes = needsQuotes || other.needsQuotes
        btcClocks.formUnion(other.btcClocks)
        if let otherBTC = other.btcRequirements {
            var need = btcRequirements ?? .init(); need.hours = max(need.hours, otherBTC.hours)
            need.metrics.formUnion(otherBTC.metrics); btcRequirements = need
        }
    }
}
