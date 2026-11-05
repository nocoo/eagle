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

  @Test("an unconfigured relay leaves local policy available and disables pairing")
  func unconfiguredRemote() async throws {
    let (model, control, defaults) = deviceSettingsFixture(requiresServiceAddress: true)
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.handler = { method, _ in
      if method == "service.status" {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(true),
          "cloudStatus": .string("unconfigured"),
        ])
      }
      if method == "directory", case .object(var value) = control.directory {
        value.removeValue(forKey: "relayOrigin")
        value["cloudStatus"] = .string("unconfigured")
        return .object(value)
      }
      return nil
    }
    await model.startIfNeeded()
    let (host, window) = makeHost(model)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    try await Task.sleep(for: .milliseconds(50))
    host.layoutSubtreeIfNeeded()
    let nodes = entries(host)
    #expect(nodes.compactMap(title).contains("远程未配置"))
    let pairing = try #require(nodes.first { title($0) == "生成本机配对码" })
    #expect(try !isEnabled(pairing))
    let localPolicy = try #require(
      nodes.first {
        attribute($0, "AXIdentifier") as? String == "devices.policy.\(deviceSettingsLocalID)"
      })
    #expect(try isEnabled(localPolicy))
  }

  @Test("an unresolved pairing stays visible without expanding the pairing section")
  func pendingPairingStaysVisible() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set(
      [
        "requestId": UUID().uuidString.lowercased(), "codeHash": String(repeating: "a", count: 64),
        "relayOrigin": "https://devices.example",
      ], forKey: DeviceSettingsViewModel.pendingRedeemKey)
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
    let submit = try #require(entries(host).first { title($0) == "添加设备" })
    #expect(try !isEnabled(submit))
    let input = try #require(entries(host).first { title($0) == "另一台设备的配对码" })
    let frame = try #require(input as? any NSAccessibilityElementProtocol).accessibilityFrame()
    let fields = nativeViews(host).compactMap { $0 as? NSTextField }.filter { field in
      field.isEditable
        && window.convertToScreen(field.convert(field.bounds, to: nil)).intersects(frame)
    }
    #expect(fields.count == 1)
    let textField = try #require(fields.first)
    try #require(window.makeFirstResponder(textField))
    let editor = try #require(window.fieldEditor(false, for: textField) as? NSTextView)
    editor.insertText("unfinished-pairing-input", replacementRange: NSRange(location: 0, length: 0))
    editor.didChangeText()
    try await Task.sleep(for: .milliseconds(50))
    let enabled = try #require(entries(host).first { title($0) == "添加设备" })
    #expect(try isEnabled(enabled))
    control.directory = deviceDirectory(observation: "visible-change", online: true)
    await model.refresh()
    #expect(model.directory?.observationRevision == "visible-change")
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
    #expect(try accessibilityBool(toggle, selector: press))
    try await waitUntil { control.stops == 1 && !model.enabled && !model.controlsBusy }
    #expect(control.stops == 1)
    #expect(!model.enabled)
    try await waitUntil {
      guard
        let node = entries(host).first(where: {
          attribute($0, "AXIdentifier") as? String == "devices.service"
        })
      else { return false }
      guard attribute(node, "AXValue") as? Int == 0 else { return false }
      return try isEnabled(node)
    }
    let stopped = try #require(
      entries(host).first { attribute($0, "AXIdentifier") as? String == "devices.service" })
    #expect(attribute(stopped, "AXValue") as? Int == 0, "a stopped service reads as off")

    var releaseStart: CheckedContinuation<Void, Never>?
    control.startGate = { await withCheckedContinuation { releaseStart = $0 } }
    defer { releaseStart?.resume() }
    #expect(try accessibilityBool(stopped, selector: press))
    try await waitUntil { releaseStart != nil }
    #expect(model.enabled)
    #expect(control.starts == 1)
    let release = try #require(releaseStart)
    releaseStart = nil
    release.resume()
    try await waitUntil { control.starts == 2 && model.localReady && !model.controlsBusy }
    #expect(control.starts == 2)
    #expect(model.enabled)
    try await waitUntil {
      guard
        let node = entries(host).first(where: {
          attribute($0, "AXIdentifier") as? String == "devices.service"
        })
      else { return false }
      return attribute(node, "AXValue") as? Int == 1
    }
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

  private func waitUntil(_ condition: () throws -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
      if try condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(domain: "DeviceSettingsLayoutTests", code: 1)
  }

  private func isEnabled(_ element: NSObject) throws -> Bool {
    try accessibilityBool(element, selector: NSSelectorFromString("isAccessibilityEnabled"))
  }

  private func accessibilityBool(_ element: NSObject, selector: Selector) throws -> Bool {
    try #require(element.responds(to: selector))
    let implementation = try #require(element.method(for: selector))
    let getter = unsafeBitCast(
      implementation, to: (@convention(c) (AnyObject, Selector) -> Bool).self)
    return getter(element, selector)
  }

  private func nativeViews(_ view: NSView) -> [NSView] {
    [view] + view.subviews.flatMap(nativeViews)
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
