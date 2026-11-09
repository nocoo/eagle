import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

/// The Herdr settings page: two tools this machine may or may not have, the `hc` switch that
/// only means something once hc is installed, and the three role models a save carries.
/// This page's own stub: the model-gateway suite uses a global handler, and two suites must
/// not answer each other's requests.
final class HerdrHTTPStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var handler: ((URLRequest) throws -> (Int, Data))?
  }

  private static let storage = Storage()

  static var handler: ((URLRequest) throws -> (Int, Data))? {
    get { storage.handler }
    set { storage.handler = newValue }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    do {
      let (status, data) = try handler(request)
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

@MainActor
func herdrSettingsFixture() throws -> (BotsSettings, URLSession) {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("herdr-settings-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let tokenURL = root.appendingPathComponent("token")
  try "test-token-01234567890123456789012".write(to: tokenURL, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
  let settings = BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"])
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HerdrHTTPStub.self]
  return (settings, URLSession(configuration: configuration))
}

@Suite("Herdr settings", .serialized)
@MainActor
struct HerdrSettingsTests {
  private static let payload = #"""
    {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,
     "toolGroups":["persona","machine","core","core-ui","coding"],
     "hc":{"steering":{"model":"group/steering","thinkingLevel":"high"},
       "coding":{"model":"group/coding","thinkingLevel":"high"},
       "reviewing":{"model":"group/reviewing","thinkingLevel":"xhigh"}}}}
    """#

  @Test("the Herdr group is off by default and is not a tool-page row")
  func herdrDefaults() {
    #expect(SettingsViewModel.toolGroups.contains(SettingsViewModel.hcToolGroup))
    #expect(SettingsViewModel.defaultToolGroups.contains(SettingsViewModel.hcToolGroup) == false)
    #expect(SettingsViewModel.hcToolGroup == "hc")
  }

  @Test("the roles decode from the daemon and fall back when the field is absent")
  func rolesDecode() async throws {
    let (settings, session) = try herdrSettingsFixture()
    HerdrHTTPStub.handler = { _ in (200, Data(Self.payload.utf8)) }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gatewayHcRoles.reviewing.model == "group/reviewing")
    #expect(model.gatewayHcRoles.reviewing.thinkingLevel == "xhigh")

    HerdrHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true}}"#
            .utf8)
      )
    }
    let older = SettingsViewModel(botsSettings: settings, urlSession: session)
    await older.loadGateway()
    #expect(older.gatewayHcRoles == HcRoles.fallback)
    #expect(HcRoles.fallback.steering.model == "group/steering")
    HerdrHTTPStub.handler = nil
  }

  @Test("the page saves the hc switch and the three rows in one write")
  func saveHerdr() async throws {
    let (settings, session) = try herdrSettingsFixture()
    var body: [String: Any] = [:]
    var methods: [String] = []
    HerdrHTTPStub.handler = { request in
      methods.append(request.httpMethod ?? "?")
      let payload = gatewayHTTPBody(request) ?? Data()
      body = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
      return (200, Data(Self.payload.utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    model.setToolGroup(SettingsViewModel.hcToolGroup, isOn: true)
    model.setHcModel(.coding, model: "custom/build")
    model.setHcThinkingLevel(.coding, level: "max")
    await model.saveHerdrSettings()

    #expect(methods == ["GET", "PUT"])
    #expect((body["toolGroups"] as? [String])?.contains("hc") == true)
    let roles = body["hc"] as? [String: Any]
    let coding = roles?["coding"] as? [String: Any]
    #expect(coding?["model"] as? String == "custom/build")
    #expect(coding?["thinkingLevel"] as? String == "max")
    #expect(model.gatewayHcRoles.coding.model == "group/coding", "the answer replaces the draft")
    HerdrHTTPStub.handler = nil
  }

  @Test("each tool has its own state, and an install re-reads what it installed")
  func toolStatesAndInstall() async {
    let model = SettingsViewModel()
    let asked = LockedBox<[String]>([])
    model.herdrToolchain = HerdrToolchain(
      detect: { tool in
        asked.mutate { $0.append("detect:\(tool.command)") }
        return tool == .hc ? .installed("hc 0.1.18") : .missing
      },
      install: { tool in
        asked.mutate { $0.append("install:\(tool.command)") }
        return nil
      })
    await model.refreshHerdrTools()
    #expect(model.herdrToolStates[.hc]?.isInstalled == true)
    #expect(model.herdrToolStates[.herdr] == .missing)

    await model.install(.herdr)
    #expect(model.herdrInstalling == nil)
    #expect(asked.value.filter { $0.hasPrefix("install:") } == ["install:herdr"])
    #expect(model.herdrToolStates[.herdr] == .missing, "the second read is what the page shows")
  }

  @Test("a failed install is reported with the installer's own words")
  func installFailure() async {
    let model = SettingsViewModel()
    model.herdrToolchain = HerdrToolchain(
      detect: { _ in .missing },
      install: { _ in "curl: (6) Could not resolve host" })
    await model.install(.hc)
    #expect(model.toasts.toast?.notice == .failure("curl: (6) Could not resolve host"))
  }

  @Test("the tool's own model and installer are what a person would type")
  func toolcatalog() {
    #expect(HerdrTool.hc.command == "hc")
    #expect(HerdrTool.hc.installCommand.contains("releases.herdr.dev/core/install.sh"))
    #expect(HerdrTool.herdr.installCommand.contains("herdr.dev/install.sh"))
    #expect(HerdrToolState.installed("hc 0.1.18").detail == "hc 0.1.18")
    #expect(HerdrToolState.missing.detail == "未安装")
  }
}

/// A tiny mutable box, so a `@Sendable` closure can record what the page asked for.
final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value

  init(_ value: Value) {
    stored = value
  }

  var value: Value {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }

  func mutate(_ body: (inout Value) -> Void) {
    lock.lock()
    defer { lock.unlock() }
    body(&stored)
  }
}
