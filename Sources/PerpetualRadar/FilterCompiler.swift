import Foundation

indirect enum FilterExpression: Sendable {
    case number(Double), text(String), name(String), unary(String, FilterExpression), binary(String, FilterExpression, FilterExpression), call(String, [FilterExpression])
    var source: String {
        switch self {
        case .number(let n): return n.rounded() == n ? String(format: "%.0f", n) : String(n)
        case .text(let s): return formulaQuote(s)
        case .name(let n): return n
        case .unary(let op, let x): return "\(op) (\(x.source))"
        case .binary(let op, let a, let b): return "(\(a.source) \(op) \(b.source))"
        case .call(let f, let xs): return "\(f)(\(xs.map(\.source).joined(separator: ", ")))"
        }
    }
}

struct FilterToken {
    var text: String, kind: String, offset: Int
}

struct FilterParser {
    private var tokens: [FilterToken] = []
    private var position = 0
    init(_ source: String) throws {
        let chars = Array(source)
        var i = 0
        while i < chars.count {
            let c = chars[i], start = i
            if c.isWhitespace { i += 1; continue }
            if c == "/", i + 1 < chars.count, chars[i + 1] == "/" { while i < chars.count, chars[i] != "\n" { i += 1 }; continue }
            if c == "\"" || c == "'" {
                let quote = c; i += 1; var value = "", finished = false
                while i < chars.count {
                    let next = chars[i]; i += 1
                    if next == quote { finished = true; break }
                    if next == "\\" {
                        guard i < chars.count else { break }
                        let escaped = chars[i]; i += 1
                        value.append(escaped == "n" ? "\n" : escaped == "t" ? "\t" : escaped == "r" ? "\r" : escaped)
                    } else { value.append(next) }
                }
                guard finished else { throw FilterError("Unterminated string.", offset: start) }
                tokens.append(.init(text: value, kind: "string", offset: start)); continue
            }
            if c.isNumber || (c == "." && i + 1 < chars.count && chars[i + 1].isNumber) {
                i += 1
                while i < chars.count, chars[i].isNumber || chars[i] == "." { i += 1 }
                if i < chars.count, chars[i] == "e" || chars[i] == "E" {
                    i += 1
                    if i < chars.count, chars[i] == "+" || chars[i] == "-" { i += 1 }
                    while i < chars.count, chars[i].isNumber { i += 1 }
                }
                let text = String(chars[start..<i])
                guard let n = Double(text), n.isFinite else { throw FilterError("Enter a finite number.", offset: start) }
                tokens.append(.init(text: text, kind: "number", offset: start)); continue
            }
            if c.isLetter || c == "_" {
                i += 1
                while i < chars.count, chars[i].isLetter || chars[i].isNumber || chars[i] == "_" || chars[i] == "." { i += 1 }
                tokens.append(.init(text: String(chars[start..<i]), kind: "name", offset: start)); continue
            }
            let pair = i + 1 < chars.count ? String(chars[i...i + 1]) : ""
            if [">=", "<=", "==", "!=", "&&", "||"].contains(pair) { tokens.append(.init(text: pair, kind: "symbol", offset: start)); i += 2; continue }
            guard "()+-*/<>,;=!".contains(c) else { throw FilterError("Unexpected character \(c).", offset: start) }
            tokens.append(.init(text: String(c), kind: "symbol", offset: start)); i += 1
        }
        tokens.append(.init(text: "", kind: "end", offset: chars.count))
    }
    private var current: FilterToken { tokens[position] }
    private mutating func take() -> FilterToken { defer { position += 1 }; return current }
    private mutating func expect(_ text: String) throws { guard current.text == text else { throw FilterError("Expected '\(text)'.", offset: current.offset) }; position += 1 }
    private func precedence(_ text: String) -> Int {
        switch text.uppercased() { case "OR", "||": return 1; case "AND", "&&": return 2; case "==", "!=", ">", ">=", "<", "<=": return 3; case "+", "-": return 4; case "*", "/": return 5; default: return 0 }
    }
    mutating func expression(_ minimum: Int = 1) throws -> FilterExpression {
        let token = take()
        var left: FilterExpression
        if token.text == "-" || token.text == "+" || token.text == "!" || token.text.uppercased() == "NOT" {
            left = .unary(token.text.uppercased(), try expression(token.text == "!" || token.text.uppercased() == "NOT" ? 3 : 6))
        } else if token.kind == "number" { left = .number(Double(token.text)!) }
        else if token.kind == "string" { left = .text(token.text) }
        else if token.text == "(" { left = try expression(); try expect(")") }
        else if token.kind == "name" {
            if current.text == "(" {
                position += 1; var args: [FilterExpression] = []
                if current.text != ")" {
                    while true {
                        args.append(try expression())
                        if current.text != "," { break }; position += 1
                    }
                }
                try expect(")"); left = .call(token.text, args)
            } else { left = .name(token.text) }
        } else { throw FilterError("Expected an expression.", offset: token.offset) }
        while precedence(current.text) >= minimum {
            let op = take().text, p = precedence(op)
            left = .binary(op.uppercased(), left, try expression(p + 1))
        }
        return left
    }
    mutating func scalar() throws -> FilterExpression { let value = try expression(); guard current.kind == "end" else { throw FilterError("Unexpected '\(current.text)'.", offset: current.offset) }; return value }
    mutating func configuration() throws -> FilterConfigV2 {
        var definitions: [FilterDefinition] = []
        while current.text.lowercased() == "let" {
            position += 1; let name = take()
            guard name.kind == "name" else { throw FilterError("Expected a formula name.", offset: name.offset) }
            try expect("="); let value = try expression(); try expect(";")
            definitions.append(.init(name: name.text, expression: value.source))
        }
        let expr = try scalar()
        if case .name(let name) = expr, name.lowercased() == "true" { return FilterConfigV2(definitions: definitions) }
        let rule = try Self.rule(expr)
        return FilterConfigV2(root: ["all", "any"].contains(rule.kind) ? rule : FilterNode(children: [rule]), definitions: definitions)
    }
    static let comparisonSymbols = ["==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte"]
    static func integer(_ expr: FilterExpression, zero: Bool = false) throws -> Int {
        guard case .number(let n) = expr, n.rounded() == n, n >= (zero ? 0 : 1), n < Double(Int64.max / hourMS / 4) else { throw FilterError("Hours and periods must be positive whole numbers within the supported timestamp range.") }
        return Int(n)
    }
    static func string(_ expr: FilterExpression) throws -> String { guard case .text(let s) = expr else { throw FilterError("Expected a quoted name.") }; return s }
    static func rule(_ expr: FilterExpression) throws -> FilterNode {
        switch expr {
        case .unary(let op, let child) where op == "NOT" || op == "!": return FilterNode(kind: "not", children: [try rule(child)])
        case .binary(let op, let left, let right):
            if ["AND", "&&", "OR", "||"].contains(op) { return FilterNode(kind: op == "AND" || op == "&&" ? "all" : "any", children: [try rule(left), try rule(right)]) }
            if let comparison = comparisonSymbols[op] { return FilterNode(kind: "condition", left: left.source, comparison: comparison, right: right.source) }
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "named", args.count == 2 { var node = try rule(args[1]); node.name = try string(args[0]); return node }
            if f == "all" || f == "any" { return FilterNode(kind: f, children: try args.map(rule)) }
            if f == "closed" || f == "live", args.count == 1 {
                var node = try rule(args[0])
                // `live` reads at the current anchor and never cancels a nested Closed anchor.
                if f == "live" { return node }
                if node.mode == "closed" { return FilterNode(children: [node], mode: "closed") }
                node.mode = f; return node
            }
            if ["available", "unavailable", "positive", "negative", "zero"].contains(f), args.count == 1 {
                return FilterNode(kind: "condition", left: args[0].source, comparison: f == "available" ? "present" : f == "unavailable" ? "missing" : f)
            }
            if ["between", "absgte", "abslte"].contains(f), args.count == (f == "between" ? 3 : 2) {
                return FilterNode(kind: "condition", left: args[0].source, comparison: f == "between" ? f : f == "absgte" ? "abs-gte" : "abs-lte", right: args[1].source, upper: f == "between" ? args[2].source : "0")
            }
            if ["every", "recent"].contains(f), args.count == 2 { return FilterNode(kind: f, children: [try rule(args[0])], hours: try integer(args[1])) }
            if f == "cooldown", args.count == 2 { return FilterNode(kind: f, children: [try rule(args[0])], hours: try integer(args[1], zero: true)) }
            if f == "count", (4...5).contains(args.count) { return FilterNode(kind: f, children: [try rule(args[0])], comparison: try string(args[2]), upper: args.count == 5 ? args[4].source : "0", hours: try integer(args[1]), minimum: try integer(args[3], zero: true)) }
            if f == "crossup" || f == "crossdown", args.count == 2 { return FilterNode(kind: f, left: args[0].source, right: args[1].source) }
            if f == "sequence", args.count >= 3 {
                let hours = try integer(args[0])
                let stages = try args.dropFirst().map { arg -> FilterNode in
                    guard case .call(let stageName, let items) = arg, stageName.lowercased() == "stage", items.count >= 3 else { throw FilterError("Use stage(\"name\", condition, gapHours, capture(...)) inside sequence.") }
                    var stage = try rule(items[1]); stage.name = try string(items[0]); stage.gapHours = try integer(items[2])
                    stage.captures = try items.dropFirst(3).map { value in
                        guard case .call(let captureName, let captureArgs) = value, captureName.lowercased() == "capture", captureArgs.count == 2 else { throw FilterError("Use capture(\"name\", expression).") }
                        return FilterDefinition(name: try string(captureArgs[0]), expression: captureArgs[1].source)
                    }
                    return stage
                }
                return FilterNode(kind: "sequence", children: stages, hours: hours)
            }
        case .name(let name) where name.lowercased() == "true": return FilterNode(kind: "condition", left: "0", comparison: "eq", right: "0")
        case .name(let name) where name.lowercased() == "false": return FilterNode(kind: "condition", left: "0", comparison: "eq", right: "1")
        default: break
        }
        throw FilterError("Expected a condition, logic group or time rule.")
    }
}

extension FilterNode {
    var formula: String {
        var value: String
        let symbols = ["eq": "==", "neq": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="]
        switch kind {
        case "all", "any": value = "\(kind)(\(children.map(\.formula).joined(separator: ", ")))"
        case "not": value = "NOT (\(children.first?.formula ?? "true"))"
        case "condition":
            if let symbol = symbols[comparison] { value = "(\(left) \(symbol) \(right))" }
            else if comparison == "between" { value = "between(\(left), \(right), \(upper))" }
            else if comparison == "abs-gte" || comparison == "abs-lte" { value = "\(comparison == "abs-gte" ? "absGte" : "absLte")(\(left), \(right))" }
            else { value = "\(comparison == "present" ? "available" : comparison == "missing" ? "unavailable" : comparison)(\(left))" }
        case "every", "recent", "cooldown": value = "\(kind)(\(children.first?.formula ?? "true"), \(hours))"
        case "count": value = "count(\(children.first?.formula ?? "true"), \(hours), \(formulaQuote(comparison)), \(minimum)\(comparison == "between" ? ", \(upper)" : ""))"
        case "crossup", "crossdown": value = "\(kind == "crossup" ? "crossUp" : "crossDown")(\(left), \(right))"
        case "sequence":
            let stages = children.map { stage in
                "stage(\(formulaQuote(stage.name)), \(stage.formula), \(stage.gapHours)\(stage.captures.map { ", capture(\(formulaQuote($0.name)), \($0.expression))" }.joined()))"
            }
            value = "sequence(\(hours), \(stages.joined(separator: ", ")))"
        default: value = "true"
        }
        if mode == "closed" { value = "closed(\(value))" }
        return name.isEmpty ? value : "named(\(formulaQuote(name)), \(value))"
    }
}

struct CompiledFilter: Sendable {
    var config: FilterConfigV2
    var expressions: [String: FilterExpression] = [:]
    var definitions: [String: FilterExpression] = [:]
    var requiredHours = 0
    var needsStats = false
    var needsQuotes = false
    var metrics = Set<String>()
    var btcRequirements: FilterSourceRequirements?
    var btcClocks = Set<String>()
    var cooldownIdentity = ""
    var units: [String: String] = [:]
    var editorExpressions: [String: FilterEditorExpression] = [:]
    var formula: String { config.definitions.map { "let \($0.name) = \($0.expression);" }.joined(separator: "\n") + (config.definitions.isEmpty ? "" : "\n\n") + config.root.formula }
}

// WebKit edits this tree; parsing, type resolution and normalization remain native.
struct FilterEditorExpression: Sendable {
    var kind: String, source: String, unit: String
    var value: String? = nil
    var operation: String? = nil
    var arguments: [Self] = []
    var choices: [FilterCatalog.Choice] = []
    var snapshot: [String: Any] {
        var result: [String: Any] = ["kind": kind, "source": source, "unit": unit, "arguments": arguments.map(\.snapshot),
                                   "choices": choices.map { ["value": $0.value, "label": $0.label] }]
        if let value { result["value"] = value }
        if let operation { result["operation"] = operation }
        return result
    }
}

struct FilterCompiler {
    private var compiled: CompiledFilter
    private var ids = Set<String>()
    private var definitionStack = Set<String>()
    private var parsedDefinitions: [String: FilterExpression] = [:]
    private var kinds: [String: Bool] = [:] // true = numeric
    private var captureUnits: [String: String] = [:]
    init(_ config: FilterConfigV2) { compiled = CompiledFilter(config: config) }
    static func compile(_ config: FilterConfigV2) throws -> CompiledFilter { var c = Self(config); return try c.compile() }
    static func compile(source: String, previous: FilterConfigV2? = nil) throws -> CompiledFilter {
        var parser = try FilterParser(source), config = try parser.configuration()
        if let previous { config.reuseIdentities(previous) }
        return try compile(config)
    }
    private mutating func compile() throws -> CompiledFilter {
        guard compiled.config.version == 2 else { throw FilterError("Unsupported filter version.") }
        for item in compiled.config.definitions {
            guard Self.validName(item.name), FilterCatalog.key(item.name) == nil, parsedDefinitions[item.name] == nil else { throw FilterError("Formula names must be unique identifiers and cannot shadow metrics: \(item.name).") }
            var p = try FilterParser(item.expression); parsedDefinitions[item.name] = try p.scalar()
        }
        for name in parsedDefinitions.keys.sorted() { _ = try definitionKind(name) }
        try validate(compiled.config.root, root: true, scope: [])
        compiled.requiredHours = try requirement(compiled.config.root)
        guard compiled.requiredHours < Int(Int64.max / hourMS / 4) else { throw FilterError("Combined history dependencies exceed the supported timestamp range.") }
        for (source, expr) in compiled.expressions { compiled.units[source] = expressionUnit(expr); compiled.units[expr.source] = expressionUnit(expr) }
        for (name, expr) in compiled.definitions { compiled.units[name] = expressionUnit(expr); compiled.units[expr.source] = expressionUnit(expr) }
        compiled.units.merge(captureUnits) { _, unit in unit }
        normalizeConfiguration()
        try collectSourceRequirements()
        guard max(compiled.requiredHours, compiled.btcRequirements?.hours ?? 0) < Int(Int64.max / hourMS / 4) else { throw FilterError("Combined history dependencies exceed the supported timestamp range.") }
        compiled.cooldownIdentity = researchHash(compiled.config.json)
        for (source, expression) in compiled.expressions { compiled.editorExpressions[source] = editorExpression(expression) }
        for (name, expression) in compiled.definitions {
            compiled.editorExpressions[name] = editorExpression(.name(name))
            compiled.editorExpressions[expression.source] = editorExpression(expression)
        }
        return compiled
    }
    static func validName(_ name: String) -> Bool { name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil }
    private mutating func definitionKind(_ name: String) throws -> Bool {
        if let kind = kinds[name] { return kind }
        guard !definitionStack.contains(name), let expr = parsedDefinitions[name] else { throw FilterError("Circular or unknown formula: \(name).") }
        definitionStack.insert(name); defer { definitionStack.remove(name) }
        let kind = try scalarKind(expr, scope: [])
        kinds[name] = kind; compiled.definitions[name] = expr
        return kind
    }
    private mutating func parse(_ source: String, scope: Set<String>) throws -> Bool {
        var p = try FilterParser(source); let expr = try p.scalar()
        let kind = try scalarKind(expr, scope: scope); compiled.expressions[source] = expr
        return kind
    }
    private mutating func scalarKind(_ expr: FilterExpression, scope: Set<String>) throws -> Bool {
        switch expr {
        case .number: return true
        case .text: return false
        case .name(let name):
            if scope.contains(name) { return true }
            if parsedDefinitions[name] != nil { return try definitionKind(name) }
            guard let key = FilterCatalog.key(name) else { throw FilterError("Unknown metric or formula: \(name).") }
            compiled.metrics.insert(key)
            if ["oiUSD", "oiChange", "oiTrend", "buy", "sell", "buyVsSell", "takerRatio"].contains(key) { compiled.needsStats = true }
            if key == "turnover" || key == "spread" { compiled.needsQuotes = true }
            if key.hasPrefix("opportunity") { compiled.needsStats = true }
            return FilterCatalog.numericFields.contains(key)
        case .unary(let op, let x):
            guard ["+", "-"].contains(op), try scalarKind(x, scope: scope) else { throw FilterError("Arithmetic requires numeric operands.") }; return true
        case .binary(let op, let a, let b):
            guard ["+", "-", "*", "/"].contains(op), try scalarKind(a, scope: scope), try scalarKind(b, scope: scope) else { throw FilterError("Arithmetic requires numeric operands.") }; return true
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "btc", (1...2).contains(args.count) {
                if args.count == 2 { guard ["aligned", "live", "closed"].contains(try FilterParser.string(args[1])) else { throw FilterError("Choose aligned, live or closed for the BTC clock.") } }
                return try scalarKind(args[0], scope: scope)
            }
            if ["closed", "live"].contains(f), args.count == 1 { return try scalarKind(args[0], scope: scope) }
            if f == "abs", args.count == 1, try scalarKind(args[0], scope: scope) { return true }
            if f == "multiple", args.count == 2, try scalarKind(args[0], scope: scope) {
                guard case .number(let multiplier) = args[1], multiplier.isFinite, multiplier > 0 else { throw FilterError("The baseline multiplier must be a positive number.") }
                return true
            }
            if ["mean", "sum", "highest", "lowest", "stddev", "lag", "change"].contains(f), args.count == 2, try scalarKind(args[0], scope: scope) {
                _ = try FilterParser.integer(args[1], zero: f == "lag"); return true
            }
            if f == "relativechange", args.count == 2, try scalarKind(args[0], scope: scope), try scalarKind(args[1], scope: scope) { return true }
            if ["ema", "rsi", "roc", "efficiency", "vwap"].contains(f), args.count == 1 { _ = try FilterParser.integer(args[0]); return true }
            if f == "maroc", args.count == 2 { for arg in args { _ = try FilterParser.integer(arg) }; return true }
            if f == "priorextreme", args.count == 2 {
                _ = try FilterParser.integer(args[0]); guard ["high", "low"].contains(try FilterParser.string(args[1])) else { throw FilterError("Choose high or low for the prior extreme.") }; return true
            }
            if f == "extremeage", args.count == 3 {
                _ = try FilterParser.integer(args[0]); _ = try FilterParser.integer(args[1]); guard ["breakout", "breakdown"].contains(try FilterParser.string(args[2])) else { throw FilterError("Choose breakout or breakdown for the extreme event.") }; return true
            }
            if f == "logbb", args.count == 3 {
                _ = try FilterParser.integer(args[0]); guard case .number(let k) = args[1], k > 0 else { throw FilterError("Log BB deviations must be positive.") }
                guard ["upper", "middle", "lower"].contains(try FilterParser.string(args[2])) else { throw FilterError("Choose upper, middle or lower for the Log BB band.") }
                return true
            }
            throw FilterError("Unknown function or invalid arguments: \(name).")
        }
    }
    private mutating func validate(_ node: FilterNode, root: Bool = false, scope: Set<String>) throws {
        guard !node.id.isEmpty, ids.insert(node.id).inserted else { throw FilterError("Rule IDs must be unique.") }
        guard ["live", "closed"].contains(node.mode) else { throw FilterError("Choose live or closed hourly data.") }
        let unary = ["positive", "negative", "zero", "present", "missing"]
        let numericOps = ["gt", "gte", "lt", "lte", "between", "abs-gte", "abs-lte", "positive", "negative", "zero"]
        switch node.kind {
        case "all", "any":
            guard root || !node.children.isEmpty else { throw FilterError("Add a condition to the empty group.") }
            for child in node.children { try validate(child, scope: scope) }
        case "not", "every", "recent", "count", "cooldown":
            guard node.children.count == 1 else { throw FilterError("\(node.kind) requires exactly one child rule.") }
            if node.kind != "not" { _ = try FilterParser.integer(.number(Double(node.hours)), zero: node.kind == "cooldown") }
            if node.kind == "count" {
                guard ["eq", "neq", "gt", "gte", "lt", "lte", "between"].contains(node.comparison), node.minimum >= 0 else { throw FilterError("Choose a valid count comparison and nonnegative threshold.") }
                if node.comparison == "between" { guard let upper = Double(node.upper), upper.isFinite, upper.rounded() == upper, upper >= Double(node.minimum) else { throw FilterError("Count maximum must be a whole number no smaller than minimum.") } }
            }
            try validate(node.children[0], scope: scope)
        case "condition", "crossup", "crossdown":
            guard node.children.isEmpty else { throw FilterError("This condition cannot contain child rules.") }
            let leftKind = try parse(node.left, scope: scope)
            if node.kind != "condition" { guard leftKind, try parse(node.right, scope: scope) else { throw FilterError("Crossings require numeric operands.") } }
            else {
                guard ["eq", "neq"].contains(node.comparison) || numericOps.contains(node.comparison) || ["present", "missing"].contains(node.comparison) else { throw FilterError("Unknown comparison.") }
                if numericOps.contains(node.comparison), !leftKind { throw FilterError("This comparison requires numeric data.") }
                if !unary.contains(node.comparison), try parse(node.right, scope: scope) != leftKind { throw FilterError("Both comparison operands must have the same data type.") }
                if node.comparison == "between", !(try parse(node.upper, scope: scope)) { throw FilterError("A range requires numeric endpoints.") }
                if let lo = Double(node.right), let hi = Double(node.upper), node.comparison == "between", lo > hi { throw FilterError("Minimum must be no greater than maximum.") }
                if ["abs-gte", "abs-lte"].contains(node.comparison), let value = Double(node.right), value < 0 { throw FilterError("Absolute thresholds must be nonnegative.") }
            }
        case "sequence":
            guard node.children.count >= 2 else { throw FilterError("A sequence requires at least two stages.") }
            _ = try FilterParser.integer(.number(Double(node.hours)))
            var stageNames = Set<String>(), stageScope = scope
            for stage in node.children {
                guard Self.validName(stage.name), stageNames.insert(stage.name).inserted else { throw FilterError("Sequence stages require unique identifier names.") }
                _ = try FilterParser.integer(.number(Double(stage.gapHours)))
                try validate(stage, scope: stageScope)
                var captureNames = Set<String>()
                for capture in stage.captures {
                    guard Self.validName(capture.name), captureNames.insert(capture.name).inserted, try parse(capture.expression, scope: stageScope) else { throw FilterError("Captures require unique names and numeric expressions.") }
                    let name = "\(stage.name).\(capture.name)", unit = expressionUnit(compiled.expressions[capture.expression]!)
                    if let previous = captureUnits[name], previous != unit { captureUnits[name] = "varies by sequence" }
                    else { captureUnits[name] = unit }
                    stageScope.insert(name)
                }
            }
        default: throw FilterError("Unknown rule type: \(node.kind).")
        }
    }
    private func scalarRequirement(_ expr: FilterExpression, visiting: Set<String> = []) throws -> Int {
        switch expr {
        case .number, .text: return 0
        case .name(let n):
            if let def = compiled.definitions[n], !visiting.contains(n) { return try scalarRequirement(def, visiting: visiting.union([n])) }
            if n.contains(".") { return 0 }
            let key = FilterCatalog.key(n) ?? n
            if key.hasPrefix("opportunity") || ["emaTrend", "emaSlope", "emaBody", "priceEMA", "emaDistance"].contains(key) { return emaWarmupHours(200) + 1 }
            if key.hasPrefix("rsi") { return 250 }
            if key.contains("96") { return 144 }
            if key.contains("48") || ["highPriorAge", "lowPriorAge"].contains(key) { return 96 }
            if ["bbExpansion", "bbExpansionComplete"].contains(key) { return 250 }
            if ["maroc", "marocChange", "rocVsMaroc"].contains(key) { return 18 }
            if ["roc", "rocChange"].contains(key) { return 10 }
            if key.hasPrefix("bb") || ["priceUpper", "priceMiddle", "priceLower", "highUpper", "lowLower", "bodyUpper", "bodyLower"].contains(key) { return 20 }
            if ["priceVWAP", "vwapDistance"].contains(key) { return 14 }
            return ["priceChange", "oiChange", "oiTrend"].contains(key) ? 1 : 0
        case .unary(_, let x): return try scalarRequirement(x, visiting: visiting)
        case .binary(_, let a, let b): return max(try scalarRequirement(a, visiting: visiting), try scalarRequirement(b, visiting: visiting))
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "btc" { return 0 }
            if f == "ema" { return emaWarmupHours(try FilterParser.integer(args[0])) + 1 }
            if f == "rsi" { return max(250, try FilterParser.integer(args[0]) + 1) }
            if ["roc", "efficiency", "vwap", "priorextreme", "logbb"].contains(f) { return try FilterParser.integer(args[0]) + 1 }
            if ["maroc", "extremeage"].contains(f) { return try FilterParser.integer(args[0]) + FilterParser.integer(args[1]) }
            if ["mean", "sum", "highest", "lowest", "stddev", "lag", "change"].contains(f) { return try scalarRequirement(args[0], visiting: visiting) + FilterParser.integer(args[1], zero: f == "lag") }
            if f == "relativechange" { return max(try scalarRequirement(args[0], visiting: visiting), try scalarRequirement(args[1], visiting: visiting)) }
            return try scalarRequirement(args[0], visiting: visiting) + (f == "closed" ? 1 : 0)
        }
    }
    private func requirement(_ node: FilterNode) throws -> Int {
        var need = 0
        for source in [node.left, node.right, node.upper] + node.captures.map(\.expression) {
            if let expr = compiled.expressions[source] { need = max(need, try scalarRequirement(expr)) }
        }
        for child in node.children { need = max(need, try requirement(child)) }
        if ["every", "recent", "count", "sequence", "cooldown"].contains(node.kind) { need += node.hours }
        if node.kind == "crossup" || node.kind == "crossdown" { need += 1 }
        return need + (node.mode == "closed" ? 1 : 0)
    }

    private mutating func collectSourceRequirements() throws {
        var own = FilterSourceRequirements()
        var btc: FilterSourceRequirements?
        var clocks = Set<String>()
        func scan(_ expression: FilterExpression, reference: Bool, offset: Int, visiting: Set<String> = []) throws {
            if reference {
                var need = btc ?? .init()
                need.hours = max(need.hours, offset + (try scalarRequirement(expression)))
                btc = need
            } else if compiled.usesContractInput(expression) {
                own.hours = max(own.hours, offset + (try scalarRequirement(expression)))
            }
            switch expression {
            case .name(let name):
                if let definition = compiled.definitions[name], !visiting.contains(name) { try scan(definition, reference: reference, offset: offset, visiting: visiting.union([name])) }
                else if let key = FilterCatalog.key(name) {
                    if reference {
                        guard !key.hasPrefix("Long") && !key.hasPrefix("Short") else { throw FilterError("Position readings belong to the tracked contract, not BTC.") }
                        btc?.metrics.insert(key)
                    } else { own.metrics.insert(key) }
                }
            case .unary(_, let x): try scan(x, reference: reference, offset: offset, visiting: visiting)
            case .binary(_, let a, let b): try scan(a, reference: reference, offset: offset, visiting: visiting); try scan(b, reference: reference, offset: offset, visiting: visiting)
            case .call(let name, let args):
                let f = name.lowercased()
                if f == "btc" {
                    let clock = args.count == 2 ? try FilterParser.string(args[1]) : "aligned"
                    clocks.insert(clock); btc = btc ?? .init()
                    try scan(args[0], reference: true, offset: offset + (clock == "closed" ? 1 : 0), visiting: visiting)
                } else {
                    let extra = f == "closed" ? 1 : ["mean", "sum", "highest", "lowest", "stddev", "lag", "change"].contains(f) ? try FilterParser.integer(args[1], zero: f == "lag") : 0
                    for argument in args { try scan(argument, reference: reference, offset: offset + extra, visiting: visiting) }
                }
            default: break
            }
        }
        func node(_ value: FilterNode, offset: Int) throws {
            let next = offset + (value.mode == "closed" ? 1 : 0)
            let window = ["every", "recent", "count", "sequence", "cooldown"].contains(value.kind) ? value.hours : ["crossup", "crossdown"].contains(value.kind) ? 1 : 0
            let expressions = ["condition", "crossup", "crossdown"].contains(value.kind) ? [value.left, value.right, value.upper] : []
            for source in expressions + value.captures.map(\.expression) {
                if let expression = compiled.expressions[source] { try scan(expression, reference: false, offset: next + window) }
            }
            for child in value.children { try node(child, offset: next + window) }
        }
        try node(compiled.config.root, offset: 0)
        compiled.metrics = own.metrics; compiled.needsStats = own.needsStats; compiled.needsQuotes = own.needsQuotes
        compiled.requiredHours = own.hours
        compiled.btcRequirements = btc; compiled.btcClocks = clocks
    }

    private func expressionUnit(_ expr: FilterExpression, visiting: Set<String> = []) -> String {
        func unit(_ x: FilterExpression) -> String { expressionUnit(x, visiting: visiting) }
        switch expr {
        case .number: return "constant"
        case .text: return "category"
        case .name(let name):
            if let def = compiled.definitions[name], !visiting.contains(name) { return expressionUnit(def, visiting: visiting.union([name])) }
            if let unit = captureUnits[name] { return unit }
            return FilterCatalog.metrics.first { $0.key == FilterCatalog.key(name) }?.unit ?? "captured value"
        case .unary(_, let x): return unit(x)
        case .binary(let op, let a, let b):
            let left = unit(a), right = unit(b)
            if op == "/", left == right { return "ratio" }
            if left == "constant" { return right }; if right == "constant" { return left }
            return left == right && ["+", "-"].contains(op) ? left : "\(left) \(op) \(right)"
        case .call(let name, let args):
            let f = name.lowercased()
            if f == "rsi" { return "0–100" }
            if f == "efficiency" { return "ratio" }
            if ["roc", "maroc", "change", "relativechange"].contains(f) { return "%" }
            if f == "extremeage" { return "hours" }
            if ["ema", "vwap", "priorextreme", "logbb"].contains(f) { return "USDT" }
            return args.first.map(unit) ?? "constant"
        }
    }

    private func expressionChoices(_ expression: FilterExpression, visiting: Set<String> = []) -> [FilterCatalog.Choice] {
        switch expression {
        case .name(let name):
            if let definition = compiled.definitions[name], !visiting.contains(name) {
                return expressionChoices(definition, visiting: visiting.union([name]))
            }
            return FilterCatalog.key(name).map(FilterCatalog.choices) ?? []
        case .call(let name, let arguments) where ["closed", "live", "btc"].contains(name.lowercased()):
            return arguments.first.map { expressionChoices($0, visiting: visiting) } ?? []
        default: return []
        }
    }

    private func editorExpression(_ expression: FilterExpression) -> FilterEditorExpression {
        var result = FilterEditorExpression(kind: "", source: expression.source, unit: expressionUnit(expression), choices: expressionChoices(expression))
        switch expression {
        case .number: result.kind = "number"; result.value = expression.source
        case .text(let value): result.kind = "text"; result.value = value
        case .name(let value): result.kind = "name"; result.value = value
        case .unary(let operation, let argument): result.kind = "unary"; result.operation = operation; result.arguments = [editorExpression(argument)]
        case .binary(let operation, let left, let right): result.kind = "binary"; result.operation = operation; result.arguments = [editorExpression(left), editorExpression(right)]
        case .call(let operation, let arguments): result.kind = "call"; result.operation = operation; result.arguments = arguments.map(editorExpression)
        }
        return result
    }

    private mutating func normalizeConfiguration() {
        let parsed = compiled.expressions
        func normalize(_ node: FilterNode) -> FilterNode {
            var next = node
            next.left = parsed[node.left]?.source ?? node.left; next.right = parsed[node.right]?.source ?? node.right; next.upper = parsed[node.upper]?.source ?? node.upper
            next.captures = node.captures.map { item in var value = item; value.expression = parsed[item.expression]?.source ?? item.expression; return value }
            next.children = node.children.map(normalize); return next
        }
        compiled.config.root = normalize(compiled.config.root)
        compiled.config.definitions = compiled.config.definitions.map { item in var value = item; value.expression = compiled.definitions[item.name]?.source ?? item.expression; return value }
        for expression in parsed.values { compiled.expressions[expression.source] = expression }
    }
}

extension FilterConfigV2 {
    mutating func reuseIdentities(_ previous: Self) {
        func reconcile(_ node: FilterNode, _ old: FilterNode?, stage: Bool = false) -> FilterNode {
            var value = node
            if let old, node.kind == old.kind {
                value.id = old.id
                // Formula syntax carries meaningful properties. Keep inactive
                // visual controls so a tab round trip does not erase their values.
                if !["condition", "crossup", "crossdown"].contains(node.kind) { value.left = old.left; value.right = old.right }
                if node.kind == "condition", ["present", "missing", "positive", "negative", "zero"].contains(node.comparison) { value.right = old.right }
                if node.comparison != "between" { value.upper = old.upper }
                if !["every", "recent", "count", "sequence", "cooldown"].contains(node.kind) { value.hours = old.hours }
                if node.kind != "count" { value.minimum = old.minimum }
                if !stage { value.gapHours = old.gapHours }
                value.captures = node.captures.map { item in var next = item; if let prior = old.captures.first(where: { $0.name == item.name }) { next.id = prior.id }; return next }
                var used = Set<String>()
                value.children = node.children.enumerated().map { index, child in
                    let prior = old.children.first { !used.contains($0.id) && $0.formula == child.formula }
                        ?? (old.children.indices.contains(index) && !used.contains(old.children[index].id) ? old.children[index] : nil)
                    if let prior { used.insert(prior.id) }; return reconcile(child, prior, stage: node.kind == "sequence")
                }
            }
            return value
        }
        root = reconcile(root, previous.root)
        definitions = definitions.map { item in var value = item; if let old = previous.definitions.first(where: { $0.name == item.name }) { value.id = old.id }; return value }
    }
}
