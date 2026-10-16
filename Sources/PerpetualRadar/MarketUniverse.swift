import Foundation

struct SwapInstrument: Equatable, Sendable {
    var id: String
    var listedAt: Int64?
}

func liveUSDTInstruments(_ items: [Any]) -> [String: SwapInstrument] {
    var instruments: [String: SwapInstrument] = [:]
    for case let item as [String: Any] in items {
        guard item["state"] as? String == "live", item["instCategory"] as? String == "1",
              item["settleCcy"] as? String == "USDT", let id = item["instId"] as? String,
              id.hasSuffix("-USDT-SWAP") else { continue }
        let listedAt = (item["listTime"] as? String).flatMap(Int64.init).flatMap { $0 > 0 ? $0 : nil }
        instruments[id] = SwapInstrument(id: id, listedAt: listedAt)
    }
    return instruments
}
