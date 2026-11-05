import AppKit
import BotsCore
import EagleDesign
import Foundation
import SwiftUI
import Testing

@testable import EagleFeatures

/// The result lines a settings page ends with, as a person meets them: a marker, the sentence and
/// the card's own inset. The pages own the behaviour; this suite asserts what is on screen.
@Suite("Settings status notes", .serialized)
@MainActor
struct SettingsNotesLayoutTests {
  @Test("the tools page keeps no save button and reports the save it makes when left")
  func toolsAutosaveNote() async throws {
    let (model, window) = try await notesFixture(section: .tools)
    defer { window.orderOut(nil) }
    var nodes = entries(try #require(window.contentView))
    #expect(!nodes.contains { title($0) == "保存" }, "the page saves when it is left")

    model.setToolGroup(SettingsViewModel.searchToolGroup, isOn: true)
    model.selection = .general
    try await settle { model.gatewayNotice != nil }
    model.selection = .tools
    window.contentView?.layoutSubtreeIfNeeded()

    nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0)?.contains("✅") == true })
    #expect(nodes.contains { title($0)?.contains("已保存，工具从下一轮开始生效") == true })
  }

  @Test("the model page ends its card with a marked save result")
  func gatewaySaveNote() async throws {
    let (model, window) = try await notesFixture(section: .bots)
    defer { window.orderOut(nil) }
    await model.saveGateway()
    window.contentView?.layoutSubtreeIfNeeded()
    let nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0)?.contains("✅") == true })
    #expect(nodes.contains { title($0)?.contains("已保存，Bot 会使用这个网关") == true })
  }

  private func settle(_ condition: () -> Bool) async throws {
    for _ in 0..<200 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("the page never settled")
  }

  private func notesFixture(section: SettingsSection) async throws -> (SettingsViewModel, NSWindow)
  {
    let (settings, _) = try settingsGatewayFixture()
    NotesHTTPStub.answerSettings()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NotesHTTPStub.self]
    let model = SettingsViewModel(
      botsSettings: settings, urlSession: URLSession(configuration: configuration))
    model.selection = section
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(
      rootView: SettingsView(model: model, showsCloseButton: false))
    host.frame = NSRect(x: 0, y: 0, width: 920, height: 1000)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 920, height: 1000),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    for _ in 0..<100 where model.gateway == nil {
      try? await Task.sleep(for: .milliseconds(10))
    }
    // The model page probes its own address when it opens; let that answer land first so the
    // save's result is the line under test.
    for _ in 0..<100 where model.gatewayProbe == nil {
      try? await Task.sleep(for: .milliseconds(10))
    }
    host.layoutSubtreeIfNeeded()
    return (model, window)
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

/// Answers the settings read, the gateway probe and the tools save, so a layout test never asks
/// the machine's own daemon or a real token.
final class NotesHTTPStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var savedToolGroups: [String] = ["persona", "machine", "core", "coding"]
  }

  private static let storage = Storage()

  static func answerSettings() {
    storage.savedToolGroups = ["persona", "machine", "core", "coding"]
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var status = 404
    var body = "{}"
    switch (request.httpMethod, request.url?.path) {
    case ("GET", "/v1/settings"):
      status = 200
      body = Self.snapshot(corePrompt: "存过的人格", toolGroups: Self.storage.savedToolGroups)
    case ("PUT", "/v1/settings"):
      let payload = gatewayHTTPBody(request) ?? Data()
      let parsed = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
      Self.storage.savedToolGroups = parsed["toolGroups"] as? [String] ?? []
      status = 200
      body = Self.snapshot(
        corePrompt: parsed["corePrompt"] as? String ?? "",
        toolGroups: Self.storage.savedToolGroups)
    case ("POST", "/v1/settings/test"):
      status = 200
      body = #"{"result":{"ok":true,"status":200,"message":"连接成功","latencyMs":1,"models":1}}"#
    default:
      break
    }
    let data = Data(body.utf8)
    let response = HTTPURLResponse(
      url: request.url ?? URL(string: "http://127.0.0.1")!, statusCode: status,
      httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private static func snapshot(corePrompt: String, toolGroups: [String]) -> String {
    let groups = toolGroups.map { "\"\($0)\"" }.joined(separator: ",")
    return #"""
      {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"\#(corePrompt)","toolGroups":[\#(groups)]},"machinePrompt":null}
      """#
  }
}
