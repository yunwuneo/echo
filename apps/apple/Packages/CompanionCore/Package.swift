// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CompanionCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "CompanionCore", targets: ["CompanionCore"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-http-types", exact: "1.8.0"),
        .package(url: "https://github.com/apple/swift-openapi-generator.git", exact: "1.14.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime.git", exact: "1.13.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession.git", exact: "1.3.2"),
    ],
    targets: [
        .target(
            name: "CompanionCore",
            dependencies: [
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .testTarget(name: "CompanionCoreTests", dependencies: ["CompanionCore"]),
    ]
)
