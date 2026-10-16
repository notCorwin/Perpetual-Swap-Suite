import AppKit
import Darwin

@MainActor
enum WindowServerBlur {
    static func validRadius(_ value: Double) -> Bool {
        value.isFinite && (0...160).contains(value)
    }

    private typealias Connection = @convention(c) () -> UnsafeMutableRawPointer?
    private typealias SetRadius = @convention(c) (UnsafeMutableRawPointer?, UInt, Int32) -> Int32
    private struct Functions {
        let handle: UnsafeMutableRawPointer
        let connection: Connection
        let setRadius: SetRadius
    }

    // These are the same entry points used by Ghostty. Resolve them at runtime so
    // AppKit can still provide blur if a future macOS version changes the symbols.
    private static let functions: Functions? = {
        guard let handle = dlopen(nil, RTLD_LAZY) else { return nil }
        guard let connection = dlsym(handle, "CGSDefaultConnectionForThread"),
              let setRadius = dlsym(handle, "CGSSetWindowBackgroundBlurRadius") else {
            dlclose(handle)
            return nil
        }
        return Functions(handle: handle,
                         connection: unsafeBitCast(connection, to: Connection.self),
                         setRadius: unsafeBitCast(setRadius, to: SetRadius.self))
    }()

    static func apply(radius: Int32, to window: NSWindow) -> Bool {
        guard window.isVisible, window.windowNumber > 0, let functions,
              let connection = functions.connection() else { return false }
        return functions.setRadius(connection, UInt(window.windowNumber), radius) == 0
    }
}
