// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Superagent",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "SuperagentCore", targets: ["SuperagentCore"]),
    .library(name: "SuperagentTransport", targets: ["SuperagentTransport"]),
    .library(name: "SuperagentFeatures", targets: ["SuperagentFeatures"]),
  ],
  targets: [
    .target(name: "SuperagentCore"),
    .target(name: "SuperagentTransport", dependencies: ["SuperagentCore"]),
    .target(name: "SuperagentFeatures", dependencies: ["SuperagentCore"]),
    .testTarget(name: "SuperagentTests", dependencies: ["SuperagentCore", "SuperagentTransport", "SuperagentFeatures"]),
  ],
  swiftLanguageModes: [.v5]
)
