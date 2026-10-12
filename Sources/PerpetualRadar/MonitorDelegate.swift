import AppKit
import ServiceManagement
import UserNotifications

@MainActor
final class MonitorDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let symbolName = "dot.radiowaves.left.and.right"
    private var server: MonitorIPCServer?
    private let collector = RecoveringResource(label: "Cannot open local cache") {
        try Radar(defaults: MonitorRuntime.defaults, storeURL: MonitorRuntime.storeURL)
    }
    private var radar: Radar? { collector.value }
    private var monitor: FilterMonitor?
    private var notifications: MarketNotifications?
    private var activity: NSObjectProtocol?
    private var statusItem: NSStatusItem?
    private var monitoringError = ""
    private var startupError: String { collector.error }
    private var loginError = ""
    private let sessionID = UUID().uuidString
    private let sourceRevision = Bundle.main.object(forInfoDictionaryKey: "CFBundleSourceRevision") as? String ?? "development"
    private let status = NSMenuItem(title: "Starting monitoring…", action: nil, keyEquivalent: "")
    private let permission = NSMenuItem(title: "Notifications: Permission needed", action: nil, keyEquivalent: "")
    private lazy var pauseItem = NSMenuItem(title: "Pause Monitoring", action: #selector(toggleMonitoring), keyEquivalent: "")
    private lazy var notificationsItem = NSMenuItem(title: "Strategy Notifications", action: #selector(toggleNotifications), keyEquivalent: "")
    private lazy var testItem = NSMenuItem(title: "Send Test Notification", action: #selector(sendTest), keyEquivalent: "")
    private lazy var loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
    private let injectedUpdater: (any AppUpdating)?
    private lazy var updater: any AppUpdating = injectedUpdater ?? AppUpdater(currentAppURL: MonitorRuntime.appURL)
    private let now: () -> Date
    private var updateTimer: Timer?
    private var updateState = "idle"
    private var update: AppUpdate?
    private var isCheckingUpdate = false
    private var isInstallingUpdate = false
    private var installingAutomatically = false
    private var isPresentingUpdate = false
    private var automaticInstallRetryAfter: Date?
    private var updateProgress: AppUpdateProgress?
    private var updateError = ""
    private lazy var checkUpdatesItem = NSMenuItem(title: "Check for Updates", action: #selector(checkForUpdatesNow), keyEquivalent: "")
    private lazy var automaticUpdatesItem = NSMenuItem(title: "Automatically Install Updates", action: #selector(toggleAutomaticUpdates), keyEquivalent: "")
    private var fixture: MonitorFixture?
    // Every open interface holds its own lease; several copies may share this monitor.
    private struct Lease { var workspace = "radar", researchBusy = false }
    private var leases: [Int32: Lease] = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_OWNER_PID"].flatMap(Int32.init).map { [$0: Lease()] } ?? [:]
    private var foregroundWorkspace: String { leases.values.contains { $0.workspace == "research" } ? "research" : "radar" }
    private var researchBusy: Bool { leases.values.contains(where: \.researchBusy) }
    private var leaseTimer: Timer?
    private var collectionAllowed: Bool { MonitorRuntime.backgroundMonitoringEnabled || !leases.isEmpty }

    init(updater: (any AppUpdating)? = nil, now: @escaping () -> Date = Date.init) {
        injectedUpdater = updater
        self.now = now
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            server = try MonitorIPCServer { [weak self] data in
                do {
                    guard let self, let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FilterError("Invalid background request.") }
                    return try SafeJSON.data(["value": try await handle(body)])
                } catch {
                    return (try? SafeJSON.data(["error": error.localizedDescription])) ?? Data("{}".utf8)
                }
            }
        } catch { NSApp.terminate(nil); return }
        _ = try? collector.get()
        if MonitorRuntime.testChannel != nil { fixture = MonitorFixture() }
        configureMenu()
        if let fixture {
            notifications = MarketNotifications(transport: fixture, enabled: { [weak self] in self?.radar?.notificationsEnabled == true })
        } else if Bundle.main.bundleURL.pathExtension == "app" {
            let center = UNUserNotificationCenter.current()
            let service = MarketNotifications(transport: SystemMarketNotificationTransport(center: center), enabled: { [weak self] in self?.radar?.notificationsEnabled == true })
            center.delegate = service; notifications = service
        }
        notifications?.onOpen = { [weak self] id in self?.openInterface(instId: id) }
        notifications?.onOpenStrategy = { [weak self] id in self?.openInterface(instId: nil, strategyID: id) }
        notifications?.onStateChanged = { [weak self] in self?.renderMenu() }
        Task { await notifications?.refresh() }
        Task {
            await refreshLoginStatus()
            if !MonitorRuntime.backgroundMonitoringEnabled, loginStatus == "enabled" || loginStatus == "requiresApproval" { try? await setLogin(false) }
        }
        reconcileMonitoring()
        let leaseTimer = Timer(timeInterval: 2, target: self, selector: #selector(checkForegroundLease), userInfo: nil, repeats: true)
        RunLoop.main.add(leaseTimer, forMode: .common); self.leaseTimer = leaseTimer
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(resumeAfterWake), name: NSWorkspace.didWakeNotification, object: nil)
        if ProcessInfo.processInfo.environment["PERPETUAL_RADAR_UPDATE_ROLLBACK"] == "1" { automaticInstallRetryAfter = now().addingTimeInterval(5 * 60) }
        if fixture == nil {
            let timer = Timer(timeInterval: 15, target: self, selector: #selector(checkForUpdatesAutomatically), userInfo: nil, repeats: true)
            RunLoop.main.add(timer, forMode: .common); updateTimer = timer
        }
        renderMenu(); MonitorRuntime.markReady()
    }

    func applicationWillTerminate(_ notification: Notification) {
        updateTimer?.invalidate(); updater.cancel()
        leaseTimer?.invalidate()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        stopMonitoring(); server?.invalidate()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    }

    private func configureMenu() {
        let menu = NSMenu(); menu.autoenablesItems = false; menu.delegate = self
        let show = NSMenuItem(title: "Show Perpetual Swap Suite", action: #selector(showInterface), keyEquivalent: "")
        show.target = self; menu.addItem(show); menu.addItem(.separator())
        status.isEnabled = false; permission.isEnabled = false
        menu.addItem(status); menu.addItem(permission)
        for item in [pauseItem, notificationsItem, testItem, loginItem] { item.target = self; menu.addItem(item) }
        let settings = NSMenuItem(title: "Notification Settings…", action: #selector(openNotificationSettings), keyEquivalent: "")
        settings.target = self; menu.addItem(settings); menu.addItem(.separator())
        for item in [checkUpdatesItem, automaticUpdatesItem] { item.target = self; menu.addItem(item) }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Completely", action: #selector(quitCompletely), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        // Process tests keep every native window and menu off the user's screen.
        guard fixture == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let image = NSImage(systemSymbolName: Self.symbolName, accessibilityDescription: "Perpetual Swap Suite")
        image?.isTemplate = true; item.button?.image = image
        item.menu = menu; statusItem = item
    }

    private let loginItemStatus = LoginItemStatus()
    private var loginStatusAvailable: Bool { Bundle.main.bundleURL.pathExtension == "app" && fixture == nil }
    private var loginStatus: String { loginStatusAvailable ? loginItemStatus.value : "unavailable" }

    private func refreshLoginStatus(force: Bool = false) async {
        guard loginStatusAvailable else { return }
        _ = await loginItemStatus.refresh(force: force)
        renderMenu()
    }

    private func renderMenu() {
        let paused = radar?.monitoringPaused == true || !collectionAllowed
        status.title = paused ? "Monitoring paused" : (!startupError.isEmpty || !monitoringError.isEmpty ? "Monitoring unavailable; retrying" : ((try? radar?.monitoringStrategy()) != nil ? "Monitoring active strategy · 1h" : "No active strategy · 1h"))
        pauseItem.title = paused ? "Resume Monitoring" : "Pause Monitoring"; pauseItem.isEnabled = radar != nil
        let state = notifications?.authorization ?? .unavailable
        let labels: [MarketNotificationAuthorization: String] = [.notDetermined: "Permission needed", .denied: "Blocked in System Settings", .authorized: "Allowed", .quiet: "Banners disabled in System Settings", .unavailable: "Launch the packaged app"]
        permission.title = "Notifications: \(labels[state] ?? "Unavailable")"
        notificationsItem.state = radar?.notificationsEnabled == true ? .on : .off; notificationsItem.isEnabled = radar != nil
        testItem.isEnabled = state.canDeliver
        loginItem.state = loginStatus == "enabled" ? .on : loginStatus == "requiresApproval" ? .mixed : .off
        loginItem.title = loginStatus == "requiresApproval" ? "Start at Login · Approval Needed…" : "Start at Login"
        loginItem.isEnabled = MonitorRuntime.backgroundMonitoringEnabled && loginStatus != "unavailable"
        statusItem?.button?.toolTip = "Perpetual Swap Suite · \(paused ? "Monitoring paused" : "Background monitoring")"
        renderUpdateItem()
        automaticUpdatesItem.state = AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults) ? .on : .off
    }

    func menuWillOpen(_ menu: NSMenu) {
        renderMenu()
        Task { await refreshLoginStatus(force: true); await notifications?.refresh() }
    }

    private func startMonitoring() {
        guard let radar, monitor == nil, collectionAllowed else { return }
        if fixture == nil { radar.start() }
        activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Monitor OKX contracts and deliver strategy notifications after the interface quits")
        monitor = FilterMonitor(interval: fixture == nil ? .seconds(2) : .milliseconds(100), sample: { [weak self] in
            guard let self, let radar = self.radar else { return nil }
            if let fixture { return try await fixture.observe(profile: radar.monitoringStrategy()) }
            return try await radar.observeSavedStrategy()
        }, onChanges: { [weak self] changes in await self?.notifications?.send(changes) }, onError: { [weak self] error in self?.monitoringError = error; self?.renderMenu() })
        monitor?.start()
    }

    private func stopMonitoring() {
        monitor?.stop(); monitor = nil; radar?.stop()
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
    }

    private func setPaused(_ paused: Bool) throws {
        guard let radar, paused != radar.monitoringPaused else { return }
        try radar.setMonitoringPaused(paused)
        reconcileMonitoring()
        renderMenu()
    }

    private func setLogin(_ enabled: Bool) async throws {
        guard !enabled || MonitorRuntime.backgroundMonitoringEnabled else { throw FilterError("Enable Background Monitoring before enabling Start at Login.") }
        guard loginStatusAvailable else { throw FilterError("Start at Login requires the packaged app.") }
        let loginStatus = await loginItemStatus.refresh(force: true)
        guard loginStatus != "unavailable" else { throw FilterError("Start at Login requires the packaged app.") }
        do {
            if enabled {
                if loginStatus == "requiresApproval" { SMAppService.openSystemSettingsLoginItems() }
                else if loginStatus != "enabled" { try SMAppService.mainApp.register() }
            } else if loginStatus != "disabled" { try await SMAppService.mainApp.unregister() }
            loginError = ""
        } catch { loginError = error.localizedDescription; throw error }
        await refreshLoginStatus(force: true)
    }

    @objc private func toggleMonitoring() { do { try setPaused(radar?.monitoringPaused != true) } catch { showUpdateAlert("Cannot Save Monitoring", error.localizedDescription) } }
    @objc private func toggleLogin() {
        Task {
            await refreshLoginStatus(force: true)
            do { try await setLogin(loginStatus != "enabled") }
            catch { showUpdateAlert("Cannot Change Start at Login", error.localizedDescription) }
        }
    }
    @objc private func toggleNotifications() {
        guard let radar else { return }
        do { try radar.setNotificationsEnabled(!radar.notificationsEnabled); renderMenu(); Task { await notifications?.refresh(requestPermission: radar.notificationsEnabled) } }
        catch { showUpdateAlert("Cannot Save Notifications", error.localizedDescription) }
    }
    @objc private func sendTest() { Task { await notifications?.sendTest() } }
    @objc private func openNotificationSettings() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!) }
    @objc private func resumeAfterWake(_ notification: Notification) {
        collector.retryNow(); recoverCollector()
        if collectionAllowed && radar?.monitoringPaused == false { radar?.resumeAfterWake() }
    }
    private func recoverCollector() {
        guard radar == nil else { return }
        _ = try? collector.get()
        reconcileMonitoring()
    }
    private func reconcileMonitoring() {
        if collectionAllowed && radar?.monitoringPaused == false { startMonitoring() } else { stopMonitoring() }
        renderMenu()
    }
    @objc private func checkForegroundLease() {
        Task { await refreshLoginStatus() }
        let wasResearchBusy = researchBusy
        leases = leases.filter { kill($0.key, 0) == 0 || errno == EPERM }
        if leases.isEmpty && !MonitorRuntime.backgroundMonitoringEnabled && !isInstallingUpdate { NSApp.terminate(nil) }
        if wasResearchBusy && !researchBusy { resumeAutomaticUpdate() }
        if collectionAllowed { recoverCollector() }
    }
    @objc private func showInterface() { openInterface(instId: nil) }
    private func openInterface(instId: String?, strategyID: String? = nil) {
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
        if let url = strategyID.flatMap(RadarNotificationRoute.url(strategy:)) ?? instId.flatMap(RadarNotificationRoute.url(contract:)) {
            NSWorkspace.shared.open([url], withApplicationAt: MonitorRuntime.appURL, configuration: configuration)
        } else {
            NSWorkspace.shared.openApplication(at: MonitorRuntime.appURL, configuration: configuration)
        }
    }
    @objc private func quitCompletely() {
        guard !isInstallingUpdate else { return }
        DistributedNotificationCenter.default().postNotificationName(MonitorRuntime.quitUI, object: nil, userInfo: nil, deliverImmediately: true)
        NSApp.terminate(nil)
    }

    private func decorated(_ snapshot: [String: Any]) -> [String: Any] {
        var result = snapshot
        result["notificationsEnabled"] = radar?.notificationsEnabled ?? true
        result["notificationAuthorization"] = (notifications?.authorization ?? .unavailable).rawValue
        result["notificationError"] = notifications?.error ?? "Launch the packaged macOS app to enable notifications."
        result["backgroundMonitoringError"] = startupError.isEmpty ? monitoringError : startupError
        result["monitoringPaused"] = radar?.monitoringPaused ?? false
        result["backgroundMonitoringEnabled"] = MonitorRuntime.backgroundMonitoringEnabled
        result["foregroundWorkspace"] = foregroundWorkspace
        result["foregroundPIDs"] = leases.keys.sorted()
        result["ipcVersion"] = MonitorIPC.protocolVersion
        result["serviceSession"] = sessionID
        result["databaseReady"] = radar != nil
        result["launchAtLogin"] = loginStatus; result["launchAtLoginError"] = loginError
        result["updateMenuTitle"] = checkUpdatesItem.title; result["updateMenuEnabled"] = !isCheckingUpdate && !isInstallingUpdate
        result["updateMenuToolTip"] = checkUpdatesItem.toolTip ?? ""
        result["automaticUpdatesEnabled"] = AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults)
        return result
    }

    private func handle(_ parameters: [String: Any]) async throws -> [String: Any] {
        if let lease = parameters["foregroundLease"] as? [String: Any], let pid = lease["pid"] as? Int32, pid > 0 {
            let wasResearchBusy = researchBusy
            leases[pid] = Lease(workspace: lease["workspace"] as? String == "research" ? "research" : "radar", researchBusy: lease["researchBusy"] as? Bool == true)
            if isInstallingUpdate && installingAutomatically && researchBusy {
                guard updater.cancel() else { throw FilterError("An update is completing its app replacement. Open Research after the app restarts.") }
                isInstallingUpdate = false; installingAutomatically = false; updateProgress = nil; updateState = "available"
            }
            if wasResearchBusy && !researchBusy { resumeAutomaticUpdate() }
            renderUpdateItem()
            reconcileMonitoring()
        }
        if let enabled = parameters["backgroundMonitoringEnabled"] as? Bool {
            MonitorRuntime.defaults.set(enabled, forKey: "BackgroundMonitoring")
            if !enabled, loginStatusAvailable { try await setLogin(false) }
            reconcileMonitoring()
        }
        if parameters["serviceInfo"] as? Bool == true {
            var info = decorated([:])
            info["pid"] = ProcessInfo.processInfo.processIdentifier; info["appPath"] = MonitorRuntime.appURL.path
            info["revision"] = sourceRevision
            info["menuSymbol"] = Self.symbolName
            if let fixture { info["samples"] = fixture.samples; info["delivered"] = fixture.delivered }
            return info
        }
        if let pid = parameters["releaseLease"] as? Int32 {
            let wasResearchBusy = researchBusy
            leases.removeValue(forKey: pid)
            if wasResearchBusy && !researchBusy { resumeAutomaticUpdate() }
            renderUpdateItem()
            let remaining = leases.count
            if remaining == 0 && !MonitorRuntime.backgroundMonitoringEnabled && !isInstallingUpdate {
                Task { try? await Task.sleep(for: .milliseconds(200)); if self.leases.isEmpty && !self.isInstallingUpdate { NSApp.terminate(nil) } }
            }
            return ["remainingClients": remaining]
        }
        if parameters["stopForReplacement"] as? Bool == true || parameters["quitCompletely"] as? Bool == true {
            guard !isInstallingUpdate else { throw FilterError("An update is being installed. Try again after installation finishes.") }
            let quitUI = parameters["quitCompletely"] as? Bool == true
            Task { try? await Task.sleep(for: .milliseconds(200)); if quitUI { self.quitCompletely() } else { NSApp.terminate(nil) } }
            return ["ok": true]
        }
        if let fixture, let price = parameters["testPrice"] as? Double { fixture.price = price; return ["ok": true] }
        if fixture != nil, parameters["testQuitUI"] as? Bool == true {
            DistributedNotificationCenter.default().postNotificationName(MonitorRuntime.quitUI, object: nil, userInfo: nil, deliverImmediately: true)
            return ["ok": true]
        }
        if let action = parameters["updateAction"] as? String {
            switch action {
            case "check": checkForUpdatesNow()
            case "toggleAutomatic": toggleAutomaticUpdates()
            default: throw FilterError("Invalid update action.")
            }
            return decorated([:])
        }
        let recovering = radar == nil
        let radar = try collector.get()
        // A request can be the first successful open after a startup failure.
        if recovering { reconcileMonitoring() }
        if let request = parameters["suite"] as? [String: Any] { return decorated(try await radar.suiteRequest(request)) }
        if let requested = parameters["monitoringPaused"] {
            guard let paused = requested as? Bool else { throw FilterError("Invalid monitoring setting.") }
            try setPaused(paused)
        }
        if let requested = parameters["launchAtLogin"] {
            guard let enabled = requested as? Bool else { throw FilterError("Invalid Start at Login setting.") }
            try await setLogin(enabled)
        }
        if let requested = parameters["notificationsEnabled"] {
            guard let enabled = requested as? Bool else { throw FilterError("Invalid notification setting.") }
            try radar.setNotificationsEnabled(enabled); renderMenu()
        }
        if parameters["notificationAction"] != nil || parameters["notificationsEnabled"] != nil {
            let action = parameters["notificationAction"] as? String
            guard action == nil || ["refresh", "requestPermission", "test", "openSettings"].contains(action!) else { throw FilterError("Invalid notification action.") }
            if action == "openSettings" { openNotificationSettings() }
            if action == "test" { await notifications?.sendTest() }
            else { await notifications?.refresh(requestPermission: action == "requestPermission" || parameters["notificationsEnabled"] as? Bool == true) }
        }
        if let request = parameters["compileMarketFilters"] as? [String: Any] { return radar.compileMarketFilters(request) }
        if let request = parameters["previewMarketFilters"] as? [String: Any], let json = request["filtersJSON"] as? String, let token = request["token"] as? String {
            return decorated(try await radar.previewMarketFilters(filtersJSON: json, token: token, atClose: request["atClose"] as? Bool == true, strategyID: request["strategyID"] as? String))
        }
        if let request = parameters["explainMarketFilters"] as? [String: Any], let json = request["filtersJSON"] as? String, let token = request["token"] as? String, let id = request["instId"] as? String {
            return try await radar.explainMarketFilters(instId: id, filtersJSON: json, token: token, atClose: request["atClose"] as? Bool == true, strategyID: request["strategyID"] as? String)
        }
        if let id = parameters["chartInstId"] as? String {
            if let endHour = parameters["chartEndHour"] as? Int64 { return await radar.loadHistoricalChart(id, endingAt: endHour) }
            if parameters["loadChart"] as? Bool == true { return await radar.loadChart(id) }
            return radar.chartSnapshot(id, sinceRevision: parameters["sinceRevision"] as? Int)
        }
        if parameters["frostedBackgroundEnabled"] != nil || parameters["frostedBackgroundOpacity"] != nil {
            let enabled = parameters["frostedBackgroundEnabled"] as? Bool, opacity = parameters["frostedBackgroundOpacity"] as? Double
            guard parameters["frostedBackgroundEnabled"] == nil || enabled != nil, parameters["frostedBackgroundOpacity"] == nil || opacity != nil,
                  try radar.setFrostedBackground(enabled: enabled, opacity: opacity) else { throw FilterError("Invalid frosted background setting. Opacity must be between 0 and 1.") }
        }
        if let value = parameters["filterLibraryPreferencesJSON"] { guard let json = value as? String else { throw FilterError("Invalid condition library preferences.") }; try radar.setFilterLibraryPreferences(json) }
        return decorated(try await radar.asyncSnapshot(rocPeriod: parameters["rocPeriod"] as? Int ?? 9, marocPeriod: parameters["marocPeriod"] as? Int ?? 9, sinceRevision: parameters["sinceRevision"] as? Int))
    }
    @objc private func checkForUpdatesNow() {
        if updateState == "available", let update { presentUpdate(update) }
        else { checkForUpdates(silently: false) }
    }
    @objc private func checkForUpdatesAutomatically() { checkForUpdates(silently: true) }

    @objc private func toggleAutomaticUpdates() {
        let enabled = !AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults)
        MonitorRuntime.defaults.set(enabled, forKey: "AutomaticallyInstallUpdates")
        automaticUpdatesItem.state = enabled ? .on : .off
        if enabled, updateState == "available", let update,
           !isInstallingUpdate, !isPresentingUpdate {
            automaticInstallRetryAfter = nil
            installUpdate(update, automatically: true)
        }
        renderUpdateItem()
    }

    private func resumeAutomaticUpdate() {
        guard updateState == "available", let update,
              AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults),
              !isCheckingUpdate, !isInstallingUpdate, !isPresentingUpdate,
              automaticInstallRetryAfter.map({ $0 <= now() }) ?? true else { return }
        installUpdate(update, automatically: true)
    }

    private func renderUpdateItem() {
        if updateState == "available", let update {
            let revision = update.revision == "unknown" ? "" : " · \(update.revision.prefix(7))"
            let age: String
            if let publishedAt = update.publishedAt {
                let formatter = RelativeDateTimeFormatter()
                formatter.locale = Locale(identifier: "en_US")
                formatter.unitsStyle = .abbreviated
                age = " · \(formatter.localizedString(for: publishedAt, relativeTo: now()))"
            } else { age = "" }
            if AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults), researchBusy {
                checkUpdatesItem.title = "Update Available\(revision) · Waiting for Research"
            } else if !updateError.isEmpty {
                let retry = automaticInstallRetryAfter.flatMap { date -> String? in
                    guard AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults), date > now() else { return nil }
                    let minutes = max(1, Int(ceil(date.timeIntervalSince(now()) / 60)))
                    return " · Retrying in \(minutes)m"
                } ?? ""
                checkUpdatesItem.title = "Update Failed\(revision)\(retry)"
            } else {
                checkUpdatesItem.title = "Update Available\(revision)\(age)"
            }
        } else if isInstallingUpdate {
            switch updateProgress {
            case .downloading(let received, let total):
                if total > 0 {
                    checkUpdatesItem.title = "Downloading Update · \(min(100, received * 100 / total))%"
                } else {
                    checkUpdatesItem.title = received > 0 ? "Downloading Update · \(ByteCountFormatter.string(fromByteCount: received, countStyle: .file))" : "Downloading Update…"
                }
            case .retrying(let attempt, let total):
                checkUpdatesItem.title = "Retrying Update Download · \(attempt)/\(total)"
            case .installing:
                checkUpdatesItem.title = "Installing Update…"
            case nil:
                checkUpdatesItem.title = "Downloading Update…"
            }
        } else {
            checkUpdatesItem.title = "Check for Updates"
        }
        checkUpdatesItem.toolTip = updateError.isEmpty ? nil : updateError
        checkUpdatesItem.isEnabled = !isCheckingUpdate && !isInstallingUpdate
    }

    private func checkForUpdates(silently: Bool) {
        guard !isCheckingUpdate, !isInstallingUpdate, !isPresentingUpdate else { return }
        isCheckingUpdate = true
        updateState = "checking"
        renderUpdateItem()
        updater.check { [weak self] result in
            guard let self else { return }
            isCheckingUpdate = false
            switch result {
            case .success(let found):
                if found?.revision != update?.revision {
                    updateError = ""
                    // Preserve the startup cooldown after an installer rollback.
                    // A genuinely newer offer can replace a failed cached offer.
                    if update != nil { automaticInstallRetryAfter = nil }
                }
                update = found
                updateState = found == nil ? "latest" : "available"
                if let found {
                    if AppDelegate.automaticUpdatesEnabled(in: MonitorRuntime.defaults),
                       automaticInstallRetryAfter.map({ $0 <= now() }) ?? true {
                        installUpdate(found, automatically: true)
                    } else if !silently {
                        presentUpdate(found)
                    }
                } else if !silently {
                    showUpdateAlert("Up to Date", "You have the latest version of Perpetual Swap Suite.")
                }
            case .failure(let error):
                updateState = update == nil ? "failed" : "available"
                if !silently { showUpdateAlert("Update Check Failed", error.localizedDescription) }
            }
            renderUpdateItem()
        }
    }

    private func presentUpdate(_ update: AppUpdate) {
        guard !isInstallingUpdate, !isPresentingUpdate else { return }
        isPresentingUpdate = true
        let alert = NSAlert()
        alert.messageText = "Update Available"
        let revision = update.revision == "unknown" ? "" : " (\(update.revision.prefix(7)))"
        alert.informativeText = "\(update.name)\(revision) is available. Download and install it now?"
        alert.addButton(withTitle: "Update")
        alert.addButton(withTitle: "Later")
        NSApp.activate(ignoringOtherApps: true)
        let shouldInstall = alert.runModal() == .alertFirstButtonReturn
        isPresentingUpdate = false
        guard shouldInstall else { return }
        installUpdate(update, automatically: false)
    }

    private func installUpdate(_ update: AppUpdate, automatically: Bool) {
        guard !isInstallingUpdate else { return }
        guard !researchBusy else {
            if !automatically { showUpdateAlert("Research Is Running", "Pause research before installing an update. Its checkpoint and cache will be retained.") }
            renderUpdateItem()
            return
        }
        isInstallingUpdate = true; installingAutomatically = automatically
        updateError = ""; updateProgress = .downloading(received: 0, total: 0)
        updateState = "installing"
        renderUpdateItem()
        updater.downloadAndInstall(update, progress: { [weak self] progress in
            guard let self, isInstallingUpdate else { return }
            updateProgress = progress
            renderUpdateItem()
        }) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                DistributedNotificationCenter.default().postNotificationName(MonitorRuntime.quitUI, object: nil, userInfo: ["update": true], deliverImmediately: true)
                NSApp.terminate(nil)
            case .failure(let error):
                isInstallingUpdate = false
                installingAutomatically = false; updateProgress = nil
                updateError = error.localizedDescription
                updateState = "available"
                if automatically {
                    if case .rateLimited(let until) = error { automaticInstallRetryAfter = until }
                    else { automaticInstallRetryAfter = now().addingTimeInterval(5 * 60) }
                }
                renderUpdateItem()
                if !automatically { showUpdateAlert("Update Failed", error.localizedDescription) }
            }
        }
    }

    private func showUpdateAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }


}

// Used only by isolated process tests. The real compiler, evaluation worker,
// membership tracker, persistence, IPC and notification service still run.
@MainActor
private final class MonitorFixture: MarketNotificationTransport {
    var price = 100.0
    var samples = 0
    var delivered: [[String: String]] = []
    let worker = SuiteEvaluationWorker()
    func authorization() async -> MarketNotificationAuthorization { .authorized }
    func requestAuthorization() async throws {}
    func add(_ request: UNNotificationRequest) async throws {
        delivered.append(["title": request.content.title, "instId": request.content.userInfo["instId"] as? String ?? "", "direction": request.content.userInfo["direction"] as? String ?? ""])
    }
    func observe(profile: StrategyProfile?) async throws -> FilterObservation {
        samples += 1
        guard let profile else { return FilterObservation(configuration: "no-active-strategy", universe: [], results: [:]) }
        let hour = Int64(Date().timeIntervalSince1970 * 1000) / hourMS * hourMS
        let bars = Dictionary(uniqueKeysWithValues: (0...1).map { age in
            let timestamp = hour - Int64(age) * hourMS
            return (timestamp, Candle(hour: timestamp, high: price, low: price, close: price, quoteVolume: 100, baseVolume: 1, open: price, confirmed: age > 0))
        })
        let market = FilterMarketData(id: "BTC-USDT-SWAP", hour: hour, now: hour + hourMS / 2, listedAt: 1, candles: bars, stats: [:], quotes: [:])
        let readings = try await worker.evaluate([market], profile: profile, forming: false, available: true)
        return try strategyObservation(profile: profile, readings: readings)
    }
}
