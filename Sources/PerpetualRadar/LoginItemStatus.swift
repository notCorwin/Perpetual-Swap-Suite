import Foundation
import ServiceManagement

// ServiceManagement's status getter makes a synchronous system-service request.
// Menus and market replies use this cache; refreshes never occupy the main actor.
@MainActor
final class LoginItemStatus {
    private(set) var value = "unavailable"
    private let read: @Sendable () -> String
    private let refreshInterval: Duration
    private var refreshedAt: ContinuousClock.Instant?
    private var generation = 0
    private var request: (generation: Int, task: Task<String, Never>)?

    init(refreshInterval: Duration = .seconds(5), read: @escaping @Sendable () -> String = LoginItemStatus.systemStatus) {
        self.refreshInterval = refreshInterval; self.read = read
    }

    func refresh(force: Bool = false) async -> String {
        if request == nil {
            if !force, let refreshedAt, refreshedAt.duration(to: .now) < refreshInterval { return value }
            generation += 1
            let read = read
            request = (generation, Task.detached(priority: .utility) { read() })
        }
        guard let current = request else { return value }
        let status = await current.task.value
        if request?.generation == current.generation {
            value = status; refreshedAt = .now; request = nil
        }
        return value
    }

    nonisolated private static func systemStatus() -> String {
        switch SMAppService.loginItem(identifier: MonitorRuntime.helperIdentifier).status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered: return "disabled"
        default: return "unavailable"
        }
    }
}
