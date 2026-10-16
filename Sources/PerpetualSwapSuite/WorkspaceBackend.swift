import Foundation

actor WorkspaceBackend {
    let paths: AppPaths
    let settings: SettingsStore
    let store: ParquetMarketStore
    let market: MarketService

    init(root: URL? = nil) throws {
        paths = try AppPaths(root: root)
        settings = try SettingsStore(url: paths.settings)
        store = try ParquetMarketStore(paths: paths)
        market = MarketService(store: store, settings: settings)
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
