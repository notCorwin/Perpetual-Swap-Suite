// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PerpetualRadar",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.20")],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .systemLibrary(name: "CZlib"),
        .executableTarget(name: "PerpetualRadar", dependencies: ["CSQLite", "CZlib", "ZIPFoundation"]),
        // Exercise optimized shipping code without optimizing the assertion
        // harness and its large embedded WebKit scripts on every test edit.
        .testTarget(name: "PerpetualRadarTests", dependencies: ["PerpetualRadar"],
                    swiftSettings: [.unsafeFlags(["-Onone", "-Xfrontend", "-warn-long-expression-type-checking=1000"], .when(configuration: .release))]),
    ]
)
