import Foundation

struct AppPaths: Sendable {
    let root: URL
    let market: URL
    let candles: URL
    let strategies: URL
    let cache: URL
    let settings: URL
    let catalog: URL

    init(root: URL? = nil) throws {
        let base = try root ?? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("Perpetual Swap Suite", isDirectory: true)
        self.root = base
        market = base.appendingPathComponent("Market", isDirectory: true)
        candles = market.appendingPathComponent("Candles", isDirectory: true)
        strategies = base.appendingPathComponent("Strategies", isDirectory: true)
        cache = base.appendingPathComponent("Cache", isDirectory: true)
        settings = base.appendingPathComponent("settings.json")
        catalog = market.appendingPathComponent("catalog.duckdb")

        for directory in [base, market, candles, strategies, cache] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }
}
