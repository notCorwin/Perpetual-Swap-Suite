import AppKit

@MainActor
final class WindowBackgroundView: NSView {
    private let effectView = NSVisualEffectView()
    private let tintView = WindowTintView()
    private let content: NSView
    private var contentConstraints: [NSLayoutConstraint] = []
    private var tintColor: NSColor?
    private var tintOpacity: CGFloat = 1

    init(contentView: NSView) {
        content = contentView
        super.init(frame: .zero)
        effectView.material = .underWindowBackground
        effectView.blendingMode = .behindWindow
        effectView.state = .active
        effectView.isHidden = true
        tintView.wantsLayer = true
        for view in [effectView, tintView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: leadingAnchor),
                view.trailingAnchor.constraint(equalTo: trailingAnchor),
                view.topAnchor.constraint(equalTo: topAnchor),
                view.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        constrainContent()
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        constrainContent()
    }

    private func constrainContent() {
        NSLayoutConstraint.deactivate(contentConstraints)
        if let guide = window?.contentLayoutGuide as? NSLayoutGuide {
            // The glass extends behind the native titlebar; WebKit stays in the
            // normal content area, including when AppKit changes it in fullscreen.
            contentConstraints = [
                content.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
                content.topAnchor.constraint(equalTo: guide.topAnchor),
                content.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            ]
        } else {
            contentConstraints = [
                content.leadingAnchor.constraint(equalTo: leadingAnchor),
                content.trailingAnchor.constraint(equalTo: trailingAnchor),
                content.topAnchor.constraint(equalTo: topAnchor),
                content.bottomAnchor.constraint(equalTo: bottomAnchor),
            ]
        }
        NSLayoutConstraint.activate(contentConstraints)
    }

    @discardableResult
    func setTint(rgb: [Double]) -> Bool {
        guard rgb.count == 3, rgb.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { return false }
        // WebKit resolves the shared design token into sRGB; no second native
        // palette or titlebar-specific color is maintained here.
        tintColor = NSColor(srgbRed: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
        updateTint()
        return true
    }

    private func updateTint() {
        tintView.layer?.backgroundColor = (tintColor?.withAlphaComponent(tintOpacity) ?? .clear).cgColor
    }

    @discardableResult
    func apply(enabled: Bool, opacity: Double, blurRadius: Double = 64, to window: NSWindow) -> Bool {
        guard WindowServerBlur.validRadius(blurRadius) else { return false }
        let transparent = enabled && opacity < 1
        window.isOpaque = !transparent
        // Like Ghostty, retain a minimal window fill for correct native compositing.
        // One native tint layer covers the titlebar and the clear WebKit content.
        window.backgroundColor = transparent ? .white.withAlphaComponent(0.001) : .windowBackgroundColor
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        tintOpacity = enabled ? CGFloat(opacity) : 1
        updateTint()
        let nativeBlur = WindowServerBlur.apply(radius: transparent ? Int32(blurRadius.rounded()) : 0, to: window)
        // Standard AppKit materials add their own tint, so reserve them for fallback.
        effectView.isHidden = !transparent || blurRadius == 0 || nativeBlur
        window.invalidateShadow()
        return nativeBlur
    }
}

private final class WindowTintView: NSView {
    // Leave native titlebar hit testing, dragging, and window buttons to AppKit.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
