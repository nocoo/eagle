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
    guard let (labelSlot, initialLabel) = labelSlotAndText(button) else {
      print("CLI_COPY_DIAG no_label_slot \(describeCopySkill(node: button))")
      Issue.record("cli.copy.skill: no AXTitle/AXDescription/AXValue")
      return
    }
    print(
      "CLI_COPY_DIAG label_slot=\(labelSlot.rawValue) initial=\(initialLabel) "
        + "all=\(describeCopySkill(node: button))")
    #expect(initialLabel == "复制命令", "button starts with 复制命令 on primary AX field")

    let press = NSSelectorFromString("accessibilityPerformPress")
    try #require(button.responds(to: press))
    button.perform(press)
    try await Task.sleep(for: .milliseconds(200))

    #expect(
      NSPasteboard.general.string(forType: .string) == "eagle-dev --skill",
      "the click copied the command")
    let afterPress = try #require(
      entries(host).first { identifier($0) == "cli.copy.skill" })
    #expect(
      labelText(afterPress, slot: labelSlot) == "已复制",
      "same AX field as initial shows 已复制 after press; "
        + "\(describeCopySkill(node: afterPress))")
    try await waitForLabelReset(host: host, slot: labelSlot)
  }

  private func waitForLabelReset(host: NSView, slot: LabelAttribute) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(6))
    var iteration = 0
    while true {
      iteration += 1
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      if let node = entries(host).first(where: { identifier($0) == "cli.copy.skill" }),
        labelText(node, slot: slot) == "复制命令"
      {
        print(
          "CLI_COPY_DIAG reset_ok iteration=\(iteration) slot=\(slot.rawValue) "
            + "all=\(describeCopySkill(node: node))")
        return
      }
      guard ContinuousClock.now < deadline else {
        let tail =
          entries(host).first(where: { identifier($0) == "cli.copy.skill" }).map {
            describeCopySkill(node: $0)
          } ?? "missing cli.copy.skill"
        print(
          "CLI_COPY_DIAG timeout iteration=\(iteration) slot=\(slot.rawValue) copy_skill=\(tail)"
        )
        throw NSError(domain: "CLISettingsLayoutTests", code: 1)
      }
      // Yield; do not call RunLoop.run from async (Swift 6 blocks that). Layout + sleep lets
      // MainActor run the 2s reset Task from `CLISettingsView.copy`.
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  private enum LabelAttribute: String {
    case axTitle = "AXTitle"
    case axDescription = "AXDescription"
    case axValue = "AXValue"
  }

  /// First non-empty among Title → Description → Value.
  /// AppKit maps `Text` labels to these fields inconsistently.
  private func labelSlotAndText(_ node: NSObject) -> (LabelAttribute, String)? {
    for slot in [LabelAttribute.axTitle, .axDescription, .axValue] {
      if let s = labelText(node, slot: slot), !s.isEmpty { return (slot, s) }
    }
    return nil
  }

  private func labelText(_ node: NSObject, slot: LabelAttribute) -> String? {
    attribute(node, slot.rawValue) as? String
  }

  private func describeCopySkill(node: NSObject) -> String {
    let t = labelText(node, slot: .axTitle).map { "AXTitle=\($0)" } ?? "AXTitle=nil"
    let dPart = labelText(node, slot: .axDescription).map { "AXDescription=\($0)" }
    let d = dPart ?? "AXDescription=nil"
    let vPart = labelText(node, slot: .axValue).map { "AXValue=\($0)" }
    let v = vPart ?? "AXValue=nil"
    return "\(t) \(d) \(v)"
  }

  private func identifier(_ node: NSObject) -> String? {
    attribute(node, "AXIdentifier") as? String
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
