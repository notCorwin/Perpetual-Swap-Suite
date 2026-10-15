import Foundation

struct StrategySummary: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let modifiedAt: Int64
}

struct StrategyDocument: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let source: String
    let modifiedAt: Int64
}

enum StrategyDirection: String, Codable, Sendable { case long, short }
enum OrderSide: String, Codable, Sendable { case buy, sell }
enum OrderKind: String, Codable, Sendable { case market, limit, stop, stopLimit }

struct StrategyCommand: Codable, Hashable, Sendable {
    enum Action: String, Codable, Sendable {
        case entry, order, exit, close, cancel, cancelAll, amend
    }

    let action: Action
    let id: String?
    let direction: StrategyDirection?
    let side: OrderSide?
    let type: OrderKind?
    let quantity: Double?
    let marginUSDT: Double?
    let leverage: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let reduceOnly: Bool?
    let ocaGroup: String?
}

struct StrategyBar: Codable, Hashable, Sendable {
    var timestamp: Int64
    var open: Double
    var high: Double
    var low: Double
    var close: Double
    var volume: Double
    var confirmed: Bool
}

struct StrategyPositionSnapshot: Codable, Hashable, Sendable {
    let direction: StrategyDirection
    let quantityContracts: Double
    let entryPrice: Double
    let leverage: Double
    let unrealizedPnLUSDT: Double
    let marginUSDT: Double
}

struct StrategyAccountSnapshot: Codable, Hashable, Sendable {
    let balanceUSDT: Double
    let equityUSDT: Double
    let availableUSDT: Double
    let feesUSDT: Double
    let fundingUSDT: Double
}

struct StrategyEvent: Codable, Hashable, Sendable {
    enum Reason: String, Codable, Sendable { case historyTick, barClose, orderFill }
    let reason: Reason
    let instrument: String
    let timeframe: Timeframe
    let timestamp: Int64
    let price: Double
    let bar: StrategyBar
    let position: StrategyPositionSnapshot?
    let account: StrategyAccountSnapshot
    let settings: AppSettings
}

struct StrategyExecutionOptions: Codable, Hashable, Sendable {
    var onHistoryTick = false
    var onOrderFill = false
    var processOrdersOnClose = false
    var verifyLimitTicks = 0
}

struct BacktestRequest: Codable, Hashable, Sendable {
    let strategyID: String
    let instrument: String
    let timeframe: Timeframe
    let from: Int64?
    let through: Int64?
    let execution: StrategyExecutionOptions
}

struct BacktestTrade: Codable, Hashable, Sendable {
    let id: String
    let direction: StrategyDirection
    let entryAt: Int64
    let exitAt: Int64
    let entryPrice: Double
    let exitPrice: Double
    let quantityContracts: Double
    let grossPnLUSDT: Double
    let feesUSDT: Double
    let fundingUSDT: Double
    let netPnLUSDT: Double
    let returnOnMarginPercent: Double
    let durationMS: Int64
    let maximumAdverseExcursionPercent: Double
    let maximumFavorableExcursionPercent: Double
    let exitReason: String
    let liquidated: Bool
}

struct BacktestMarker: Codable, Hashable, Sendable {
    let timestamp: Int64
    let price: Double
    let kind: String
    let label: String
}

struct BacktestReport: Codable, Sendable {
    let strategyID: String
    let instrument: String
    let timeframe: Timeframe
    let from: Int64?
    let through: Int64?
    let initialCapitalUSDT: Double
    let finalEquityUSDT: Double
    let netProfitUSDT: Double
    let returnPercent: Double
    let winRatePercent: Double
    let maximumDrawdownPercent: Double
    let totalTrades: Int
    let winningTrades: Int
    let losingTrades: Int
    let liquidations: Int
    let trades: [BacktestTrade]
    let markers: [BacktestMarker]
    let warnings: [String]
    let elapsedMS: Int64
}
