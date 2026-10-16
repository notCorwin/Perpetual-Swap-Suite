import AppKit

/// A real native rendering surface that cannot be moved onto a user's display.
/// Used only by tests and packaged applications with an isolated test channel.
@MainActor
class BackgroundTestWindow: NSWindow {
    private static func offscreen(_ frame: NSRect) -> NSRect {
        var result = frame
        result.origin = NSPoint(x: (NSScreen.screens.map { $0.frame.maxX }.max() ?? 0) + 4096, y: 0)
        return result
    }

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        NSApplication.shared.setActivationPolicy(.accessory)
        super.init(contentRect: Self.offscreen(contentRect), styleMask: style, backing: backingStoreType, defer: flag)
        isReleasedWhenClosed = false
        isRestorable = false
        isExcludedFromWindowsMenu = true
        isMovable = false
        animationBehavior = .none
        collectionBehavior = [.transient, .ignoresCycle, .fullScreenNone]
        NotificationCenter.default.addObserver(self, selector: #selector(displaysChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    // AppKit otherwise clamps titled windows back onto a display when they
    // are ordered or resized. Moving them offscreen once is not sufficient.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        Self.offscreen(frameRect)
    }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        super.setFrame(Self.offscreen(frameRect), display: flag)
    }

    override func setFrame(_ frameRect: NSRect, display displayFlag: Bool, animate animateFlag: Bool) {
        super.setFrame(Self.offscreen(frameRect), display: displayFlag, animate: false)
    }

    override func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int) {
        if place != .out {
            super.setFrame(Self.offscreen(frame), display: false)
            level = .normal
        }
        super.order(place == .out ? .out : .below, relativeTo: 0)
    }

    override func orderFrontRegardless() { orderBack(nil) }

    @objc private func displaysChanged() { setFrame(frame, display: false) }

    // Keep WebKit's compositor, requestAnimationFrame and CSS animations
    // running on the real surface even though WindowServer occludes it.
    override var occlusionState: NSWindow.OcclusionState { super.occlusionState.union(.visible) }
}
