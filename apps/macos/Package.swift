// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Eagle",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "Eagle", targets: ["EagleApp"]),
    .executable(name: "EagleDeviceHelper", targets: ["EagleDeviceHelper"]),
    // Tokens and primitives, dependent on nothing (docs/bots/ARCHITECTURE.md).
    .library(name: "EagleDesign", targets: ["EagleDesign"]),
    // The CLI the App installs as `eagle` / `eagle-dev` (docs/bots/CLI.md). The product
    // keeps its own name: a bundle copy is what carries the installed name, and macOS
    // filenames are case-insensitive, so `eagle` would collide with the `Eagle` app.
    .executable(name: "eagle-cli", targets: ["EagleCLI"]),
  ],
  dependencies: [
    .package(path: "../bots-macos")
  ],
  targets: [
    .target(name: "EagleDesign", resources: [.process("Resources")]),
    .target(name: "EagleDevices"),
    .executableTarget(name: "EagleDeviceHelper", dependencies: ["EagleDevices"]),
    // Bots lives in the shell: its view model and publisher are part of EagleFeatures,
    // and its logic is the separate Bots package (docs/bots/PLAN.md, stage 5).
    .target(
      name: "EagleFeatures",
      dependencies: [
        "EagleDesign",
        "EagleDevices",
        .product(name: "BotsCore", package: "bots-macos"),
        .product(name: "BotsTransport", package: "bots-macos"),
        .product(name: "BotsFeatures", package: "bots-macos"),
      ]
    ),
    .executableTarget(
      name: "EagleApp",
      dependencies: ["EagleDesign", "EagleDevices", "EagleFeatures"]
    ),
    .executableTarget(
      name: "SnapshotRenderer",
      dependencies: [
        "EagleDesign",
        "EagleFeatures",
        .product(name: "BotsTransport", package: "bots-macos"),
      ]
    ),
    .executableTarget(
      name: "ComposerFocusFixture",
      dependencies: ["EagleDesign"]
    ),
    .target(name: "EagleCLIKit"),
    .executableTarget(name: "EagleCLI", dependencies: ["EagleCLIKit"]),
    .testTarget(name: "EagleDesignTests", dependencies: ["EagleDesign"]),
    .testTarget(name: "EagleCLITests", dependencies: ["EagleCLIKit"]),
    .testTarget(name: "EagleFeaturesTests", dependencies: ["EagleFeatures"]),
    .testTarget(name: "EagleDevicesTests", dependencies: ["EagleDevices"]),
  ]
)
