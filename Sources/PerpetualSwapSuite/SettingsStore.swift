import Foundation

struct AppSettings: Codable, Equatable, Hashable, Sendable {
    var settlementCurrencies = ["USDT"]
    var spreadLimitPercent = 0.05
    var depthRangePercent = 0.5
    var minimumSideDepthUSDT = 100_000.0
    var slippageLimitPercent = 0.10
    var slippageNotionalUSDT = 100_000.0
    var minimumVolume24hUSDT = 30_000_000.0
    var minimumOpenInterestUSDT = 5_000_000.0
    var volumeStabilityEnabled = false
    var maximumHourlyVolumeRatio = 2.0
    var initialCapitalUSDT = 300.0
    var leverage = 10.0
    var takeProfitMarginPercent = 10.0
    var stopLossMarginPercent = 10.0
    var takerFeePercent = 0.05
    var slippageTicks = 1
    var selectedTimeframe = Timeframe.fiveMinutes
    var selectedInstrument = "BTC-USDT-SWAP"
    var backgroundEnabled = true
    var launchAtLogin = false
    var appearance = "dark"
    var automaticUpdatesEnabled = true
    var aiBaseURL = "https://api.openai.com/v1"
    var aiModel = ""
}

actor SettingsStore {
    private let url: URL
    private var value: AppSettings
    private let encoder: JSONEncoder

    init(url: URL) throws {
        self.url = url
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if FileManager.default.fileExists(atPath: url.path) {
            value = try JSONDecoder().decode(AppSettings.self, from: Data(contentsOf: url))
        } else {
            value = AppSettings()
            try Self.write(value, to: url, encoder: encoder)
        }
    }

    func current() -> AppSettings { value }

    func replace(with settings: AppSettings) throws -> AppSettings {
        value = settings
        try Self.write(settings, to: url, encoder: encoder)
        return value
    }

    func update(_ change: @Sendable (inout AppSettings) -> Void) throws -> AppSettings {
        change(&value)
        try Self.write(value, to: url, encoder: encoder)
        return value
    }

    private static func write(_ settings: AppSettings, to url: URL, encoder: JSONEncoder) throws {
        try encoder.encode(settings).write(to: url, options: [.atomic])
    }
}
