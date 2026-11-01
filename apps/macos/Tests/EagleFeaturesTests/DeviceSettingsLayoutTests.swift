import AppKit
import EagleDevices
import SwiftUI
import Testing

@testable import EagleFeatures

@Suite("Device settings layout", .serialized)
@MainActor
struct DeviceSettingsLayoutTests {
  @Test("the local machine remains listed before its service starts", arguments: [true, false])
  func unavailableLocalDevice(disabled: Bool) async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set(disabled, forKey: DeviceSettingsViewModel.disabledKey)
    control.startError = DevicePortError("background_approval_required")
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    #expect(titles.contains { $0.contains(name) && $0.contains("本机") })
    #expect(titles.contains { $0.contains("本机未就绪") })
    #expect(model.enabled)
    #expect(!model.localReady)
  }

  @Test("a known local machine stays visible with its disabled service state")
  func disabledKnownLocalDevice() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let name = try #require(model.directory?.devices.first?.name)
    await model.setEnabled(false)
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    #expect(titles.contains { $0.contains(name) })
    #expect(titles.contains { $0.contains("本机未就绪") })
  }

  @Test("adding a device is immediately available without a manual service switch")
  func pairingStartsExpanded() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    #expect(!titles.contains("启用设备服务"))
    #expect(!titles.contains("关闭窗口后服务仍在后台运行。"))
    #expect(titles.contains("添加设备"))
    #expect(titles.contains("生成本机配对码"))
    #expect(titles.contains("另一台设备的配对码"))
  }

  @Test("an unresolved pairing stays visible without expanding the pairing section")
  func pendingPairingStaysVisible() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set(UUID().uuidString.lowercased(), forKey: DeviceSettingsViewModel.pendingRedeemKey)
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    await model.startIfNeeded()
    #expect(model.pendingRedeemRequestId != nil)
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()

    let titles = entries(host).compactMap(title)
    #expect(titles.contains("查询配对结果"))
    #expect(titles.contains("用原请求重试"))
  }

  @Test("unfinished pairing input survives device status updates")
  func pairingInputSurvivesRefresh() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()
    #expect(entries(host).compactMap(title).contains("另一台设备的配对码"))
    let input = try #require(entries(host).first { title($0) == "另一台设备的配对码" })
    let setter = NSSelectorFromString("setAccessibilityValue:")
    try #require(input.responds(to: setter))
    input.perform(setter, with: "unfinished-pairing-input")
    let textField = try #require((input as? NSCell)?.controlView as? NSTextField)
    textField.delegate?.controlTextDidChange?(
      Notification(name: NSControl.textDidChangeNotification, object: textField))
    control.directory = deviceDirectory(observation: "visible-change", online: true)
    await model.refresh()
    try await Task.sleep(for: .milliseconds(20))
    let refreshed = try #require(entries(host).first { title($0) == "另一台设备的配对码" })
    #expect(attribute(refreshed, "AXValue") as? String == "unfinished-pairing-input")
  }

  @Test("each device exposes policy and removal beside its inline details link")
  func deviceControls() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.directory = managedDeviceDirectory()
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    let titles = entries(host).compactMap(title)
    let policies = Set(
      entries(host).compactMap { attribute($0, "AXIdentifier") as? String }
        .filter { $0.hasPrefix("devices.policy.") })
    #expect(
      policies == [
        "devices.policy.\(deviceSettingsLocalID)",
        "devices.policy.22222222-2222-4222-8222-222222222222",
      ])
    #expect(titles.filter { $0 == "移除" }.count == 2)
    #expect(!titles.contains("退出群"))
    #expect(!titles.contains("移出"))
    let details = try #require(entries(host).first { title($0) == "详情" })
    let press = NSSelectorFromString("accessibilityPerformPress")
    try #require(details.responds(to: press))
    details.perform(press)
    try await Task.sleep(for: .milliseconds(20))
    #expect(entries(host).compactMap(title).contains(deviceSettingsLocalID))
  }

  @Test("the device service has one switch, and it is the only way the person stops it")
  func serviceSwitch() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    #expect(model.enabled)
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))

    let toggle = try #require(
      entries(host).first { attribute($0, "AXIdentifier") as? String == "devices.service" })
    #expect(attribute(toggle, "AXValue") as? Int == 1, "a running service reads as on")

    let press = NSSelectorFromString("accessibilityPerformPress")
    try #require(toggle.responds(to: press))
    toggle.perform(press)
    try await Task.sleep(for: .milliseconds(50))
    #expect(control.stops == 1)
    #expect(!model.enabled)
    #expect(attribute(toggle, "AXValue") as? Int == 0, "a stopped service reads as off")

    toggle.perform(press)
    try await Task.sleep(for: .milliseconds(50))
    #expect(control.starts == 2)
    #expect(model.enabled)
  }

  private func makeHost(
    _ model: DeviceSettingsViewModel
  ) -> (
    NSHostingView<DeviceSettingsView>, NSWindow
  ) {
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: DeviceSettingsView(model: model))
    host.frame = NSRect(x: 0, y: 0, width: 660, height: 1100)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 660, height: 1100),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    return (host, window)
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
        "AXChildren": "accessibilityChildren", "AXValue": "accessibilityValue",
        "AXIdentifier": "accessibilityIdentifier",
      ][name] ?? name)
    if node.responds(to: selector) { return node.perform(selector)?.takeUnretainedValue() }
    let legacy = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: legacy) else { return nil }
    return node.perform(legacy, with: name)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
