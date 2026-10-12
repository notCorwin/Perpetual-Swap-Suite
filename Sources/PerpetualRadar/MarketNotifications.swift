import Foundation
import UserNotifications

enum RadarNotificationRoute {
    static func url(strategy id: String) -> URL? { URL(string: "perpetualradar://strategy/\(id)") }
    static func url(contract id: String) -> URL? { URL(string: "perpetualradar://contract/\(id)") }
    static func strategy(in url: URL) -> String? {
        guard url.scheme == "perpetualradar", url.host == "strategy", url.pathComponents.count == 2 else { return nil }
        let id = url.lastPathComponent
        return !id.isEmpty && id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) ? id : nil
    }
    static func contract(in url: URL) -> String? {
        guard url.scheme == "perpetualradar", url.host == "contract", url.pathComponents.count == 2 else { return nil }
        let id = url.lastPathComponent
        guard id.hasSuffix("-USDT-SWAP"), id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
        return id
    }
}

enum MarketNotificationAuthorization: String, Sendable {
    case notDetermined, denied, authorized, quiet, unavailable
    var canDeliver: Bool { self == .authorized || self == .quiet }
}

@MainActor
protocol MarketNotificationTransport {
    func authorization() async -> MarketNotificationAuthorization
    func requestAuthorization() async throws
    func add(_ request: UNNotificationRequest) async throws
}

@MainActor
struct SystemMarketNotificationTransport: MarketNotificationTransport {
    let center: UNUserNotificationCenter
    func authorization() async -> MarketNotificationAuthorization {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized, .provisional: return settings.alertSetting == .enabled ? .authorized : .quiet
        default: return .unavailable
        }
    }
    func requestAuthorization() async throws { _ = try await center.requestAuthorization(options: [.alert, .sound]) }
    func add(_ request: UNNotificationRequest) async throws { try await center.add(request) }
}

@MainActor
final class MarketNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let transport: any MarketNotificationTransport
    private let enabled: () -> Bool
    var onOpen: ((String?) -> Void)?
    var onOpenStrategy: ((String) -> Void)?
    var onStateChanged: (() -> Void)?
    private(set) var authorization = MarketNotificationAuthorization.notDetermined
    private(set) var error = ""

    init(transport: any MarketNotificationTransport, enabled: @escaping () -> Bool) {
        self.transport = transport; self.enabled = enabled
    }

    func refresh(requestPermission: Bool = false) async {
        authorization = await transport.authorization()
        if requestPermission, authorization == .notDetermined {
            do { try await transport.requestAuthorization(); error = "" }
            catch { self.error = "Cannot request notification permission: \(error.localizedDescription)" }
            authorization = await transport.authorization()
        }
        onStateChanged?()
    }

    func send(_ changes: [FilterMembershipChange]) async {
        guard enabled(), !changes.isEmpty else { return }
        await refresh()
        guard enabled(), authorization.canDeliver else { return }
        for change in changes {
            guard enabled(), !Task.isCancelled else { return }
            let content = UNMutableNotificationContent()
            content.title = change.direction == .entered ? "Strategy signal confirmed" : "Strategy signal ended"
            let parts = change.instId.split(separator: "|").map(String.init), instrument = parts[0], phase = parts.count > 1 ? parts[1] : nil
            content.subtitle = instrument
            if let phase { content.title = phase + (change.direction == .entered ? " · Confirmed" : " · Ended") }
            content.body = change.direction == .entered
                ? "This OKX USDT perpetual swap now matches the active saved 1h strategy."
                : "This OKX USDT perpetual swap no longer matches the active saved 1h strategy or has left the exchange universe."
            if let phase { content.body = "\(instrument) · \(phase) at the completed 1h close. Inspect your Bullish Setup rules and signal evidence in Radar." }
            content.sound = .default
            content.threadIdentifier = "saved-strategy-signals"
            content.userInfo = ["instId": instrument, "direction": change.direction.rawValue]
            await deliver(content)
        }
    }

    func sendTest() async {
        await refresh(requestPermission: true)
        guard authorization.canDeliver else { return }
        let content = UNMutableNotificationContent()
        content.title = "Perpetual Swap Suite"
        content.body = "Strategy notifications are working. Monitoring continues after closing the window or quitting the interface with Cmd+Q."
        content.sound = .default
        await deliver(content)
    }
    private func deliver(_ content: UNMutableNotificationContent) async {
        do {
            try await transport.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            error = ""
        } catch { self.error = "Cannot send notification: \(error.localizedDescription)" }
        onStateChanged?()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            let instId = response.notification.request.content.userInfo["instId"] as? String
            let strategyID = response.notification.request.content.userInfo["strategyID"] as? String
            Task { @MainActor [weak self] in
                if let strategyID { self?.onOpenStrategy?(strategyID) } else { self?.onOpen?(instId) }
            }
        }
        completionHandler()
    }
}
