import Foundation

enum ResearchSpreadPolicy {
    static let notice = "Research excludes bid/ask spread data and spread-dependent conditions. Order book archives are not downloaded. Fees and configured slippage still apply to net returns."
    static func excludes(_ source: ResearchSource) -> Bool {
        source.kind == "spread" || [4, 5, 6].contains(source.module ?? 0)
    }
}

extension StudySpec {
    func excludingSpread() throws -> StudySpec {
        var spec = self, excluded = excludedSpreadConditions ?? []
        spec.rules = try rules.map { rule in
            let compiled = try FilterCompiler.compile(FilterConfigV2.decode(rule.filtersJSON))
            func depends(_ expression: FilterExpression, captures: Set<String>) -> Bool {
                switch expression {
                case .name(let name):
                    if FilterCatalog.key(name) == "spread" || captures.contains(name) { return true }
                    return compiled.definitions[name].map { depends($0, captures: captures) } ?? false
                case .unary(_, let value): return depends(value, captures: captures)
                case .binary(_, let left, let right): return depends(left, captures: captures) || depends(right, captures: captures)
                case .call(_, let arguments): return arguments.contains { depends($0, captures: captures) }
                default: return false
                }
            }
            func depends(_ source: String, captures: Set<String>) -> Bool {
                compiled.expressions[source].map { depends($0, captures: captures) } ?? false
            }
            // Omit predicates instead of replacing them with true: an OR group
            // must still evaluate its remaining conditions. Empty wrappers go too.
            func project(_ original: FilterNode, captures: Set<String>) -> FilterNode? {
                var node = original
                let unary = ["positive", "negative", "zero", "present", "missing"].contains(node.comparison)
                let operands = [node.left] + (node.kind == "condition" && unary ? [] : [node.right]) + (node.comparison == "between" ? [node.upper] : [])
                if ["condition", "crossup", "crossdown"].contains(node.kind),
                   operands.contains(where: { depends($0, captures: captures) }) {
                    excluded.append(rule.name + ": " + node.formula)
                    return nil
                }
                if node.kind == "sequence" {
                    var scope = captures
                    node.children = original.children.map { stage in
                        var value = project(stage, captures: scope) ?? {
                            var neutral = stage
                            neutral.kind = "condition"; neutral.children = []; neutral.left = "0"; neutral.comparison = "eq"; neutral.right = "0"; neutral.upper = "0"
                            return neutral
                        }()
                        // Keep stage clocks and independent captures. Consumers
                        // of an excluded capture are excluded transitively.
                        value.captures = stage.captures.filter { capture in
                            guard depends(capture.expression, captures: scope) else { return true }
                            excluded.append(rule.name + ": " + stage.name + "." + capture.name + " = " + capture.expression)
                            return false
                        }
                        scope.formUnion(stage.captures.filter { capture in !value.captures.contains(where: { $0.id == capture.id }) }.map { stage.name + "." + $0.name })
                        return value
                    }
                } else if !node.children.isEmpty {
                    node.children = node.children.compactMap { project($0, captures: captures) }
                    if node.children.isEmpty { return nil }
                }
                return node
            }
            let root = project(compiled.config.root, captures: []) ?? {
                var root = compiled.config.root
                root.kind = "all"; root.children = []; root.captures = []
                return root
            }()
            let definitions = compiled.config.definitions.filter { definition in
                !(compiled.definitions[definition.name].map { depends($0, captures: []) } ?? false)
            }
            let result = try FilterCompiler.compile(FilterConfigV2(root: root, definitions: definitions))
            return StudyRule(name: rule.name, filtersJSON: result.config.json)
        }
        spec.excludedSpreadConditions = Array(Set(excluded)).sorted()
        return spec
    }
}

extension DataPlan {
    func excludingSpread() throws -> DataPlan {
        var plan = self
        plan.spec = try spec.excludingSpread()
        plan.sources.removeAll(where: ResearchSpreadPolicy.excludes)
        plan.coverage.removeAll { $0.kind == "spread" }
        plan.warnings.removeAll { $0.localizedCaseInsensitiveContains("spread") }
        plan.warnings.append(ResearchSpreadPolicy.notice)
        return plan
    }
}
