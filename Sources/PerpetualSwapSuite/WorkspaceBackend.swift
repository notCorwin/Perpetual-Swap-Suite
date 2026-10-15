import Foundation

actor WorkspaceBackend {
    let paths: AppPaths
    let settings: SettingsStore
    let store: ParquetMarketStore
    let market: MarketService
    let strategies: StrategyStore
    let backtests: BacktestService

    init(root: URL? = nil) throws {
        paths = try AppPaths(root: root)
        let settingsStore = try SettingsStore(url: paths.settings)
        let marketStore = try ParquetMarketStore(paths: paths)
        let marketService = MarketService(store: marketStore, settings: settingsStore)
        let strategyStore = try StrategyStore(directory: paths.strategies)
        settings = settingsStore
        store = marketStore
        market = marketService
        strategies = strategyStore
        backtests = BacktestService(
            market: marketService, store: marketStore, settings: settingsStore,
            strategies: strategyStore, runtime: NodeStrategyRuntime(paths: paths, store: marketStore)
        )
    }

    func start() async { await market.refresh() }

    func handle(_ request: [String: Any]) async throws -> Data {
        let method = request["method"] as? String ?? "snapshot"
        switch method {
        case "snapshot":
            return try bridgeData(await market.snapshot(instrument: request["instrument"] as? String))
        case "refresh":
            await market.refresh(selectedInstrument: request["instrument"] as? String)
            return try bridgeData(await market.snapshot(instrument: request["instrument"] as? String))
        case "select":
            guard let instrument = request["instrument"] as? String else { throw BridgeError.invalidRequest }
            return try bridgeData(try await market.select(instrument))
        case "settings":
            guard let object = request["settings"] else { throw BridgeError.invalidRequest }
            let settings = try decodeBridge(AppSettings.self, from: object)
            return try bridgeData(try await market.updateSettings(settings))
        case "validate":
            return try bridgeData(try await market.validateData())
        case "query":
            guard let sql = request["sql"] as? String else { throw BridgeError.invalidRequest }
            return try bridgeData(try await market.query(sql))
        case "strategyList":
            return try bridgeData(try await strategies.list())
        case "strategyRead":
            guard let id = request["id"] as? String else { throw BridgeError.invalidRequest }
            return try bridgeData(try await strategies.read(id: id))
        case "strategySave":
            guard let name = request["name"] as? String, let source = request["source"] as? String else { throw BridgeError.invalidRequest }
            return try bridgeData(try await strategies.save(id: request["id"] as? String, name: name, source: source))
        case "backtest":
            guard let value = request["backtest"] else { throw BridgeError.invalidRequest }
            return try bridgeData(try await backtests.run(decodeBridge(BacktestRequest.self, from: value)))
        default: throw BridgeError.unknownMethod(method)
        }
    }
}

func bridgeData<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

func decodeBridge<T: Decodable>(_ type: T.Type, from value: Any) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
}

enum BridgeError: LocalizedError {
    case invalidRequest
    case unknownMethod(String)

    var errorDescription: String? {
        switch self {
        case .invalidRequest: "The native request is incomplete."
        case .unknownMethod(let method): "Unknown native method: \(method)"
        }
    }
}
