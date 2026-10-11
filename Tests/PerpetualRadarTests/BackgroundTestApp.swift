import Foundation

/// LaunchServices reads the bundle before Swift's entry point runs. Setting
/// activationPolicy in main is too late to prevent a transient Dock icon.
func backgroundTestApp(from source: URL, in directory: URL, bundleIdentifier: String? = nil) throws -> URL {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let app = directory.appendingPathComponent(source.lastPathComponent)
    try FileManager.default.copyItem(at: source, to: app)
    let plistURL = app.appendingPathComponent("Contents/Info.plist")
    guard var plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: plistURL), options: [], format: nil) as? [String: Any] else {
        throw CocoaError(.fileReadCorruptFile)
    }
    plist["LSUIElement"] = true
    if let bundleIdentifier { plist["CFBundleIdentifier"] = bundleIdentifier }
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: plistURL)
    let signer = Process()
    signer.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    signer.arguments = ["--force", "--sign", "-", app.path]
    signer.standardOutput = FileHandle.nullDevice
    signer.standardError = FileHandle.nullDevice
    try signer.run()
    signer.waitUntilExit()
    guard signer.terminationStatus == 0 else { throw CocoaError(.executableLoad) }
    return app
}
