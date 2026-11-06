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
    // `SettingsActionButton` is plain `Button { Text(title) }`: AX can surface the label on
    // AXTitle, AXDescription, or the button value. Poll MainActor + RunLoop until any field reads
    // 「复制命令」, with dumps on timeout (no longer timeout cap increase).
    try await waitForCopyCommandLabel(host: host)
  }

  private func waitForCopyCommandLabel(host: NSView) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(6))
    var iteration = 0
    while true {
      iteration += 1
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      if let node = entries(host).first(where: { identifier($0) == "cli.copy.skill" }),
        labelShowsCopyCommand(node)
      {
        return
      }
      guard ContinuousClock.now < deadline else {
        print(
          "CLI_COPY_DIAG timeout iteration=\(iteration) copy_skill=\(describeCopySkill(host: host))"
        )
        throw NSError(domain: "CLISettingsLayoutTests", code: 1)
      }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  /// True when any common AX field matches the visible button title after reset.
  private func labelShowsCopyCommand(_ node: NSObject) -> Bool {
    let candidates = [
      title(node),
      attribute(node, "AXDescription") as? String,
      attribute(node, "AXValue") as? String,
    ].compactMap { $0 }
    return candidates.contains { $0 == "复制命令" || $0.contains("复制命令") }
  }

  private func describeCopySkill(host: NSView) -> String {
    guard let node = entries(host).first(where: { identifier($0) == "cli.copy.skill" }) else {
      return "missing cli.copy.skill"
    }
    let t = title(node).map { "AXTitle=\($0)" } ?? "AXTitle=nil"
    let d = (attribute(node, "AXDescription") as? String).map { "AXDescription=\($0)" } ?? "AXDescription=nil"
    let v = (attribute(node, "AXValue") as? String).map { "AXValue=\($0)" } ?? "AXValue=nil"
    return "\(t) \(d) \(v)"
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
