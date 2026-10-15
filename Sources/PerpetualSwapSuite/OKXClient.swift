import Foundation

actor RequestPacer {
    private var nextRequest = ContinuousClock.now

    func wait() async throws {
        let now = ContinuousClock.now
        if now < nextRequest { try await Task.sleep(until: nextRequest) }
        nextRequest = .now.advanced(by: .milliseconds(65))
    }
}

struct OKXClient: Sendable {
    private let session: URLSession
    private let pacer: RequestPacer
    private let baseURL = URL(string: "https://www.okx.com")!

    init(session: URLSession = .shared, pacer: RequestPacer = RequestPacer()) {
        self.session = session
        self.pacer = pacer
    }

    func instruments() async throws -> [Instrument] {
        let rows = try await request(path: "/api/v5/public/instruments", query: ["instType": "SWAP"])
        return rows.compactMap { row in
            guard let id = row.string("instId"), id != "USDC-USDT-SWAP",
                  let base = row.string("baseCcy") ?? id.split(separator: "-").first.map(String.init),
                  let quote = row.string("quoteCcy") ?? id.split(separator: "-").dropFirst().first.map(String.init),
                  let settle = row.string("settleCcy"),
                  let contractValue = row.double("ctVal"), let tick = row.double("tickSz"), let lot = row.double("lotSz")
            else { return nil }
            return Instrument(
                id: id, baseCurrency: base, quoteCurrency: quote, settlementCurrency: settle,
                contractValue: contractValue, contractValueCurrency: row.string("ctValCcy") ?? base,
                tickSize: tick, lotSize: lot, listedAt: row.int64("listTime"), state: row.string("state") ?? ""
            )
        }
    }

    func tickers() async throws -> [String: OKXTicker] {
        let rows = try await request(path: "/api/v5/market/tickers", query: ["instType": "SWAP"])
        return Dictionary(uniqueKeysWithValues: rows.compactMap { row in
            guard let id = row.string("instId") else { return nil }
            let ticker = OKXTicker(
                instrument: id, last: row.double("last"), open24h: row.double("open24h"),
                volumeBase24h: row.double("volCcy24h"), bid: row.double("bidPx"), ask: row.double("askPx"),
                timestamp: row.int64("ts") ?? unixMilliseconds()
            )
            return (id, ticker)
        })
    }

    func openInterest() async throws -> [String: Double] {
        let rows = try await request(path: "/api/v5/public/open-interest", query: ["instType": "SWAP"])
        return Dictionary(uniqueKeysWithValues: rows.compactMap { row in
            guard let id = row.string("instId") else { return nil }
            return (id, row.double("oiUsd") ?? 0)
        })
    }

    func fundingRate(instrument: String) async throws -> Double? {
        try await request(path: "/api/v5/public/funding-rate", query: ["instId": instrument]).first?.double("fundingRate")
    }

    func orderBook(instrument: String, depth: Int = 400) async throws -> OrderBook {
        let rows = try await request(path: "/api/v5/market/books", query: ["instId": instrument, "sz": String(depth)])
        guard let row = rows.first else { throw OKXError.invalidResponse("Order book is empty") }
        return OrderBook(
            instrument: instrument,
            timestamp: row.int64("ts") ?? unixMilliseconds(),
            bids: row.levels("bids"), asks: row.levels("asks")
        )
    }

    func candles(instrument: String, before: Int64? = nil, after: Int64? = nil, limit: Int = 300) async throws -> [Candle] {
        var query = ["instId": instrument, "bar": "5m", "limit": String(min(300, max(1, limit)))]
        if let before { query["before"] = String(before) }
        if let after { query["after"] = String(after) }
        let data = try await requestRaw(path: "/api/v5/market/history-candles", query: query)
        return data.compactMap { value in
            guard let row = value as? [Any], row.count >= 9,
                  let timestamp = Self.int64(row[0]), let open = Self.double(row[1]), let high = Self.double(row[2]),
                  let low = Self.double(row[3]), let close = Self.double(row[4]), let contracts = Self.double(row[5])
            else { return nil }
            return Candle(
                instrument: instrument, timestamp: timestamp, open: open, high: high, low: low, close: close,
                volumeContracts: contracts, volumeBase: Self.double(row[6]), volumeQuote: Self.double(row[7]),
                confirmed: Self.int64(row[8]) == 1
            )
        }.sorted { $0.timestamp < $1.timestamp }
    }

    private func request(path: String, query: [String: String]) async throws -> [JSONObject] {
        try await requestRaw(path: path, query: query).compactMap { $0 as? JSONObject }
    }

    private func requestRaw(path: String, query: [String: String]) async throws -> [Any] {
        try await pacer.wait()
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.sorted { $0.key < $1.key }.map(URLQueryItem.init)
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 30
        request.setValue("PerpetualSwapSuite/1", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw OKXError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? JSONObject,
              envelope.string("code") == "0", let rows = envelope["data"] as? [Any]
        else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? JSONObject)?.string("msg")
            throw OKXError.invalidResponse(message ?? "Unknown OKX response")
        }
        return rows
    }

    private static func double(_ value: Any) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        return (value as? String).flatMap(Double.init)
    }

    private static func int64(_ value: Any) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? NSNumber { return value.int64Value }
        return (value as? String).flatMap(Int64.init)
    }
}

typealias JSONObject = [String: Any]

private extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }
    func double(_ key: String) -> Double? {
        if let value = self[key] as? Double { return value }
        if let value = self[key] as? NSNumber { return value.doubleValue }
        return (self[key] as? String).flatMap(Double.init)
    }
    func int64(_ key: String) -> Int64? {
        if let value = self[key] as? Int64 { return value }
        if let value = self[key] as? NSNumber { return value.int64Value }
        return (self[key] as? String).flatMap(Int64.init)
    }
    func levels(_ key: String) -> [BookLevel] {
        (self[key] as? [[Any]] ?? []).compactMap { row in
            guard row.count >= 2, let price = OKXClientValue.double(row[0]), let size = OKXClientValue.double(row[1]) else { return nil }
            return .init(price: price, sizeContracts: size)
        }
    }
}

private enum OKXClientValue {
    static func double(_ value: Any) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        return (value as? String).flatMap(Double.init)
    }
}

struct OKXTicker: Sendable {
    let instrument: String
    let last: Double?
    let open24h: Double?
    let volumeBase24h: Double?
    let bid: Double?
    let ask: Double?
    let timestamp: Int64
}

enum OKXError: LocalizedError {
    case http(Int)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .http(let status): "OKX returned HTTP \(status)."
        case .invalidResponse(let message): "OKX returned invalid data: \(message)"
        }
    }
}
