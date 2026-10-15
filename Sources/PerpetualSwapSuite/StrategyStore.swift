import Foundation

actor StrategyStore {
    private let directory: URL

    init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        if !files.contains(where: { $0.pathExtension == "mjs" }) {
            try Self.exampleSource.write(to: directory.appendingPathComponent("ema-trend-entry.mjs"), atomically: true, encoding: .utf8)
        }
    }

    func list() throws -> [StrategySummary] {
        try strategyURLs().map { url in
            let values = try url.resourceValues(forKeys: [.contentModificationDateKey])
            return StrategySummary(
                id: url.deletingPathExtension().lastPathComponent,
                name: Self.displayName(from: url.deletingPathExtension().lastPathComponent),
                modifiedAt: Int64((values.contentModificationDate ?? .distantPast).timeIntervalSince1970 * 1_000)
            )
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func read(id: String) throws -> StrategyDocument {
        let url = try strategyURL(id: id)
        let source = try String(contentsOf: url, encoding: .utf8)
        let modified = try url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast
        return .init(id: id, name: Self.displayName(from: id), source: source, modifiedAt: Int64(modified.timeIntervalSince1970 * 1_000))
    }

    func save(id: String?, name: String, source: String) throws -> StrategyDocument {
        let strategyID = try id.map(Self.validatedID) ?? Self.slug(name)
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw StrategyStoreError.emptySource }
        let url = try strategyURL(id: strategyID)
        try source.write(to: url, atomically: true, encoding: .utf8)
        return try read(id: strategyID)
    }

    func fileURL(id: String) throws -> URL { try strategyURL(id: id) }

    private func strategyURLs() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter { $0.pathExtension == "mjs" && !$0.lastPathComponent.hasPrefix(".") }
    }

    private func strategyURL(id: String) throws -> URL {
        let safe = try Self.validatedID(id)
        return directory.appendingPathComponent(safe).appendingPathExtension("mjs")
    }

    private static func validatedID(_ id: String) throws -> String {
        guard !id.isEmpty, id.count <= 80,
              id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_" )).contains($0) })
        else { throw StrategyStoreError.invalidName }
        return id
    }

    private static func slug(_ name: String) -> String {
        let slug = String(name.lowercased().map { character -> Character in
            character.isLetter || character.isNumber ? character : "-"
        }.split(separator: "-").filter { !$0.isEmpty }.joined(separator: "-"))
        return slug.isEmpty ? "strategy-\(Int(Date().timeIntervalSince1970))" : String(slug.prefix(80))
    }

    private static func displayName(from id: String) -> String {
        id.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    private static let exampleSource = """
        export const metadata = {
          name: 'EMA Trend Entry',
          description: 'Enters with the trend after EMA 20 crosses EMA 50.'
        }

        export async function onTick(context) {
          if (!context.bar.confirmed || context.position) return

          const fast = context.indicators.ema(20)
          const slow = context.indicators.ema(50)
          const previousFast = context.indicators.ema(20, 1)
          const previousSlow = context.indicators.ema(50, 1)
          if ([fast, slow, previousFast, previousSlow].some(value => value == null)) return

          if (previousFast <= previousSlow && fast > slow) {
            strategy.entry('EMA Long', strategy.long, { marginUSDT: context.settings.initialCapitalUSDT })
          } else if (previousFast >= previousSlow && fast < slow) {
            strategy.entry('EMA Short', strategy.short, { marginUSDT: context.settings.initialCapitalUSDT })
          }
        }
        """
}

enum StrategyStoreError: LocalizedError {
    case invalidName, emptySource
    var errorDescription: String? {
        switch self {
        case .invalidName: "Strategy names may contain only letters, numbers, dashes, and underscores."
        case .emptySource: "Strategy source cannot be empty."
        }
    }
}
