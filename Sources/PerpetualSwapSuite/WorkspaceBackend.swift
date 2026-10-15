import Foundation

actor WorkspaceBackend {
    let paths: AppPaths
    let settings: SettingsStore
    let store: ParquetMarketStore
    let market: MarketService
    let strategies: StrategyStore
    let backtests: BacktestService
    let dataSync: DataSyncService
    let ai: AIGateway
    let updater: AppUpdater
    private var refreshTask: Task<Void, Never>?

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
        dataSync = DataSyncService(store: marketStore)
        ai = AIGateway(credentialURL: paths.aiCredential, settings: settingsStore)
        updater = AppUpdater(cache: paths.cache)
        backtests = BacktestService(
            market: marketService, store: marketStore, settings: settingsStore,
            strategies: strategyStore, runtime: NodeStrategyRuntime(paths: paths, store: marketStore)
        )
    }

    func start() async {
        guard refreshTask == nil else { return }
        await market.refresh()
        if (await settings.current()).launchAtLogin { try? LoginItemController.apply(enabled: true) }
        refreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { break }
                await market.refresh()
            }
        }
    }

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
            try LoginItemController.apply(enabled: settings.launchAtLogin)
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
        case "syncStart":
            guard let instruments = request["instruments"] as? [String] else { throw BridgeError.invalidRequest }
            return try bridgeData(try await dataSync.start(instruments: instruments))
        case "syncStatus":
            return try bridgeData(await dataSync.status())
        case "syncCancel":
            return try bridgeData(await dataSync.cancel())
        case "aiStatus":
            return try bridgeData(await ai.status())
        case "aiSaveKey":
            return try bridgeData(try await ai.save(key: request["key"] as? String))
        case "aiFetch":
            guard let value = request["request"] else { throw BridgeError.invalidRequest }
            return try bridgeData(try await ai.fetch(decodeBridge(AIGatewayRequest.self, from: value)))
        case "updateCheck":
            return try bridgeData(try await updater.check())
        case "updateInstall":
            return try bridgeData(try await updater.install())
        default: throw BridgeError.unknownMethod(method)
        }
    }

    func prepareAutomaticUpdate() async -> Bool {
        guard (await settings.current()).automaticUpdatesEnabled else { return false }
        do {
            let checked = try await updater.check()
            guard checked.state == "available" else { return false }
            return try await updater.install().relaunchRequired
        } catch { return false }
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
