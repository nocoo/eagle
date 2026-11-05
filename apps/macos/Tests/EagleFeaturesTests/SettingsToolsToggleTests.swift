import BotsCore
import EagleDesign
import Foundation
import Testing

@testable import EagleFeatures

/// The 工具 page has no save button: each switch writes itself and reports that one switch.
@Suite("Settings tools switches", .serialized)
@MainActor
struct SettingsToolsToggleTests {
  @Test("a flipped switch writes itself at once and reports that switch")
  func writesOnFlip() async throws {
    let fixture = try toolsFixture()
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.commitToolGroup(SettingsViewModel.searchToolGroup, title: "搜索", isOn: true)
    await model.awaitToolSaves()
    let body = try #require(fixture.puts.first)
    #expect(
      body["toolGroups"] as? [String]
        == ["persona", "machine", "core", "coding", "memory", "search"])
    #expect(body["baseUrl"] == nil, "a switch never rewrites the gateway")
    #expect(model.toasts.toast?.notice == .success("已开启 搜索"))
  }

  @Test("switching a group off reports the off state")
  func reportsOff() async throws {
    let fixture = try toolsFixture()
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.commitToolGroup(SettingsViewModel.memoryToolGroup, title: "记忆", isOn: false)
    await model.awaitToolSaves()
    let body = try #require(fixture.puts.first)
    #expect(body["toolGroups"] as? [String] == ["persona", "machine", "core", "coding"])
    #expect(model.toasts.toast?.notice == .success("已关闭 记忆"))
  }

  @Test("two flips are two writes, and the newer set is the one left behind")
  func twoFlips() async throws {
    let fixture = try toolsFixture()
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.commitToolGroup(SettingsViewModel.searchToolGroup, title: "搜索", isOn: true)
    model.commitToolGroup(SettingsViewModel.decisionToolGroup, title: "决策", isOn: true)
    await model.awaitToolSaves()
    #expect(fixture.puts.count == 2, "each switch is its own write")
    #expect(
      fixture.puts.last?["toolGroups"] as? [String]
        == ["persona", "machine", "core", "coding", "memory", "search", "decision"])
    #expect(model.toasts.toast?.notice == .success("已开启 决策"))
  }

  @Test("a refused write keeps the switch as a draft and says why")
  func refusalKeepsDraft() async throws {
    let fixture = try toolsFixture(refusesSave: true)
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.commitToolGroup(SettingsViewModel.searchToolGroup, title: "搜索", isOn: true)
    await model.awaitToolSaves()
    #expect(model.toasts.toast?.notice == .failure("设置被拒绝"))
    #expect(model.isToolGroupEnabled(SettingsViewModel.searchToolGroup))
  }

  @Test("opening the page writes nothing")
  func openedOnly() async throws {
    let fixture = try toolsFixture()
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    await model.awaitToolSaves()
    #expect(fixture.puts.isEmpty)
    #expect(model.toasts.toast == nil, "no action means no result line")
  }

  @Test("a switch keeps the standing instruction as the 提示词 page stored it")
  func keepsPromptDraft() async throws {
    let fixture = try toolsFixture()
    let model = SettingsViewModel(botsSettings: fixture.settings, urlSession: fixture.session)
    await model.loadGateway()
    model.gatewayCorePrompt = "还没保存的草稿"
    model.commitToolGroup(SettingsViewModel.searchToolGroup, title: "搜索", isOn: true)
    await model.awaitToolSaves()
    #expect(fixture.puts.first?["corePrompt"] as? String == "存过的人格")
    #expect(model.gatewayCorePrompt == "还没保存的草稿", "a draft belongs to the page that owns it")
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
  var last: [String: Any]? { all.last }
  var isEmpty: Bool { all.isEmpty }
  var count: Int { all.count }
}

@MainActor
private func toolsFixture(refusesSave: Bool = false) throws -> ToolsFixture {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("eagle-tools-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let token = root.appendingPathComponent("token")
  try "tools-token-012345678901234567890123".write(
    to: token, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)

  let recorder = RequestBodies()
  ToolsSwitchStub.refuses = refusesSave
  ToolsSwitchStub.recorder = recorder
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ToolsSwitchStub.self]
  return ToolsFixture(
    settings: BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"]),
    session: URLSession(configuration: configuration), puts: recorder)
}

/// Answers the settings read and records what the page wrote, so this suite never shares a stub
/// with another one running in parallel.
final class ToolsSwitchStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var refuses = false
    var recorder: RequestBodies?
  }

  private static let storage = Storage()

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
      body = Self.snapshot(corePrompt: "存过的人格", toolGroups: Self.storedGroups)
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

  private static let storedGroups = ["persona", "machine", "core", "coding", "memory"]

  private static func snapshot(corePrompt: String, toolGroups: [String]) -> String {
    let groups = toolGroups.map { "\"\($0)\"" }.joined(separator: ",")
    return #"""
      {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"\#(corePrompt)","toolGroups":[\#(groups)]},"machinePrompt":null}
      """#
  }
}
