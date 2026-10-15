import Foundation

enum Timeframe: String, Codable, CaseIterable, Sendable {
    case fiveMinutes = "5m"
    case fifteenMinutes = "15m"
    case thirtyMinutes = "30m"
    case oneHour = "1H"
    case fourHours = "4H"
    case oneDay = "1D"

    var milliseconds: Int64 {
        switch self {
        case .fiveMinutes: 5 * 60 * 1_000
        case .fifteenMinutes: 15 * 60 * 1_000
        case .thirtyMinutes: 30 * 60 * 1_000
        case .oneHour: 60 * 60 * 1_000
        case .fourHours: 4 * 60 * 60 * 1_000
        case .oneDay: 24 * 60 * 60 * 1_000
        }
    }

    var sourceBarCount: Int { Int(milliseconds / Timeframe.fiveMinutes.milliseconds) }
}

struct Candle: Codable, Hashable, Sendable {
    let instrument: String
    let timestamp: Int64
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volumeContracts: Double
    let volumeBase: Double?
    let volumeQuote: Double?
    let confirmed: Bool
}

struct Instrument: Codable, Hashable, Sendable {
    let id: String
    let baseCurrency: String
    let quoteCurrency: String
    let settlementCurrency: String
    let contractValue: Double
    let contractValueCurrency: String
    let tickSize: Double
    let lotSize: Double
    let listedAt: Int64?
    let state: String
}

struct BookLevel: Codable, Hashable, Sendable {
    let price: Double
    let sizeContracts: Double
}

struct OrderBook: Codable, Hashable, Sendable {
    let instrument: String
    let timestamp: Int64
    let bids: [BookLevel]
    let asks: [BookLevel]
}

struct LiquidityReading: Codable, Hashable, Sendable {
    let spreadPercent: Double?
    let bidDepthUSDT: Double?
    let askDepthUSDT: Double?
    let buySlippagePercent: Double?
    let sellSlippagePercent: Double?
}

struct MarketSummary: Codable, Hashable, Sendable {
    let instrument: Instrument
    let last: Double?
    let change24hPercent: Double?
    let volume24hUSDT: Double?
    let openInterestUSDT: Double?
    let fundingRatePercent: Double?
    let liquidity: LiquidityReading
    let eligible: Bool
    let missingRequirements: [String]
    let updatedAt: Int64
}

struct DataCoverage: Codable, Hashable, Sendable {
    let instrument: String
    let from: Int64?
    let through: Int64?
    let candleCount: Int
    let gaps: Int
}

struct WorkspaceSnapshot: Codable, Sendable {
    let markets: [MarketSummary]
    let selectedInstrument: String?
    let candles: [Candle]
    let formingCandle: Candle?
    let coverage: DataCoverage?
    let settings: AppSettings
    let status: String
    let error: String?
    let updatedAt: Int64
}

struct LiquidityCalculator: Sendable {
    static func reading(
        book: OrderBook,
        instrument: Instrument,
        depthRangePercent: Double,
        slippageNotionalUSDT: Double
    ) -> LiquidityReading {
        guard let bestBid = book.bids.first?.price,
              let bestAsk = book.asks.first?.price,
              bestBid > 0, bestAsk >= bestBid
        else { return .init(spreadPercent: nil, bidDepthUSDT: nil, askDepthUSDT: nil, buySlippagePercent: nil, sellSlippagePercent: nil) }

        let mid = (bestBid + bestAsk) / 2
        let spread = signedRelativeChange(current: bestAsk, baseline: bestBid)
        let fraction = depthRangePercent / 100
        let bidFloor = mid * (1 - fraction)
        let askCeiling = mid * (1 + fraction)
        let bidDepth = book.bids.filter { $0.price >= bidFloor }.reduce(0) {
            $0 + notional(level: $1, instrument: instrument)
        }
        let askDepth = book.asks.filter { $0.price <= askCeiling }.reduce(0) {
            $0 + notional(level: $1, instrument: instrument)
        }
        return .init(
            spreadPercent: spread,
            bidDepthUSDT: bidDepth,
            askDepthUSDT: askDepth,
            buySlippagePercent: slippage(levels: book.asks, target: slippageNotionalUSDT, mid: mid, instrument: instrument, buying: true),
            sellSlippagePercent: slippage(levels: book.bids, target: slippageNotionalUSDT, mid: mid, instrument: instrument, buying: false)
        )
    }

    private static func notional(level: BookLevel, instrument: Instrument) -> Double {
        let value = level.sizeContracts * instrument.contractValue
        return instrument.contractValueCurrency == instrument.settlementCurrency ? value : value * level.price
    }

    private static func slippage(
        levels: [BookLevel], target: Double, mid: Double, instrument: Instrument, buying: Bool
    ) -> Double? {
        guard target > 0 else { return 0 }
        var remaining = target
        var quantity = 0.0
        var paid = 0.0
        for level in levels where remaining > 0 {
            let availableNotional = notional(level: level, instrument: instrument)
            let usedNotional = min(remaining, availableNotional)
            let usedQuantity = usedNotional / level.price
            quantity += usedQuantity
            paid += usedQuantity * level.price
            remaining -= usedNotional
        }
        guard remaining <= max(0.01, target * 0.000_001), quantity > 0 else { return nil }
        let average = paid / quantity
        let raw = signedRelativeChange(current: average, baseline: mid)
        return buying ? raw : -raw
    }
}

func signedRelativeChange(current: Double, baseline: Double) -> Double {
    guard baseline != 0 else { return 0 }
    return (current - baseline) / baseline * 100
}

func unixMilliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
