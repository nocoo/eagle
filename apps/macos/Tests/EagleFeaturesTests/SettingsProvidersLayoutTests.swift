import AppKit
import BotsCore
import Foundation
import SwiftUI
import Testing

@testable import EagleFeatures

/// The 服务 page's rows as a person meets them: what the rendered tree actually carries. The App
/// has no XCTest target, and SwiftUI publishes button enablement only as an `NSAccessibility`
/// property this hosting path does not expose, so a row's *enabled* state is asserted through the
/// view model predicates the row is built from, and this suite asserts what is on screen.
@Suite("Settings providers layout", .serialized)
@MainActor
struct SettingsProvidersLayoutTests {
  @Test("a relay that needs no key offers a probe and a way to clear its optional key")
  func keylessRelayRow() async throws {
    let (model, window) = try providersFixture([
      provider(
        id: "jev-relay", title: "Jev 中转站", service: ProviderSettings.decisionService,
        model: "typesafe/jev-latest", keyRequired: false, hasApiKey: true, enabled: true)
    ])
    defer { window.orderOut(nil) }
    let nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0) == "测试" })
    #expect(nodes.contains { title($0) == "清除 Key" }, "an optional key can be cleared again")
    #expect(nodes.contains { title($0) == "http://127.0.0.1:3425 · typesafe/jev-latest" })
    #expect(model.canTestProvider(model.providers[0]))
  }

  @Test("a provider that requires a key offers no probe and nothing to clear")
  func keyRequiredRow() async throws {
    let (model, window) = try providersFixture([
      provider(
        id: "raven", title: "Raven", service: ProviderSettings.decisionService,
        model: "microsoft-decision-1", keyRequired: true, hasApiKey: false, enabled: false)
    ])
    defer { window.orderOut(nil) }
    let nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0) == "测试" })
    #expect(!nodes.contains { title($0) == "清除 Key" }, "a required key is not cleared, replaced")
    #expect(!nodes.contains { title($0) == "使用中" })
    #expect(!model.canTestProvider(model.providers[0]), "and the row is built from that answer")
  }

  @Test("a typed address keeps the probe off until it is saved")
  func draftRow() async throws {
    let (model, window) = try providersFixture([
      provider(
        id: "falcon", title: "Falcon", service: ProviderSettings.decisionService,
        model: "jev-latest", keyRequired: true, hasApiKey: true, enabled: true)
    ])
    defer { window.orderOut(nil) }
    model.providerModels["falcon"] = "jev-preview"
    try await Task.sleep(for: .milliseconds(80))
    window.contentView?.layoutSubtreeIfNeeded()
    let nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0) == "保存" })
    #expect(nodes.contains { title($0) == "测试" })
    #expect(model.canSaveProvider(model.providers[0]), "the row and the model agree")
    #expect(!model.canTestProvider(model.providers[0]), "a draft is saved before it is probed")
  }

  @Test("an expanded row shows the address and model fields")
  func addressFields() async throws {
    let (_, window) = try providersFixture(
      [
        provider(
          id: "typesafe", title: "TypeSafe", service: ProviderSettings.decisionService,
          model: "jev-latest", keyRequired: true, hasApiKey: true, enabled: true)
      ],
      expandsProviderDetails: ["typesafe"])
    defer { window.orderOut(nil) }
    let nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0) == "地址" })
    #expect(nodes.contains { title($0) == "模型" })
  }

  private func providersFixture(
    _ providers: [ProviderSettings],
    expandsProviderDetails: Set<String> = []
  ) throws -> (SettingsViewModel, NSWindow) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-providers-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let token = root.appendingPathComponent("token")
    try "providers-layout-token-0123456789012345678901".write(
      to: token, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)
    let model = SettingsViewModel(
      botsSettings: BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"]),
      urlSession: URLSession(configuration: .ephemeral))
    model.selection = .providers
    model.providers = providers
    for provider in providers where provider.isDecision {
      model.providerAddresses[provider.id] = provider.baseUrl
      model.providerModels[provider.id] = provider.model
    }
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(
      rootView: SettingsView(
        model: model, showsCloseButton: false,
        expandsProviderDetails: expandsProviderDetails))
    host.frame = NSRect(x: 0, y: 0, width: 920, height: 1000)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 920, height: 1000),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    return (model, window)
  }

  private func provider(
    id: String,
    title: String,
    service: String,
    model: String,
    keyRequired: Bool,
    hasApiKey: Bool,
    enabled: Bool
  ) -> ProviderSettings {
    ProviderSettings(
      id: id, title: title, service: service, kind: "systemone",
      baseUrl: "http://127.0.0.1:3425", model: model, docsUrl: "",
      keyLabel: "API Key", keyRequired: keyRequired, hasApiKey: hasApiKey, enabled: enabled,
      defaults: ProviderDefaults(baseUrl: "http://127.0.0.1:3425", model: model))
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
