import Foundation

extension StudySpec {
    // The native planner derives study conditions from frozen strategies. The UI
    // selects versions; it never supplies a separate applied filter.
    func resolvingStrategyRules() throws -> StudySpec {
        guard ["filter", "score", "comparison"].contains(kind) else { throw FilterError("Choose Bullish Setup signals, Opportunity, or Compare strategies.") }
        guard strategyPhase == nil || strategyPhase == "bullishSetup" else { throw FilterError("Research supports Bullish Setup only.") }
        guard let profiles = strategySnapshots else { return try excludingSpread() }
        guard profiles.count == (kind == "comparison" ? 2 : 1) else {
            throw FilterError("Choose one strategy, or two strategy versions for a comparison.")
        }
        for profile in profiles { _ = try profile.compiled() }
        var spec = self
        spec.rules = try profiles.map { try $0.researchRule("bullishSetup") }
        spec.direction = "Long"
        if kind == "score" { spec.sampling = "hourly" }
        return try spec.excludingSpread()
    }
}

extension StrategyProfile {
    func researchRule(_ scope: String) throws -> StudyRule {
        guard let phase = SuitePhase(rawValue: scope), phase == .bullishSetup,
              let phaseJSON = phaseRules[scope] else {
            throw FilterError("Choose Bullish Setup.")
        }
        let universe = try scopedResearchConfig(universeJSON, prefix: "universe_")
        let signal = try scopedResearchConfig(phaseJSON, prefix: "phase_")
        let unrestricted = ["all", "any"].contains(universe.root.kind) && universe.root.children.isEmpty
        var root = FilterNode(children: unrestricted ? [signal.root] : [universe.root, signal.root])
        root.id = "strategy-study-entry"
        let combined = try FilterCompiler.compile(FilterConfigV2(root: root, definitions: universe.definitions + signal.definitions))
        return .init(name: name + " · " + phase.label, filtersJSON: combined.config.json)
    }
}

private func scopedResearchConfig(_ json: String, prefix: String) throws -> FilterConfigV2 {
    let compiled = try FilterCompiler.compile(FilterConfigV2.decode(json))
    let names = Set(compiled.config.definitions.map(\.name))
    func rename(_ value: FilterExpression) -> FilterExpression {
        switch value {
        case .name(let name): return .name(names.contains(name) ? prefix + name : name)
        case .unary(let op, let value): return .unary(op, rename(value))
        case .binary(let op, let left, let right): return .binary(op, rename(left), rename(right))
        case .call(let name, let arguments): return .call(name, arguments.map(rename))
        default: return value
        }
    }
    func expression(_ source: String) -> String {
        compiled.expressions[source].map { rename($0).source } ?? source
    }
    func node(_ original: FilterNode) -> FilterNode {
        var value = original
        value.id = prefix + original.id
        value.left = expression(original.left); value.right = expression(original.right); value.upper = expression(original.upper)
        value.children = original.children.map(node)
        value.captures = original.captures.map { original in
            var value = original; value.id = prefix + original.id; value.expression = expression(original.expression); return value
        }
        return value
    }
    let definitions = compiled.config.definitions.map { original in
        var value = original; value.id = prefix + original.id; value.name = prefix + original.name
        value.expression = compiled.definitions[original.name].map { rename($0).source } ?? original.expression
        return value
    }
    return FilterConfigV2(root: node(compiled.config.root), definitions: definitions)
}
