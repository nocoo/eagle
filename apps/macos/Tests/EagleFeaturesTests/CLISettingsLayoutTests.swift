import AppKit
import SwiftUI
import Testing

@testable import EagleFeatures

@Suite("CLI settings layout", .serialized)
@MainActor
struct CLISettingsLayoutTests {
  @Test("the copy button answers the click with 已复制 and copies the command")
  func copyFeedback() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-cli-layout-\(UUID().uuidString)", isDirectory: true)
    let home = base.appendingPathComponent("home", isDirectory: true)
    let root = base.appendingPathComponent("bots", isDirectory: true)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data(String(repeating: "t", count: 48).utf8).write(to: root.appendingPathComponent("token"))

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CLITransport.self]
    CLITransport.calls = []
    CLITransport.clients = []
    CLITransport.issueCount = 0
    let model = CLISettingsViewModel(
      appVersion: AppVersion(short: "1.2.3", build: "1", isRelease: false),
      botsSettings: BotsSettings(rootPath: root.path, port: "43117"),
      session: URLSession(configuration: configuration),
      home: home,
      binaryURL: nil,
      environment: ["PATH": "/usr/bin:/bin"])

    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: CLISettingsView(model: model))
    host.frame = NSRect(x: 0, y: 0, width: 900, height: 900)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 900),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(80))

    let button = try #require(
      entries(host).first { identifier($0) == "cli.copy.skill" })
    #expect(title(button)?.contains("复制") == true)

    let press = NSSelectorFromString("accessibilityPerformPress")
    try #require(button.responds(to: press))
    button.perform(press)
    try await Task.sleep(for: .milliseconds(200))

    #expect(
      NSPasteboard.general.string(forType: .string) == "eagle-dev --skill",
      "the click copied the command")
    #expect(
      entries(host).compactMap(title).filter { $0 == "已复制" }.count == 1,
      "the pressed button says the copy happened")
    try await Task.sleep(for: .milliseconds(2200))
    #expect(
      entries(host).compactMap(title).contains("复制命令"),
      "and the label comes back so it can be pressed again")
  }

  private func identifier(_ node: NSObject) -> String? {
    attribute(node, "AXIdentifier") as? String
  }

  private func title(_ node: NSObject) -> String? {
    for name in ["AXTitle", "AXDescription", "AXValue"] {
      if let value = attribute(node, name) as? String, !value.isEmpty { return value }
    }
    return nil
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXIdentifier": "accessibilityIdentifier", "AXChildren": "accessibilityChildren",
      ][name] ?? "")
    guard selector != NSSelectorFromString(""), node.responds(to: selector) else { return nil }
    return node.perform(selector)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
