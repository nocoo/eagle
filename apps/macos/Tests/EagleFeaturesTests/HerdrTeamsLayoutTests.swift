import AppKit
import SwiftUI
import Testing

@testable import EagleFeatures

@Suite("Herdr inspector layout", .serialized)
@MainActor
struct HerdrTeamsLayoutTests {
  @Test(
    "Herdr belongs to the local Mac and expands even when the device service is unavailable",
    arguments: ["unavailable", "ready", "disabled"])
  func localTeamsWithoutDeviceService(mode: String) async throws {
    let (devices, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.directory = managedDeviceDirectory()
    if mode == "unavailable" { control.startError = NSError(domain: "fixture", code: 1) }
    if mode == "disabled" { await devices.setEnabled(false) }
    if mode == "ready" { await devices.startIfNeeded() }
    let metadata = try MetadataLogFixture()
    defer { metadata.remove() }
    try metadata.write(metadata.header + metadata.turn + metadata.window)
    let snapshot = try await LocalHerdrClient(
      metadata: CodexSessionMetadataReader(root: metadata.root)
    ) { arguments in
      Data(
        (arguments == ["session", "list", "--json"] ? herdrSessionFixture : herdrSnapshotFixture)
          .utf8)
    }.read()
    var reads = 0
    // Rendering speed must not consume the failure reserved for the refresh action.
    let clock = HerdrObservationClock()
    let herdr = HerdrTeamsViewModel(
      read: {
        reads += 1
        if reads > 1 { throw HerdrReadError.unavailable }
        return snapshot
      }, observationWait: { try await clock.wait() })
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(
      rootView: DeviceInspectorView(model: devices, herdr: herdr, onManage: {}))
    host.frame = NSRect(x: 0, y: 0, width: 248, height: 900)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 248, height: 900),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(100))
    host.layoutSubtreeIfNeeded()
    #expect(devices.localReady == (mode == "ready"))
    let collapsed = entries(host).compactMap(label)
    if mode != "ready" {
      let message = mode == "disabled" ? "设备服务已停用" : "还没有读到设备目录"
      #expect(collapsed.contains { $0.contains(message) })
      #expect(!collapsed.contains { $0.contains("1 台 · 0 在线") })
    }
    #expect(!collapsed.contains { $0.contains("service") })
    #expect(collapsed.contains { $0.contains("4 个团队") })
    #expect(collapsed.contains { $0.contains("2 个团队运行中") })
    let disclosure = try #require(
      entries(host).first {
        attribute($0, "accessibilityIdentifier") as? String == "herdr.disclosure"
      })
    #expect(!herdr.isExpanded)
    let localID = devices.directory?.localDeviceId ?? "local-placeholder"
    let localGroup = try #require(
      entries(host).first {
        attribute($0, "accessibilityIdentifier") as? String == "devices.inspector.\(localID)"
      })
    #expect(
      entries(localGroup).contains {
        attribute($0, "accessibilityIdentifier") as? String == "herdr.disclosure"
      })
    for device in devices.directory?.devices ?? [] where device.deviceId != localID {
      let remoteGroup = try #require(
        entries(host).first {
          attribute($0, "accessibilityIdentifier") as? String
            == "devices.inspector.\(device.deviceId)"
        })
      #expect(
        !entries(remoteGroup).contains {
          attribute($0, "accessibilityIdentifier") as? String == "herdr.disclosure"
        })
    }
    let press = NSSelectorFromString("accessibilityPerformPress")
    try #require(disclosure.responds(to: press))
    disclosure.perform(press)
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()
    #expect(herdr.isExpanded)
    #expect(!entries(host).compactMap(label).contains { $0.contains("service") })
    let teamDisclosure = try #require(
      entries(host).first {
        attribute($0, "accessibilityIdentifier") as? String == "herdr.team.default:w1"
      })
    try #require(teamDisclosure.responds(to: press))
    teamDisclosure.perform(press)
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()
    let labels = entries(host).compactMap(label)
    #expect(labels.contains { $0.contains("Herdr") })
    #expect(labels.contains { $0.contains("service") && $0.contains("运行中") })
    #expect(!labels.contains { $0.contains("/work/current") })
    #expect(labels.contains { $0.contains("codex · gpt-6-astra · max · 257.4K") })
    #expect(labels.contains { $0.contains("Shells") })
    #expect(labels.contains { $0.contains("0 成员") })
    #expect(labels.contains { $0.contains("review") && $0.contains("已响应") })
    #expect(!labels.contains { $0.contains("已完成") })

    let refresh = try #require(entries(host).first { label($0) == "刷新本机 Herdr 团队" })
    let before = reads
    try #require(refresh.responds(to: press))
    refresh.perform(press)
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()
    #expect(reads == before + 1)
    let staleLabels = entries(host).compactMap(label)
    #expect(staleLabels.contains { $0.contains("service") && $0.contains("未确认") })
    #expect(!staleLabels.contains { $0.contains("运行中") })
    disclosure.perform(press)
    try await Task.sleep(for: .milliseconds(50))
    #expect(!entries(host).compactMap(label).contains { $0.contains("service") })
  }

  @Test("large rosters start with five active-first teams and individually collapsed members")
  func limitedTeams() async throws {
    let teams = (0..<8).map { index in
      HerdrTeam(
        session: "default", workspaceID: "w\(index)", name: "Team \(index)",
        members: (0..<(index == 6 ? 2 : 1)).map { member in
          HerdrTeamMember(
            id: "p\(member)", name: "Agent \(index)-\(member)", kind: "codex",
            status: index >= 6 ? .working : .idle)
        })
    }
    let model = HerdrTeamsViewModel {
      HerdrTeamsSnapshot(teams: teams, sessionCount: 1)
    }
    await model.refresh()
    model.isExpanded = true
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: HerdrTeamsView(model: model))
    host.frame = NSRect(x: 0, y: 0, width: 248, height: 900)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 248, height: 900),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(100))
    host.layoutSubtreeIfNeeded()
    func teamIDs() -> [String] {
      entries(host).compactMap { attribute($0, "accessibilityIdentifier") as? String }
        .filter { $0.hasPrefix("herdr.team.") }
    }
    func press(_ id: String) async throws {
      let node = try #require(
        entries(host).first {
          attribute($0, "accessibilityIdentifier") as? String == id
        })
      let action = NSSelectorFromString("accessibilityPerformPress")
      try #require(node.responds(to: action))
      node.perform(action)
      try await Task.sleep(for: .milliseconds(50))
      host.layoutSubtreeIfNeeded()
    }
    #expect(Set(teamIDs()).count == 5)
    #expect(teamIDs().first == "herdr.team.default:w6")
    #expect(!entries(host).compactMap(label).contains { $0.contains("Agent") })
    #expect(entries(host).compactMap(label).contains { $0.contains("查看更多团队") })
    try await press("herdr.more-teams")
    #expect(Set(teamIDs()).count == 8)
    #expect(!entries(host).compactMap(label).contains { $0.contains("Agent") })
    try await press("herdr.team.default:w6")
    #expect(entries(host).compactMap(label).contains { $0.contains("Agent 6-") })
    #expect(!entries(host).compactMap(label).contains { $0.contains("Agent 7-") })
    await model.refresh()
    host.layoutSubtreeIfNeeded()
    #expect(entries(host).compactMap(label).contains { $0.contains("Agent 6-") })
    try await press("herdr.more-teams")
    #expect(Set(teamIDs()).count == 5)
    try await press("herdr.team.default:w6")
    #expect(!entries(host).compactMap(label).contains { $0.contains("Agent") })
  }

  private func label(_ node: NSObject) -> String? {
    for name in ["accessibilityLabel", "accessibilityTitle", "accessibilityValue"] {
      if let value = attribute(node, name) as? String, !value.isEmpty { return value }
    }
    return nil
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(name)
    if node.responds(to: selector) { return node.perform(selector)?.takeUnretainedValue() }
    let legacy = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: legacy) else { return nil }
    let attribute =
      [
        "accessibilityLabel": "AXDescription", "accessibilityTitle": "AXTitle",
        "accessibilityValue": "AXValue", "accessibilityChildren": "AXChildren",
        "accessibilityIdentifier": "AXIdentifier",
      ][name] ?? name
    return node.perform(legacy, with: attribute)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element]
      + ((attribute(element, "accessibilityChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
