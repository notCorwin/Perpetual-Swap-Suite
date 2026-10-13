import AppKit
import WebKit
import ScreenCaptureKit
import XCTest
@testable import PerpetualRadar

// Exercises the actual packaged-origin WebKit renderer and promise bridge with
// native compile/evaluation/persistence and a deterministic 500-market feed.
@MainActor
private final class RuleUIBridge: NSObject, WKScriptMessageHandlerWithReply, WKURLSchemeHandler {
    private let renderingActivity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Run background WKWebView interaction and material verification")
    let root: URL
    let radar: Radar
    let suite: String
    let directory: URL
    var revision = 1
    var rows: [[String: Any]]
    var contexts: [FilterMarketData]
    var previewDelay: UInt64 = 0
    var cancelPreviousPreview = true
    var previewRequests = 0
    var previewResponses = 0
    var holdNextPreview = false
    var heldPreviewReply: (() -> Void)?
    private var previewTask: Task<Void, Never>?
    var strategySaveDelay: UInt64 = 0
    var strategySaveError: String?
    var pulseRows = false
    var pulse = 0.0
    var includeChartBars = false
    var holdChartLoadID: String?
    var heldChartLoadReply: (() -> Void)?
    var chartLiveClose: Double?
    var chartSnapshotRGB: [Double] = []
    var analysisModel = "openai/gpt-6.1-sol"
    var analysisKey = "fixture-key"
    var analysisCaptureBounds: [[String: Any]] = []
    var analysisPNG: [String: Any]?
    var gatewayRequests: [[String: Any]] = []
    var gatewayCancelled: [String] = []
    var holdGateway = false
    weak var windowBackground: WindowBackgroundView?
    var windowTintRGB: [Double] = []
    var previewWindowBlur: Double?
    var holdNextBlurSave = false
    var heldBlurSave: (() -> Void)?
    var blurSaveError: String?
    var notificationAuthorization = "authorized"
    var notificationTestCount = 0
    var notificationSettingsOpenCount = 0
    var notificationPermissionRequests = 0
    var notificationError = ""
    var backgroundMonitoringEnabled = true
    var foregroundWorkspace = "radar"
    var workspaceDelay: UInt64 = 0
    var workspaceError: String?
    var radarRequests = 0
    var suiteEvaluationRequests = 0
    var suiteEvaluationDelay: UInt64 = 0
    var suiteReadError: String?
    var researchReadError: String?
    var holdNextResearchEvents = false
    var heldResearchEventsReply: (() -> Void)?
    var researchJobOverride: [String: Any]?
    var research: ResearchController?
    var launchAtLogin = "disabled"
    var loginSettingsOpenCount = 0
    let worker = FilterEvaluationWorker()
    let suiteWorker = SuiteEvaluationWorker()
    init(root: URL, seedStrategy: Bool = true, marketCount: Int = 500) throws {
        self.root = root; suite = "RuleUI-\(UUID())"
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        radar = try Radar(defaults: UserDefaults(suiteName: suite)!, storeURL: directory.appendingPathComponent("radar.sqlite3"))
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: root.deletingLastPathComponent().appendingPathComponent("Tests/Fixtures/filter-compatibility.json"))) as! [[String: Any]]
        let template = fixtures[0]["row"] as! [String: Any], hour = Int64(Date().timeIntervalSince1970 * 1000) / hourMS * hourMS
        var generated: [[String: Any]] = [], data: [FilterMarketData] = []
        let candles = Dictionary(uniqueKeysWithValues: (0...900).map { age in let ts = hour - Int64(age) * hourMS; return (ts, Candle(hour: ts, high: 111, low: 99, close: 110, quoteVolume: 100, baseVolume: 1, open: 105, confirmed: age != 0)) })
        for index in 0..<marketCount {
            var row = template; let id = String(format: "MKT%03d-USDT-SWAP", index)
            row["instId"] = id; row["turnover24hUSDT"] = index % 4 == 0 ? 5_000_000.0 : 20_000_000.0
            row["oiChange"] = index % 3 == 0 ? 2.0 : index % 3 == 1 ? 0.0 : -2.0
            generated.append(row)
            data.append(.init(id: id, hour: hour, now: hour + hourMS / 2, listedAt: hour - 3 * 365 * 24 * hourMS, candles: candles, stats: [:], quotes: [:], current: LegacyFilterReadings.from(row), previousEMA: 100))
        }
        rows = generated; contexts = data
        if seedStrategy {
            let store = try Store(url: directory.appendingPathComponent("radar.sqlite3"))
            let on = try FilterCompiler.compile(source: "Close > 0").config.json
            let profile = try store.saveSuiteProfile(.init(id: "test-strategy", name: "Test strategy", universeJSON: try FilterCompiler.compile(source: "turnover >= 10").config.json,
                phaseRules: ["bullishSetup": on]))
            _ = try store.manageSuite(["action": "select", "profileID": profile.id], mode: "radar")
        } else {
            _ = try Store(url: directory.appendingPathComponent("radar.sqlite3")).manageSuite(["action": "select", "profileID": ""], mode: "radar")
        }
        super.init()
    }
    var savedUniverseJSON: String { (try? radar.monitoringStrategy()?.universeJSON) ?? "" }
    func cleanUp() { heldPreviewReply?(); heldPreviewReply = nil; previewTask?.cancel(); ProcessInfo.processInfo.endActivity(renderingActivity); UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
    func snapshot() -> [String: Any] {
        var result = radar.snapshot(rocPeriod: 9, marocPeriod: 9)
        result["rows"] = rows; result["revision"] = revision
        result["notificationAuthorization"] = notificationAuthorization
        result["notificationError"] = notificationError; result["backgroundMonitoringError"] = ""
        result["monitoringPaused"] = radar.monitoringPaused
        result["backgroundMonitoringEnabled"] = backgroundMonitoringEnabled
        result["launchAtLogin"] = launchAtLogin; result["launchAtLoginError"] = ""
        return result
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let request = message.body as! [String: Any]
        if let radius = request["previewWindowBlur"] {
            previewWindowBlur = radius as? Double
            applyAppearance()
            replyHandler(["ok": true], nil); return
        }
        if ["frostedBackgroundEnabled", "frostedBackgroundOpacity", "windowBlurRadius", "floatingBlurRadius"].contains(where: { request[$0] != nil }) {
            let save = { [self] in
                do {
                    if let blurSaveError { throw FilterError(blurSaveError) }
                    guard try radar.setFrostedBackground(enabled: request["frostedBackgroundEnabled"] as? Bool, opacity: request["frostedBackgroundOpacity"] as? Double,
                        windowBlur: request["windowBlurRadius"] as? Double, floatingBlur: request["floatingBlurRadius"] as? Double) else { throw FilterError("Invalid appearance setting.") }
                    applyAppearance(); revision += 1; replyHandler(snapshot(), nil)
                } catch { replyHandler(nil, error.localizedDescription) }
            }
            if holdNextBlurSave { holdNextBlurSave = false; heldBlurSave = save } else { save() }
            return
        }
        if let settings = request["analysisSettings"] as? [String: Any] {
            if settings["action"] as? String == "save" {
                analysisModel = settings["model"] as! String
                if let key = settings["apiKey"] as? String, !key.isEmpty { analysisKey = key }
            }
            if settings["action"] as? String == "removeKey" { analysisKey = "" }
            replyHandler(["model": analysisModel, "hasAPIKey": !analysisKey.isEmpty], nil); return
        }
        if let id = request["cancelGatewayFetch"] as? String {
            gatewayCancelled.append(id); replyHandler(["ok": true], nil); return
        }
        if let text = request["copyText"] as? String {
            NSPasteboard.general.clearContents(); replyHandler(["ok": NSPasteboard.general.setString(text, forType: .string)], nil); return
        }
        if let gateway = request["gatewayFetch"] as? [String: Any] {
            let body = try! JSONSerialization.jsonObject(with: Data((gateway["body"] as! String).utf8)) as! [String: Any]
            gatewayRequests.append(body)
            let id = gateway["id"] as! String, hold = holdGateway
            replyHandler(["status": 200, "headers": ["Content-Type": "text/event-stream"]], nil)
            Task { @MainActor in
                func delta(_ text: String, finish: Any = NSNull()) -> String {
                    let value: [String: Any] = ["id": "fixture", "choices": [["index": 0, "delta": ["content": text], "finish_reason": finish]]]
                    return "data: " + String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)! + "\n\n"
                }
                let response = delta(hold ? "部分分析" : "## 判断\n\n等待确认，不追多。\n\n| 条件 | 确认 |\n| --- | --- |\n| 1h 收盘 | 站稳阻力 |") + (hold ? "" : delta("", finish: "stop") + "data: [DONE]\n\n")
                let bytes = Array(response.utf8)
                let chunks = stride(from: 0, to: bytes.count, by: 7).map { Data(bytes[$0..<min($0 + 7, bytes.count)]).base64EncodedString() }
                message.webView?.callAsyncJavaScript(
                    "for (const base64 of chunks) window.dispatchEvent(new CustomEvent('radar-gateway-stream', {detail:{id,type:'data',base64}})); if (!hold) window.dispatchEvent(new CustomEvent('radar-gateway-stream', {detail:{id,type:'end'}}));",
                    arguments: ["chunks": chunks, "id": id, "hold": hold], in: nil, in: .page, completionHandler: nil)
            }
            return
        }
        if let workspace = request["foregroundWorkspace"] as? String {
            Task {
                if workspaceDelay > 0 { try? await Task.sleep(nanoseconds:workspaceDelay) }
                if let workspaceError { replyHandler(nil,workspaceError); return }
                foregroundWorkspace = workspace
                windowBackground?.window?.title = workspace == "research" ? "Perpetual Swap Research" : "Perpetual Swap Radar"
                replyHandler(["ok":true],nil)
            }; return
        }
        if let parameters = request["suite"] as? [String: Any] {
            Task {
                do {
                    let action = parameters["action"] as? String ?? "inventory"
                    if ["inventory","evaluate"].contains(action), let suiteReadError { replyHandler(nil,suiteReadError); return }
                    let delay = action == "evaluate" ? suiteEvaluationDelay : 0
                    if action == "save" {
                        if strategySaveDelay > 0 { try await Task.sleep(nanoseconds: strategySaveDelay) }
                        if let strategySaveError { replyHandler(nil, strategySaveError); return }
                        revision += 1
                    }
                    if action == "evaluate" { suiteEvaluationRequests += 1 }
                    let store = try Store(url: directory.appendingPathComponent("radar.sqlite3"))
                    var response = try store.manageSuite(parameters,mode: parameters["mode"] as? String ?? "radar")
                    if ["evaluate","preview"].contains(parameters["action"] as? String ?? ""), let profile = try store.selectedSuiteProfile("radar") {
                        for forming in [true,false] {
                            let readings = try await suiteWorker.evaluate(contexts,profile: profile,forming: forming,available: !radar.monitoringPaused,detail: parameters["instrument"] as? String)
                            response[forming ? "provisional" : "confirmed"] = try JSONSerialization.jsonObject(with: Data(researchJSON(readings).utf8))
                        }
                    }
                    if delay > 0 { try await Task.sleep(nanoseconds:delay) }
                    response["paused"] = radar.monitoringPaused; replyHandler(response,nil)
                } catch { replyHandler(nil,error.localizedDescription) }
            }; return
        }
        if let parameters = request["research"] as? [String: Any], let research {
            if parameters["action"] as? String == "inventory", let researchReadError { replyHandler(nil, researchReadError); return }
            Task { do {
                var result = try await research.handle(parameters)
                if parameters["action"] as? String == "inventory", let researchJobOverride { result["job"] = researchJobOverride }
                if parameters["action"] as? String == "events", holdNextResearchEvents {
                    holdNextResearchEvents = false
                    heldResearchEventsReply = { replyHandler(result, nil) }
                    return
                }
                replyHandler(result, nil)
            } catch { replyHandler(nil, error.localizedDescription) } }; return
        }
        radarRequests += 1
        if request["backgroundMonitoringEnabled"] != nil || request["notificationsEnabled"] != nil || request["notificationAction"] != nil || request["monitoringPaused"] != nil || request["launchAtLogin"] != nil {
            do {
                if let enabled = request["backgroundMonitoringEnabled"] as? Bool { backgroundMonitoringEnabled = enabled; if !enabled { launchAtLogin = "disabled" }; revision += 1 }
                if let enabled = request["notificationsEnabled"] as? Bool { try radar.setNotificationsEnabled(enabled); revision += 1 }
                if let paused = request["monitoringPaused"] as? Bool { try radar.setMonitoringPaused(paused); revision += 1 }
                if let enabled = request["launchAtLogin"] as? Bool {
                    if launchAtLogin == "requiresApproval", enabled { loginSettingsOpenCount += 1 }
                    else { launchAtLogin = enabled ? "enabled" : "disabled" }
                    revision += 1
                }
                if request["notificationAction"] as? String == "test" { notificationTestCount += 1 }
                if request["notificationAction"] as? String == "openSettings" { notificationSettingsOpenCount += 1 }
                if (request["notificationAction"] as? String == "requestPermission" || request["notificationsEnabled"] as? Bool == true), notificationAuthorization == "notDetermined" {
                    notificationPermissionRequests += 1; notificationAuthorization = "authorized"
                }
                replyHandler(snapshot(), nil)
            } catch { replyHandler(nil, String(describing: error)) }
            return
        }
        if let rgb = request["windowTintRGB"] as? [Double] {
            guard windowBackground?.setTint(rgb: rgb) == true else { replyHandler(nil, "Invalid window tint"); return }
            windowTintRGB = rgb
            replyHandler(["ok": true], nil)
            return
        }
        if let compile = request["compileMarketFilters"] as? [String: Any] { replyHandler(radar.compileMarketFilters(compile), nil); return }
        if let preview = request["previewMarketFilters"] as? [String: Any] {
            var original = snapshot()
            if pulseRows { pulse += 0.01; original["rows"] = rows.map { var row = $0; row["price"] = 110 + pulse; return row } }
            let source = preview["filtersJSON"] as! String, token = preview["token"] as! String, delay = previewDelay
            previewRequests += 1
            let holdReply = holdNextPreview
            holdNextPreview = false
            if cancelPreviousPreview { previewTask?.cancel() }
            previewTask = Task {
                do {
                    let filter = try FilterCompiler.compile(FilterConfigV2.decode(source))
                    let results = await worker.evaluate(contexts.map { SuiteEvaluation.context($0, forming: preview["atClose"] as? Bool != true) }, filter: filter)
                    try Task.checkCancellation()
                    if delay > 0 { try await Task.sleep(nanoseconds: delay) }
                    var result = original; result["filterToken"] = token; result["filterResults"] = results.mapValues(\.rawValue); result["historyProgress"] = ["pending": 0, "completed": 0, "error": ""]
                    let reply: () -> Void = { self.previewResponses += 1; replyHandler(result, nil) }
                    if holdReply { heldPreviewReply = reply } else { reply() }
                } catch { replyHandler(nil, String(describing: error)) }
            }; return
        }
        if let explain = request["explainMarketFilters"] as? [String: Any], let market = contexts.first(where: { $0.id == explain["instId"] as? String }) {
            do { let filter = try FilterCompiler.compile(FilterConfigV2.decode(explain["filtersJSON"] as! String)); replyHandler(["instId": market.id, "filterToken": explain["token"]!, "revision": revision, "trace": FilterEvaluator(market: SuiteEvaluation.context(market, forming: explain["atClose"] as? Bool != true), filter: filter).evaluate(explain: true).snapshot], nil) }
            catch { replyHandler(nil, String(describing: error)) }; return
        }
        if let capture = request["captureChart"] as? [String: Any], let rgb = capture["backgroundRGB"] as? [Double] {
            chartSnapshotRGB = rgb
            if capture["output"] as? String == "png", let view = message.webView {
                analysisCaptureBounds.append(capture)
                captureChartImage(in: view, bounds: capture) { image, error in
                    guard let image, let png = chartSnapshotPNG(image) else { replyHandler(nil, error ?? "PNG capture failed"); return }
                    self.analysisPNG = png; replyHandler(png, nil)
                }
                return
            }
            replyHandler(["ok": true], nil)
            return
        }
        if request["chartInstId"] != nil {
            guard includeChartBars else { replyHandler(["bars": [], "revision": revision, "error": "Fixture chart"], nil); return }
            let hour = contexts[0].hour
            let bars: [[String: Any]] = (0..<96).map { index in
                let close = (index == 95 ? chartLiveClose : nil) ?? (105 + Double(index) * 0.05 + sin(Double(index) / 5))
                return ["hour": hour - Int64(95 - index) * hourMS, "open": close - 0.3, "high": close + 0.8, "low": close - 0.7, "close": close, "confirmed": index != 95,
                        "vwap": close - 0.4, "ema": 105.0, "logBBUpper": close + 1.5, "logBBMiddle": close, "logBBLower": close - 1.5,
                        "roc": sin(Double(index) / 5) * 2, "maroc": sin(Double(index) / 7), "rsi6": 50 + sin(Double(index) / 5) * 20,
                        "rsi12": 50 + sin(Double(index) / 7) * 10, "rsi24": 50 + sin(Double(index) / 9) * 5, "oi": 100_000_000 + index * 100_000, "buy": 1000 + index * 5, "sell": 800 + index * 3]
            }
            var response: [String: Any] = ["bars": bars, "revision": revision, "error": "", "endHour": hour]
            if let profile = try? Store(url: directory.appendingPathComponent("radar.sqlite3")).selectedSuiteProfile("radar") {
                response["strategy"] = ["id": profile.id, "name": profile.name, "revision": profile.revision]
                response["strategySignals"] = [["hour": hour - 5 * hourMS, "price": 110.0]]
                response["strategyReplay"] = ["fromHour": hour - 95 * hourMS, "throughHour": hour - hourMS, "historyHours": 1001,
                    "completedHours": 95, "matchedHours": 3, "unknownHours": 0,
                    "signals": [["hour": hour - 5 * hourMS, "price": 110.0]]]
            }
            if request["loadChart"] as? Bool == true, request["chartInstId"] as? String == holdChartLoadID {
                holdChartLoadID = nil; heldChartLoadReply = { replyHandler(response, nil) }
                return
            }
            replyHandler(response, nil)
            return
        }
        do {
            if let json = request["filterLibraryPreferencesJSON"] as? String { try radar.setFilterLibraryPreferences(json); revision += 1 }
            replyHandler(snapshot(), nil)
        } catch { replyHandler(nil, String(describing: error)) }
    }
    private func applyAppearance() {
        if let background = windowBackground, let window = background.window {
            background.apply(enabled: radar.frostedBackgroundEnabled, opacity: radar.frostedBackgroundOpacity,
                blurRadius: previewWindowBlur ?? radar.windowBlurRadius, to: window)
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!, file = root.appendingPathComponent(String(url.path.dropFirst()))
        do {
            let data = try Data(contentsOf: file), mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf"][file.pathExtension] ?? "application/octet-stream"
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil)); task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class RuleEditorUITests: BackgroundTestCase {
    private var capturePixels: Bool { ProcessInfo.processInfo.environment["RADAR_VISUAL_TESTS"] == "1" }

    @MainActor
    private func showAllMarkets(_ view: WKWebView, count: Int = 500) async throws {
        try await wait(view, "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'All markets' && !button.disabled)")
        try await click(view, "All markets")
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === \(count)")
    }

    @MainActor
    private func uiConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.inactiveSchedulingPolicy = .none
        return configuration
    }

    @MainActor
    private func present(_ window: BackgroundTestWindow) {
        window.orderBack(nil)
        XCTAssertFalse(NSScreen.screens.contains { $0.frame.intersects(window.frame) })
        XCTAssertFalse(window.isKeyWindow)
        XCTAssertFalse(window.isMainWindow)
    }

    @MainActor
    func testOnlyStrategiesDriveRulesAndInactiveRadarKeepsAllMarkets() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), seedStrategy: false), configuration = uiConfiguration()
        // Universe and setup editing are covered by the strategy workflow scenario.
        // Here a saved, inactive strategy isolates activation and list behavior.
        let store = try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3"))
        func rule(_ source: String) throws -> String { try FilterCompiler.compile(source: source).config.json }
        _ = try store.saveSuiteProfile(.init(name: "Strategy only", universeJSON: try rule("Close > 0"), phaseRules: ["bullishSetup": try rule("Close > 100")]))
        XCTAssertNil(try bridge.radar.monitoringStrategy())
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500 && document.body.innerText.includes('Activate a strategy to monitor signals')")
        let absent = try await js(view, "!document.querySelector('[data-filter-summary]') && !document.body.innerText.includes('Market filters only') && !document.querySelector('[aria-label=\"Saved combinations\"]')") as? Bool
        XCTAssertEqual(absent, true)
        bridge.rows[0]["price"] = 812.0; bridge.revision += 1
        try await input(view, "input[aria-label='Search contracts']", "MKT000")
        try await wait(view, "document.querySelector('tbody')?.innerText.includes('812')", seconds: 5)
        try await input(view, "input[aria-label='Search contracts']", "")
        try await click(view, "Strategy Library…")
        try await wait(view, "document.querySelector('[data-suite-workspace=radar] #suite-strategy-name')?.value === 'Strategy only'")
        try await click(view, "Activate saved strategy"); try await click(view, "Radar")
        try await wait(view, "document.querySelector('[data-signal-lane=bullishSetup]') !== null")
        _ = try await openMenu(view, selector: "[aria-label=\"Active Radar strategy\"]")
        try await option(view, "No active strategy")
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500 && !Array.from(document.querySelectorAll('[data-filter-summary]')).some(node => node.getBoundingClientRect().height > 0)")
        XCTAssertNil(try bridge.radar.monitoringStrategy())
    }

    @MainActor
    func testBTCMarketContextVisualParametersReadingsMaterialsAndNotificationNavigation() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        let h = bridge.contexts[0].hour, now = bridge.contexts[0].now
        let bars = Dictionary(uniqueKeysWithValues: (0...50).map { age in
            let ts = h-Int64(age)*hourMS, price = age == 0 ? 97.0 : 100.0
            return (ts,Candle(hour: ts,high: price+1,low: price-1,close: price,quoteVolume: 100,baseVolume: 1,open: 100,confirmed: age != 0))
        })
        let reference = FilterReferenceSnapshot(market: .init(id: btcReferenceID,hour: h,now: now,listedAt: 1,candles: bars,stats: [:],quotes: [:]), receivedAt: now)
        for index in bridge.contexts.indices { bridge.contexts[index].referenceBTC = reference }
        let store = try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3"))
        let first = try store.saveSuiteProfile(.init(name:"Ordinary strategy",universeJSON:FilterConfigV2().json,phaseRules:["bullishSetup":try FilterCompiler.compile(source:"Close > 0").config.json]))
        var risk = first; risk.id="";risk.revision=0;risk.name="BTC risk strategy";risk.phaseRules["bullishSetup"]=try FilterCompiler.compile(source:#"BTC(ROC(1), "live") <= -2"#).config.json
        risk = try store.saveSuiteProfile(risk)
        configuration.userContentController.addScriptMessageHandler(bridge,contentWorld: .page,name: "radar")
        configuration.setURLSchemeHandler(bridge,forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0,y: 0,width: 1440,height: 1100),styleMask: [.titled,.resizable],backing: .buffered,defer: false)
        let view = WKWebView(frame: .zero,configuration: configuration), background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background; window.contentView = background; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar",contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await wait(view,"Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 6")
        try await click(view,"Universe rules"); try await click(view,"Reset draft")
        _ = try await openMenu(view,selector: "[aria-label=\"Add condition\"]",popover: true)
        try await input(view,"[data-rule-library] [cmdk-input]","BTC Crash")
        try await wait(view,"document.querySelector('[data-rule-library]')?.innerText.includes('BTC Market Context')")
        _ = try await js(view,"document.querySelector('[data-library-id=\"preset:btc-crash\"]').click(); true")
        try await validDraft(view)
        try await wait(view,"document.querySelector('[aria-label=\"Window hours\"]')?.value === '0'")
        try await click(view,"Explain markets")
        try await wait(view,"document.querySelector('[role=dialog] [data-btc-reading-source]')?.innerText.includes('BTC-USDT-SWAP')")
        try await click(view,"Done")
        try await input(view,"[aria-label=\"Window hours\"]","2"); try await validDraft(view)
        try await wait(view,"document.querySelector('[aria-label=\"Window hours\"]')?.value === '2'")
        // BTC clock and indicator parameters are edited as typed controls.
        try await click(view,"Reset draft"); try await click(view,"Add condition")
        try await expression(view, field: "Left expression", choice: "BTC")
        _ = try await openMenu(view,selector: "[aria-label=\"Comparison\"]"); try await option(view,"At most ≤")
        try await input(view,"[aria-label=\"Threshold\"]","-2")
        _ = try await openMenu(view,selector: "[aria-label=\"Left expression BTC clock\"]")
        try await option(view,"Latest closed BTC hour")
        try await validDraft(view)
        try await wait(view,"Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 0")
        try await click(view,"Explain markets")
        try await wait(view,"document.querySelector('[role=dialog] [data-btc-reading-source]')?.innerText.includes('Closed')")
        try await click(view,"Done")
        try await input(view,"[aria-label=\"Left expression Source expression Period (h)\"]","3")
        try await validDraft(view)
        for theme in [NSAppearance.Name.aqua,.darkAqua] {
            window.appearance = NSAppearance(named: theme)
            try await assertSharedSurfaces(view,opacity: bridge.radar.frostedBackgroundOpacity)
        }
        let edited = try await js(view,"document.querySelector('[data-expression-field=\"Left expression\"]')?.dataset.expressionSource") as? String
        XCTAssertEqual(edited,#"BTC(ROC(3), "closed")"#)
        // The native notification event opens the specified saved strategy,
        // even though another strategy was previously selected.
        _ = try store.manageSuite(["action":"select","profileID":first.id],mode:"radar")
        _ = try await js(view,"window.radarNotificationStrategy = \(formulaQuote(risk.id)); window.dispatchEvent(new Event('radar-open-strategy')); true")
        try await wait(view,"document.querySelector('[aria-label=\"Saved strategies\"]')?.textContent.includes('BTC risk strategy')")
        try await click(view,"Activate saved strategy")

        try await click(view,"Confirmed setups");try await input(view,"#phase-search","MKT000");try await click(view,"Explain")
        try await wait(view,"document.querySelector('[role=dialog] [data-btc-reading-source]')?.innerText.includes('Closed')")
        try await click(view,"Provisional live")
        try await wait(view,"document.querySelector('[role=dialog]')?.innerText.includes('Bullish Setup') && document.querySelector('[role=dialog] [data-btc-reading-source]')?.innerText.includes('Live')")
        try await assertSharedSurfaces(view,opacity: bridge.radar.frostedBackgroundOpacity)
        XCTAssertFalse(bridge.rows.contains { $0["instId"] as? String == btcReferenceID })
    }

    @MainActor
    func testBullishSetupRadarSharedResearchRevisionsAndRestoredSnapshotsInNativeWebKit() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), seedStrategy: false), configuration = uiConfiguration()
        let store = try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3"))
        func rule(_ source: String) throws -> String { try FilterCompiler.compile(source: source).config.json }
        let profile = try store.saveSuiteProfile(.init(name:"Shared Radar",universeJSON:try rule("Close > 0 AND Volume > 10"),phaseRules:["bullishSetup":try rule("Close >= 100")]))
        _ = try store.manageSuite(["action":"select","profileID":profile.id],mode:"research")
        // Closed and forming phases can differ. Universe must gate each hour
        // independently for confirmed and provisional Bullish Setup signals.
        for (index,closedPrice,livePrice,closedVolume,liveVolume) in [(0,90.0,110.0,100.0,100.0),(1,100.0,100.0,100.0,100.0),(2,110.0,90.0,100.0,100.0),(3,110.0,110.0,0.0,100.0),(4,110.0,90.0,100.0,0.0)] {
            var market = bridge.contexts[index]
            for (hour,close,volume,confirmed) in [(market.hour-hourMS,closedPrice,closedVolume,true),(market.hour,livePrice,liveVolume,false)] {
                market.candles[hour] = Candle(hour:hour,high:max(110,close),low:min(90,close),close:close,quoteVolume:volume,baseVolume:1,open:105,confirmed:confirmed)
            }
            market.current["Close"] = .number(livePrice); market.current["price"] = .number(livePrice)
            market.current["Volume"] = .number(liveVolume); market.current["liveVolume"] = .number(liveVolume)
            bridge.rows[index]["price"] = livePrice
            bridge.contexts[index] = market
        }
        bridge.research = try ResearchController(directory:bridge.directory.appendingPathComponent("Research"),transport:ResearchFixtureTransport(),radarURL:bridge.directory.appendingPathComponent("absent"))
        bridge.includeChartBars = true
        configuration.userContentController.addScriptMessageHandler(bridge,contentWorld:.page,name:"radar")
        configuration.setURLSchemeHandler(bridge,forURLScheme:"radar")
        let window = BackgroundTestWindow(contentRect:NSRect(x:0,y:0,width:1440,height:900),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        let view = WKWebView(frame:.zero,configuration:configuration), background = WindowBackgroundView(contentView:view)
        bridge.windowBackground=background; window.contentView=background; present(window)
        defer { view.stopLoading();window.orderOut(nil);configuration.userContentController.removeScriptMessageHandler(forName:"radar",contentWorld:.page);bridge.cleanUp() }
        view.load(URLRequest(url:URL(string:"radar://app/index.html")!))
        try await wait(view,"document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT001-USDT-SWAP\"]') !== null")
        let paginated = try await js(view,"document.querySelectorAll('[data-signal-instrument]').length <= 25") as? Bool; XCTAssertEqual(paginated,true)
        try await input(view,"input[aria-label='Search contracts']","MKT00")
        try await wait(view,"document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT003-USDT-SWAP\"]') !== null")
        let singleLane = try await js(view,"document.querySelectorAll('[data-signal-lane]').length === 1 && document.querySelectorAll('[data-signal-instrument]').length <= 25") as? Bool
        XCTAssertEqual(singleLane, true)

        try await assertSharedSurfaces(view,opacity:bridge.radar.frostedBackgroundOpacity)
        for appearance in [NSAppearance.Name.aqua,.darkAqua] {
            window.appearance=NSAppearance(named:appearance)
            try await wait(view,"window.matchMedia('(prefers-color-scheme: dark)').matches === \(appearance == .darkAqua)")
            try await assertSharedSurfaces(view,opacity:bridge.radar.frostedBackgroundOpacity)
        }
        for width in [900.0,1920.0,1440.0] {
            window.setContentSize(NSSize(width:width,height:900))
            try await wait(view,"(() => { const a=document.querySelector('[data-signal-lane=bullishSetup]').getBoundingClientRect(), board=document.querySelector('[data-signal-board]').getBoundingClientRect(), content=document.querySelector('[data-market-list-content]').getBoundingClientRect(); return a.width > board.width * 0.95 && Math.abs(content.width-innerWidth)<1 && document.documentElement.scrollWidth <= innerWidth+1; })()")
        }
        // Optional off-screen WKWebView capture for reviewing this design. It
        // never reads the desktop or brings the test window to the foreground.
        if let path = ProcessInfo.processInfo.environment["RADAR_SIGNAL_PREVIEW_PATH"] {
            try await Task.sleep(for:.milliseconds(150))
            let image: NSImage = try await withCheckedThrowingContinuation { continuation in
                view.takeSnapshot(with:nil) { image,error in
                    if let image { continuation.resume(returning:image) }
                    else { continuation.resume(throwing:error ?? FilterError("Cannot capture signal preview.")) }
                }
            }
            if let data=image.tiffRepresentation, let png=NSBitmapImageRep(data:data)?.representation(using:.png,properties:[:]) { try png.write(to:URL(fileURLWithPath:path)) }
        }
        _ = try await js(view,"document.querySelector('[data-signal-lane=bullishSetup] button[aria-label=\"View MKT001-USDT-SWAP chart\"]').click(); true")
        try await wait(view,"document.querySelector('section[aria-label=\"MKT001-USDT-SWAP chart\"] [data-chart-buy-hour]')?.textContent.includes('BUY') && document.querySelector('[data-strategy-chart-summary]')?.innerText.includes('1 BUY entry')")
        _ = try await js(view,"window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'})); true")
        try await wait(view,"document.querySelector('section[aria-label=\"MKT002-USDT-SWAP chart\"]') !== null")
        try await click(view,"Signals")
        try await wait(view,"document.querySelector('[data-signal-board]') !== null")
        try await click(view,"Confirmed")
        try await wait(view,"!document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT003-USDT-SWAP\"]') && !document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT000-USDT-SWAP\"]')")
        try await click(view,"Provisional")
        try await wait(view,"document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT003-USDT-SWAP\"]') !== null && document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT000-USDT-SWAP\"]') !== null")
        try await click(view,"Both hours");try await input(view,"input[aria-label='Search contracts']","MKT001")
        try await wait(view,"document.querySelectorAll('[data-signal-instrument]').length === 1")
        try await click(view,"Explain MKT001-USDT-SWAP Bullish Setup")
        try await wait(view,"document.querySelector('[role=dialog]')?.innerText.includes('Bullish Setup') && !document.querySelector('[role=dialog]')?.innerText.includes('Bearish Reversal')")
        try await dismissFloating(view)
        try await click(view,"All markets");try await wait(view,"Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 1")
        try await input(view,"input[aria-label='Search contracts']","")
        try await wait(view,"Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500")
        try await click(view,"Signals");try await input(view,"input[aria-label='Search contracts']","MKT00");try await click(view,"Test strategy")
        try await wait(view,"document.querySelector('#study-name')?.value === 'Shared Radar Bullish Setup study'")
        try await click(view,"Strategy Library…")
        try await wait(view,"document.querySelector('#suite-strategy-name')?.value === 'Shared Radar'")
        try await selectPhase(view,"Bullish Setup")
        try await setBasicRule(view, metric: "Close", comparison: "At least ≥", threshold: "115")
        try await wait(view,"Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Save strategy' && !b.disabled && b.getBoundingClientRect().height>0)")
        try await click(view,"Save strategy");try await wait(view,"document.body.innerText.includes('Strategy saved.')")
        XCTAssertEqual(try store.selectedSuiteProfile("radar")?.id,profile.id);XCTAssertEqual(try store.selectedSuiteProfile("radar")?.revision,2)
        try await click(view,"Research");try await click(view,"Perpetual Swap Research")
        try await wait(view,"document.querySelector('[data-signal-board]')?.innerText.includes('Shared Radar · r2') && document.querySelector('[data-signal-lane=bullishSetup]')?.innerText.includes('No BUY signals right now')")
        try await click(view,"Perpetual Swap Radar")
        try await wait(view,"document.querySelector('[data-research]')?.innerText.includes('New saved revisions exist')")
        try await click(view,"Use this version in Radar")
        try await wait(view,"document.title === 'Perpetual Swap Radar' && document.querySelector('[data-signal-lane=bullishSetup] [data-signal-instrument=\"MKT003-USDT-SWAP\"]') !== null")
        let restored = try XCTUnwrap(store.selectedSuiteProfile("radar"))
        XCTAssertNotEqual(restored.id,profile.id);XCTAssertEqual(restored.phaseRules,profile.phaseRules)
        let researchProfiles = try store.suiteProfiles("research")
        XCTAssertEqual(Set(researchProfiles.map(\.id)), [defaultStrategyID, profile.id, restored.id])
    }

    @MainActor
    func testBullishSetupEditingSavingActivationAndResearchInNativeWebKit() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        // This scenario tests setup editing and activation; the separate menu and
        // navigation benchmarks retain the full 500-market workload.
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), seedStrategy: false, marketCount: 8), configuration = uiConfiguration()
        let directory = bridge.directory.appendingPathComponent("Research"), store = try ResearchStore(directory: directory)
        try ResearchFixture.seed(store)
        bridge.research = try ResearchController(directory: directory,transport: ResearchFixtureTransport(),radarURL: bridge.directory.appendingPathComponent("absent"),exportDestination: { kind,_ in directory.appendingPathComponent("bullish-\(kind).csv") })
        let originalRadarRules = try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3")).preference(forKey: "marketFiltersV2JSON")
        configuration.userContentController.addScriptMessageHandler(bridge,contentWorld: .page,name: "radar")
        configuration.setURLSchemeHandler(bridge,forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0,y: 0,width: 1440,height: 900),styleMask: [.titled,.closable,.resizable],backing: .buffered,defer: false)
        let view = WKWebView(frame: .zero,configuration: configuration), background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background; window.contentView = background; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar",contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await wait(view,"Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 8")
        try await click(view,"Strategy Library")
        try await wait(view,"document.querySelector('[data-suite-workspace=radar] #suite-strategy-name') !== null")
        XCTAssertEqual(bridge.foregroundWorkspace,"radar")
        try await click(view,"New strategy")
        try await wait(view,"document.querySelector('#suite-strategy-name')?.value === 'My strategy' && !document.querySelector('#suite-strategy-name')?.disabled")
        try await input(view,"#suite-strategy-name","WK Bullish")
        for (label,metric,comparison,threshold) in [("Universe","Close","Greater than >","0"),("Bullish Setup","Close","At least ≥","100")] {
            try await selectPhase(view,label)
            try await setBasicRule(view, metric: metric, comparison: comparison, threshold: threshold)
        }
        try await selectPhase(view,"Bullish Setup")
        _ = try await openMenu(view, selector: "[aria-label=\"Choose Left expression\"]", popover: true)
        let hidesPositionReadings = try await js(view, "!Array.from(document.querySelectorAll('[cmdk-item]')).some(x => x.dataset.value?.endsWith(' LongReturn'))") as? Bool
        XCTAssertEqual(hidesPositionReadings, true, "Entry phases must not offer position-only readings.")
        _ = try await js(view, "document.querySelector('[data-slot=\"popover-content\"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
        try await selectPhase(view,"Bullish Setup")
        try await input(view,"[aria-label=\"Threshold\"]","",textarea: false)
        try await wait(view,"document.body.innerText.includes('Last valid preview') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Save strategy' && b.disabled)")
        try await input(view,"[aria-label=\"Threshold\"]","100")
        try await click(view,"Save strategy"); try await wait(view,"document.body.innerText.includes('Strategy saved.')")
        XCTAssertEqual(try Store(url:bridge.directory.appendingPathComponent("radar.sqlite3")).suiteProfiles("radar").first?.name,"WK Bullish")
        try await click(view,"Activate saved strategy"); try await click(view,"Confirmed setups")
        try await wait(view,"document.querySelector('table[aria-label=\"Confirmed phase readings\"]')?.innerText.includes('Bullish Setup')")
        XCTAssertEqual(try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3")).preference(forKey: "marketFiltersV2JSON"),originalRadarRules)
        try await assertSharedSurfaces(view,opacity: bridge.radar.frostedBackgroundOpacity)
        try await input(view,"#phase-search","MKT000")
        try await click(view,"Explain"); try await wait(view,"document.querySelector('[role=dialog]')?.innerText.includes('Bullish Setup')")
        try await dismissFloating(view)
        try await click(view,"Strategy rules")
        let focused = try await js(view,"Array.from(document.querySelectorAll('[aria-label=\"Phase rule editor\"] button')).map(b=>b.getAttribute('aria-label')).join('|') === 'Universe|Bullish Setup' && !document.querySelector('[data-suite-workspace=radar]').innerText.includes('Positions')") as? Bool
        XCTAssertEqual(focused, true)
        try await click(view,"Duplicate saved strategy")
        try await wait(view,"document.body.innerText.includes('Strategy duplicated in the shared library')")
        let profiles = try Store(url:bridge.directory.appendingPathComponent("radar.sqlite3")).suiteProfiles("research")
        XCTAssertEqual(Set(profiles.map(\.name)), ["Default Strategy", "WK Bullish", "WK Bullish copy"])
        try await click(view,"Backtest saved strategy")
        try await wait(view,"document.querySelector('#study-name')?.value === 'WK Bullish Bullish Setup study'")
        let questions = try await js(view,"Array.from(document.querySelectorAll('[aria-label=\"Research question\"] button')).map(b=>b.textContent.trim()).join('|')") as? String
        XCTAssertEqual(questions, "Strategy signals|Opportunity|Compare strategies")
        let direction = try await js(view,"!document.querySelector('[aria-label=\"Study direction\"]') && !document.querySelector('[aria-label=\"Study strategy phase\"]')") as? Bool
        XCTAssertEqual(direction, true)
    }

    @MainActor
    func testResearchPrepareRunFrozenChartPaginationAndRadarIsolationInNativeWebKit() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        let directory = bridge.directory.appendingPathComponent("Research"), store = try ResearchStore(directory: directory)
        try ResearchFixture.seed(store)
        bridge.research = try ResearchController(directory: directory, transport: ResearchFixtureTransport(), radarURL: bridge.directory.appendingPathComponent("absent"), exportDestination: { kind, _ in directory.appendingPathComponent("research-\(kind).csv") })
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration), background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background; window.contentView = background; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 6")
        let nativeStore = try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3"))
        var shared = try XCTUnwrap(nativeStore.selectedSuiteProfile("radar"))
        shared.universeJSON = try FilterCompiler.compile(source: "spread <= 0.15").config.json
        _ = try nativeStore.saveSuiteProfile(shared)
        bridge.workspaceError = "Mode switch temporarily unavailable"
        try await click(view, "Perpetual Swap Radar")
        try await wait(view,"document.querySelector('[role=alert]')?.textContent.includes('Mode switch temporarily unavailable')")
        let failedTitle = try await js(view,"document.title") as? String
        XCTAssertEqual(failedTitle,"Perpetual Swap Radar"); XCTAssertEqual(bridge.foregroundWorkspace,"radar")
        bridge.workspaceError = nil; bridge.workspaceDelay = 300_000_000
        _ = try await js(view,"document.querySelector('[data-mode-switch=radar]').focus(); true")
        let enter = try XCTUnwrap(NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[],timestamp:0,windowNumber:window.windowNumber,context:nil,characters:"\r",charactersIgnoringModifiers:"\r",isARepeat:false,keyCode:36))
        view.keyDown(with:enter)
        try await wait(view,"document.querySelector('[data-mode-switch=radar]').disabled")
        try await wait(view, "document.querySelector('[data-research]') !== null")
        bridge.workspaceDelay = 0
        XCTAssertEqual(bridge.foregroundWorkspace, "research")
        XCTAssertEqual(window.title,"Perpetual Swap Research")
        try await wait(view,"document.activeElement.dataset.modeSwitch === 'research'")
        try await Task.sleep(for: .milliseconds(300))
        var radarRequests = bridge.radarRequests
        try await Task.sleep(for: .milliseconds(2300))
        XCTAssertEqual(bridge.radarRequests, radarRequests, "Radar polling and live chart loads must stop while researching.")
        try await click(view, "Strategy signals")
        try await input(view, "#study-name", "WKWebView experiment")
        try await click(view,"Perpetual Swap Research")
        try await wait(view,"document.title === 'Perpetual Swap Radar'")
        try await click(view,"Perpetual Swap Radar")
        try await wait(view,"document.title === 'Perpetual Swap Research' && document.querySelector('#study-name')?.value === 'WKWebView experiment'")
        try await click(view,"Strategy Library…")
        try await wait(view,"document.querySelector('[data-suite-workspace=research] #suite-strategy-name') !== null")
        try await input(view,"[data-suite-workspace=research] #suite-strategy-name","Retained Research draft")
        try await click(view,"Perpetual Swap Research")
        try await wait(view,"document.title === 'Perpetual Swap Radar'")
        try await click(view,"Perpetual Swap Radar")
        try await wait(view,"document.title === 'Perpetual Swap Research' && document.querySelector('[data-suite-workspace=research] #suite-strategy-name')?.value === 'Retained Research draft'")
        try await click(view,"Research")
        try await wait(view,"document.querySelector('#study-name')?.getBoundingClientRect().height > 0")
        try await click(view,"Strategy signals")
        try await Task.sleep(for:.milliseconds(300))
        radarRequests = bridge.radarRequests
        bridge.researchReadError = "Research cache temporarily locked"
        try await wait(view,"document.querySelector('[data-research-task] [role=alert]')?.innerText.includes('Research cache temporarily locked')")
        bridge.researchReadError = nil
        try await wait(view,"!document.body.innerText.includes('Research cache temporarily locked')")
        let recoveredName = try await js(view,"document.querySelector('#study-name').value") as? String
        XCTAssertEqual(recoveredName,"WKWebView experiment", "Reconnection must preserve the research draft.")
        let researchDescription = try await js(view, "document.querySelector('[data-research]').innerText") as? String ?? ""
        XCTAssertTrue(researchDescription.contains("Bid/ask spread data is excluded from Research"))
        XCTAssertTrue(researchDescription.contains("Order book archives are not downloaded"))
        bridge.researchJobOverride = ["id": "catalog", "phase": "planning", "completed": 4, "total": 8, "message": "Checking candle archive catalog", "error": "", "updatedAt": researchNow() - 20_000,
            "catalog": ["kind": "candle", "completed": 4, "total": 8, "message": "Checking candle archive catalog", "waitingForResponse": true, "remainingSeconds": 60]]
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('Catalog pages checked: 4 / 8') && document.querySelector('[data-research-task]')?.innerText.includes('No data received for')")
        let catalogStatus = try await js(view, "document.querySelector('[data-research-task]').innerText") as? String ?? ""
        XCTAssertTrue(catalogStatus.contains("file downloads start after Prepare Data"))
        XCTAssertTrue(catalogStatus.contains("Estimated catalog time remaining: About 1m 0s"))
        bridge.researchJobOverride = ["id": "coverage", "phase": "planning", "completed": 3600, "total": 7200, "message": "Checking local coverage · BTC-USDT-SWAP · candle", "error": "", "updatedAt": researchNow(),
            "planning": ["stage": "coverage", "unit": "hours", "completed": 3600, "total": 7200, "message": "Checking local coverage · BTC-USDT-SWAP · candle", "from": ResearchFixture.hour, "through": ResearchFixture.hour + 719 * hourMS, "remainingSeconds": 120]]
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('Hourly inputs checked: 3,600 / 7,200 · 50.0%')")
        let localStatus = try await js(view, "document.querySelector('[data-research-task]').innerText") as? String ?? ""
        XCTAssertTrue(localStatus.contains("Checking local input coverage")); XCTAssertTrue(localStatus.contains("Current range:"))
        XCTAssertTrue(localStatus.contains("Estimated check time remaining: About 2m 0s"))
        XCTAssertFalse(localStatus.contains("Counting")); XCTAssertFalse(localStatus.contains("Reading archive catalogs"))
        let localPercent = try await js(view, "document.querySelector('[aria-label=\"Research task progress\"]').getAttribute('aria-valuenow')") as? String
        XCTAssertEqual(localPercent, "50")
        bridge.researchJobOverride?["completed"] = 5400; bridge.researchJobOverride?["phase"] = "failed"
        bridge.researchJobOverride?["error"] = "Local coverage check failed · BTC-USDT-SWAP · candle: database read failed"
        try await wait(view, "document.querySelector('[data-research-task] [role=alert]')?.innerText.includes('database read failed') && document.querySelector('[data-research-task]')?.innerText.includes('Hourly inputs checked: 5,400 / 7,200')")
        bridge.researchJobOverride = ["id": "transfer", "phase": "preparing", "completed": 3, "total": 10, "message": "BTC-USDT-SWAP-2025-06.zip", "error": "", "startedAt": researchNow() - 60_000, "updatedAt": researchNow(),
            "preparation": ["stage": "downloading", "filename": "BTC-USDT-SWAP-2025-06.zip", "instrument": "BTC-USDT-SWAP", "receivedBytes": 50_000_000, "totalBytes": 100_000_000, "bytesPerSecond": 1_000_000, "fileRemainingSeconds": 50, "remainingSeconds": 600, "pages": 0]]
        try await wait(view, "document.querySelector('[aria-label=\"Current file download progress\"]')?.getAttribute('aria-valuenow') === '50'")
        let downloadStatus = try await js(view, "document.querySelector('[data-research-task]').innerText") as? String ?? ""
        XCTAssertTrue(downloadStatus.contains("50 MB / 100 MB")); XCTAssertTrue(downloadStatus.contains("1 MB/s"))
        XCTAssertTrue(downloadStatus.contains("File remaining: About 50s")); XCTAssertTrue(downloadStatus.contains("Estimated time to ready: About 10m 0s"))
        let placement = try await js(view, "window.scrollTo(0, document.body.scrollHeight); const r=document.querySelector('[data-research-task]').getBoundingClientRect(); r.top >= 0 && r.bottom <= window.innerHeight + 1") as? Bool
        XCTAssertEqual(placement, true, "Download status must stay visible after scrolling.")
        try await assertSharedSurfaces(view, opacity: bridge.radar.frostedBackgroundOpacity)
        if var progress = bridge.researchJobOverride?["preparation"] as? [String: Any] { progress["receivedBytes"] = 75_000_000; bridge.researchJobOverride?["preparation"] = progress }
        _ = try await js(view, "document.documentElement.style.setProperty('--window-background-opacity','0'); true")
        try await assertSharedSurfaces(view, opacity: 0)
        _ = try await js(view, "document.documentElement.style.setProperty('--window-background-opacity','\(bridge.radar.frostedBackgroundOpacity)'); true")
        try await wait(view, "document.querySelector('[aria-label=\"Current file download progress\"]')?.getAttribute('aria-valuenow') === '75'")
        if var progress = bridge.researchJobOverride?["preparation"] as? [String: Any] { progress["retryAt"] = researchNow() + 5_000; bridge.researchJobOverride?["preparation"] = progress }
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('Retrying automatically in') && Array.from(document.querySelectorAll('[data-research-task] button')).some(b=>b.textContent.trim()==='Pause') && !Array.from(document.querySelectorAll('[data-research-task] button')).some(b=>b.textContent.trim()==='Resume') && document.querySelector('[aria-label=\"Current file download progress\"]')?.getAttribute('aria-valuenow') === '75'", seconds: 3)
        if var progress = bridge.researchJobOverride?["preparation"] as? [String: Any] { progress["retryAt"] = researchNow() - 1; bridge.researchJobOverride?["preparation"] = progress }
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('Retrying the current request automatically')", seconds: 3)
        if var progress = bridge.researchJobOverride?["preparation"] as? [String: Any] { progress.removeValue(forKey: "retryAt"); bridge.researchJobOverride?["preparation"] = progress }
        bridge.researchJobOverride?["retryAt"] = researchNow() + 5_000
        bridge.researchJobOverride?["recovery"] = "The network connection was lost."
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('network connection was lost') && document.querySelector('[data-research-task]')?.innerText.includes('Retrying automatically in') && !document.querySelector('[data-research-task] [role=alert]') && Array.from(document.querySelectorAll('[data-research-task] button')).some(b=>b.textContent.trim()==='Pause') && !Array.from(document.querySelectorAll('[data-research-task] button')).some(b=>b.textContent.trim()==='Resume')", seconds: 3)
        bridge.researchJobOverride?.removeValue(forKey: "retryAt"); bridge.researchJobOverride?.removeValue(forKey: "recovery")
        if var progress = bridge.researchJobOverride?["preparation"] as? [String: Any] {
            progress["stage"] = "recovering"; progress["recovery"] = "Checking missing archive hours automatically."
            bridge.researchJobOverride?["preparation"] = progress
        }
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('Recovering missing data') && document.querySelector('[data-research-task]')?.innerText.includes('Checking missing archive hours automatically.') && !document.querySelector('[data-research-task] [role=alert]')", seconds: 3)
        if var progress = bridge.researchJobOverride?["preparation"] as? [String: Any] {
            progress["stage"] = "downloading"; progress.removeValue(forKey: "recovery")
            bridge.researchJobOverride?["preparation"] = progress
        }
        bridge.researchJobOverride?["updatedAt"] = researchNow() - 20_000
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('No data received for')")
        bridge.researchJobOverride?["phase"] = "failed"; bridge.researchJobOverride?["error"] = "Archive connection lost: BTC-USDT-SWAP-2025-06.zip"
        try await wait(view, "document.querySelector('[data-research-task] [role=alert]')?.innerText.includes('Archive connection lost')")
        bridge.researchJobOverride = nil
        _ = try await js(view, "window.scrollTo(0,0); true")
        try await click(view, "Every matching hour")
        let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; formatter.timeZone = TimeZone(secondsFromGMT: 0)
        try await input(view, "#study-from", formatter.string(from: Date(timeIntervalSince1970: Double(ResearchFixture.hour)/1000)))
        try await input(view, "#study-through", formatter.string(from: Date(timeIntervalSince1970: Double(ResearchFixture.hour+192*hourMS)/1000)))
        try await click(view, "Review data plan")
        try await wait(view, "document.body.innerText.includes('This range is fully cached.')", seconds: 4)
        let planDescription = try await js(view, "document.querySelector('[data-research]').innerText") as? String ?? ""
        XCTAssertTrue(planDescription.contains("Spread-dependent conditions excluded from this study (1)"))
        let sourceKinds = try await js(view, "Array.from(document.querySelectorAll('table[aria-label=\"Planned data sources\"] tbody tr')).map(row => row.cells[1].innerText).join(',')") as? String ?? ""
        XCTAssertFalse(sourceKinds.contains("spread"))
        try await click(view, "Prepare Data")
        try await wait(view, "document.body.innerText.includes('Frozen dataset') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Run Study')")
        try await click(view, "Run Study")
        try await wait(view, "document.querySelector('table[aria-label=\"Signal events\"] tbody tr') !== null", seconds: 30)
        try await assertSharedSurfaces(view, opacity: bridge.radar.frostedBackgroundOpacity)
        XCTAssertEqual(bridge.radarRequests, radarRequests)
        for kind in ["summary", "events"] {
            try await click(view, "Export \(kind) CSV")
            let destination = directory.appendingPathComponent("research-\(kind).csv")
            let deadline = Date().addingTimeInterval(5)
            while !FileManager.default.fileExists(atPath: destination.path), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertTrue(try String(contentsOf: destination, encoding: .utf8).contains("data_digest"))
            try await wait(view, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Export \(kind) CSV' && !b.disabled)")
        }
        try await click(view, "Next events")
        try await wait(view, "document.body.innerText.includes('51–')")
        let inspect = try await js(view, "document.querySelector('table[aria-label=\"Signal events\"] tbody button').getAttribute('aria-label')") as! String
        try await click(view, inspect)
        try await wait(view, "document.querySelector('section[aria-label=\"Frozen event chart\"] svg') !== null")
        try await click(view, "Copy chart")
        try await wait(view, "document.body.innerText.includes('Copied')")
        XCTAssertEqual(bridge.chartSnapshotRGB.count, 3)
        let frozen = try await js(view, "document.querySelector('svg[aria-label^=\"Frozen 96-hour\"]').outerHTML") as? String
        bridge.revision += 1; bridge.rows[0]["price"] = 1_000_000
        try await Task.sleep(for: .milliseconds(1100))
        let unchanged = try await js(view, "document.querySelector('svg[aria-label^=\"Frozen 96-hour\"]').outerHTML") as? String
        XCTAssertEqual(frozen, unchanged, "Frozen chart values must ignore all live feed changes.")
        try await dismissFloating(view)
        try await click(view, "Score calibration"); try await click(view, "Partial inputs")
        try await wait(view, "document.querySelector('table[aria-label=\"Study statistics\"]') !== null")
        try await click(view, "Studies & cache")
        try await click(view, "Copy configuration")
        try await wait(view, "document.querySelector('#study-name')?.value === 'WKWebView experiment copy'")
        var comparison = shared; comparison.id = UUID().uuidString; comparison.name = "Comparison strategy"; comparison.revision = 0
        comparison.universeJSON = try FilterCompiler.compile(source: "Close > 0").config.json
        _ = try nativeStore.saveSuiteProfile(comparison)
        try await click(view, "Compare strategies")
        _ = try await openMenu(view, selector: "[aria-label=\"Compare strategy\"]")
        try await option(view, "Comparison strategy · r1")
        try await wait(view, "document.querySelector('[aria-label=\"Compare strategy\"]')?.textContent.includes('Comparison strategy · r1')")
        try await click(view, "Review data plan"); try await wait(view, "document.body.innerText.includes('This range is fully cached.')")
        try await click(view, "Prepare Data"); try await wait(view, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Run Study')")
        try await click(view, "Run Study")
        try await wait(view, "document.querySelector('table[aria-label=\"Signal events\"]') !== null", seconds: 30)
        try await click(view, "Perpetual Swap Research")
        try await wait(view, "document.title === 'Perpetual Swap Radar' && document.querySelector('[data-research]').getBoundingClientRect().height === 0")
        XCTAssertEqual(bridge.foregroundWorkspace, "radar")
        XCTAssertEqual(window.title,"Perpetual Swap Radar")
        try await Task.sleep(for: .milliseconds(2300))
        XCTAssertGreaterThan(bridge.radarRequests, radarRequests)
    }

    @MainActor
    func testLargeResearchDataPlanKeepsWorkspaceSwitchingResponsive() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 500), configuration = uiConfiguration()
        let directory = bridge.directory.appendingPathComponent("Research"), store = try ResearchStore(directory: directory)
        var plan = ResearchFixture.plan(try ResearchFixture.spec())
        plan.spec.name = "All contracts data plan"
        plan.instruments = (0..<500).map { index in
            var instrument = ResearchFixture.instrument; instrument.id = "PLAN\(index)-USDT-SWAP"; return instrument
        }
        plan.referenceInstruments = [ResearchFixture.instrument]
        plan.sources = plan.instruments.flatMap { instrument in
            (0..<12).map { index in
                ResearchSource(id: "\(instrument.id):\(index)", instrument: instrument.id, kind: "candle", from: plan.from, through: plan.through,
                    url: "https://www.okx.com/fixture", filename: "\(instrument.id)-\(index).zip", archive: true)
            }
        }
        plan.coverage = plan.inputInstruments.flatMap { instrument in
            ["candle", "stat", "funding"].map { kind in
                ResearchCoverage(instrument: instrument.id, kind: kind, available: 120, expected: 240, first: plan.from, last: plan.through,
                    gaps: (0..<64).map { index in .init(from: plan.from + Int64(index * 2) * hourMS, through: plan.from + Int64(index * 2) * hourMS) })
            }
        }
        try store.put(plan.id, kind: "plan", plan)
        bridge.research = try ResearchController(directory: directory, transport: ResearchFixtureTransport(), radarURL: bridge.directory.appendingPathComponent("absent"))
        bridge.researchJobOverride = ["id": "large-plan", "phase": "planned", "resultID": plan.id, "completed": 1, "total": 1, "message": "Plan ready", "error": ""]
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view)
        try await click(view, "Perpetual Swap Radar")
        try await wait(view, "document.querySelector('table[aria-label=\"Planned data sources\"] tbody tr') !== null")
        try await wait(view, "!document.querySelector('table[aria-label=\"Frozen input coverage\"]') && !document.querySelector('table[aria-label=\"Historical instrument catalog\"]')")
        try await click(view, "Last sources")
        try await wait(view, "document.querySelector('table[aria-label=\"Planned data sources\"] tbody').lastElementChild.innerText.includes('PLAN499-USDT-SWAP-11.zip')")
        try await click(view, "First sources"); try await click(view, "Next sources")
        try await wait(view, "document.querySelector('table[aria-label=\"Planned data sources\"] tbody').firstElementChild.innerText.includes('PLAN4-USDT-SWAP-2.zip')")

        for expanded in [false, true] {
            if expanded {
                try await click(view, "Local input coverage and data gaps")
                try await wait(view, "document.querySelectorAll('table[aria-label=\"Frozen input coverage\"] tbody tr').length === 50")
                try await click(view, "Missing intervals for PLAN0-USDT-SWAP candle")
                try await wait(view, "document.querySelectorAll('div[aria-label=\"Missing intervals for PLAN0-USDT-SWAP candle\"] p').length === 50")
                try await click(view, "Next gaps for PLAN0-USDT-SWAP candle")
                try await wait(view, "document.querySelectorAll('div[aria-label=\"Missing intervals for PLAN0-USDT-SWAP candle\"] p').length === 14")
                try await click(view, "Last coverage")
                try await wait(view, "document.querySelectorAll('table[aria-label=\"Frozen input coverage\"] tbody tr').length === 3 && document.querySelector('table[aria-label=\"Frozen input coverage\"]').innerText.includes('BTC-USDT-SWAPReference')")
                try await click(view, "First coverage"); try await click(view, "Next coverage")
                try await click(view, "Missing intervals for PLAN16-USDT-SWAP funding")
                try await click(view, "Next gaps for PLAN16-USDT-SWAP funding")
                try await click(view, "Historical instrument eligibility and sources")
                try await wait(view, "document.querySelectorAll('table[aria-label=\"Historical instrument catalog\"] tbody tr').length === 50")
                try await click(view, "Last instruments")
                try await wait(view, "document.querySelectorAll('table[aria-label=\"Historical instrument catalog\"] tbody tr').length === 1 && document.querySelector('table[aria-label=\"Historical instrument catalog\"]').innerText.includes('BTC-USDT-SWAP')")
                try await click(view, "First instruments"); try await click(view, "Next instruments")
            }
            for _ in 0..<2 {
                for mode in ["research", "radar"] {
                    let elapsed = try await view.callAsyncJavaScript("""
                        const start = performance.now();
                        document.querySelector('[data-mode-switch=' + mode + ']').click();
                        const target = mode === 'research' ? 'radar' : 'research';
                        await new Promise((resolve, reject) => {
                            const check = () => {
                                const button = document.querySelector('[data-mode-switch=' + target + ']');
                                if (button && !button.disabled && button.getBoundingClientRect().height > 0 && document.activeElement === button) {
                                    requestAnimationFrame(() => requestAnimationFrame(resolve)); return;
                                }
                                if (performance.now() - start > 5000) { reject(new Error('Workspace switch stalled')); return; }
                                requestAnimationFrame(check);
                            };
                            requestAnimationFrame(check);
                        });
                        return performance.now() - start;
                        """, arguments: ["mode": mode], in: nil, contentWorld: .page) as? Double
                    print("Large data plan \(mode) switch (expanded: \(expanded)): \(elapsed ?? -1)ms")
                    XCTAssertLessThan(try XCTUnwrap(elapsed), 500, "Switching with an all-contract data plan must remain interactive.")
                }
            }
            try await wait(view, "document.querySelector('table[aria-label=\"Planned data sources\"] tbody').firstElementChild.innerText.includes('PLAN4-USDT-SWAP-2.zip')")
            if expanded {
                try await wait(view, "document.querySelector('table[aria-label=\"Frozen input coverage\"] tbody').firstElementChild.innerText.includes('PLAN16-USDT-SWAP') && document.querySelector('table[aria-label=\"Historical instrument catalog\"] tbody').firstElementChild.innerText.includes('PLAN50-USDT-SWAP')")
                try await wait(view, "document.querySelectorAll('div[aria-label=\"Missing intervals for PLAN16-USDT-SWAP funding\"] p').length === 14")
            }
        }
        try await click(view, "Configure"); try await click(view, "Data coverage")
        try await wait(view, "document.querySelector('table[aria-label=\"Planned data sources\"] tbody').firstElementChild.innerText.includes('PLAN4-USDT-SWAP-2.zip')")
    }

    @MainActor
    func testFrozenResearchWarningsStayPagedAndInteractiveAfterPreparation() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        let directory = bridge.directory.appendingPathComponent("Research"), store = try ResearchStore(directory: directory)
        let spec = try ResearchFixture.spec(), plan = ResearchFixture.plan(spec)
        var manifest = DataManifest(planID: plan.id, from: plan.from, through: plan.through, instruments: plan.instruments, warnings: [], unknownInstruments: [])
        manifest.warnings = (0..<4445).map { "Archive warning \($0): base-currency volume for 43200 minute candles was converted using verified contract metadata. Quote-currency volume is missing; affected VWAP inputs remain Unknown. OHLC prices were imported." }
        manifest.sources = (0..<13209).map { index in
            ResearchSource(id: "source-\(index)", instrument: ResearchFixture.instrument.id, kind: "candle", from: plan.from, through: plan.through, url: "https://www.okx.com/fixture/\(index)", filename: "archive-\(index).zip", archive: true)
        }
        let study = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
        try store.put(plan.id, kind: "plan", plan)
        try store.put(manifest.id, kind: "manifest", manifest)
        try store.put(study.id, kind: "study", study)
        try store.put("checkpoint:\(study.id)", kind: "checkpoint", Checkpoint(studyID: study.id, phase: "ready"))
        bridge.research = try ResearchController(directory: directory, transport: ResearchFixtureTransport())
        bridge.researchJobOverride = ["id": "prepared", "phase": "ready", "resultID": study.id, "completed": 1, "total": 1, "message": "Dataset frozen and ready to run.", "error": ""]
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await click(view, "Perpetual Swap Radar")
        try await click(view, "Data coverage")
        try await wait(view, "document.querySelector('[aria-label=\"Data warnings\"]')?.innerText.includes('Data warnings (4,445)')")
        try await wait(view, "document.querySelectorAll('[aria-label=\"Data warnings\"] [role=alert]').length === 50")
        try await click(view, "Last warnings")
        try await wait(view, "document.querySelectorAll('[aria-label=\"Data warnings\"] [role=alert]').length === 45 && document.querySelector('[aria-label=\"Data warnings\"]').innerText.includes('Archive warning 4444:')")
        try await click(view, "First warnings"); try await click(view, "Next warnings")
        try await wait(view, "document.querySelector('[aria-label=\"Data warnings\"] [role=alert]').innerText.includes('Archive warning 50:')")
        for label in ["Configure", "Data coverage", "Studies & cache", "Data coverage", "Perpetual Swap Research", "Perpetual Swap Radar"] {
            let elapsed = try await view.callAsyncJavaScript("""
                const start = performance.now();
                const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === label && b.getBoundingClientRect().height > 0);
                if (!button || button.disabled) throw new Error('Missing enabled control: ' + label);
                button.click();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return performance.now() - start;
                """, arguments: ["label": label], in: nil, contentWorld: .page) as? Double
            print("Frozen dataset \(label) interaction: \(elapsed ?? -1)ms")
            XCTAssertLessThan(try XCTUnwrap(elapsed), 500, "Prepared archive warnings must not stall ordinary clicks.")
        }
        try await wait(view, "document.querySelector('[data-research]')?.getBoundingClientRect().height > 0 && Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Run Study' && !b.disabled)")
        let rows = try await js(view, "document.querySelectorAll('[aria-label=\"Data warnings\"] [role=alert]').length") as? Int
        XCTAssertEqual(rows, 50)
    }

    @MainActor
    func testResearchReportSwitchIgnoresLateEventsFromThePreviousStudy() async throws {
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        let directory = bridge.directory.appendingPathComponent("Research"), store = try ResearchStore(directory: directory)
        try ResearchFixture.seed(store)
        let bars = ResearchFixture.bars()
        try store.write(bars.map { .init(instrument: "ETH-USDT-SWAP", kind: "candle", timestamp: $0.hour, candle: $0, sources: ["fixture"]) })
        for (instrument, name) in [("BTC-USDT-SWAP", "Bitcoin experiment"), ("ETH-USDT-SWAP", "Ether experiment")] {
            var spec = try ResearchFixture.spec(); spec.name = name; spec.instruments = [instrument]
            var plan = ResearchFixture.plan(spec); plan.instruments[0].id = instrument
            let manifest = try store.freeze(plan), study = ResearchStudy(spec: spec, planID: plan.id, manifestID: manifest.id)
            var checkpoint = Checkpoint(studyID: study.id, phase: "running")
            try ResearchEngine.run(store: store, study: study, manifest: manifest, checkpoint: &checkpoint) { _, _, _ in }
            let report = try store.report(study, manifest: manifest)
            checkpoint.phase = "completed"
            try store.put(study.id, kind: "study", study)
            try store.put("report:\(study.id)", kind: "report", report)
            try store.put("checkpoint:\(study.id)", kind: "checkpoint", checkpoint)
        }
        bridge.research = try ResearchController(directory: directory, transport: ResearchFixtureTransport(), radarURL: bridge.directory.appendingPathComponent("absent"))
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        window.contentView = view; present(window)
        defer {
            bridge.heldResearchEventsReply?(); bridge.heldResearchEventsReply = nil
            view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp()
        }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await click(view, "Perpetual Swap Radar")
        try await wait(view, "document.querySelector('[data-research]')?.getBoundingClientRect().height > 0")
        try await click(view, "Studies & cache")
        try await wait(view, "document.querySelector('table[aria-label=\"Saved studies\"] tbody').innerText.includes('Ether experiment')")
        bridge.holdNextResearchEvents = true
        _ = try await js(view, "Array.from(document.querySelectorAll('table[aria-label=\"Saved studies\"] tbody tr')).find(row => row.innerText.includes('Bitcoin experiment')).querySelector('button').click(); true")
        let deadline = ContinuousClock.now + .seconds(5)
        while bridge.heldResearchEventsReply == nil && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNotNil(bridge.heldResearchEventsReply)
        _ = try await js(view, "Array.from(document.querySelectorAll('table[aria-label=\"Saved studies\"] tbody tr')).find(row => row.innerText.includes('Ether experiment')).querySelector('button').click(); true")
        try await wait(view, "document.querySelector('table[aria-label=\"Signal events\"] tbody')?.innerText.includes('ETH-USDT-SWAP')")
        bridge.heldResearchEventsReply?(); bridge.heldResearchEventsReply = nil
        try await Task.sleep(for: .milliseconds(100))
        let instruments = try await js(view, "Array.from(document.querySelectorAll('table[aria-label=\"Signal events\"] tbody tr')).map(row => row.cells[0].innerText)") as? [String]
        XCTAssertFalse(instruments?.isEmpty ?? true)
        XCTAssertEqual(Set(instruments ?? []), ["ETH-USDT-SWAP"], "Late Bitcoin events must never appear under the Ether report's statistics or rule evidence.")
    }

    @MainActor
    func testSavedResearchErrorsWrapInsideTheirColumnAndStaySeparateFromTheCurrentTask() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist")), configuration = uiConfiguration()
        let directory = bridge.directory.appendingPathComponent("Research"), store = try ResearchStore(directory: directory)
        try ResearchFixture.seed(store)
        var oldSpec = try ResearchFixture.spec(); oldSpec.name = "Historical failed study"
        var failed = ResearchStudy(spec: oldSpec, planID: "old-plan"); failed.createdAt = researchNow() - 3_600_000
        let savedError = "BTC-USDT-SWAP · BTC-USDT-SWAP-candlesticks-2021-09.zip: 43200 invalid archive records; the file was kept for retry, and coverage was not marked complete.\n" + String(repeating: "long-record-name-", count: 35)
        var checkpoint = Checkpoint(studyID: failed.id, phase: "failed"); checkpoint.error = savedError; checkpoint.updatedAt = failed.createdAt + 60_000
        try store.put(failed.id, kind: "study", failed); try store.put("checkpoint:\(failed.id)", kind: "checkpoint", checkpoint)
        var currentSpec = try ResearchFixture.spec(); currentSpec.name = "Current preparing study"
        var plan = ResearchFixture.plan(currentSpec)
        plan.sources = [.init(id: "current-source", instrument: ResearchFixture.instrument.id, kind: "candle", from: ResearchFixture.hour, through: ResearchFixture.hour + 2 * hourMS,
            url: ResearchDataProvider.url("/market/history-candles", [("after", String(ResearchFixture.hour + 3 * hourMS))]).absoluteString, filename: "Current history range", archive: false)]
        try store.put(plan.id, kind: "plan", plan)
        let controller = try ResearchController(directory: directory, transport: ResearchFixtureTransport(delay: .seconds(60)), radarURL: directory.appendingPathComponent("absent"))
        bridge.research = controller
        _ = try controller.prepare(planID: plan.id)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration), background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background; window.contentView = background; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp(); Task { try? await controller.stop() } }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await wait(view, "document.querySelector('[data-mode-switch=radar]') !== null")
        try await click(view, "Perpetual Swap Radar")
        try await wait(view, "document.querySelector('[data-research-task]')?.innerText.includes('Preparing data')")
        try await click(view, "Studies & cache")
        try await wait(view, "document.querySelector('table[aria-label=\"Saved studies\"]')?.innerText.includes('Current task')")
        let collapsed = try await js(view, "(() => { const details = document.querySelector('[data-study-error]'); return !details.open && details.getBoundingClientRect().height <= details.querySelector('summary').getBoundingClientRect().height + 2; })()") as? Bool
        XCTAssertEqual(collapsed, true, "Saved errors must start collapsed so they cannot cover neighboring actions.")
        _ = try await js(view, "document.querySelector('[data-study-error] summary').click(); true")
        try await wait(view, "document.querySelector('[data-study-error]').open")
        for width in [1440.0, 960.0] {
            window.setContentSize(NSSize(width: width, height: 900))
            try await Task.sleep(for: .milliseconds(100))
            let fits = try await js(view, """
            (() => {
              const details = document.querySelector('[data-study-error]'), row = details.closest('tr'), cell = details.closest('td');
              const error = details.querySelector('p:last-child'), bounds = cell.getBoundingClientRect(), text = error.getBoundingClientRect();
              const actions = row.cells[3].getBoundingClientRect(), buttons = Array.from(row.cells[3].querySelectorAll('button'));
              return getComputedStyle(cell).whiteSpace === 'normal' && getComputedStyle(error).whiteSpace === 'pre-wrap'
                && error.scrollWidth <= error.clientWidth + 1 && text.left >= bounds.left && text.right <= bounds.right + 1
                && text.right <= actions.left && buttons.every(button => { const b=button.getBoundingClientRect(); return b.left >= actions.left && b.right <= actions.right + 1; });
            })()
            """) as? Bool
            XCTAssertEqual(fits, true, "Expanded long errors and every action must stay inside their columns at \(width)px.")
        }
        let errorText = try await js(view, "document.querySelector('[data-study-error] p:last-child').textContent") as? String
        XCTAssertEqual(errorText, savedError, "The complete saved error must remain readable.")
        let currentIsClear = try await js(view, "!document.querySelector('[data-research-task] [role=alert]') && !document.querySelector('[data-research-task]').innerText.includes('43200 invalid archive records')") as? Bool
        XCTAssertEqual(currentIsClear, true, "A historical failure must not become the current task's error.")
        let image = try await view.takeSnapshot(configuration: nil)
        let snapshot = project.appendingPathComponent(".build/ui-qa/research-saved-errors.png")
        try FileManager.default.createDirectory(at: snapshot.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: snapshot)
        XCTAssertEqual(try store.get("checkpoint:\(failed.id)", as: Checkpoint.self)?.error, savedError)
        try await controller.stop()
    }

    @MainActor
    func testNotificationSettingsPermissionRecoveryAndContractRoutingInNativeWebKit() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist")), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        let background = WindowBackgroundView(contentView: view); bridge.windowBackground = background
        window.contentView = background
        present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 375")
        try await click(view, "Settings")
        try await wait(view, "document.body.innerText.includes('macOS notifications are allowed.')")
        try await click(view, "Test notification")
        try await wait(view, "document.querySelector('#strategy-notifications')?.disabled === false")
        XCTAssertEqual(bridge.notificationTestCount, 1)
        try await click(view, "Enable background monitoring")
        try await wait(view, "document.querySelector('#background-monitoring')?.textContent === 'Paused' && document.querySelector('#background-monitoring')?.disabled === false")
        XCTAssertTrue(bridge.radar.monitoringPaused)
        try await click(view, "Enable background monitoring")
        try await wait(view, "document.querySelector('#background-monitoring')?.textContent === 'Running' && document.querySelector('#background-monitoring')?.disabled === false")
        XCTAssertFalse(bridge.radar.monitoringPaused)
        try await click(view, "Start monitoring at login")
        try await wait(view, "document.querySelector('#launch-at-login')?.dataset.state === 'on' && document.querySelector('#launch-at-login')?.disabled === false")
        XCTAssertEqual(bridge.launchAtLogin, "enabled")
        bridge.launchAtLogin = "requiresApproval"
        try await click(view, "Settings"); try await click(view, "Settings")
        try await wait(view, "document.body.innerText.includes('Open Login Items')")
        try await click(view, "Open Login Items")
        try await wait(view, "document.querySelector('#launch-at-login')?.disabled === false")
        XCTAssertEqual(bridge.loginSettingsOpenCount, 1)
        try await click(view, "Start monitoring at login")
        try await wait(view, "document.querySelector('#launch-at-login')?.dataset.state === 'off' && document.querySelector('#launch-at-login')?.disabled === false")
        try await click(view, "Enable strategy notifications")
        try await wait(view, "document.querySelector('#strategy-notifications')?.dataset.state === 'off'")
        XCTAssertFalse(bridge.radar.notificationsEnabled)
        let testDisabled = try await js(view, "Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Test notification').disabled") as? Bool
        XCTAssertEqual(testDisabled, true)
        bridge.notificationAuthorization = "denied"
        try await click(view, "Enable strategy notifications")
        try await wait(view, "document.body.innerText.includes('Notifications are blocked.') && document.querySelector('#strategy-notifications')?.dataset.state === 'on'")
        XCTAssertTrue(bridge.radar.notificationsEnabled)
        XCTAssertEqual(bridge.notificationPermissionRequests, 0)
        try await click(view, "Notification Settings")
        try await wait(view, "document.querySelector('#strategy-notifications')?.disabled === false")
        XCTAssertEqual(bridge.notificationSettingsOpenCount, 1)
        bridge.notificationAuthorization = "notDetermined"
        try await click(view, "Settings"); try await click(view, "Settings")
        try await wait(view, "Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Allow notifications')")
        try await click(view, "Allow notifications")
        try await wait(view, "document.body.innerText.includes('macOS notifications are allowed.')")
        XCTAssertEqual(bridge.notificationPermissionRequests, 1)
        bridge.notificationError = "Cannot send notification: fixture failure"
        try await click(view, "Settings"); try await click(view, "Settings")
        try await wait(view, "document.querySelector('[role=alert]')?.textContent.includes('fixture failure')")
        try await click(view, "Settings")
        _ = try await js(view, "window.radarNotificationContract = 'MKT499-USDT-SWAP'; window.dispatchEvent(new Event('radar-open-contract')); true")
        try await wait(view, "document.querySelector('h1[title=\"MKT499-USDT-SWAP\"]') !== null")
        let consumed = try await js(view, "window.radarNotificationContract === undefined") as? Bool
        XCTAssertEqual(consumed, true)
    }

    @MainActor
    func testBlurSlidersPreviewWhileSavingAndRestoreAfterReload() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 48), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.radarAppearance = { frostedBackgroundEnabled: true, frostedBackgroundOpacity: 0.3, nativeWindowBackground: true };", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration), background = WindowBackgroundView(contentView: view)
        view.setValue(false, forKey: "drawsBackground"); view.underPageBackgroundColor = .clear
        bridge.windowBackground = background; window.contentView = background; present(window)
        defer { bridge.heldBlurSave?(); bridge.heldBlurSave = nil; view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 48)
        try await click(view, "Settings")
        try await wait(view, "document.querySelector('#window-blur [role=slider]')?.getAttribute('aria-valuenow') === '64' && document.querySelector('#floating-blur [role=slider]')?.getAttribute('aria-valuenow') === '64'")
        func slide(_ id: String, _ key: String) async throws {
            _ = try await js(view, "(() => { const thumb = document.querySelector('#\(id) [role=slider]'); thumb.focus(); thumb.dispatchEvent(new KeyboardEvent('keydown', {key:'\(key)',bubbles:true,cancelable:true})); return true; })()")
        }
        bridge.holdNextBlurSave = true
        try await slide("window-blur", "End")
        try await wait(view, "document.querySelector('#window-blur [role=slider]').getAttribute('aria-valuenow') === '160' && document.body.innerText.includes('Saving')")
        XCTAssertEqual(bridge.previewWindowBlur, 160)
        XCTAssertEqual(bridge.radar.windowBlurRadius, 64, "Preview must not wait for or prematurely persist a pending save.")
        try await slide("window-blur", "Home")
        try await wait(view, "document.querySelector('#window-blur [role=slider]').getAttribute('aria-valuenow') === '0'")
        XCTAssertEqual(bridge.previewWindowBlur, 0)
        try XCTUnwrap(bridge.heldBlurSave)(); bridge.heldBlurSave = nil
        try await wait(view, "!document.body.innerText.includes('Saving')")
        XCTAssertEqual(bridge.radar.windowBlurRadius, 0, "The latest edit must win over an older pending save.")
        XCTAssertNil(bridge.previewWindowBlur)
        var clearMaterial: NSBitmapImageRep?
        var materialRect = CGRect.zero
        try await slide("floating-blur", "Home")
        try await wait(view, "getComputedStyle(document.querySelector('[data-slot=popover-content]')).backdropFilter === 'none' && !document.body.innerText.includes('Saving')")
        if capturePixels {
            let bounds = try await js(view, "(() => { const style=document.createElement('style'); style.id='slider-pixel-style'; style.textContent='[data-slot=popover-content] > * {visibility:hidden!important}'; document.head.append(style); const fixture=document.createElement('div'); fixture.id='slider-pixel-fixture'; fixture.style.cssText='position:fixed;inset:0;z-index:49;pointer-events:none;background:conic-gradient(#111 25%,#fff 0 50%,#111 0 75%,#fff 0) 0 0 / 24px 24px'; document.body.append(fixture); return document.querySelector('[data-slot=popover-content]').getBoundingClientRect().toJSON(); })()") as! [String: Double]
            materialRect = CGRect(x: bounds["x"]! + 20, y: bounds["y"]! + 20, width: bounds["width"]! - 40, height: bounds["height"]! - 40)
            try await settleRendering(view)
            let image = try await nativeRendererSnapshot(view)
            clearMaterial = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        }
        try await slide("floating-blur", "End")
        try await wait(view, "getComputedStyle(document.querySelector('[data-slot=popover-content]')).backdropFilter === 'blur(160px)' && !document.body.innerText.includes('Saving')")
        XCTAssertEqual(bridge.radar.floatingBlurRadius, 160)
        if capturePixels {
            try await settleRendering(view)
            let material = try await nativeRendererSnapshot(view)
            let blurred = try XCTUnwrap(NSBitmapImageRep(data: material.tiffRepresentation!)), clear = try XCTUnwrap(clearMaterial)
            let sharp = try pixelDetail(clear, rect: materialRect, view: view)
            let softened = try pixelDetail(blurred, rect: materialRect, view: view)
            print("Backdrop detail, Popover blur 0 → 160: \(sharp) → \(softened)")
            XCTAssertGreaterThan(sharp, 0.005, "The baseline must retain a visible backdrop response behind the dense material.")
            XCTAssertLessThan(softened, sharp * 0.2, "Changing the slider must strongly diffuse the backdrop.")
            let outside = CGRect(x: 24, y: 200, width: 200, height: 500)
            XCTAssertEqual(try pixelDetail(blurred, rect: outside, view: view), try pixelDetail(clear, rect: outside, view: view), accuracy: 0.002, "Popover blur must leave content outside its bounds sharp.")
            _ = try await js(view, "document.querySelector('#slider-pixel-style').remove(); document.querySelector('#slider-pixel-fixture').remove(); true")
            try await settleRendering(view)
            let image = try await nativeRendererSnapshot(view)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            let path = project.appendingPathComponent(".build/ui-qa/blur-settings.png")
            try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: path)
        }
        bridge.blurSaveError = "Cannot save blur fixture"
        try await slide("floating-blur", "Home")
        try await wait(view, "document.body.innerText.includes('Cannot save blur fixture') && getComputedStyle(document.querySelector('[data-slot=popover-content]')).backdropFilter === 'none'")
        XCTAssertEqual(bridge.radar.floatingBlurRadius, 160)
        bridge.blurSaveError = nil
        try await click(view, "Retry saving")
        try await wait(view, "!document.body.innerText.includes('Cannot save blur fixture') && !document.body.innerText.includes('Saving')")
        XCTAssertEqual(bridge.radar.floatingBlurRadius, 0)
        let documentTimeOrigin = try await js(view, "performance.timeOrigin")
        let previousDocument = try XCTUnwrap(documentTimeOrigin as? Double)
        view.reload()
        // Wait for the new document before querying controls: the old page
        // remains interactive briefly while WebKit starts a reload.
        try await wait(view, "performance.timeOrigin !== \(previousDocument)")
        try await showAllMarkets(view, count: 48)
        try await click(view, "Settings")
        try await wait(view, "document.querySelector('#window-blur [role=slider]')?.getAttribute('aria-valuenow') === '0' && document.querySelector('#floating-blur [role=slider]')?.getAttribute('aria-valuenow') === '0'")
        try await assertSharedSurfaces(view, opacity: 0.3)
    }

    @MainActor
    func testGlassTintAndAppearanceChangesKeepTheBackgroundAndContentSeparate() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 48), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.radarAppearance = { frostedBackgroundEnabled: true, frostedBackgroundOpacity: 0.3, nativeWindowBackground: true };", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.underPageBackgroundColor = .clear
        let background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background
        window.contentView = background
        window.appearance = NSAppearance(named: .darkAqua)
        present(window)
        background.apply(enabled: true, opacity: 0.3, to: window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 48)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 36 && document.documentElement.dataset.nativeWindowBackground === 'true'")
        try await assertLiveValuesDoNotResizeLayout(view)
        let pixels = """
        (() => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          const read = color => { context.clearRect(0,0,1,1); context.fillStyle = color; context.fillRect(0,0,1,1); return Array.from(context.getImageData(0,0,1,1).data); };
          const style = getComputedStyle(document.body);
          return { tint: read(getComputedStyle(document.documentElement).getPropertyValue('--window-background-tint')), bodyFill: read(style.backgroundColor), text: read(style.color), contentOpacity: style.opacity, snapshotBackground: read(getComputedStyle(document.documentElement).getPropertyValue('--chart-snapshot-background')) };
        })()
        """
        let glassResult = try await js(view, pixels)
        let glass = try XCTUnwrap(glassResult as? [String: Any])
        let tint = try XCTUnwrap(glass["tint"] as? [Int])
        XCTAssertEqual(tint, [40, 44, 52, 255])
        XCTAssertEqual(glass["bodyFill"] as? [Int], [0, 0, 0, 0], "WebKit must not tint the native surface a second time.")
        XCTAssertEqual(bridge.windowTintRGB, [40 / 255.0, 44 / 255.0, 52 / 255.0])
        let nativeTintView = background.subviews[1]
        XCTAssertEqual(nativeTintView.frame, background.bounds)
        XCTAssertEqual(view.frame, background.convert(window.contentLayoutRect, from: nil))
        let nativeFill = try XCTUnwrap(NSColor(cgColor: try XCTUnwrap(nativeTintView.layer?.backgroundColor))?.usingColorSpace(.sRGB))
        XCTAssertEqual(nativeFill.alphaComponent, 0.3, accuracy: 1e-6)
        XCTAssertEqual(glass["text"] as? [Int], [255, 255, 255, 255])
        XCTAssertEqual(glass["contentOpacity"] as? String, "1")
        XCTAssertEqual(glass["snapshotBackground"] as? [Int], [40, 44, 52, 255], "Copied charts must have a matching opaque tint behind white text.")
        try await click(view, "Settings")
        try await wait(view, "document.querySelector('#background-opacity') !== null")
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            window.appearance = NSAppearance(named: appearance)
            try await wait(view, "window.matchMedia('(prefers-color-scheme: dark)').matches === \(appearance == .darkAqua)")
            for opacity in [0.0, 0.3, 0.65, 1.0] {
                try await input(view, "#background-opacity", String(opacity))
                _ = try await js(view, "document.querySelector('#background-opacity').dispatchEvent(new FocusEvent('focusout', {bubbles:true})); true")
                try await wait(view, "Number(document.documentElement.style.getPropertyValue('--window-background-opacity')) === \(opacity)")
                try await assertSharedSurfaces(view, opacity: opacity)
                XCTAssertEqual(try XCTUnwrap(nativeTintView.layer?.backgroundColor).alpha, opacity, accuracy: 1e-6, "The window tint keeps its own opacity while components weight their own defaults.")
            }
            // Separate material and primary defaults must remain independent
            // under the same weight, even when overridden from the theme.
            _ = try await js(view, "for (const [role, alpha] of Object.entries({control:0.5,panel:0.35,floating:0.9,primary:0.25})) document.documentElement.style.setProperty(`--${role}-default-opacity`, String(alpha)); true")
            try await assertSharedSurfaces(view, opacity: 1, defaultOpacities: [0.5, 0.35, 0.9, 0.25])
            try await input(view, "#background-opacity", "0.5")
            _ = try await js(view, "document.querySelector('#background-opacity').dispatchEvent(new FocusEvent('focusout', {bubbles:true})); true")
            try await wait(view, "document.documentElement.style.getPropertyValue('--window-background-opacity') === '0.5'")
            try await assertSharedSurfaces(view, opacity: 0.5, defaultOpacities: [0.5, 0.35, 0.9, 0.25])
            _ = try await js(view, "for (const role of ['control','panel','floating','primary']) document.documentElement.style.removeProperty(`--${role}-default-opacity`); true")
            try await assertSharedSurfaces(view, opacity: 0.5)
            _ = try await js(view, "document.querySelector('#frosted-background').click(); true")
            try await wait(view, "document.documentElement.dataset.frostedBackground === 'false'")
            try await assertSharedSurfaces(view, opacity: 1)
            XCTAssertEqual(nativeTintView.layer?.backgroundColor?.alpha, 1, "Disabling glass retains a fully opaque shared window background.")
            let disabledInput = try await js(view, "document.querySelector('#background-opacity').disabled") as? Bool
            XCTAssertEqual(disabledInput, true)
            _ = try await js(view, "document.querySelector('#frosted-background').click(); true")
            try await wait(view, "document.documentElement.dataset.frostedBackground === 'true'")
        }
        try await input(view, "#background-opacity", "1")
        _ = try await js(view, "document.querySelector('#background-opacity').dispatchEvent(new FocusEvent('focusout', {bubbles:true})); true")
        try await wait(view, "document.documentElement.dataset.translucentBackground === 'false' && document.documentElement.style.getPropertyValue('--window-background-opacity') === '1'")
        let solidResult = try await js(view, pixels)
        let solid = try XCTUnwrap(solidResult as? [String: Any])
        XCTAssertEqual((solid["tint"] as? [Int])?.last, 255)
        XCTAssertEqual(solid["bodyFill"] as? [Int], [0, 0, 0, 0])
        XCTAssertEqual(nativeTintView.layer?.backgroundColor?.alpha, 1)
        try await waitForTint(bridge, rgb: try XCTUnwrap(solid["tint"] as? [Int]).prefix(3).map { Double($0) / 255 })
        XCTAssertLessThan((solid["tint"] as? [Int])?.first ?? 255, 40, "Full opacity restores the solid Dark palette.")
        try await input(view, "#background-opacity", "0.3")
        _ = try await js(view, "document.querySelector('#background-opacity').dispatchEvent(new FocusEvent('focusout', {bubbles:true})); true")
        try await wait(view, "document.documentElement.dataset.translucentBackground === 'true'")
        _ = try await js(view, "document.querySelector('#frosted-background').click(); true")
        try await wait(view, "document.documentElement.dataset.frostedBackground === 'false'")
        let disabled = try await js(view, pixels) as? [String: Any]
        XCTAssertEqual(disabled?["tint"] as? [Int], solid["tint"] as? [Int])
        _ = try await js(view, "document.querySelector('#frosted-background').click(); true")
        try await wait(view, "document.documentElement.dataset.translucentBackground === 'true'")
        window.appearance = NSAppearance(named: .aqua)
        try await wait(view, "!window.matchMedia('(prefers-color-scheme: dark)').matches")
        let lightResult = try await js(view, pixels)
        let light = try XCTUnwrap(lightResult as? [String: Any])
        XCTAssertEqual(light["bodyFill"] as? [Int], [0, 0, 0, 0])
        XCTAssertGreaterThan((light["tint"] as? [Int])?.first ?? 0, 240, "An explicitly chosen Light appearance keeps its light tint.")
        XCTAssertLessThan((light["text"] as? [Int])?.first ?? 255, 40)
        try await waitForTint(bridge, rgb: try XCTUnwrap(light["tint"] as? [Int]).prefix(3).map { Double($0) / 255 })
        window.appearance = NSAppearance(named: .darkAqua)
        try await wait(view, "window.matchMedia('(prefers-color-scheme: dark)').matches")
        let restored = try await js(view, pixels) as? [String: Any]
        XCTAssertEqual(restored?["tint"] as? [Int], tint)
        try await waitForTint(bridge, rgb: [40 / 255.0, 44 / 255.0, 52 / 255.0])
        // Reloads must restore the native capability and re-send the design token.
        view.reload()
        try await wait(view, "document.documentElement.dataset.nativeWindowBackground === 'true' && Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 36")
        let reloaded = try await js(view, pixels) as? [String: Any]
        XCTAssertEqual(reloaded?["bodyFill"] as? [Int], [0, 0, 0, 0])
        try await waitForTint(bridge, rgb: [40 / 255.0, 44 / 255.0, 52 / 255.0])
    }

    @MainActor
    private func assertSharedSurfaces(_ view: WKWebView, opacity: Double, defaultOpacities: [Double] = [0.8, 0.6, 0.92, 0.4]) async throws {
        // Wait for control color transitions; inspect the renderer rather than
        // matching generated classes or the source token formulas.
        try await wait(view, "Array.from(document.querySelectorAll('[data-surface=\"floating\"]')).every(x => x.closest('[data-state=\"closed\"]') || !x.getBoundingClientRect().width || !x.getBoundingClientRect().height || getComputedStyle(x).opacity === '1')", seconds: 2)
        let script = """
        (() => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d'), root = getComputedStyle(document.documentElement);
          const read = color => { context.clearRect(0,0,1,1); context.fillStyle = color; context.fillRect(0,0,1,1); return Array.from(context.getImageData(0,0,1,1).data); };
          const p = Number(root.getPropertyValue('--window-background-opacity')), issues = [];
          for (const element of document.querySelectorAll('[data-surface]')) {
            if (!(element instanceof HTMLElement) || element.closest('[data-state="closed"]') || !element.getBoundingClientRect().width || !element.getBoundingClientRect().height) continue;
            const style = getComputedStyle(element), role = element.dataset.surface;
            const filter = style.backdropFilter || style.webkitBackdropFilter || 'none';
            const radius = Number(filter.match(/blur\\(([\\d.]+)px\\)/)?.[1] ?? 0);
            const parent = element.parentElement?.closest('[data-surface="control"], [data-surface="panel"], [data-surface="floating"]');
            const nativeTable = document.documentElement.dataset.nativeWindowBackground === 'true' && element.closest('[data-slot="table-container"]');
            const inherited = role === 'inherited' || role !== 'floating' && (parent || nativeTable && role === 'control');
            const expected = role === 'floating' ? parseFloat(root.getPropertyValue('--floating-blur')) : p === 1 || inherited ? 0 : ({control:12,panel:16}[role] ?? 0) * (1-p);
            if (Math.abs(radius - expected) > 0.05 || expected === 0 && filter !== 'none') issues.push(`${element.dataset.slot ?? element.tagName} ${role}: filter=${filter}, expected=${expected}`);
            if (role === 'floating' && style.transitionProperty !== 'none') issues.push(`${element.dataset.slot ?? element.tagName}: implicit material transition`);
            if (role === 'floating' && style.backgroundImage !== 'none') issues.push(`${element.dataset.slot ?? element.tagName}: tinted glass gradient`);
            if (p < 1 && !['inherited','floating'].includes(role) && read(style.backgroundColor)[3] === 255) issues.push(`${element.dataset.slot ?? element.tagName}: opaque component paint`);
            if (style.opacity !== '1' || read(style.color)[3] !== 255) issues.push(`${element.dataset.slot ?? element.tagName}: faded content`);
            if (!style.fontVariantNumeric.includes('tabular-nums')) issues.push(`${element.dataset.slot ?? element.tagName}: non-tabular numbers`);
          }
          const input = document.querySelector('#background-opacity');
          if (input && (getComputedStyle(input).backdropFilter || getComputedStyle(input).webkitBackdropFilter) !== 'none') issues.push('Settings input must reuse its floating owner');
          const defaults = Object.fromEntries(['control','panel','floating','primary','state-hover','state-selection','state-accent','state-secondary','state-warning','table-header','overlay'].map(role => [role, Number(root.getPropertyValue(`--${role}-default-opacity`))]));
          const checkAlpha = (label, color, baseline, weight = p) => {
            const actual = read(color)[3]/255, expected = baseline*weight;
            if (Math.abs(actual-expected) > 1/255) issues.push(`${label}: alpha=${actual}, expected own default ${baseline} * weight ${weight}`);
          };
          for (const [role, tokens] of Object.entries({
            control: ['control','control-hover','selection','secondary','muted','accent','destructive-surface','destructive-hover','positive-surface','chart-annotation'],
            panel: ['card','sidebar'], floating: ['popover'], primary: ['primary-surface','primary-surface-hover'],
            'state-hover': ['state-hover'], 'state-selection': ['state-selection'], 'state-accent': ['state-accent'],
            'state-secondary': ['state-secondary'], 'state-warning': ['state-warning'], 'table-header': ['table-header'], overlay: ['overlay']
          })) {
            for (const token of tokens) checkAlpha(`--${token}`, root.getPropertyValue(`--${token}`), defaults[role], role === 'floating' ? 1 : p);
          }
          for (const element of document.querySelectorAll('[data-slot="input"], [data-slot="textarea"], [data-slot="input-group"], [data-slot="tabs-list"][data-surface="control"], [data-slot="select-trigger"], [data-slot="table-header"], [data-slot="table-footer"], [data-slot="dialog-footer"], [data-slot="dialog-overlay"], [data-surface="floating"], [data-slot="button"][data-variant="default"], [data-slot="badge"][data-variant="default"]')) {
            if (!element.getBoundingClientRect().width || !element.getBoundingClientRect().height) continue;
            const role = element.dataset.surface === 'floating' ? 'floating' : ['button','badge'].includes(element.dataset.slot) ? 'primary' : element.dataset.slot === 'dialog-footer' ? 'state-hover' : element.dataset.slot === 'dialog-overlay' ? 'overlay' : ['table-header','table-footer'].includes(element.dataset.slot) ? 'table-header' : 'control';
            checkAlpha(element.dataset.slot, getComputedStyle(element).backgroundColor, defaults[role], role === 'floating' ? 1 : p);
          }
          // Raising neutral control alpha must not turn primary fills into
          // saturated backgrounds with unreadable foreground text at weight 1.
          if (p === 1) {
            const luminance = rgb => rgb.map(c => { const s=c/255; return s<=0.04045 ? s/12.92 : ((s+0.055)/1.055)**2.4; }).reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0);
            const foreground = luminance(read(root.getPropertyValue('--primary-surface-foreground')).slice(0,3));
            for (const token of ['--primary-surface','--primary-surface-hover']) {
              const fill = read(root.getPropertyValue(token));
              for (const base of ['--background','--popover-base']) {
                const background = read(root.getPropertyValue(base)), alpha=fill[3]/255;
                const painted = luminance(fill.slice(0,3).map((c,i)=>c*alpha+background[i]*(1-alpha)));
                const contrast = (Math.max(foreground,painted)+0.05)/(Math.min(foreground,painted)+0.05);
                if (contrast < 4.5) issues.push(`${token} over ${base}: primary text contrast=${contrast}`);
              }
            }
          }
          return { issues, opacity: p, alphas: ['--control','--card','--popover','--primary-surface','--chart-snapshot-background'].map(name => read(root.getPropertyValue(name))[3]/255), positive: read(root.getPropertyValue('--positive')), destructive: read(root.getPropertyValue('--destructive')) };
        })()
        """
        var result = try await js(view, script) as? [String: Any]
        let deadline = ContinuousClock.now + .seconds(2)
        while ((result?["issues"] as? [String])?.isEmpty != true || result?["opacity"] as? Double != opacity), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
            result = try await js(view, script) as? [String: Any]
        }
        let values = try XCTUnwrap(result)
        XCTAssertEqual(values["issues"] as? [String], [], "Surface rendering contract: \(values)")
        XCTAssertEqual(values["opacity"] as? Double, opacity)
        let alphas = try XCTUnwrap(values["alphas"] as? [Double])
        for (actual, expected) in zip(alphas, [defaultOpacities[0] * opacity, defaultOpacities[1] * opacity, defaultOpacities[2], defaultOpacities[3] * opacity, 1]) {
            XCTAssertEqual(actual, expected, accuracy: 1 / 255.0)
        }
        XCTAssertEqual(values["destructive"] as? [Int], [232, 85, 168, 255])
        let dark = try await js(view, "window.matchMedia('(prefers-color-scheme: dark)').matches") as? Bool
        XCTAssertEqual(values["positive"] as? [Int], dark == true ? [202, 253, 92, 255] : [142, 188, 57, 255])
    }

    @MainActor
    func testAllSurfaceFamiliesAndChartCaptureInNativeWebKit() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        if capturePixels {
            guard #available(macOS 14.4, *) else { throw XCTSkip("Current-process window capture requires macOS 14.4.") }
        }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        // Fill the viewport and exercise virtualization without repeating the
        // 500-market stress workload during every material/pixel assertion.
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 48), configuration = uiConfiguration()
        bridge.includeChartBars = true
        bridge.research = try ResearchController(directory: bridge.directory.appendingPathComponent("Research"), transport: ResearchFixtureTransport(), radarURL: bridge.directory.appendingPathComponent("radar.sqlite3"))
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.radarAppearance = { frostedBackgroundEnabled: true, frostedBackgroundOpacity: 0.3, nativeWindowBackground: true };", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground"); view.underPageBackgroundColor = .clear
        let background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background; window.contentView = background
        // Keep WebKit's compositor/exit animations running when terminal or
        // editor windows become active during local CI.
        present(window)
        background.apply(enabled: true, opacity: 0.3, to: window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 48)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 36 && document.documentElement.dataset.nativeWindowBackground === 'true'")

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let theme = appearance == .darkAqua ? "dark" : "light"
            window.appearance = NSAppearance(named: appearance)
            try await wait(view, "window.matchMedia('(prefers-color-scheme: dark)').matches === \(appearance == .darkAqua)")
            try await assertSharedSurfaces(view, opacity: 0.3)
            try await click(view, "Settings")
            try await wait(view, "document.querySelector('#background-opacity') !== null")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            if capturePixels { try await assertFloatingPixels(view, project: project, theme: theme, selector: "[data-slot=\"popover-content\"]", name: "settings") }
            try await click(view, "Configure analysis")
            try await wait(view, "document.querySelector('[aria-label=\"AI analysis settings\"]') !== null && !document.querySelector('#analysis-model').disabled")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if capturePixels { try await assertFloatingPixels(view, project: project, theme: theme, selector: "[aria-label=\"AI analysis settings\"]", name: "analysis-settings") }
            try await click(view, "Cancel")
            try await dismissFloating(view)

            try await click(view, "Universe rules")
            try await wait(view, "document.querySelector('[data-rule-layout]') !== null")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            _ = try await js(view, "document.querySelector('[aria-label=\"Add condition\"]').click(); true")
            try await wait(view, "document.querySelector('[data-rule-library]') !== null")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            if capturePixels { try await assertFloatingPixels(view, project: project, theme: theme, selector: "[data-rule-library]", name: "library") }
            try await input(view, "[data-rule-library] [cmdk-input]", "Candle close")
            _ = try await js(view, "document.querySelector('[data-library-id=\"metric:Close\"]').click(); true")
            try await wait(view, "document.querySelector('[data-rule-library][data-state=\"open\"]') === null")
            try await validDraft(view)
            try await assertSharedSurfaces(view, opacity: 0.3)
            _ = try await openMenu(view, selector: "[aria-label=\"Choose Left expression\"]", popover: true)
            try await assertSharedSurfaces(view, opacity: 0.3)
            try await dismissFloating(view)

            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            try await click(view, "Explain markets")
            try await wait(view, "document.querySelector('[role=dialog]') !== null")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            try await click(view, "Done")
            try await wait(view, "document.querySelector('[role=dialog]') === null")
            try await click(view, "Universe rules")

            _ = try await js(view, "Array.from(document.querySelectorAll('button')).find(x => x.getAttribute('aria-label')?.startsWith('View ') && x.getAttribute('aria-label').includes('opportunity details')).click(); true")
            try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]')?.innerText.includes('Opportunity')")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            try await dismissFloating(view)
            _ = try await js(view, "document.querySelector('tbody tr[tabindex]').click(); true")
            try await wait(view, "document.querySelector('section[aria-label$=\" chart\"] svg[role=img]') !== null")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if appearance == .aqua { try await assertScaledSurfaces(view, window: window) }
            bridge.chartSnapshotRGB = []
            try await click(view, "Copy chart")
            let deadline = Date().addingTimeInterval(2)
            while bridge.chartSnapshotRGB.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
            XCTAssertEqual(bridge.chartSnapshotRGB, appearance == .darkAqua ? [40 / 255.0, 44 / 255.0, 52 / 255.0] : [1, 1, 1])
            let image = try await view.takeSnapshot(configuration: nil)
            let opaque = try XCTUnwrap(opaqueChartSnapshot(image, backgroundRGB: bridge.chartSnapshotRGB))
            XCTAssertEqual(NSBitmapImageRep(data: opaque.tiffRepresentation!)?.colorAt(x: 0, y: 0)?.alphaComponent, 1)
            if try await js(view, "document.querySelector('[aria-label=\"Chart analysis\"]') !== null") as? Bool == true {
                try await click(view, "New analysis")
            } else { try await click(view, "Analyze Long") }
            try await wait(view, "document.querySelector('[data-analysis-answer] table') !== null && !document.querySelector('[aria-label=\"Ask a follow-up\"]').disabled")
            try await assertSharedSurfaces(view, opacity: 0.3)
            let analysisPreview = try await view.takeSnapshot(configuration: nil)
            if let png = chartSnapshotPNG(try XCTUnwrap(opaqueChartSnapshot(analysisPreview, backgroundRGB: bridge.chartSnapshotRGB))),
               let url = png["imageDataURL"] as? String, let bytes = Data(base64Encoded: String(url.dropFirst("data:image/png;base64,".count))) {
                try bytes.write(to: project.appendingPathComponent(".build/analysis-\(theme).png"))
            }
            try await click(view, "Markets")
            try await wait(view, "document.querySelector('table[data-market-count]') !== null")
            try await click(view, "Universe rules"); try await click(view, "Universe rules")
            bridge.researchJobOverride = ["id": "glass-task", "phase": "preparing", "completed": 3, "total": 10, "message": "Preparing glass fixture", "error": "", "startedAt": researchNow() - 60_000, "updatedAt": researchNow()]
            try await click(view, "Perpetual Swap Radar")
            try await wait(view, "document.querySelector('[data-research-task] [data-surface=floating]') !== null")
            try await assertSharedSurfaces(view, opacity: 0.3)
            if capturePixels { try await assertFloatingPixels(view, project: project, theme: theme, selector: "[data-research-task] [data-surface=floating]", name: "research-task") }
            try await click(view, "Perpetual Swap Research")
            bridge.researchJobOverride = nil
            try await wait(view, "document.querySelector('table[data-market-count]')?.getBoundingClientRect().width > 0")
        }
    }

    @MainActor
    func testChartKeepsLivePollingDuringSlowHydrationAndRejectsItsLateOldReply() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run ci:local for native WebKit checks.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 3), configuration = uiConfiguration()
        bridge.includeChartBars = true; bridge.holdChartLoadID = "MKT000-USDT-SWAP"
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        window.contentView = view; present(window)
        defer {
            bridge.heldChartLoadReply?(); bridge.heldChartLoadReply = nil
            view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp()
        }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 3)
        _ = try await js(view, "document.querySelector('[aria-label=\"View MKT000-USDT-SWAP chart\"]').click(); true")
        try await wait(view, "document.querySelector('[data-chart-inst] svg[role=img]') !== null")
        let deadline = ContinuousClock.now + .seconds(3)
        while bridge.heldChartLoadReply == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNotNil(bridge.heldChartLoadReply, "The network hydration request must remain pending during this check.")
        bridge.chartLiveClose = 150; bridge.revision += 1
        try await wait(view, "document.querySelector('[data-chart-inst] > div')?.innerText.includes('Close 150')")
        bridge.heldChartLoadReply?(); bridge.heldChartLoadReply = nil
        try await Task.sleep(for: .milliseconds(100))
        let latest = try await js(view, "document.querySelector('[data-chart-inst] > div')?.innerText.includes('Close 150')") as? Bool
        XCTAssertEqual(latest, true, "A late hydration response must not regress the live candle.")
    }

    @MainActor
    func testChartNavigationKeepsArrowKeysInAnalysisInputsAndDialogs() async throws {
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 12), configuration = uiConfiguration()
        bridge.includeChartBars = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 12)
        _ = try await js(view, "document.querySelector('tbody tr[tabindex]').click(); true")
        try await wait(view, "document.querySelector('[data-chart-inst] svg[role=img]') !== null")
        let contractValue = try await js(view, "document.querySelector('[data-chart-inst]').dataset.chartInst") as? String
        let contract = try XCTUnwrap(contractValue)
        try await click(view, "Analyze Long")
        try await wait(view, "document.querySelector('[data-analysis-answer]') !== null && !document.querySelector('[aria-label=\"Ask a follow-up\"]').disabled")
        try await input(view, "[aria-label=\"Ask a follow-up\"]", "Edit this question", textarea: true)
        for key in ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"] {
            let allowed = try await js(view, "(() => { const input = document.querySelector('[aria-label=\"Ask a follow-up\"]'); input.focus(); const event = new KeyboardEvent('keydown', {key:\(formulaQuote(key)),bubbles:true,cancelable:true}); input.dispatchEvent(event); return !event.defaultPrevented })()") as? Bool
            XCTAssertEqual(allowed, true, "\(key) must remain available for editing a follow-up.")
            guard allowed == true else { return }
        }
        try await Task.sleep(for: .milliseconds(50))
        let afterEditing = try await js(view, "document.querySelector('[data-chart-inst]').dataset.chartInst") as? String
        XCTAssertEqual(afterEditing, contract)
        try await click(view, "Configure analysis")
        try await wait(view, "!document.querySelector('#analysis-model')?.disabled")
        for selector in ["#analysis-model", "#gateway-api-key", "[aria-label=\"AI analysis settings\"]"] {
            let allowed = try await js(view, "(() => { const input = document.querySelector(\(formulaQuote(selector))); const event = new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true}); input.dispatchEvent(event); return !event.defaultPrevented })()") as? Bool
            XCTAssertEqual(allowed, true, "A settings dialog must keep its keyboard input.")
            guard allowed == true else { return }
        }
        try await click(view, "Cancel")
        let composing = try await js(view, "(() => { document.activeElement.blur(); const event = new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true,isComposing:true}); window.dispatchEvent(event); return !event.defaultPrevented })()") as? Bool
        XCTAssertEqual(composing, true, "IME candidate navigation must not switch contracts.")
        _ = try await js(view, "document.activeElement.blur(); window.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true})); true")
        try await wait(view, "document.querySelector('[data-chart-inst]').dataset.chartInst !== \(formulaQuote(contract))")
    }

    @MainActor
    func testChartAnalysisConfigurationSnapshotFollowUpsCancellationAndRestoration() async throws {
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 12), configuration = uiConfiguration()
        bridge.includeChartBars = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.radarAppearance = {frostedBackgroundEnabled:true,frostedBackgroundOpacity:0.3,nativeWindowBackground:true};", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        let view = WKWebView(frame: .zero, configuration: configuration), background = WindowBackgroundView(contentView: view)
        bridge.windowBackground = background; window.contentView = background; present(window)
        background.apply(enabled: true, opacity: 0.3, to: window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 12)
        try await click(view, "Settings"); try await click(view, "Configure analysis")
        try await wait(view, "document.querySelector('#analysis-model')?.value === 'openai/gpt-6.1-sol' && !document.querySelector('#analysis-model').disabled")
        let passwordDraft = try await js(view, "document.querySelector('#gateway-api-key').value") as? String
        XCTAssertEqual(passwordDraft, "")
        try await click(view, "Remove key")
        try await wait(view, "document.querySelector('[aria-label=\"AI analysis settings\"]')?.innerText.includes('Not configured.')")
        try await click(view, "Cancel"); try await dismissFloating(view)
        _ = try await js(view, "document.querySelector('tbody tr[tabindex]').click(); true")
        try await wait(view, "document.querySelector('[data-chart-inst] svg[role=img]') !== null")
        let contractResult = try await js(view, "document.querySelector('[data-chart-inst]').dataset.chartInst") as? String
        let contract = try XCTUnwrap(contractResult)
        _ = try await js(view, "Array.from(document.querySelectorAll('[aria-label=\"Chart analysis actions\"] button')).find(x=>x.textContent.trim()==='Analyze Short').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})); true")
        try await settleRendering(view)
        let unchangedContract = try await js(view, "document.querySelector('[data-chart-inst]').dataset.chartInst") as? String
        XCTAssertEqual(unchangedContract, contract, "Direction controls must not trigger chart navigation.")
        try await click(view, "Analyze Short")
        try await wait(view, "document.querySelector('[aria-label=\"Chart analysis\"]')?.innerText.includes('Configure a Gateway API Key')")
        XCTAssertTrue(bridge.gatewayRequests.isEmpty)
        try await click(view, "Configure analysis")
        try await wait(view, "!document.querySelector('#gateway-api-key')?.disabled")
        try await input(view, "#gateway-api-key", "fixture-replacement")
        try await click(view, "Save")
        try await wait(view, "document.querySelector('[role=dialog][data-state=open]') === null")
        try await click(view, "Analyze chart")
        try await wait(view, "document.querySelector('[data-analysis-answer]')?.innerText.includes('等待确认，不追多。') && !document.querySelector('[aria-label=\"Ask a follow-up\"]')?.disabled")
        XCTAssertEqual(bridge.analysisKey, "fixture-replacement")
        XCTAssertEqual(bridge.gatewayRequests.count, 1)
        XCTAssertEqual(bridge.analysisCaptureBounds.count, 1)
        let first = try XCTUnwrap(bridge.gatewayRequests.first), messages = try XCTUnwrap(first["messages"] as? [[String: Any]])
        XCTAssertEqual(first["model"] as? String, "openai/gpt-6.1-sol")
        XCTAssertTrue((messages[0]["content"] as? String)?.contains("未收盘") == true)
        XCTAssertTrue((messages[0]["content"] as? String)?.contains("是否追空") == true)
        XCTAssertFalse((messages[0]["content"] as? String)?.contains("追多") == true)
        let contents = try XCTUnwrap(messages[1]["content"] as? [[String: Any]])
        XCTAssertEqual(contents[0]["text"] as? String, "你推荐我追空吗？如果追空，限价单开在哪个位置合适？如果不追，应该等待什么确认？")
        let imageURL = try XCTUnwrap((contents[1]["image_url"] as? [String: Any])?["url"] as? String)
        XCTAssertTrue(imageURL.hasPrefix("data:image/png;base64,"))
        let bounds = bridge.analysisCaptureBounds[0]
        let panelResult = try await js(view, "document.querySelector('[aria-label=\"Chart analysis\"]').getBoundingClientRect().x") as? Double
        let panelX = try XCTUnwrap(panelResult)
        XCTAssertLessThanOrEqual((bounds["x"] as! Double) + (bounds["width"] as! Double), panelX + 1)
        try await click(view, "Copy analysis")
        try await wait(view, "document.querySelector('[aria-label=\"Copy analysis\"]')?.innerText.includes('Copied')")
        XCTAssertTrue(NSPasteboard.general.string(forType: .string)?.contains("等待确认") == true)

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            window.appearance = NSAppearance(named: appearance)
            try await wait(view, "matchMedia('(prefers-color-scheme: dark)').matches === \(appearance == .darkAqua)")
            try await assertSharedSurfaces(view, opacity: 0.3)
        }
        window.setContentSize(NSSize(width: 800, height: 650))
        try await wait(view, "innerWidth === 800 && Math.abs(document.querySelector('[aria-label=\"Chart analysis\"]').getBoundingClientRect().width - 200) < 1")
        let scaledLayout = try await js(view, "document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('[data-chart-workspace]').offsetWidth === 1600") as? Bool
        XCTAssertEqual(scaledLayout, true)
        window.setContentSize(NSSize(width: 1440, height: 900))
        try await wait(view, "innerWidth === 1440")
        try await input(view, "[aria-label=\"Ask a follow-up\"]", "确认条件是什么？", textarea: true)
        _ = try await js(view, "(() => { const x=document.querySelector('[aria-label=\"Ask a follow-up\"]'); x.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); x.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true})); return true })()")
        XCTAssertEqual(bridge.gatewayRequests.count, 1)
        _ = try await js(view, "(() => { const x=document.querySelector('[aria-label=\"Ask a follow-up\"]'); x.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); const e=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}); x.dispatchEvent(e); return !e.defaultPrevented })()")
        XCTAssertEqual(bridge.gatewayRequests.count, 1)
        _ = try await js(view, "document.querySelector('[aria-label=\"Ask a follow-up\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); true")
        try await wait(view, "document.querySelectorAll('[data-analysis-answer]').length === 2 && !document.querySelector('[aria-label=\"Ask a follow-up\"]').disabled")
        XCTAssertEqual(bridge.gatewayRequests.count, 2)
        XCTAssertEqual(bridge.analysisCaptureBounds.count, 1)
        let follow = bridge.gatewayRequests[1]["messages"] as! [[String: Any]]
        XCTAssertTrue((follow[0]["content"] as? String)?.contains("是否追空") == true)
        XCTAssertEqual(((follow[1]["content"] as! [[String: Any]])[1]["image_url"] as! [String: Any])["url"] as? String, imageURL)
        XCTAssertEqual(follow.last?["content"] as? String, "确认条件是什么？")
        try await input(view, "[aria-label=\"Ask a follow-up\"]", "保留草稿", textarea: true)
        try await click(view, "Markets")
        try await wait(view, "document.querySelector('table[data-market-count]') !== null")
        _ = try await js(view, "Array.from(document.querySelectorAll('tbody tr[tabindex]')).find(x=>x.getAttribute('aria-label') === 'View \(contract) chart').click(); true")
        try await wait(view, "document.querySelector('[aria-label=\"Ask a follow-up\"]')?.value === '保留草稿'")
        let restoredDirection = try await js(view, "document.querySelector('[aria-label=\"Chart analysis\"] [data-slot=badge]')?.innerText") as? String
        XCTAssertEqual(restoredDirection, "Chase short")
        bridge.holdGateway = true
        try await click(view, "Send follow-up")
        try await wait(view, "Array.from(document.querySelectorAll('[data-analysis-answer]')).some(x=>x.innerText.includes('部分分析'))")
        let protectedAnalysis = try await js(view, "(() => { const buttons=Array.from(document.querySelectorAll('[aria-label=\"Chart analysis actions\"] button')); return buttons.find(x=>x.textContent.trim()==='Analyze Long').disabled && !buttons.find(x=>x.textContent.trim()==='Analyze Short').disabled; })()") as? Bool
        XCTAssertEqual(protectedAnalysis, true, "Keep the running analysis accessible without allowing a direction change to replace it.")
        try await click(view, "Close analysis")
        try await wait(view, "document.querySelector('[aria-label=\"Chart analysis\"]') === null")
        XCTAssertFalse(bridge.gatewayCancelled.isEmpty)
        bridge.holdGateway = false
        try await click(view, "Analyze Short")
        XCTAssertEqual(bridge.analysisCaptureBounds.count, 1, "Opening the existing directional analysis must preserve its snapshot and conversation.")
        try await click(view, "Retry")
        try await wait(view, "document.querySelectorAll('[data-analysis-answer]').length === 3 && !document.querySelector('[aria-label=\"Ask a follow-up\"]').disabled")
        XCTAssertEqual(bridge.gatewayRequests.count, 4)
        XCTAssertEqual(bridge.analysisCaptureBounds.count, 1)
        let retried = bridge.gatewayRequests[3]["messages"] as! [[String: Any]]
        XCTAssertTrue((retried[0]["content"] as? String)?.contains("是否追空") == true)
        try await click(view, "Analyze Long")
        try await wait(view, "document.querySelectorAll('[data-analysis-answer]').length === 1 && !document.querySelector('[aria-label=\"Ask a follow-up\"]').disabled")
        XCTAssertEqual(bridge.analysisCaptureBounds.count, 2)
        let replacement = bridge.gatewayRequests[4]["messages"] as! [[String: Any]]
        XCTAssertTrue((replacement[0]["content"] as? String)?.contains("是否追多") == true)
        XCTAssertFalse((replacement[0]["content"] as? String)?.contains("追空") == true)
        XCTAssertEqual((replacement[1]["content"] as! [[String: Any]])[0]["text"] as? String, "你推荐我追多吗？如果追多，限价单开在哪个位置合适？如果不追，应该等待什么确认？")
        try await click(view, "New analysis")
        try await wait(view, "document.querySelectorAll('[data-analysis-answer]').length === 1 && !document.querySelector('[aria-label=\"Ask a follow-up\"]').disabled")
        XCTAssertEqual(bridge.analysisCaptureBounds.count, 3)
        let refreshed = bridge.gatewayRequests[5]["messages"] as! [[String: Any]]
        XCTAssertTrue((refreshed[0]["content"] as? String)?.contains("是否追多") == true, "New analysis must retain the direction chosen by the toolbar action.")
    }

    @MainActor
    private func dismissFloating(_ view: WKWebView) async throws {
        _ = try await js(view, "document.querySelector('[data-slot=\"dialog-content\"][data-state=\"open\"] [data-slot=\"dialog-close\"]')?.click(); true")
        try await wait(view, "document.querySelector('[data-slot=\"dialog-content\"][data-state=\"open\"]') === null")
        _ = try await js(view, "document.querySelector('[data-slot=\"popover-content\"][data-state=\"open\"]')?.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"][data-state=\"open\"]') === null")
        try await settleRendering(view)
    }

    @MainActor
    private func assertScaledSurfaces(_ view: WKWebView, window: BackgroundTestWindow) async throws {
        for width in [1440, 720] {
            window.setContentSize(NSSize(width: width, height: 900))
            present(window)
            try await wait(view, "innerWidth === \(width) && (() => { const content = document.querySelector('[data-market-list-content]'); return !content || Math.abs(content.getBoundingClientRect().width - innerWidth) < 1; })()")
            try await assertSharedSurfaces(view, opacity: 0.3)
            let overflow = try await js(view, "document.documentElement.scrollWidth > innerWidth + 1") as? Bool
            XCTAssertEqual(overflow, false)
            let squeezedLabels = try await js(view, "(() => { const scale=Number(getComputedStyle(document.documentElement).getPropertyValue('--market-list-scale')); return Array.from(document.querySelectorAll('[aria-label=\"Rule decision details\"] summary > span.flex-1')).some(x=>x.getBoundingClientRect().width < 100*scale); })()") as? Bool
            XCTAssertEqual(squeezedLabels, false, "Portaled rule details must retain readable label widths when the window scales.")
        }
        window.setContentSize(NSSize(width: 1440, height: 900))
        try await wait(view, "innerWidth === 1440 && (() => { const content = document.querySelector('[data-market-list-content]'); return !content || Math.abs(content.getBoundingClientRect().width - innerWidth) < 1; })()")
    }

    @MainActor
    private func assertLiveValuesDoNotResizeLayout(_ view: WKWebView) async throws {
        let beforeResult = try await js(view, """
        (() => {
          const content = document.querySelector('[data-market-list-content]');
          const table = document.querySelector('table[data-market-count]');
          return {scale: Number(getComputedStyle(document.documentElement).getPropertyValue('--market-list-scale')), contentWidth: content.getBoundingClientRect().width, tableWidth: table.getBoundingClientRect().width};
        })()
        """)
        let before = try XCTUnwrap(beforeResult as? [String: Double])
        _ = try await js(view, """
        (() => {
          const fixture = document.createElement('span');
          fixture.dataset.liveWidthFixture = 'true';
          fixture.textContent = '9'.repeat(400);
          document.querySelector('tbody td').append(fixture);
          return true;
        })()
        """)
        try await Task.sleep(for: .milliseconds(100))
        let afterResult = try await js(view, """
        (() => {
          const content = document.querySelector('[data-market-list-content]');
          const table = document.querySelector('table[data-market-count]');
          document.querySelector('[data-live-width-fixture]')?.remove();
          return {scale: Number(getComputedStyle(document.documentElement).getPropertyValue('--market-list-scale')), contentWidth: content.getBoundingClientRect().width, tableWidth: table.getBoundingClientRect().width};
        })()
        """)
        let after = try XCTUnwrap(afterResult as? [String: Double])
        XCTAssertEqual(try XCTUnwrap(after["scale"]), try XCTUnwrap(before["scale"]), accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(after["contentWidth"]), try XCTUnwrap(before["contentWidth"]), accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(after["tableWidth"]), try XCTUnwrap(before["tableWidth"]), accuracy: 0.5)
    }

    @MainActor
    private func settleRendering(_ view: WKWebView) async throws {
        // Allow the 150 ms control transitions to finish without enumerating
        // thousands of table-cell animations or awaiting offscreen frame callbacks.
        try await Task.sleep(for: .milliseconds(200))
    }

    @MainActor
    private func assertFloatingPixels(_ view: WKWebView, project: URL, theme: String, selector: String, name: String) async throws {
        let query = String(data: try JSONEncoder().encode(selector), encoding: .utf8)!
        let bounds = try await js(view, """
        (() => {
          // Large checkerboard tiles model app blocks, not just fine text.
          // Hide only the real portaled surface's children to sample its material.
          const fixture = document.createElement('div'); fixture.id = 'floating-pixel-fixture';
          // Translucent tiles expose backdrop response in the real translucent
          // window without relying on incidental table text.
          fixture.style.cssText = 'position:absolute;inset:0;z-index:39;pointer-events:none;background:conic-gradient(rgb(0 0 0 / .2) 25%,#fff 0 50%,rgb(0 0 0 / .2) 0 75%,#fff 0) 0 0 / 128px 128px';
          const source = document.querySelector(\(query));
          source.dataset.qaFloatingTest = 'true';
          const hideContent = document.createElement('style'); hideContent.id = 'floating-pixel-style';
          hideContent.textContent = '[data-qa-floating-test] > * { visibility:hidden!important }';
          Array.from(document.querySelectorAll('[data-market-list-content]')).find(element => element.getBoundingClientRect().width > 0).append(fixture);
          document.body.append(hideContent);
          window.radarSurfaceFixture = { source, style:source.style.cssText, backdrop:fixture.style.background };
          return source.getBoundingClientRect().toJSON();
        })()
        """) as? [String: Double]
        let rect = try XCTUnwrap(bounds)
        try await settleRendering(view)
        let image = try await nativeRendererSnapshot(view)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: image.tiffRepresentation!))
        let scaleX = Double(bitmap.pixelsWide) / view.bounds.width, scaleY = Double(bitmap.pixelsHigh) / view.bounds.height
        func samples(_ bitmap: NSBitmapImageRep) throws -> [[Double]] {
            try [0.2, 0.5, 0.8].flatMap { fraction in
                try (24..<216).map { offset in
                    let color = try XCTUnwrap(bitmap.colorAt(x: Int((rect["x"]! + Double(offset)) * scaleX), y: Int((rect["y"]! + rect["height"]! * fraction) * scaleY))?.usingColorSpace(.sRGB))
                    return [color.redComponent, color.greenComponent, color.blueComponent]
                }
            }
        }
        func contrast(_ samples: [[Double]]) -> Double {
            let values = samples.map { $0.reduce(0, +) / 3 }
            return values.max()! - values.min()!
        }
        // Dense glass must diffuse broad shapes. It deliberately limits the
        // backdrop response so live content cannot flash through during mount.
        let blurredSamples = try samples(bitmap), softened = contrast(blurredSamples)
        _ = try await js(view, "document.querySelector('#floating-pixel-fixture').style.background='rgb(32 128 224)'; true")
        try await settleRendering(view)
        let colored = try await nativeRendererSnapshot(view)
        let coloredSamples = try samples(XCTUnwrap(NSBitmapImageRep(data: colored.tiffRepresentation!)))
        var backdropResponse = 0.0
        for (before, after) in zip(blurredSamples, coloredSamples) {
            backdropResponse += zip(before, after).map { abs($0 - $1) }.max()!
        }
        backdropResponse /= Double(blurredSamples.count)
        _ = try await js(view, "document.querySelector('#floating-pixel-fixture').style.background=window.radarSurfaceFixture.backdrop; window.radarSurfaceFixture.source.style.backgroundColor='transparent'; window.radarSurfaceFixture.source.style.backdropFilter='none'; window.radarSurfaceFixture.source.style.webkitBackdropFilter='none'; true")
        try await settleRendering(view)
        let reference = try await nativeRendererSnapshot(view)
        let referenceBitmap = try XCTUnwrap(NSBitmapImageRep(data: reference.tiffRepresentation!))
        let exposed = contrast(try samples(referenceBitmap))
        _ = try await js(view, "(() => { const {source,style}=window.radarSurfaceFixture; source.style.cssText=style; delete source.dataset.qaFloatingTest; delete window.radarSurfaceFixture; document.querySelector('#floating-pixel-fixture').remove(); document.querySelector('#floating-pixel-style').remove(); return true; })()")
        print("Floating pixel contrast \(name) \(theme): softened=\(softened), exposed=\(exposed), backdropResponse=\(backdropResponse)")
        XCTAssertGreaterThan(exposed, 0.15, "The reference must expose high-contrast app content behind the floating surface.")
        XCTAssertLessThan(softened, exposed * 0.1, "Dense glass must suppress broad backdrop shapes without blurring its own content.")
        XCTAssertGreaterThan(backdropResponse, 0.005, "Dense glass must retain a subtle response to the blurred backdrop.")
        XCTAssertLessThan(backdropResponse, 0.1, "Dense glass must prevent live backdrop changes from flashing through the popup.")
        try FileManager.default.createDirectory(at: project.appendingPathComponent(".build/ui-qa"), withIntermediateDirectories: true)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: project.appendingPathComponent(".build/ui-qa/floating-blur-\(name)-\(theme).png"))
    }

    @MainActor
    private func pixelDetail(_ bitmap: NSBitmapImageRep, rect: CGRect, view: WKWebView) throws -> Double {
        let scaleX = CGFloat(bitmap.pixelsWide) / view.bounds.width, scaleY = CGFloat(bitmap.pixelsHigh) / view.bounds.height
        func brightness(_ x: CGFloat, _ y: CGFloat) throws -> Double {
            let color = try XCTUnwrap(bitmap.colorAt(x: Int(x * scaleX), y: Int(y * scaleY))?.usingColorSpace(.sRGB))
            return (color.redComponent + color.greenComponent + color.blueComponent) / 3
        }
        var difference = 0.0, count = 0
        for y in stride(from: rect.minY, to: rect.maxY - 2, by: 4) {
            for x in stride(from: rect.minX, to: rect.maxX - 2, by: 4) {
                let center = try brightness(x, y)
                difference += abs(center - (try brightness(x + 2, y))) + abs(center - (try brightness(x, y + 2)))
                count += 2
            }
        }
        return difference / Double(count)
    }

    @MainActor
    private func nativeRendererSnapshot(_ view: WKWebView) async throws -> NSImage {
        guard #available(macOS 14.4, *), let window = view.window, let contentView = window.contentView else { throw FilterError("Native window capture is unavailable.") }
        // This API enumerates only this process's capturable windows and needs
        // no screen recording consent. WK takeSnapshot omits backdrop filters.
        let scale = window.backingScaleFactor
        let id = CGWindowID(window.windowNumber), width = Int(window.frame.width * scale), height = Int(window.frame.height * scale)
        let capture = try await withNativeCaptureDeadline { try await Self.nativeWindowImage(id: id, width: width, height: height) }
        let rect = view.convert(view.bounds, to: contentView)
        let sx = CGFloat(capture.width) / window.frame.width, sy = CGFloat(capture.height) / window.frame.height
        let crop = CGRect(x: rect.minX * sx, y: (window.frame.height - rect.maxY) * sy, width: rect.width * sx, height: rect.height * sy)
        let image = try XCTUnwrap(capture.cropping(to: crop))
        return NSImage(cgImage: image, size: view.bounds.size)
    }

    private nonisolated static func nativeWindowImage(id: CGWindowID, width: Int, height: Int) async throws -> CGImage {
        guard #available(macOS 14.4, *) else { throw FilterError("Current-process window capture is unavailable.") }
        // Keep ScreenCaptureKit's legacy non-Sendable objects in one executor;
        // only the immutable CGImage crosses back into AppKit's main actor.
        let content = try await SCShareableContent.currentProcess
        let ownWindow = try XCTUnwrap(content.windows.first(where: { $0.windowID == id }))
        let filter = SCContentFilter(desktopIndependentWindow: ownWindow), config = SCStreamConfiguration()
        config.width = width; config.height = height
        config.ignoreShadowsSingleWindow = true; config.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    @MainActor
    private func js(_ view: WKWebView, _ script: String) async throws -> Any? { try await view.evaluateJavaScript(script) }
    @MainActor
    private func waitForTint(_ bridge: RuleUIBridge, rgb: [Double]) async throws {
        let deadline = Date().addingTimeInterval(2)
        while bridge.windowTintRGB != rgb && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(bridge.windowTintRGB, rgb)
    }
    @MainActor
    private func wait(_ view: WKWebView, _ predicate: String, seconds: Double = 12) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline { if try await js(view, predicate) as? Bool == true { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        let body = try await js(view, "document.body.innerText") as? String ?? ""
        let diagnostics = try await js(view, "JSON.stringify({dialogs:Array.from(document.querySelectorAll('[role=dialog]')).map(x=>({state:x.dataset.state,animation:getComputedStyle(x).animationName,opacity:getComputedStyle(x).opacity,animations:x.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))})),visibility:document.visibilityState,height:innerHeight,scrollY,documentHeight:document.documentElement.scrollHeight})") as? String ?? ""
        print("UI diagnostics: \(diagnostics)")
        XCTFail("UI timed out: \(predicate)\n\(body.prefix(1500))")
        throw FilterError("UI predicate failed.")
    }
    @MainActor
    private func click(_ view: WKWebView, _ label: String) async throws {
        // Check and click in one renderer task so asynchronous native validation
        // cannot disable a control between separate JavaScript evaluations.
        try await wait(view, "(() => { const x = Array.from(document.querySelectorAll('button')).find(x => (x.textContent.trim() === \(formulaQuote(label)) || x.getAttribute('aria-label') === \(formulaQuote(label))) && !x.disabled && x.getBoundingClientRect().height > 0); if (!x) return false; x.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,button:0})); x.click(); return true; })()")
        if label == "Add condition" {
            try await wait(view, "Array.from(document.querySelectorAll('[data-rule-library]')).some(x => x.getBoundingClientRect().height > 0)")
            try await input(view, "[data-rule-library] [cmdk-input]", "Candle close")
            _ = try await js(view, "Array.from(document.querySelectorAll('[data-library-id=\"metric:Close\"]')).find(x => x.getBoundingClientRect().height > 0).click(); true")
            try await wait(view, "!Array.from(document.querySelectorAll('[data-rule-library]')).some(x => x.getBoundingClientRect().height > 0) && Array.from(document.querySelectorAll('[aria-label=\"Choose Left expression\"]')).some(x => x.getBoundingClientRect().height > 0)")
        }
    }
    @MainActor
    private func input(_ view: WKWebView, _ selector: String, _ text: String, textarea: Bool = false) async throws {
        _ = try await js(view, "(() => { const x = Array.from(document.querySelectorAll(\(formulaQuote(selector)))).find(x => x instanceof \(textarea ? "HTMLTextAreaElement" : "HTMLInputElement") && x.getBoundingClientRect().height > 0); if (!x) throw new Error('Missing visible input: ' + \(formulaQuote(selector)) + '\\nInputs: ' + Array.from(document.querySelectorAll('input')).map(x => x.getAttribute('aria-label')).join(', ')); Object.getOwnPropertyDescriptor(\(textarea ? "HTMLTextAreaElement" : "HTMLInputElement").prototype, 'value').set.call(x, \(formulaQuote(text))); x.dispatchEvent(new Event('input', {bubbles:true})); return true; })()")
    }
    @MainActor
    private func openMenu(_ view: WKWebView, selector: String, popover: Bool = false) async throws -> Double {
        if selector.contains("Rule type") || selector.contains("Wrap rule") {
            if try await js(view, "!Array.from(document.querySelectorAll(\(formulaQuote(selector)))).some(x => x.getBoundingClientRect().height > 0)") as? Bool == true { try await click(view, "Structure & name") }
        }
        try await wait(view, "Array.from(document.querySelectorAll(\(formulaQuote(selector)))).some(x => !x.disabled && x.getBoundingClientRect().height > 0)")
        // Other overlays can still be mounted while their exit animation runs.
        // Measure the trigger's own popup rather than another overlay in DOM.
        let predicate = popover ? "document.getElementById(trigger.getAttribute('aria-controls'))" : "document.querySelector('[data-slot=\"select-content\"][data-state=\"open\"]')"
        let script = """
        const trigger = Array.from(document.querySelectorAll(\(formulaQuote(selector)))).find(x => !x.disabled && x.getBoundingClientRect().height > 0);
        if (!trigger) throw new Error('Missing menu trigger');
        const start = performance.now();
        \(popover ? "trigger.click();" : "trigger.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));")
        const dispatched = performance.now() - start;
        let firstFrame = 0, animation = '', frames = 0;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Menu did not open: ' + \(formulaQuote(selector)) + '; trigger=' + trigger.outerHTML + '; focus=' + document.activeElement?.outerHTML?.slice(0, 400) + '; menus=' + Array.from(document.querySelectorAll('[data-slot="popover-content"], [data-slot="select-content"]')).map(x => x.outerHTML.slice(0, 500)))), 2000);
          const frame = () => { const menu = \(predicate); frames += 1;
            if (!firstFrame) firstFrame = performance.now() - start;
            if (menu) animation = getComputedStyle(menu).animationDuration;
            if (menu && menu.dataset.state === 'open' && menu.getBoundingClientRect().height > 0 && Number(getComputedStyle(menu).opacity) > 0.9) {
              requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
            } else requestAnimationFrame(frame);
          }; requestAnimationFrame(frame);
        });
        return { elapsed: performance.now() - start, dispatched, firstFrame, animation, frames };
        """
        let result = try await view.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
        print("Menu \(selector) timing: \(result ?? [:])")
        return try XCTUnwrap(result?["elapsed"] as? Double)
    }

    @MainActor
    private func option(_ view: WKWebView, _ label: String) async throws {
        try await wait(view, "Array.from(document.querySelectorAll('[data-slot=\"select-item\"]')).some(item => item.textContent.trim() === \(formulaQuote(label)))")
        _ = try await js(view, "(() => { const item = Array.from(document.querySelectorAll('[data-slot=\"select-item\"]')).find(x => x.textContent.trim() === \(formulaQuote(label))); if (!item) throw new Error('Missing option'); item.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); return true; })()")
        try await wait(view, "document.querySelector('[data-slot=\"select-content\"]') === null")
    }

    @MainActor
    private func metric(_ view: WKWebView, _ key: String) async throws -> Double {
        let latency = try await openMenu(view, selector: "[aria-label=\"Choose Left expression\"]", popover: true)
        try await input(view, "[cmdk-input]", key)
        try await wait(view, "Array.from(document.querySelectorAll('[cmdk-item]')).some(x => x.dataset.value?.endsWith(\(formulaQuote(" " + key))))")
        _ = try await js(view, "Array.from(document.querySelectorAll('[cmdk-item]')).find(x => x.dataset.value?.endsWith(\(formulaQuote(" " + key)))).click(); true")
        try await wait(view, "Array.from(document.querySelectorAll('[data-expression-field=\"Left expression\"]')).some(x => x.getBoundingClientRect().height > 0 && x.dataset.expressionSource === \(formulaQuote(key)))")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
        return latency
    }

    @MainActor
    private func selectPhase(_ view: WKWebView, _ label: String) async throws {
        try await click(view, label)
        try await wait(view, "Array.from(document.querySelectorAll('section')).some(x => x.getAttribute('aria-label') === \(formulaQuote(label)) && x.getBoundingClientRect().height > 0)")
    }

    @MainActor
    private func setBasicRule(_ view: WKWebView, metric key: String, comparison: String, threshold: String, waitUntilValid: Bool = true) async throws {
        try await click(view, "Reset draft")
        try await click(view, "Add condition")
        _ = try await metric(view, key)
        _ = try await openMenu(view, selector: "[aria-label=\"Comparison\"]")
        try await option(view, comparison)
        try await input(view, "[aria-label=\"Threshold\"]", threshold)
        if waitUntilValid { try await wait(view, "(Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Save Universe' && !x.disabled && x.getBoundingClientRect().height > 0) || Array.from(document.querySelectorAll('[data-rule-draft-state=\"valid\"]')).some(x => x.closest('[data-strategy-rules]') && x.getBoundingClientRect().height > 0)) && !document.body.innerText.includes('Compiling…')") }
    }

    @MainActor
    private func expression(_ view: WKWebView, field: String, choice: String) async throws {
        _ = try await openMenu(view, selector: "[aria-label=\(formulaQuote("Choose " + field))]", popover: true)
        let picker = "[data-expression-picker=\(formulaQuote(field))][data-state=\"open\"]"
        try await wait(view, "document.querySelector(\(formulaQuote(picker))) !== null")
        try await input(view, "\(picker) [cmdk-input]", choice)
        let predicate = "Array.from(document.querySelector(\(formulaQuote(picker))).querySelectorAll('[cmdk-item]')).find(x => x.dataset.functionName?.toLowerCase() === \(formulaQuote(choice.lowercased())))"
        try await wait(view, "Boolean(\(predicate))")
        _ = try await js(view, "\(predicate).click(); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
    }

    @MainActor
    private func validDraft(_ view: WKWebView) async throws {
        try await wait(view, "(Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Save Universe' && !x.disabled && x.getBoundingClientRect().height > 0) || Array.from(document.querySelectorAll('[data-rule-draft-state=\"valid\"]')).some(x => x.closest('[data-strategy-rules]') && x.getBoundingClientRect().height > 0)) && !document.body.innerText.includes('Compiling…')")
    }

    @MainActor
    private func startRuleDrag(_ view: WKWebView, source: String) async throws {
        _ = try await js(view, """
        (() => {
          const node = document.querySelector('[data-rule-outline-id="\(source)"]');
          const handle = node.querySelector('button[draggable="true"]');
          handle.scrollIntoView({block:'center'});
          const bounds = handle.getBoundingClientRect();
          window.radarRuleDragOrigin = {left:bounds.left + scrollX, top:bounds.top + scrollY, width:bounds.width, height:bounds.height};
          window.radarRuleDrag = new DataTransfer();
          handle.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer:window.radarRuleDrag}));
          return true;
        })()
        """)
        try await wait(view, "getComputedStyle(document.querySelector('[data-rule-outline-id=\"\(source)\"] > [data-surface=\"panel\"]')).opacity === '0.5'")
        let sourceState = try await js(view, """
        (() => {
          const handle = document.querySelector('[data-rule-outline-id="\(source)"] button[draggable="true"]');
          const bounds = handle.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          const current = {left:bounds.left + scrollX, top:bounds.top + scrollY, width:bounds.width, height:bounds.height};
          return {interactive:!handle.disabled && !handle.closest('[inert]') && handle.contains(hit),
            stationary:Object.keys(current).every(key => Math.abs(current[key] - window.radarRuleDragOrigin[key]) < 0.5)};
        })()
        """) as? [String: Bool]
        XCTAssertEqual(sourceState?["interactive"], true, "The native drag handle must remain interactive and reachable throughout the drag.")
        XCTAssertEqual(sourceState?["stationary"], true, "Drop hints must not move the native drag source during dragstart.")
    }

    @MainActor
    private func ruleDragEvent(_ view: WKWebView, type: String, target: String, position: Double = 0.5) async throws -> Bool {
        let result = try await js(view, """
        (() => {
          const node = document.querySelector('[data-rule-outline-id="\(target)"]');
          const heading = node.querySelector(':scope > [data-surface="panel"]').firstElementChild;
          const bounds = heading.getBoundingClientRect();
          const event = new DragEvent('\(type)', {bubbles:true, cancelable:true, dataTransfer:window.radarRuleDrag,
            clientX:bounds.left + bounds.width / 2, clientY:bounds.top + bounds.height * \(position)});
          heading.dispatchEvent(event);
          return event.defaultPrevented;
        })()
        """)
        return result as? Bool == true
    }

    @MainActor
    private func ruleChildIDs(_ view: WKWebView, parent: String) async throws -> [String] {
        let result = try await js(view, """
        (() => {
          const parent = document.querySelector('[data-rule-outline-id="\(parent)"]');
          return Array.from(parent.querySelectorAll('[data-rule-outline-id]'))
            .filter(child => child.parentElement.closest('[data-rule-outline-id]') === parent).map(child => child.dataset.ruleOutlineId);
        })()
        """)
        return try XCTUnwrap(result as? [String])
    }

    @MainActor
    func testDraggingConditionsAcrossGroupCards() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 1100), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 1100), configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await wait(view, "document.querySelector('table[data-market-count]') !== null")
        try await click(view, "Universe rules")
        let parentIs = { (child: String, parent: String) in "document.querySelector('[data-rule-outline-id=\"\(child)\"]').parentElement.closest('[data-rule-outline-id]').dataset.ruleOutlineId === '\(parent)'" }
        for layout in ["Sentence rows", "Guided cards"] {
            try await click(view, "Reset draft")
            let initialRootValue = try await js(view, "document.querySelector('[data-rule-outline-id]').dataset.ruleOutlineId") as? String
            let initialRoot = try XCTUnwrap(initialRootValue)
            try await click(view, "Add group"); try await click(view, "Add condition"); try await input(view, "[aria-label=\"Threshold\"]", "100")
            try await click(view, "Add condition"); try await expression(view, field: "Left expression", choice: "RSI")
            try await input(view, "[aria-label=\"Left expression Period (h)\"]", "14"); try await input(view, "[aria-label=\"Threshold\"]", "40")
            _ = try await js(view, "document.querySelector('[data-rule-outline-id=\"\(initialRoot)\"] button[aria-label^=\"Edit \" ]').click(); true")
            try await click(view, "Add group"); try await click(view, "Any (OR)")
            try await click(view, "Add condition"); _ = try await metric(view, "Volume"); try await input(view, "[aria-label=\"Threshold\"]", "10")
            try await click(view, "Add condition")
            _ = try await openMenu(view, selector: "[aria-label=\"Comparison\"]"); try await option(view, "Less than <")
            try await input(view, "[aria-label=\"Threshold\"]", "200")
            try await validDraft(view); try await click(view, layout)
            let rootResult = try await js(view, "document.querySelector('[data-rule-outline-id]').dataset.ruleOutlineId")
            let root = try XCTUnwrap(rootResult as? String), groups = try await ruleChildIDs(view, parent: root)
            let origin = groups[0], target = groups[1]
            let originChildren = try await ruleChildIDs(view, parent: origin), targetChildren = try await ruleChildIDs(view, parent: target)
            let source = originChildren[0]
            // Drop onto a selected group card, including its taller guided inspector.
            _ = try await js(view, "document.querySelector('[data-rule-outline-id=\"\(target)\"] button[aria-label^=\"Edit \"]').click(); true")
            try await startRuleDrag(view, source: source)
            let accepted = try await ruleDragEvent(view, type: "dragover", target: target)
            XCTAssertTrue(accepted, layout)
            try await wait(view, "document.querySelector('[data-rule-outline-id=\"\(target)\"] > [data-filter-drop-target]') !== null")
            _ = try await ruleDragEvent(view, type: "drop", target: target)
            try await wait(view, parentIs(source, target)); try await validDraft(view)
            try await click(view, "Undo rule edit"); try await wait(view, parentIs(source, origin))
            try await click(view, "Redo rule edit"); try await wait(view, parentIs(source, target))
            // Row edges still insert before and after siblings, including the final row.
            try await startRuleDrag(view, source: source)
            _ = try await ruleDragEvent(view, type: "dragover", target: targetChildren[0], position: 0.1)
            _ = try await ruleDragEvent(view, type: "drop", target: targetChildren[0], position: 0.1)
            var ordered = try await ruleChildIDs(view, parent: target)
            XCTAssertEqual(ordered, [source] + targetChildren, layout)
            try await startRuleDrag(view, source: source)
            _ = try await ruleDragEvent(view, type: "dragover", target: targetChildren[1], position: 0.9)
            try await wait(view, "document.querySelector('[data-rule-outline-id=\"\(targetChildren[1])\"] > [data-filter-insertion-line]') !== null")
            _ = try await ruleDragEvent(view, type: "drop", target: targetChildren[1], position: 0.9)
            ordered = try await ruleChildIDs(view, parent: target)
            XCTAssertEqual(ordered, targetChildren + [source], layout)
            try await startRuleDrag(view, source: source)
            _ = try await ruleDragEvent(view, type: "dragover", target: originChildren[1], position: 0.1)
            _ = try await ruleDragEvent(view, type: "drop", target: originChildren[1], position: 0.1)
            try await wait(view, parentIs(source, origin))
            ordered = try await ruleChildIDs(view, parent: origin)
            XCTAssertEqual(ordered, originChildren, layout)
            // Collapsed groups accept the drop and reveal the moved condition.
            _ = try await js(view, "document.querySelector('[data-rule-outline-id=\"\(target)\"] button[aria-label=\"Collapse rule\"]').click(); true")
            try await wait(view, "document.querySelector('[data-rule-outline-id=\"\(target)\"]').querySelectorAll('[data-rule-outline-id]').length === 0")
            try await startRuleDrag(view, source: source)
            _ = try await ruleDragEvent(view, type: "dragover", target: target)
            _ = try await ruleDragEvent(view, type: "drop", target: target)
            try await wait(view, parentIs(source, target)); try await validDraft(view)
            try await click(view, "Undo rule edit"); try await wait(view, parentIs(source, origin))
            // A newly added empty group becomes valid once it receives a condition.
            _ = try await js(view, "document.querySelector('[data-rule-outline-id=\"\(root)\"] button[aria-label^=\"Edit \"]').click(); true")
            try await click(view, "Add group")
            let withEmpty = try await ruleChildIDs(view, parent: root), empty = try XCTUnwrap(withEmpty.last)
            try await startRuleDrag(view, source: source)
            _ = try await ruleDragEvent(view, type: "dragover", target: empty)
            _ = try await ruleDragEvent(view, type: "drop", target: empty)
            try await wait(view, parentIs(source, empty)); try await validDraft(view)
            // Invalid descendant targets clear feedback and cannot use a stale valid destination.
            try await startRuleDrag(view, source: empty)
            _ = try await ruleDragEvent(view, type: "dragover", target: target)
            try await wait(view, "document.querySelector('[data-filter-drop-target]') !== null")
            let invalid = try await ruleDragEvent(view, type: "dragover", target: source)
            XCTAssertFalse(invalid, layout)
            try await wait(view, "document.querySelector('[data-filter-drop-target], [data-filter-insertion-line]') === null")
            _ = try await ruleDragEvent(view, type: "dragover", target: target)
            try await wait(view, "document.querySelector('[data-filter-drop-target]') !== null")
            _ = try await ruleDragEvent(view, type: "drop", target: source)
            try await wait(view, parentIs(empty, root)); try await wait(view, parentIs(source, empty))
            try await wait(view, "document.querySelector('[data-filter-drop-group], [data-filter-drop-target], [data-filter-insertion-line]') === null")
            // Rejected drops add no undo revision; cancelling a drag leaves the tree unchanged.
            try await click(view, "Undo rule edit"); try await wait(view, parentIs(source, origin))
            try await click(view, "Redo rule edit"); try await wait(view, parentIs(source, empty))
            try await startRuleDrag(view, source: source)
            _ = try await ruleDragEvent(view, type: "dragover", target: target)
            _ = try await ruleDragEvent(view, type: "dragend", target: source)
            try await wait(view, "document.querySelector('[data-filter-drop-group], [data-filter-drop-target]') === null")
            try await wait(view, parentIs(source, empty)); try await validDraft(view)
            try await click(view, "Save Universe")
            try await wait(view, "document.body.innerText.includes('Universe saved to the strategy.')")
            let saved = try FilterConfigV2.decode(bridge.savedUniverseJSON)
            let moved = saved.root.children.first(where: { $0.id == empty })?.children.first
            XCTAssertEqual(moved?.id, source, layout); XCTAssertEqual(moved?.left, "Close", layout); XCTAssertEqual(moved?.right, "100", layout)
        }
    }

    @MainActor
    func testVisualFunctionCoverageRelativeVolumeCountTextAndCrossingControls() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        bridge.pulseRows = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 1100), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 1100), configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 6")
        try await click(view, "Universe rules"); try await click(view, "Reset draft"); try await click(view, "Add condition")
        try await validDraft(view)
        // New numeric rules exclude equality; inclusive comparisons remain explicit choices.
        try await wait(view, "document.querySelector('[aria-label=\"Comparison\"]')?.textContent.includes('Greater than >')")
        _ = try await metric(view, "Close")
        try await input(view, "[aria-label=\"Threshold\"]", "110")
        try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 0")
        _ = try await openMenu(view, selector: "[aria-label=\"Comparison\"]")
        let comparisons = try await js(view, "Array.from(document.querySelectorAll('[data-slot=\"select-item\"]')).map(item=>item.textContent.trim())") as? [String]
        XCTAssertEqual(Array(try XCTUnwrap(comparisons).prefix(2)), ["Greater than >", "Less than <"])
        try await option(view, "At least ≥"); try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 8")
        _ = try await openMenu(view, selector: "[aria-label=\"Comparison\"]")
        try await option(view, "Less than <"); try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 0")
        try await input(view, "[aria-label=\"Threshold\"]", "111"); try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 8")
        _ = try await openMenu(view, selector: "[aria-label=\"Comparison\"]")
        try await option(view, "Greater than >")
        try await input(view, "[aria-label=\"Threshold\"]", "0"); try await validDraft(view)
        // Every native metric and scalar value block has a visual entry; basic judgments do not expose free arithmetic.
        _ = try await openMenu(view, selector: "[aria-label=\"Choose Left expression\"]", popover: true)
        let entryValues = try await js(view, "Array.from(document.querySelectorAll('[cmdk-item]')).map(x => x.dataset.value)") as? [String]
        let entries = try XCTUnwrap(entryValues)
        let consolidated = Set(["emaSlope", "priceEMA", "emaDistance", "rsi6", "rsi12", "rsi24", "rsi6vs12", "rsi12vs24", "roc", "rocVsMaroc", "rocChange", "maroc", "marocChange", "priceUpper", "priceMiddle", "priceLower", "highUpper", "lowLower", "priceVWAP", "vwapDistance", "high48", "high96", "closeHigh48", "closeHigh96", "low48", "low96", "closeLow48", "closeLow96", "recentHigh48", "recentHigh96", "recentLow48", "recentLow96", "high48Age", "high96Age", "low48Age", "low96Age", "priceChange", "bodyChange", "candleRange", "oiChange", "price", "liveVolume", "candleDirection", "buyVsSell"])
        for metric in FilterCatalog.metrics where !consolidated.contains(metric.key) {
            XCTAssertTrue(entries.contains { $0.hasSuffix(" " + metric.key) }, metric.key)
        }
        for key in consolidated { XCTAssertFalse(entries.contains { $0.hasSuffix(" " + key) }, key) }
        for name in ["EMA", "RSI", "ROC", "MAROC", "LogBB", "VWAP", "PriorExtreme", "ExtremeAge", "abs", "mean", "sum", "highest", "lowest", "stddev", "lag", "change", "relativeChange", "closed", "live"] { XCTAssertTrue(entries.contains { $0.hasSuffix(" " + name) }, name) }
        XCTAssertEqual(entries.filter { $0.hasPrefix("arithmetic ") }.count, 0)
        _ = try await js(view, "document.querySelector('[data-slot=\"popover-content\"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
        // Wick/body band relations expose their complete categorical choices through the native catalogue.
        for key in ["bodyUpper", "bodyLower"] {
            _ = try await metric(view, key)
            for choice in FilterCatalog.choices(for: key) {
                _ = try await openMenu(view, selector: "[aria-label=\"Right value\"]")
                try await option(view, choice.label); try await validDraft(view)
            }
            try await wait(view, "document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes(\(formulaQuote(FilterCatalog.choices(for: key).last!.label)))")
        }
        _ = try await metric(view, "Close"); try await validDraft(view)
        // Exercise each parameter-control shape; FilterLibraryTests validates every scalar default.
        _ = try await openMenu(view, selector: "[aria-label=\"Threshold / reference value type\"]"); try await option(view, "Another value / indicator")
        for name in ["EMA", "MAROC", "LogBB", "PriorExtreme", "ExtremeAge", "relativeChange", "abs", "mean", "lag", "closed"] {
            try await expression(view, field: "Reference value", choice: name)
            try await validDraft(view)
            let parts = try await js(view, "document.querySelector('[aria-label=\"Toggle Reference value parameters\"]') !== null") as? Bool
            XCTAssertEqual(parts, true, name)
        }
        // The ready-to-use volume judgment exposes a flat historical-average reference.
        try await click(view, "Reset draft"); try await click(view, "Volume surge"); try await validDraft(view)
        try await wait(view, "document.querySelector('[aria-label=\"Threshold / reference value type\"]')?.textContent.includes('Average × multiplier') && document.querySelector('[aria-label=\"Baseline average window hours\"]')?.value === '20' && document.querySelector('[aria-label=\"Baseline end offset hours\"]')?.value === '1' && document.querySelector('[aria-label=\"Baseline multiplier\"]')?.value === '2'")
        try await input(view, "[aria-label=\"Baseline average window hours\"]", "")
        try await wait(view, "document.body.innerText.includes('Last valid preview remains active')")
        // Incomplete typed value blocks survive panel folding and chart navigation.
        try await click(view, "Universe rules"); try await click(view, "Universe rules")
        try await wait(view, "document.querySelector('[aria-label=\"Baseline average window hours\"]')?.value === ''")
        _ = try await js(view, "document.querySelector('tbody tr[tabindex]').click(); true")
        try await wait(view, "document.body.innerText.includes('Fixture chart')")
        try await click(view, "Markets")
        try await wait(view, "document.querySelector('[aria-label=\"Baseline average window hours\"]')?.value === '' && document.querySelector('[aria-label=\"Baseline end offset hours\"]')?.value === '1'")
        try await input(view, "[aria-label=\"Baseline average window hours\"]", "20"); try await validDraft(view)
        // Existing conditions can be wrapped in counts and unwrapped without losing the typed reference.
        _ = try await openMenu(view, selector: "[aria-label=\"Wrap rule\"]"); try await option(view, "Occurrence count")
        try await input(view, "[aria-label=\"Window hours\"]", "48")
        try await input(view, "[aria-label=\"Count threshold\"]", "3")
        _ = try await openMenu(view, selector: "[aria-label=\"Count comparison\"]"); try await option(view, "Between (inclusive)")
        try await input(view, "[aria-label=\"Maximum count\"]", "24"); try await validDraft(view)
        _ = try await openMenu(view, selector: "[aria-label=\"Wrap rule\"]"); try await option(view, "Remove wrapper")
        try await validDraft(view)
        try await wait(view, "document.querySelector('[aria-label=\"Baseline multiplier\"]')?.value === '2'")
        // Switching to a crossing keeps an explicit indicator reference and removes range-only controls.
        try await click(view, "Reset draft"); try await click(view, "Add condition"); _ = try await metric(view, "Close")
        _ = try await openMenu(view, selector: "[aria-label=\"Threshold / reference value type\"]"); try await option(view, "Another value / indicator")
        try await expression(view, field: "Reference value", choice: "EMA")
        try await input(view, "[aria-label=\"Reference value Period (h)\"]", "480")
        _ = try await openMenu(view, selector: "[aria-label=\"Comparison\"]"); try await option(view, "Crosses above")
        try await validDraft(view)
        let crossingControls = try await js(view, "document.querySelector('[aria-label=\"Maximum reference type\"]') === null && document.querySelector('[data-expression-field=\"Reference value\"]')?.dataset.expressionSource === 'EMA(480)'") as? Bool
        XCTAssertEqual(crossingControls, true)
        _ = try await metric(view, "oiTrend"); try await validDraft(view)
        let risingControl = try await js(view, "document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes('Rising')") as? Bool
        XCTAssertEqual(risingControl, true)
        // Symbols use a literal text control and no direct formula input is exposed.
        _ = try await metric(view, "Symbol")
        try await input(view, "[aria-label=\"Right text value\"]", "MKT000-USDT-SWAP"); try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 1")
        let noFormulaEditor = try await js(view, "document.querySelector('textarea') === null && !Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Formula' || x.getAttribute('aria-label')?.includes('formula'))") as? Bool
        XCTAssertEqual(noFormulaEditor, true)
        window.setContentSize(NSSize(width: 720, height: 1000))
        window.appearance = NSAppearance(named: .darkAqua)
        try await wait(view, "innerWidth === 720")
        try await settleRendering(view)
        let overflowing = try await js(view, "document.documentElement.scrollWidth > window.innerWidth + 1") as? Bool
        XCTAssertEqual(overflowing, false)
    }

    @MainActor
    func testConditionLibraryTemplatesGuidedCardsUndoAndBulkEditing() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 20), configuration = uiConfiguration()
        bridge.pulseRows = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 1100), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 1100), configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 20)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 15")
        try await click(view, "Universe rules"); try await click(view, "Reset draft")
        _ = try await openMenu(view, selector: "[aria-label=\"Add condition\"]", popover: true)
        try await input(view, "[data-rule-library] [cmdk-input]", "持仓趋势")
        try await wait(view, "document.querySelector('[data-library-id=\"metric:oiTrend\"]') !== null")
        _ = try await js(view, "document.querySelector('[data-library-id=\"metric:oiTrend\"]').click(); true")
        try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 7")
        let contractCheckRemoved = try await js(view, "document.querySelector('[data-rule-preview]') === null && !document.body.innerText.includes('Check a contract')") as? Bool
        XCTAssertEqual(contractCheckRemoved, true)
        let noFormula = try await js(view, "document.querySelector('textarea') === null") as? Bool
        XCTAssertEqual(noFormula, true)
        try await click(view, "Guided cards")
        try await wait(view, "document.querySelector('[data-rule-layout=\"guided\"] [data-expression-field=\"Left expression\"]') !== null")
        XCTAssertEqual(bridge.radar.filterLibraryPreferences.layout, "guided")
        _ = try await openMenu(view, selector: "[aria-label=\"Right value\"]"); try await option(view, "Falling")
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 6")
        try await click(view, "Undo rule edit")
        try await wait(view, "document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes('Rising') && Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 7")
        try await click(view, "Redo rule edit")
        try await wait(view, "document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes('Falling')")
        try await click(view, "Sentence rows")
        try await wait(view, "document.querySelector('[aria-label=\"Selected rule editor\"]') !== null")
        try await click(view, "Reset draft"); try await click(view, "Body above EMA")
        try await validDraft(view)
        try await wait(view, "document.querySelector('[aria-label=\"Body EMA period hours\"]')?.value === '200' && document.querySelector('[aria-label=\"Window hours\"]')?.value === '48'")
        try await input(view, "[aria-label=\"Body EMA period hours\"]", "")
        try await wait(view, "document.body.innerText.includes('Last valid preview remains active') && document.querySelector('[aria-label=\"Body EMA period hours\"]')?.value === ''")
        try await input(view, "[aria-label=\"Body EMA period hours\"]", "480")
        try await validDraft(view)
        try await wait(view, "document.querySelector('[aria-label=\"Body EMA period hours\"]')?.value === '480' && document.querySelector('[aria-label=\"Window hours\"]')?.value === '48' && document.body.innerText.includes('Whole candle body above EMA 480')")
        try await click(view, "Reset draft"); try await click(view, "Volume surge")
        try await validDraft(view)
        try await wait(view, "document.querySelector('[aria-label=\"Threshold / reference value type\"]')?.textContent.includes('Average × multiplier') && document.querySelector('[aria-label=\"Baseline end offset hours\"]')?.value === '1'")
        try await click(view, "Reset draft"); try await click(view, "Break & retest")
        try await validDraft(view)
        try await wait(view, "document.querySelector('[aria-label=\"Sequence stages\"]')?.innerText.includes('Capture: Level')")
        _ = try await js(view, "Array.from(document.querySelector('[aria-label=\"Sequence stages\"]').querySelectorAll('button')).find(x => x.textContent.includes('1.')).click(); true")
        try await input(view, "[aria-label=\"Stage name\"]", "breakout")
        _ = try await js(view, "document.querySelector('[aria-label=\"Stage name\"]').dispatchEvent(new FocusEvent('focusout', {bubbles:true})); true")
        try await validDraft(view)
        _ = try await js(view, "Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().startsWith('3. Reclaim'))?.click(); true")
        try await wait(view, "document.querySelector('[data-expression-field=\"Reference value\"]')?.dataset.expressionSource === 'breakout.level'")
        try await click(view, "Reset draft"); try await click(view, "OI rising"); try await click(view, "OI rising")
        _ = try await js(view, "Array.from(document.querySelectorAll('[aria-label*=\"for bulk editing\"]')).forEach(x => x.click()); true")
        try await wait(view, "document.body.innerText.includes('2 selected')")
        try await click(view, "Set Closed"); try await validDraft(view)
        try await click(view, "Undo rule edit"); try await validDraft(view)
        try await click(view, "Reset draft")
        _ = try await openMenu(view, selector: "[aria-label=\"Add condition\"]", popover: true)
        try await input(view, "[data-rule-library] [cmdk-input]", "RSI12 vs RSI24")
        try await wait(view, "document.querySelector('[data-library-id=\"vs:rsi-rsi\"]') !== null && document.querySelectorAll('[data-library-id^=\"vs:rsi\"]').length === 1")
        _ = try await js(view, "document.querySelector('[data-library-id=\"vs:rsi-rsi\"]').click(); true")
        try await validDraft(view)
        try await wait(view, "document.querySelector('[data-expression-field=\"Left expression\"]')?.dataset.expressionSource === 'RSI(6)' && document.querySelector('[data-expression-field=\"Reference value\"]')?.dataset.expressionSource === 'RSI(12)'")
        try await click(view, "Reset draft")
        _ = try await openMenu(view, selector: "[aria-label=\"Add condition\"]", popover: true)
        try await click(view, "Favorite OI rising")
        try await wait(view, "Boolean(document.querySelector('[aria-label=\"Favorite OI rising\"][aria-pressed=\"true\"]'))")
        XCTAssertTrue(bridge.radar.filterLibraryPreferences.favorites.contains("preset:oi"))
        _ = try await js(view, "document.querySelector('[data-rule-library]').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true")
        try await wait(view, "document.querySelector('[data-rule-library]') === null")
        window.setContentSize(NSSize(width: 720, height: 1000)); window.appearance = NSAppearance(named: .darkAqua)
        try await wait(view, "innerWidth === 720")
        try await settleRendering(view)
        let overflow = try await js(view, "document.documentElement.scrollWidth > window.innerWidth + 1") as? Bool
        XCTAssertEqual(overflow, false)
    }

    @MainActor
    func testCategoricalMenusAndTypedRuleEditingStayResponsiveWithFiveHundredMarkets() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist")), configuration = uiConfiguration()
        bridge.pulseRows = true
        for index in bridge.contexts.indices {
            let hour = bridge.contexts[index].hour
            bridge.contexts[index].stats[hour - 2 * hourMS] = .init(oi: 100_000_000, sell: nil, buy: nil)
            bridge.contexts[index].stats[hour - hourMS] = .init(oi: 99_000_000 + Double(index % 3) * 1_000_000, sell: nil, buy: nil)
        }
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 375")
        try await click(view, "Universe rules"); try await click(view, "Reset draft")
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500")
        let rendered = try await js(view, "document.querySelectorAll('tbody tr[data-market-index]').length") as? Int
        XCTAssertLessThan(try XCTUnwrap(rendered), 50, "Offscreen contracts should not delay menus.")
        _ = try await view.callAsyncJavaScript("await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'}); return true;", arguments: [:], in: nil, contentWorld: .page)
        try await wait(view, "document.querySelector('tr[data-market-index=\"499\"]') !== null")
        _ = try await js(view, "(() => { const row = document.querySelector('tr[data-market-index=\"499\"]'); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true})); return true; })()")
        try await wait(view, "document.activeElement?.dataset.marketIndex === '0'")
        _ = try await js(view, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true})); true")
        try await wait(view, "document.activeElement?.dataset.marketIndex === '499'")
        _ = try await js(view, "document.querySelector('[aria-label=\"Search contracts\"]').focus(); window.scrollTo({top:0,behavior:'instant'}); true")
        try await wait(view, "document.querySelector('tr[data-market-index=\"0\"]') !== null")
        _ = try await js(view, "document.querySelector('tr[data-market-index=\"0\"] button[aria-label*=\"opportunity details\"]').focus(); true")
        _ = try await openMenu(view, selector: "tr[data-market-index=\"0\"] button[aria-label*=\"opportunity details\"]", popover: true)
        _ = try await js(view, "window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}); true")
        try await wait(view, "document.querySelector('tr[data-market-index=\"499\"]') !== null && document.querySelector('tr[data-market-index=\"0\"]') !== null && document.querySelector('[data-slot=\"popover-content\"]') !== null")
        _ = try await js(view, "document.querySelector('[data-slot=\"popover-content\"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
        _ = try await js(view, "document.querySelector('[aria-label=\"Search contracts\"]').focus(); window.scrollTo({top:0,behavior:'instant'}); true")
        try await wait(view, "document.querySelector('tr[data-market-index=\"0\"]') !== null")
        var timings: [Double] = []
        timings.append(try await openMenu(view, selector: "[aria-label=\"Add condition\"]", popover: true))
        try await dismissFloating(view)
        timings.append(try await openMenu(view, selector: "[aria-label=\"Rule type\"]"))
        try await option(view, "All (AND)")
        try await click(view, "Add condition")
        // Select OI entirely by its visible name and ordinary terminology, without entering a formula.
        timings.append(try await openMenu(view, selector: "[aria-label=\"Choose Left expression\"]", popover: true))
        let metricFirst = try await js(view, "(() => { const items = Array.from(document.querySelectorAll('[cmdk-item]')); return items.findIndex(x => x.dataset.metricKey === 'oiTrend') < items.findIndex(x => x.dataset.value === 'EMA EMA'); })()") as? Bool
        XCTAssertEqual(metricFirst, true)
        try await input(view, "[cmdk-input]", "Open interest trend")
        try await wait(view, "document.querySelector('[cmdk-item][data-metric-key=\"oiTrend\"]')?.textContent.includes('OI Trend')")
        _ = try await js(view, "document.querySelector('[cmdk-item][data-metric-key=\"oiTrend\"]').click(); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
        try await wait(view, "document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes('Rising') && Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 167")
        let visualOI = try await js(view, "document.querySelector('[aria-label=\"Choose Left expression\"]')?.textContent === 'OI Trend' && document.querySelector('[aria-label=\"Left expression\"]') === null") as? Bool
        XCTAssertEqual(visualOI, true, "A selected indicator should show its name, not require a formula input.")
        timings.append(try await openMenu(view, selector: "[aria-label=\"Comparison\"]"))
        let operators = try await js(view, "Array.from(document.querySelectorAll('[data-slot=\"select-item\"]')).map(x => x.textContent.trim())") as? [String]
        XCTAssertEqual(operators, ["Equals", "Does not equal", "Available", "Unavailable"])
        let retainedMenu = try await view.callAsyncJavaScript("""
        Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(x => x.textContent.trim() === 'Equals').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
        await new Promise(resolve => requestAnimationFrame(resolve));
        document.querySelector('[aria-label="Choose Left expression"]').click();
        await new Promise(resolve => setTimeout(resolve, 250));
        return Boolean(document.querySelector('[data-expression-picker="Left expression"][data-state="open"]')?.contains(document.activeElement));
        """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(retainedMenu, true, "Closing the preceding select must not dismiss the next indicator menu.")
        _ = try await js(view, "document.querySelector('[data-slot=\"popover-content\"]')?.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true")
        try await wait(view, "document.querySelector('[data-slot=\"popover-content\"]') === null")
        for (label, count) in [("Falling", 166), ("Flat", 167), ("Rising", 167)] {
            timings.append(try await openMenu(view, selector: "[aria-label=\"Right value\"]"))
            try await option(view, label)
            try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === \(count) && !document.body.innerText.includes('Compiling…')")
        }
        // Closed must use the last two completed OI readings, independently of the live direction.
        _ = try await js(view, "Array.from(document.querySelector('[data-rule-kind=\"condition\"] [aria-label=\"Evaluation hour\"]').querySelectorAll('button')).find(x => x.textContent.trim() === 'Closed').click(); true")
        try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 166")
        _ = try await js(view, "Array.from(document.querySelector('[data-rule-kind=\"condition\"] [aria-label=\"Evaluation hour\"]').querySelectorAll('button')).find(x => x.textContent.trim() === 'Live').click(); true")
        try await validDraft(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 167")
        let restored = try await js(view, "document.querySelector('[aria-label=\"Right value\"]').textContent.includes('Rising')") as? Bool
        XCTAssertEqual(restored, true)
        // A categorical reference can be another indicator without text entry.
        timings.append(try await openMenu(view, selector: "[aria-label=\"Right value\"]"))
        try await option(view, "Another indicator / value…")
        timings.append(try await openMenu(view, selector: "[aria-label=\"Choose Right expression\"]", popover: true))
        try await input(view, "[cmdk-input]", "emaTrend")
        _ = try await js(view, "document.querySelector('[cmdk-item][data-metric-key=\"emaTrend\"]').click(); true")
        try await wait(view, "Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Save Universe' && !x.disabled)")
        let custom = try await js(view, "document.querySelector('[data-expression-field=\"Right expression\"]')?.dataset.expressionSource") as? String
        XCTAssertEqual(custom, "emaTrend")
        timings.append(try await openMenu(view, selector: "[aria-label=\"Right value\"]"))
        try await option(view, "Rising")
        timings.append(try await metric(view, "emaBody"))
        try await wait(view, "document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes('Entire body above')")
        timings.append(try await openMenu(view, selector: "[aria-label=\"Wrap rule\"]"))
        try await option(view, "Every hour")
        try await input(view, "[aria-label=\"Window hours\"]", "48")
        try await wait(view, "Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Save Universe' && !x.disabled)")
        try await wait(view, "document.querySelector('[aria-label=\"Window hours\"]')?.value === '48' && document.body.innerText.includes('every hour for 48h')")
        print("500-market menu paint timings (ms): \(timings.map { Int($0) }); max=\(Int(timings.max() ?? 0))")
        XCTAssertLessThan(timings.max() ?? 0, 250, "Menus must open promptly, including their animation and first paint.")
    }

    @MainActor
    func testStrategyUniverseSavesPromptlyWhilePreviewIsSlowAndKeepsMarketRows() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist")), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 375")
        try await click(view, "Universe rules")
        try await setBasicRule(view, metric: "Close", comparison: "Greater than >", threshold: "0")
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500")

        bridge.previewDelay = 2_000_000_000
        _ = try await metric(view, "oiTrend"); try await validDraft(view)
        try await wait(view, "document.querySelector('[data-filter-summary]')?.innerText.includes('Updating preview')")
        let start = ContinuousClock.now
        try await click(view, "Save Universe")
        try await wait(view, "document.querySelector('[data-filter-unsaved]') === null && document.body.innerText.includes('Universe saved to the strategy.')")
        let elapsed = start.duration(to: .now)
        print("500-market Apply filters with a 2s preview delay: \(elapsed)")
        XCTAssertLessThan(elapsed, .milliseconds(500), "Persisting filters must not wait for market evaluation.")
        let countAfterSave = try await js(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount)") as? Int
        XCTAssertEqual(countAfterSave, 500, "A metadata acknowledgment must preserve the existing list.")
        let saved = bridge.savedUniverseJSON
        XCTAssertEqual(try Store(url: bridge.directory.appendingPathComponent("radar.sqlite3")).selectedSuiteProfile("radar")?.universeJSON, saved)
        bridge.previewDelay = 0
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 167")
        let stillSaved = try await js(view, "document.querySelector('[data-filter-unsaved]') === null") as? Bool
        XCTAssertEqual(stillSaved, true, "A preview captured before saving must not undo the acknowledged rules.")
        let judgmentRetained = try await js(view, "document.querySelector('[aria-label=\"Choose Left expression\"]')?.textContent === 'OI Trend' && document.querySelector('[aria-label=\"Right value\"]')?.textContent.includes('Rising')") as? Bool
        XCTAssertEqual(judgmentRetained, true)
        XCTAssertEqual(bridge.savedUniverseJSON, saved)
    }

    @MainActor
    func testUnsavedStrategyRulesWarningPersistsThroughCollapseAndFailedSave() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist"), marketCount: 8), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: configuration)
        window.contentView = view; present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view, count: 8)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 6")

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            window.appearance = NSAppearance(named: appearance)
            try await wait(view, "window.matchMedia('(prefers-color-scheme: dark)').matches === \(appearance == .darkAqua)")
            try await wait(view, "document.querySelector('[data-filter-unsaved]') === null && document.querySelector('[data-filter-unsaved-badge]') === null")
            try await click(view, "Universe rules")
            try await setBasicRule(view, metric: "Close", comparison: "Greater than >", threshold: "0")
            try await wait(view, "document.querySelector('[data-filter-unsaved]')?.textContent.includes('Save Universe to update the strategy') && document.querySelector('[data-filter-unsaved-badge]')?.textContent.includes('Unsaved changes')")
            let accessible = try await js(view, "document.querySelector('[data-filter-unsaved]')?.getAttribute('role') === 'status' && document.querySelector('[data-filter-unsaved]')?.getAttribute('aria-live') === 'polite'") as? Bool
            XCTAssertEqual(accessible, true)
            try await assertSharedSurfaces(view, opacity: 0.3)
            try await click(view, "Universe rules")
            try await wait(view, "document.querySelector('[data-rule-layout]') === null && document.querySelector('[data-filter-unsaved] button')?.disabled === false")
            window.setContentSize(NSSize(width: 720, height: 900))
            try await wait(view, "window.innerWidth === 720")
            let fits = try await js(view, """
            (() => {
              const alert = document.querySelector('[data-filter-unsaved]').getBoundingClientRect();
              const description = document.querySelector('[data-filter-unsaved] [data-slot=alert-description]').getBoundingClientRect();
              const action = document.querySelector('[data-filter-unsaved] button').getBoundingClientRect();
              return document.documentElement.scrollWidth <= window.innerWidth + 1 && description.right < action.left && action.right <= alert.right && action.bottom <= alert.bottom;
            })()
            """) as? Bool
            XCTAssertEqual(fits, true, "The unsaved warning and save action must fit the scaled native layout.")
            window.setContentSize(NSSize(width: 1440, height: 900))
            try await wait(view, "window.innerWidth === 1440")

            let saved = bridge.savedUniverseJSON, revision = bridge.revision
            bridge.strategySaveDelay = 400_000_000
            bridge.strategySaveError = "Strategy save failed. Try again."
            try await click(view, "Save Universe")
            try await wait(view, "document.querySelector('[data-filter-unsaved]')?.getAttribute('aria-busy') === 'true' && document.querySelector('[data-filter-unsaved] button')?.disabled === true")
            try await wait(view, "Array.from(document.querySelectorAll('[role=alert]')).some(x => x.textContent.includes('Strategy save failed. Try again.')) && document.querySelector('[data-filter-unsaved] button')?.disabled === false")
            XCTAssertEqual(bridge.savedUniverseJSON, saved)
            XCTAssertEqual(bridge.revision, revision)
            bridge.strategySaveDelay = 0; bridge.strategySaveError = nil
            try await click(view, "Save Universe")
            try await wait(view, "document.querySelector('[data-filter-unsaved]') === null && document.querySelector('[data-filter-unsaved-badge]') === null && document.body.innerText.includes('Universe saved to the strategy.')")
            XCTAssertEqual(bridge.revision, revision + 1)
            try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 8")

            try await click(view, "Universe rules")
            try await input(view, "[aria-label=\"Threshold\"]", "")
            try await wait(view, "document.querySelector('[data-filter-unsaved]')?.textContent.includes('Fix the rule errors') && document.querySelector('[data-filter-unsaved] button')?.disabled === true")
            try await click(view, "Discard changes")
            try await wait(view, "document.querySelector('[data-filter-unsaved]') === null && document.querySelector('[data-filter-unsaved-badge]') === null && Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 8")
            try await click(view, "Universe rules")
        }
    }

    @MainActor
    func testNativeTypedRuleDraftRecoveryExplanationsAndLargeMarketResponsiveness() async throws {
        guard ProcessInfo.processInfo.environment["RADAR_UI_TESTS"] == "1" else { throw XCTSkip("Run npm run test:ui after building the Web renderer.") }
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bridge = try RuleUIBridge(root: project.appendingPathComponent("dist")), configuration = uiConfiguration()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "radar")
        configuration.setURLSchemeHandler(bridge, forURLScheme: "radar")
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: configuration)
        window.contentView = view; window.appearance = NSAppearance(named: .aqua); present(window)
        defer { view.stopLoading(); window.orderOut(nil); configuration.userContentController.removeScriptMessageHandler(forName: "radar", contentWorld: .page); bridge.cleanUp() }
        view.load(URLRequest(url: URL(string: "radar://app/index.html")!))
        try await showAllMarkets(view)
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 375")
        try await wait(view, "document.querySelector('[data-filter-summary] [data-slot=\"collapsible-trigger\"]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('[aria-label=\"Combination name\"]') === null && document.querySelector('[data-filter-rules]')?.textContent.includes('24h turnover')")
        try await click(view, "Universe rules")
        try await click(view, "Reset draft"); try await click(view, "Volume surge"); try await validDraft(view)
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500 && Array.from(document.querySelectorAll('button')).some(x => x.textContent.trim() === 'Save Universe' && !x.disabled)")
        try await wait(view, "document.querySelector('[data-filter-unsaved]') !== null")
        try await click(view, "Universe rules")
        try await wait(view, "document.querySelector('[data-filter-name]')?.textContent === 'Universe rules' && document.querySelector('[data-filter-count]')?.textContent === '1 condition' && document.querySelector('[data-filter-rules]')?.textContent.includes('2× Average Quote volume') && document.querySelector('[aria-label=\"Combination name\"]') === null")
        try await click(view, "Universe rules")
        try await wait(view, "document.querySelector('[aria-label=\"Baseline multiplier\"]')?.value === '2'")
        try await input(view, "[aria-label=\"Baseline multiplier\"]", "")
        try await wait(view, "document.body.innerText.includes('Last valid preview remains active')")
        try await wait(view, "document.querySelector('[data-filter-name]')?.textContent === 'Universe rules' && document.querySelector('[data-filter-rules]')?.textContent.includes('2× Average Quote volume')")
        let retained = try await js(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount)") as? Int
        XCTAssertEqual(retained, 500)
        let disabled = try await js(view, "Array.from(document.querySelectorAll('button')).filter(x => ['Save Universe'].includes(x.textContent.trim())).every(x => x.disabled)") as? Bool
        XCTAssertEqual(disabled, true)
        // Chart navigation and panel folding must preserve an incomplete typed value.
        _ = try await js(view, "document.querySelector('tbody tr[tabindex]').click(); true")
        try await wait(view, "document.body.innerText.includes('Fixture chart')")
        try await click(view, "Markets")
        try await wait(view, "document.querySelector('[aria-label=\"Baseline multiplier\"]')?.value === ''")
        try await click(view, "Universe rules"); try await click(view, "Universe rules")
        try await wait(view, "document.querySelector('[aria-label=\"Baseline multiplier\"]')?.value === ''")
        // A slow old draft response must not overwrite a later valid preview.
        bridge.cancelPreviousPreview = false
        bridge.holdNextPreview = true
        let previousRequests = bridge.previewRequests, previousResponses = bridge.previewResponses
        try await input(view, "[aria-label=\"Baseline multiplier\"]", "200")
        let requestDeadline = ContinuousClock.now + .seconds(2)
        while bridge.previewRequests == previousRequests && ContinuousClock.now < requestDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertGreaterThan(bridge.previewRequests, previousRequests)
        try await input(view, "[aria-label=\"Baseline multiplier\"]", "2")
        try await wait(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount) === 500 && !document.body.innerText.includes('Compiling…')")
        let responseDeadline = ContinuousClock.now + .seconds(2)
        while (bridge.heldPreviewReply == nil || bridge.previewResponses < previousResponses + 1) && ContinuousClock.now < responseDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertGreaterThanOrEqual(bridge.previewResponses, previousResponses + 1)
        let obsoleteReply = try XCTUnwrap(bridge.heldPreviewReply)
        bridge.heldPreviewReply = nil
        obsoleteReply()
        XCTAssertGreaterThanOrEqual(bridge.previewResponses, previousResponses + 2, "Deliver the obsolete reply only after the new preview has rendered.")
        try await settleRendering(view)
        let count = try await js(view, "Number(document.querySelector('[data-strategy-match-count]')?.dataset.strategyMatchCount)") as? Int
        XCTAssertEqual(count, 500)
        bridge.cancelPreviousPreview = true
        try await click(view, "Save Universe")
        try await wait(view, "document.body.innerText.includes('Universe saved to the strategy')")
        try await wait(view, "document.querySelector('[data-filter-name]')?.textContent === 'Universe rules' && document.querySelector('[data-filter-rules]')?.textContent.includes('2× Average Quote volume')")
        try await click(view, "Reset draft"); try await click(view, "Add condition"); _ = try await metric(view, "spread")
        _ = try await js(view, "Array.from(document.querySelector('[data-rule-kind=\"condition\"] [aria-label=\"Evaluation hour\"]').querySelectorAll('button')).find(x => x.textContent.trim() === 'Closed').click(); true")
        try await input(view, "[aria-label=\"Threshold\"]", "0"); try await validDraft(view)
        try await wait(view, "document.body.innerText.includes('500 Unknown')")
        try await click(view, "Explain markets")
        try await wait(view, "document.querySelector('[aria-label=\"Rule decision details\"]')?.innerText.includes('Spread has no quote snapshot')")
        try await click(view, "Done")
        try await wait(view, "document.querySelector('[role=\"dialog\"]') === null")
        try await setBasicRule(view, metric: "Close", comparison: "Greater than >", threshold: "0")
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 500")
        // The real scaling container must retain its design layout at narrow native widths.
        window.setContentSize(NSSize(width: 720, height: 900))
        window.appearance = NSAppearance(named: .darkAqua)
        try await settleRendering(view)
        let overflow = try await js(view, "document.documentElement.scrollWidth > window.innerWidth + 1") as? Bool
        XCTAssertEqual(overflow, false)
        let start = Date()
        try await input(view, "[aria-label=\"Search contracts\"]", "MKT499")
        try await wait(view, "Number(document.querySelector('table[data-market-count]')?.dataset.marketCount) === 1", seconds: 2)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1, "Typing search must remain responsive with 500 contracts.")
    }
}
