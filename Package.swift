// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "PerpetualSwapSuite",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "PerpetualSwapSuite", targets: ["PerpetualSwapSuite"]),
    ],
    dependencies: [
        .package(url: "https://github.com/duckdb/duckdb-swift.git", exact: "1.1.3"),
    ],
    targets: [
        .executableTarget(
            name: "PerpetualSwapSuite",
            dependencies: [.product(name: "DuckDB", package: "duckdb-swift")]
        ),
        .testTarget(
            name: "PerpetualSwapSuiteTests",
            dependencies: ["PerpetualSwapSuite"]
        ),
    ]
)
