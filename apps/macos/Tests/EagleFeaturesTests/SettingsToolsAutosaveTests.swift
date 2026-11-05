import BotsCore
import EagleDesign
import Foundation
import Testing

@testable import EagleFeatures

/// The 工具 page has no save button: leaving it writes the switches a person flipped, and a page
/// that was only opened writes nothing.
@Suite("Settings tools autosave", .serialized)
@MainActor
struct SettingsToolsAutosaveTests {
  @Test("leaving the page writes the switches a person flipped")
  func savesOnLeave() async throws {
    let fixture = try toolsFixture(corePrompt: "存过的人格")
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.setToolGroup(SettingsViewModel.searchToolGroup, isOn: true)
    await model.leaveToolsPage()
    let body = try #require(fixture.puts.first)
    #expect(body["toolGroups"] as? [String] == ["persona", "machine", "core", "coding", "search"])
    #expect(body["baseUrl"] == nil, "the tools page never rewrites the gateway")
    #expect(model.toasts.toast?.notice == .success("已保存，工具从下一轮开始生效"))
  }

  @Test("the standing instruction stays as the 提示词 page stored it")
  func keepsPromptDraft() async throws {
    let fixture = try toolsFixture(corePrompt: "存过的人格")
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.gatewayCorePrompt = "还没保存的草稿"
    model.setToolGroup(SettingsViewModel.searchToolGroup, isOn: true)
    await model.leaveToolsPage()
    let body = try #require(fixture.puts.first)
    #expect(body["corePrompt"] as? String == "存过的人格")
    #expect(model.gatewayCorePrompt == "还没保存的草稿", "a draft belongs to the page that owns it")
  }

  @Test("a page that was only opened writes nothing")
  func openedOnly() async throws {
    let fixture = try toolsFixture(corePrompt: "存过的人格")
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    await model.leaveToolsPage()
    #expect(fixture.puts.isEmpty)
    #expect(model.toasts.toast == nil, "no action means no result line")
  }

  @Test("a second visit after a save writes nothing more")
  func savesOnce() async throws {
    let fixture = try toolsFixture(corePrompt: "存过的人格")
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.setToolGroup(SettingsViewModel.searchToolGroup, isOn: true)
    await model.leaveToolsPage()
    await model.leaveToolsPage()
    #expect(fixture.puts.count == 1)
  }

  @Test("a refused save keeps the switches as drafts and says why")
  func failureKeepsDraft() async throws {
    let fixture = try toolsFixture(corePrompt: "存过的人格", refusesSave: true)
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.setToolGroup(SettingsViewModel.searchToolGroup, isOn: true)
    await model.leaveToolsPage()
    #expect(model.toasts.toast?.notice == .failure("设置被拒绝"))
    #expect(model.isToolGroupEnabled(SettingsViewModel.searchToolGroup))
  }
}

private struct ToolsFixture {
  let settings: BotsSettings
  let session: URLSession
  let puts: RequestBodies
}

final class RequestBodies {
  var all: [[String: Any]] = []
  var first: [String: Any]? { all.first }
  var isEmpty: Bool { all.isEmpty }
  var count: Int { all.count }
}

@MainActor
private func toolsFixture(corePrompt: String, refusesSave: Bool = false) throws -> ToolsFixture {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("eagle-tools-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let token = root.appendingPathComponent("token")
  try "tools-token-012345678901234567890123".write(
    to: token, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)

  let recorder = RequestBodies()
  ToolsAutosaveStub.refuses = refusesSave
  ToolsAutosaveStub.corePrompt = corePrompt
  ToolsAutosaveStub.recorder = recorder
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ToolsAutosaveStub.self]
  return ToolsFixture(
    settings: BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"]),
    session: URLSession(configuration: configuration), puts: recorder)
}

/// Answers the settings read and records what the page wrote, so this suite never shares a stub
/// with another one running in parallel.
final class ToolsAutosaveStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var corePrompt = ""
    var refuses = false
    var recorder: RequestBodies?
  }

  private static let storage = Storage()

  static var corePrompt: String {
    get { storage.corePrompt }
    set { storage.corePrompt = newValue }
  }

  static var refuses: Bool {
    get { storage.refuses }
    set { storage.refuses = newValue }
  }

  static var recorder: RequestBodies? {
    get { storage.recorder }
    set { storage.recorder = newValue }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var status = 404
    var body = "{}"
    switch (request.httpMethod, request.url?.path) {
    case ("GET", "/v1/settings"):
      status = 200
      body = Self.snapshot(corePrompt: Self.corePrompt, toolGroups: Self.storedGroups)
    case ("PUT", "/v1/settings"):
      let payload = gatewayHTTPBody(request) ?? Data()
      let parsed = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
      Self.recorder?.all.append(parsed)
      if Self.refuses {
        status = 400
        body = #"{"error":{"kind":"invalid_command","message":"设置被拒绝"}}"#
      } else {
        status = 200
        body = Self.snapshot(
          corePrompt: parsed["corePrompt"] as? String ?? "",
          toolGroups: parsed["toolGroups"] as? [String] ?? [])
      }
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

  private static let storedGroups = ["persona", "machine", "core", "coding"]

  private static func snapshot(corePrompt: String, toolGroups: [String]) -> String {
    let groups = toolGroups.map { "\"\($0)\"" }.joined(separator: ",")
    return #"""
      {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"\#(corePrompt)","toolGroups":[\#(groups)]},"machinePrompt":null}
      """#
  }
}
