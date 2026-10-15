import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKURLSchemeHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var webRoot: URL?
    private var backend: WorkspaceBackend?
    private var startupError: Error?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { backend = try WorkspaceBackend() } catch { startupError = error }
        configureMenus()
        configureWindow()
        loadInterface()
        if let backend { Task { await backend.start() } }
    }

    private func configureMenus() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let app = NSMenu(title: "Perpetual Swap Suite")
        app.addItem(withTitle: "About Perpetual Swap Suite", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Perpetual Swap Suite", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Perpetual Swap Suite", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        main.addItem(appItem)
        let windowItem = NSMenuItem()
        let windows = NSMenu(title: "Window")
        windows.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windows
        main.addItem(windowItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "suite")
        configuration.setURLSchemeHandler(self, forURLScheme: "suite")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Perpetual Swap Suite"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 450)
        window.contentView = WindowMaterialView(content: webView)
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func loadInterface() {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Web/index.html")
        let development = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("dist/index.html")
        if let bundled, FileManager.default.fileExists(atPath: bundled.path) {
            webRoot = bundled.deletingLastPathComponent()
        } else if FileManager.default.fileExists(atPath: development.path) {
            webRoot = development.deletingLastPathComponent()
        }
        if webRoot != nil { webView.load(URLRequest(url: URL(string: "suite://app/index.html")!)) }
        else { webView.loadHTMLString("<main style='font:13px system-ui;padding:40px'>Run <code>npm run build</code> to create the interface.</main>", baseURL: nil) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        return false
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let request = message.body as? [String: Any] else { replyHandler(nil, BridgeError.invalidRequest.localizedDescription); return }
        guard let backend else { replyHandler(nil, startupError?.localizedDescription ?? "Native backend is unavailable."); return }
        Task {
            do {
                let data = try await backend.handle(request)
                replyHandler(try JSONSerialization.jsonObject(with: data), nil)
            }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let root = webRoot, let url = urlSchemeTask.request.url else { urlSchemeTask.didFailWithError(BridgeError.invalidRequest); return }
        let component = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(component).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime: String
        switch file.pathExtension.lowercased() {
        case "html": mime = "text/html"
        case "js": mime = "text/javascript"
        case "css": mime = "text/css"
        case "svg": mime = "image/svg+xml"
        case "png": mime = "image/png"
        default: mime = "application/octet-stream"
        }
        let response = URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
