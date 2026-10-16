import Foundation

struct FilterLibraryPreferences: Codable, Sendable, Equatable {
    var favorites: [String] = []
    var recent: [String] = []
    var layout = "sentences"
    var snapshot: [String: Any] { ["favorites": favorites, "recent": recent, "layout": layout] }
    var json: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try! encoder.encode(self), as: UTF8.self)
    }

    static func decode(_ json: String) throws -> Self {
        let result = try JSONDecoder().decode(Self.self, from: Data(json.utf8))
        guard ["sentences", "guided"].contains(result.layout), result.favorites.count <= 100, result.recent.count <= 12,
              (result.favorites + result.recent).allSatisfy({ !$0.isEmpty && $0.count <= 120 }),
              Set(result.favorites).count == result.favorites.count, Set(result.recent).count == result.recent.count else {
            throw FilterError("Invalid condition library preferences.")
        }
        return result
    }
}
