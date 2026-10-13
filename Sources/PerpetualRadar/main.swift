import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKURLSchemeHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var windowBackground: WindowBackgroundView!
    private let monitorClient = MonitorClient()
    private let gatewayClient = GatewayClient()
    private var frostedBackgroundEnabled = MonitorRuntime.defaults.object(forKey: "LastWindowFrostedEnabled") as? Bool ?? true
    private var frostedBackgroundOpacity = MonitorRuntime.defaults.object(forKey: "LastWindowFrostedOpacity") as? Double ?? 0.3
    private var windowBlurRadius = MonitorRuntime.defaults.object(forKey: "LastWindowBlurRadius") as? Double ?? 64
    private var floatingBlurRadius = MonitorRuntime.defaults.object(forKey: "LastFloatingBlurRadius") as? Double ?? 64
    private var previewWindowBlurRadius: Double?
    private var pendingNotificationInstId: String?
    private var pendingNotificationStrategyID: String?
    private var filterPreviewTask: Task<Void, Never>?
    private var filterExplainTask: Task<Void, Never>?
    private var webRoot: URL?
    private lazy var researchCache = RecoveringResource(label: "Cannot open research cache") { [weak self] in
        let controller = try ResearchController()
        controller.onBusyChanged = { [weak self] busy in
            guard let self else { return }; monitorClient.researchBusy = busy
            renewForegroundLease()
        }
        return controller
    }
    private var research: ResearchController? { researchCache.value }
    private var leaseTimer: Timer?
    private var leaseTask: Task<Void, Never>?
    private var monitorSettingsInitialized = false
    private var terminating = false
    private var terminationReady = false
    private var quittingForUpdate = false
    private var lifecycleTestServer: MonitorIPCServer?
    private lazy var checkUpdatesItem = NSMenuItem(title: "Check for Updates", action: #selector(checkForUpdatesNow), keyEquivalent: "")
    private lazy var automaticUpdatesItem = NSMenuItem(title: "Automatically Install Updates", action: #selector(toggleAutomaticUpdates), keyEquivalent: "")
    private let appearanceMenu = NSMenu(title: "Appearance")
    private nonisolated static let automaticUpdatesKey = "AutomaticallyInstallUpdates"

    nonisolated static func automaticUpdatesEnabled(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: automaticUpdatesKey) as? Bool ?? true
    }

    nonisolated static func preferredAppearance(in defaults: UserDefaults = .standard) -> String {
        defaults.string(forKey: "appearance") ?? "dark"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.removeItem(at: MonitorRuntime.updateSuppressionURL)
        let launchInBackground = MonitorRuntime.testChannel != nil || ProcessInfo.processInfo.environment["PERPETUAL_RADAR_BACKGROUND"] == "1"
        if let path = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_PID_FILE"], !path.isEmpty {
            FileManager.default.createFile(atPath: path, contents: Data(String(ProcessInfo.processInfo.processIdentifier).utf8))
        }
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) { NSApp.applicationIconImage = icon }
        let menu = NSMenu()
        let application = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.delegate = self
        checkUpdatesItem.target = self
        appMenu.addItem(checkUpdatesItem)
        automaticUpdatesItem.target = self
        automaticUpdatesItem.state = Self.automaticUpdatesEnabled() ? .on : .off
        appMenu.addItem(automaticUpdatesItem)
        let appearanceItem = NSMenuItem(title: "Appearance", action: nil, keyEquivalent: "")
        for (title, value) in [("System", "system"), ("Light", "light"), ("Dark", "dark")] {
            let item = NSMenuItem(title: title, action: #selector(changeAppearance(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = value
            appearanceMenu.addItem(item)
        }
        appearanceItem.submenu = appearanceMenu
        appMenu.addItem(appearanceItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Perpetual Swap Suite", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        application.submenu = appMenu; menu.addItem(application)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windowMenu; menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu

        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "radar")
        configureBackgroundScript(in: configuration.userContentController)
        configuration.setURLSchemeHandler(self, forURLScheme: "radar")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        let windowType: NSWindow.Type = MonitorRuntime.testChannel == nil ? NSWindow.self : BackgroundTestWindow.self
        window = windowType.init(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                                 styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                 backing: .buffered, defer: false)
        window.title = "Perpetual Swap Radar"
        window.isReleasedWhenClosed = false
        applyAppearance(Self.preferredAppearance())
        window.minSize = NSSize(width: 400, height: 300)
        windowBackground = WindowBackgroundView(contentView: webView)
        window.contentView = windowBackground
        window.delegate = self
        applyWindowBackground()
        window.center()
        if !launchInBackground { window.makeKeyAndOrderFront(nil) }
        updateRelaunchPresentation()
        applyWindowBackground()
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(resumeAfterWake),
                                                        name: NSWorkspace.didWakeNotification, object: nil)

        DistributedNotificationCenter.default().addObserver(self, selector: #selector(quitInterface(_:)), name: MonitorRuntime.quitUI, object: nil)
        _ = try? researchCache.get()
        if MonitorRuntime.testChannel != nil {
            // Packaged CI controls an isolated, hidden application instance.
            lifecycleTestServer = try? MonitorIPCServer(name: MonitorRuntime.portName + ".interface-tests") { [weak self] data in
                do {
                    guard let self, let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FilterError("Invalid lifecycle fixture request.") }
                    var value: [String: Any] = ["ok": true]
                    if let workspace = body["workspace"] as? String {
                        monitorClient.workspace = workspace; _ = try await monitorClient.request(["serviceInfo": true])
                        window.title = workspace == "research" ? "Perpetual Swap Research" : "Perpetual Swap Radar"
                    }
                    if let request = body["suite"] as? [String: Any] { value = try await monitorClient.request(["suite":request]) }
                    if let request = body["research"] as? [String: Any] { value = try await researchCache.get().handle(request) }
                    if let request = body["monitor"] as? [String: Any] { value = try await monitorClient.request(request) }
                    if body["hideWindow"] as? Bool == true {
                        // Dock miniaturization requires a regular application
                        // and exposes a desktop icon. Exercise hidden-window
                        // research lifecycle here; delegate callbacks have
                        // their own native tests without invoking the Dock.
                        window.orderOut(nil)
                        updateRelaunchPresentation()
                    }
                    if body["showWindow"] as? Bool == true { showWindow() }
                    value["windowHidden"] = !window.isVisible
                    value["windowTitle"] = window.title
                    if body["close"] as? Bool == true { Task { try? await Task.sleep(for: .milliseconds(50)); self.window.performClose(nil) } }
                    return try SafeJSON.data(["value": value])
                } catch { return (try? SafeJSON.data(["error": error.localizedDescription])) ?? Data("{}".utf8) }
            }
        }
        let leaseTimer = Timer(timeInterval: 2, target: self, selector: #selector(renewForegroundLease), userInfo: nil, repeats: true)
        RunLoop.main.add(leaseTimer, forMode: .common); self.leaseTimer = leaseTimer
        renewForegroundLease()

        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Web/index.html")
        let development = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("dist/index.html")
        if let bundled, FileManager.default.fileExists(atPath: bundled.path) {
            webRoot = bundled.deletingLastPathComponent()
            webView.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        } else if FileManager.default.fileExists(atPath: development.path) {
            webRoot = development.deletingLastPathComponent()
            webView.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        } else {
            let diagnostics = [
                "Bundle resource path: \(Bundle.main.resourceURL?.path ?? "none")",
                "Bundled web path exists: \(bundled.map { FileManager.default.fileExists(atPath: $0.path) } ?? false)",
                "Development path: \(development.path)",
                "Development exists: \(FileManager.default.fileExists(atPath: development.path))",
                "Current directory: \(FileManager.default.currentDirectoryPath)"
            ].joined(separator: "<br>")
            let message = "Web assets not found. Diagnostics:<br><br>\(diagnostics)<br><br>If you downloaded this app from the internet, try: Right-click the app → Open (to bypass Gatekeeper), or run in Terminal:<br><code>xattr -cr '/path/to/Perpetual Swap Suite.app'</code>"
            webView.loadHTMLString("<html><body style='font:13px system-ui;padding:40px;line-height:1.6'>\(message)</body></html>", baseURL: nil)
        }
        if !launchInBackground { NSApp.activate(ignoringOtherApps: true) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        gatewayClient.cancelAll()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        filterPreviewTask?.cancel(); filterExplainTask?.cancel()
        leaseTimer?.invalidate(); leaseTask?.cancel(); lifecycleTestServer?.invalidate()
        MonitorRuntime.defaults.set(MonitorRuntime.backgroundMonitoringEnabled, forKey: AppUpdater.backgroundRelaunchKey)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationReady { return .terminateNow }
        if terminating { return .terminateCancel }
        terminating = true; leaseTimer?.invalidate(); leaseTask?.cancel()
        if !quittingForUpdate && !MonitorRuntime.backgroundMonitoringEnabled {
            try? FileManager.default.createDirectory(at: MonitorRuntime.updateSuppressionURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data().write(to: MonitorRuntime.updateSuppressionURL, options: .atomic)
        }
        Task {
            try? await research?.stop()
            if !MonitorRuntime.backgroundMonitoringEnabled { await monitorClient.shutdown() }
            // A termination invoked by a dispatch/notification callback cannot
            // drain another MainActor task inside AppKit's terminateLater loop.
            // Finish checkpointing first, then request synchronous termination.
            terminationReady = true; sender.terminate(nil)
        }
        return .terminateCancel
    }
    @objc private func renewForegroundLease() {
        guard !terminating, leaseTask == nil else { return }
        leaseTask = Task {
            defer { leaseTask = nil }
            if research == nil { _ = try? researchCache.get() }
            do {
                let info = try await monitorClient.request(["serviceInfo": true])
                guard !terminating else { return }
                acceptNativeSettings(info)
                if !monitorSettingsInitialized, info["databaseReady"] as? Bool == true {
                    let launchInBackground = ProcessInfo.processInfo.environment["PERPETUAL_RADAR_BACKGROUND"] == "1"
                    let settings = try await monitorClient.request(["notificationAction": !launchInBackground && info["notificationsEnabled"] as? Bool == true ? "requestPermission" : "refresh"])
                    guard !terminating else { return }
                    acceptNativeSettings(settings); monitorSettingsInitialized = true
                }
                if monitorSettingsInitialized { MonitorRuntime.markReady() }
            } catch { /* The next lease or interface request shares the recovery attempt. */ }
        }
    }

    @objc private func quitInterface(_ notification: Notification) { if !terminating { quittingForUpdate = notification.userInfo?["update"] as? Bool == true }; NSApp.terminate(nil) }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if let strategy = RadarNotificationRoute.strategy(in: url) {
                pendingNotificationStrategyID = strategy; showWindow(); openNotificationContract(); continue
            }
            guard let id = RadarNotificationRoute.contract(in: url) else { continue }
            pendingNotificationInstId = id
            showWindow(); openNotificationContract()
        }
    }

    private func acceptNativeSettings(_ snapshot: [String: Any]) {
        if let enabled = snapshot["frostedBackgroundEnabled"] as? Bool, let opacity = snapshot["frostedBackgroundOpacity"] as? Double {
            frostedBackgroundEnabled = enabled; frostedBackgroundOpacity = opacity
            MonitorRuntime.defaults.set(enabled, forKey: "LastWindowFrostedEnabled")
            MonitorRuntime.defaults.set(opacity, forKey: "LastWindowFrostedOpacity")
            if let value = snapshot["windowBlurRadius"] as? Double, WindowServerBlur.validRadius(value) {
                windowBlurRadius = value; MonitorRuntime.defaults.set(value, forKey: "LastWindowBlurRadius")
            }
            if let value = snapshot["floatingBlurRadius"] as? Double, WindowServerBlur.validRadius(value) {
                floatingBlurRadius = value; MonitorRuntime.defaults.set(value, forKey: "LastFloatingBlurRadius")
            }
            applyWindowBackground(); configureBackgroundScript(in: webView.configuration.userContentController)
        }
        if let title = snapshot["updateMenuTitle"] as? String { checkUpdatesItem.title = title }
        if let toolTip = snapshot["updateMenuToolTip"] as? String { checkUpdatesItem.toolTip = toolTip.isEmpty ? nil : toolTip }
        if let enabled = snapshot["updateMenuEnabled"] as? Bool { checkUpdatesItem.isEnabled = enabled }
        if let enabled = snapshot["automaticUpdatesEnabled"] as? Bool { automaticUpdatesItem.state = enabled ? .on : .off }
    }

    @objc private func showWindow() {
        guard let window else { return }
        if MonitorRuntime.testChannel != nil {
            window.orderBack(nil)
            updateRelaunchPresentation()
            applyWindowBackground()
            return
        }
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        updateRelaunchPresentation()
        applyWindowBackground()
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if !MonitorRuntime.backgroundMonitoringEnabled { NSApp.terminate(nil); return false }
        Task { try? await research?.stop() }
        sender.orderOut(nil)
        MonitorRuntime.defaults.set(true, forKey: AppUpdater.backgroundRelaunchKey)
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { if let info = try? await monitorClient.request(["serviceInfo": true]) { acceptNativeSettings(info) } }
    }

    private func updateRelaunchPresentation(for presentedWindow: NSWindow? = nil) {
        guard let window = presentedWindow ?? window else { return }
        MonitorRuntime.defaults.set(MonitorRuntime.backgroundMonitoringEnabled && (!window.isVisible || window.isMiniaturized || NSApp.isHidden), forKey: AppUpdater.backgroundRelaunchKey)
    }

    func windowDidMiniaturize(_ notification: Notification) { updateRelaunchPresentation(for: notification.object as? NSWindow) }
    func windowDidDeminiaturize(_ notification: Notification) { updateRelaunchPresentation(for: notification.object as? NSWindow) }
    func applicationDidHide(_ notification: Notification) { updateRelaunchPresentation() }
    func applicationDidUnhide(_ notification: Notification) { updateRelaunchPresentation() }

    private func openNotificationContract() {
        if let strategy = pendingNotificationStrategyID, let webView, !webView.isLoading {
            pendingNotificationStrategyID = nil
            webView.callAsyncJavaScript("window.radarNotificationStrategy = strategyID; window.dispatchEvent(new Event('radar-open-strategy'));", arguments: ["strategyID": strategy], in: nil, in: .page, completionHandler: nil)
        }
        guard let id = pendingNotificationInstId, let webView, !webView.isLoading else { return }
        pendingNotificationInstId = nil
        webView.callAsyncJavaScript("window.radarNotificationContract = instId; window.dispatchEvent(new Event('radar-open-contract'));",
            arguments: ["instId": id], in: nil, in: .page, completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        windowBackground.updateFloatingGlass([])
        previewWindowBlurRadius = nil; applyWindowBackground()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { openNotificationContract() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let alert = NSAlert()
        alert.messageText = "Navigation Failed"
        alert.informativeText = "Failed to load the interface: \(error.localizedDescription)\n\nIf you downloaded this app, try removing quarantine attributes: xattr -cr '/path/to/app'"
        alert.alertStyle = .warning
        alert.runModal()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let alert = NSAlert()
        alert.messageText = "Failed to Load Interface"
        let nsError = error as NSError
        var details = "Error: \(error.localizedDescription)\nDomain: \(nsError.domain)\nCode: \(nsError.code)"
        if let url = nsError.userInfo[NSURLErrorKey] as? URL {
            details += "\nURL: \(url.absoluteString)"
        }
        if let bundleURL = Bundle.main.resourceURL?.appendingPathComponent("Web") {
            let webExists = FileManager.default.fileExists(atPath: bundleURL.path)
            details += "\n\nWeb assets directory exists: \(webExists)"
            if webExists {
                let contents = try? FileManager.default.contentsOfDirectory(atPath: bundleURL.path)
                details += "\nFiles found: \(contents?.count ?? 0)"
            }
        }
        alert.informativeText = details
        alert.alertStyle = .critical
        alert.runModal()
    }

    @objc private func resumeAfterWake(_ notification: Notification) {
        applyWindowBackground()
        researchCache.retryNow(); renewForegroundLease()
    }

    func windowDidBecomeKey(_ notification: Notification) { applyWindowBackground() }
    func windowDidEnterFullScreen(_ notification: Notification) { applyWindowBackground() }
    func windowDidExitFullScreen(_ notification: Notification) { applyWindowBackground() }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        gatewayClient.cancelAll()
        webView.reload()
    }

    func menuWillOpen(_ menu: NSMenu) {
        Task { if let info = try? await monitorClient.request(["serviceInfo": true]) { acceptNativeSettings(info) } }
    }

    @objc private func changeAppearance(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String else { return }
        UserDefaults.standard.set(value, forKey: "appearance")
        applyAppearance(value)
    }

    private func applyAppearance(_ value: String) {
        window.appearance = value == "light" ? NSAppearance(named: .aqua) : value == "dark" ? NSAppearance(named: .darkAqua) : nil
        for item in appearanceMenu.items { item.state = (item.representedObject as? String == value) ? .on : .off }
    }

    private func configureBackgroundScript(in controller: WKUserContentController) {
        let enabled = frostedBackgroundEnabled
        let opacity = frostedBackgroundOpacity
        // Keep the document-start settings current for wake and WebKit process reloads.
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "window.radarAppearance = { frostedBackgroundEnabled: \(enabled), frostedBackgroundOpacity: \(opacity), windowBlurRadius: \(windowBlurRadius), floatingBlurRadius: \(floatingBlurRadius), nativeWindowBackground: true };",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func applyWindowBackground() {
        windowBackground.apply(enabled: frostedBackgroundEnabled, opacity: frostedBackgroundOpacity, blurRadius: previewWindowBlurRadius ?? windowBlurRadius, to: window)
    }

    @objc private func checkForUpdatesNow() { sendUpdateAction("check") }
    @objc private func toggleAutomaticUpdates() { sendUpdateAction("toggleAutomatic") }
    private func sendUpdateAction(_ action: String) {
        Task {
            do { acceptNativeSettings(try await monitorClient.request(["updateAction": action])) }
            catch {
                let alert = NSAlert(); alert.messageText = "Cannot Reach Background Monitor"
                alert.informativeText = error.localizedDescription; alert.runModal()
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let parameters = message.body as? [String: Any] else { replyHandler(nil, "Invalid request"); return }
        if let surfaces = parameters["floatingGlassSurfaces"] as? [[String: Double]] {
            windowBackground.updateFloatingGlass(surfaces)
            replyHandler(["ok": true], nil); return
        }
        if let text = parameters["copyText"] as? String {
            NSPasteboard.general.clearContents()
            replyHandler(["ok": NSPasteboard.general.setString(text, forType: .string)], nil)
            return
        }
        if let request = parameters["analysisSettings"] as? [String: Any] {
            do { replyHandler(try gatewayClient.settings.handle(request), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
            return
        }
        if let id = parameters["cancelGatewayFetch"] as? String {
            gatewayClient.cancel(id); replyHandler(["ok": true], nil); return
        }
        if let request = parameters["gatewayFetch"] as? [String: Any] {
            guard let id = request["id"] as? String, let body = request["body"] as? String else {
                replyHandler(nil, "Invalid Gateway request"); return
            }
            do {
                try gatewayClient.start(id: id, body: body, reply: replyHandler) { [weak webView] event in
                    guard let webView else { return }
                    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                        webView.callAsyncJavaScript(
                            "window.dispatchEvent(new CustomEvent('radar-gateway-stream', {detail: event}));",
                            arguments: ["event": event], in: nil, in: .page) { _ in continuation.resume() }
                    }
                }
            } catch { replyHandler(nil, error.localizedDescription) }
            return
        }
        if let workspace = parameters["foregroundWorkspace"] as? String {
            let previous = monitorClient.workspace
            let mode = workspace == "research" ? "research" : "radar"
            monitorClient.workspace = mode
            Task {
                do {
                    _ = try await monitorClient.request(["serviceInfo": true])
                    window.title = mode == "research" ? "Perpetual Swap Research" : "Perpetual Swap Radar"
                    replyHandler(["ok": true], nil)
                } catch { monitorClient.workspace = previous; replyHandler(nil, error.localizedDescription) }
            }
            return
        }
        if let request = parameters["research"] as? [String: Any] {
            Task {
                do { replyHandler(try await researchCache.get().handle(request, window: window), nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }
            return
        }
        if let requested = parameters["windowTintRGB"] {
            guard let rgb = requested as? [Double], windowBackground.setTint(rgb: rgb) else { replyHandler(nil, "Invalid window tint"); return }
            replyHandler(["ok": true], nil)
            return
        }
        if let requested = parameters["previewWindowBlur"] {
            if requested is NSNull { previewWindowBlurRadius = nil }
            else {
                guard let value = requested as? Double, WindowServerBlur.validRadius(value) else { replyHandler(nil, "Blur must be between 0 and 160."); return }
                previewWindowBlurRadius = value
            }
            applyWindowBackground()
            replyHandler(["ok": true], nil)
            return
        }
        if let bounds = parameters["captureChart"] as? [String: Any] {
            captureChartImage(in: webView, bounds: bounds) { image, error in
                guard let image else { replyHandler(nil, error); return }
                if bounds["output"] as? String == "png" {
                    guard let png = chartSnapshotPNG(image) else { replyHandler(nil, "Could not encode chart screenshot"); return }
                    replyHandler(png, nil); return
                }
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                guard pasteboard.writeObjects([image]) else {
                    replyHandler(nil, "Could not copy chart screenshot"); return
                }
                replyHandler(["ok": true], nil)
            }
            return
        }
        let requestTask = Task {
            do {
                let result = try await monitorClient.request(parameters)
                try Task.checkCancellation()
                acceptNativeSettings(result)
                replyHandler(result, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
        if parameters["previewMarketFilters"] != nil { filterPreviewTask?.cancel(); filterPreviewTask = requestTask }
        if parameters["explainMarketFilters"] != nil { filterExplainTask?.cancel(); filterExplainTask = requestTask }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let root = webRoot, let url = task.request.url, url.host == "app",
              !url.path.contains("..") else {
            task.didFailWithError(NSError(domain: "PerpetualRadar", code: 404)); return
        }
        let file = root.appendingPathComponent(String(url.path.dropFirst()))
        guard file.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/"),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: "PerpetualRadar", code: 404)); return
        }
        let mime: String
        switch file.pathExtension {
        case "html": mime = "text/html"
        case "js": mime = "text/javascript"
        case "css": mime = "text/css"
        case "woff": mime = "font/woff"
        case "woff2": mime = "font/woff2"
        case "ttf": mime = "font/ttf"
        default: mime = "application/octet-stream"
        }
        task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

if ["--study-benchmark", "--study-report-benchmark"].contains(CommandLine.arguments.dropFirst().first ?? "") { ResearchBenchmark.start(arguments: CommandLine.arguments) }

let application = NSApplication.shared
application.setActivationPolicy(MonitorRuntime.testChannel != nil || MonitorRuntime.isHelper || ProcessInfo.processInfo.environment["PERPETUAL_RADAR_BACKGROUND"] == "1" ? .accessory : .regular)
let delegate: any NSApplicationDelegate = MonitorRuntime.isHelper ? MonitorDelegate() : AppDelegate()
application.delegate = delegate
application.run()
