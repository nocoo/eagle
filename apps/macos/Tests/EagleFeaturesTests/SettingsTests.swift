import Foundation
import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Settings")
@MainActor
struct SettingsTests {
  @Test("permissions cycle through every option")
  func permissionCycle() {
    let model = SettingsViewModel()
    let start = model.machines[0].permission
    model.cyclePermission(model.machines[0].id)
    #expect(model.machines[0].permission != start)
    for _ in 1..<MachinePermission.allCases.count {
      model.cyclePermission(model.machines[0].id)
    }
    #expect(model.machines[0].permission == start)
  }

  @Test("unknown machines are ignored")
  func unknownMachine() {
    let model = SettingsViewModel()
    let before = model.machines
    model.cyclePermission("nope")
    model.setPermission("nope", .deny)
    model.remove("nope")
    #expect(model.machines == before)
  }

  @Test("renaming trims input and rejects blanks")
  func rename() {
    let model = SettingsViewModel()
    let target = try! #require(model.machines.first { $0.renamable })
    model.beginRename(target.id)
    #expect(model.renameTarget == target.id)

    model.rename(target.id, to: " 书房 Mac ")
    #expect(model.machines.first { $0.id == target.id }?.name == "书房 Mac")
    #expect(model.renameTarget == nil)

    model.rename(target.id, to: "   ")
    #expect(model.machines.first { $0.id == target.id }?.name == "书房 Mac")
  }

  @Test("removing a machine drops exactly one row")
  func remove() {
    let model = SettingsViewModel()
    let before = model.machines.count
    let id = try! #require(model.machines.last?.id)
    model.remove(id)
    #expect(model.machines.count == before - 1)
    #expect(model.machines.contains { $0.id == id } == false)
  }

  @Test("online count follows the mock data")
  func onlineCount() {
    let model = SettingsViewModel()
    #expect(model.onlineCount == model.machines.filter(\.online).count)
    #expect(model.onlineCount > 0)
  }

  @Test("checking for updates settles on the current version")
  func updates() {
    let model = SettingsViewModel()
    model.checkForUpdates()
    #expect(model.updateState == .current("0.14.1"))
  }

  @Test("setPermission writes the chosen option")
  func setPermission() {
    let model = SettingsViewModel()
    let id = try! #require(model.machines.first?.id)
    model.setPermission(id, .deny)
    #expect(model.machines.first { $0.id == id }?.permission == .deny)
  }

  @Test("cancelRename clears the active target")
  func cancelRename() {
    let model = SettingsViewModel()
    let id = try! #require(model.machines.first?.id)
    model.beginRename(id)
    model.cancelRename()
    #expect(model.renameTarget == nil)
  }
}

@Suite("Settings gateway", .serialized)
@MainActor
struct SettingsGatewayTests {
  @Test("loadGateway fills the form and reports configuration state")
  func loadGatewayConfigured() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/settings")
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gateway?.configured == true)
    #expect(model.gatewayBaseURL == "http://gw/v1")
    #expect(model.gatewayModel == "m1")
    #expect(model.gatewayMessage == "已配置")
    #expect(model.gatewayBusy == false)
    GatewayHTTPStub.handler = nil
  }

  @Test("loadGateway reports when the daemon has no gateway yet")
  func loadGatewayUnconfigured() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"{"settings":{"configured":false,"provider":"","baseUrl":"","model":"","hasApiKey":false}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gateway?.configured == false)
    #expect(model.gatewayMessage == "尚未配置")
    GatewayHTTPStub.handler = nil
  }

  @Test("loadGateway surfaces read failures")
  func loadGatewayFailure() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in (401, Data()) }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gatewayMessage?.contains("无法读取 Bots 设置") == true)
    GatewayHTTPStub.handler = nil
  }

  @Test("loadGateway does not overwrite fields the user already typed")
  func loadGatewayPreservesDraft() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://typed/v1"
    model.gatewayModel = "typed-model"
    await model.loadGateway()
    #expect(model.gatewayBaseURL == "http://typed/v1")
    #expect(model.gatewayModel == "typed-model")
    GatewayHTTPStub.handler = nil
  }

  @Test("loadGatewayIfNeeded fetches only once")
  func loadGatewayIfNeededOnce() async throws {
    let (settings, session) = try settingsGatewayFixture()
    var loads = 0
    GatewayHTTPStub.handler = { _ in
      loads += 1
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGatewayIfNeeded()
    await model.loadGatewayIfNeeded()
    #expect(loads == 1)
    GatewayHTTPStub.handler = nil
  }

  @Test("testGateway probes trimmed values and records the result")
  func testGatewaySuccess() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      #expect(request.httpMethod == "POST")
      #expect(request.url?.path == "/v1/settings/test")
      let body = gatewayHTTPBody(request)
      let parsed = try JSONSerialization.jsonObject(with: try #require(body)) as? [String: Any]
      #expect(parsed?["baseUrl"] as? String == "http://gw/v1")
      #expect(parsed?["model"] as? String == "m1")
      #expect(parsed?["apiKey"] as? String == "secret")
      return (
        200,
        Data(
          #"{"result":{"ok":true,"status":200,"message":"连接成功","latencyMs":4,"models":3}}"#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "  http://gw/v1  "
    model.gatewayModel = " m1 "
    model.gatewayAPIKey = "secret"
    await model.testGateway()
    #expect(model.gatewayProbe?.ok == true)
    #expect(model.gatewayProbe?.models == 3)
    #expect(model.gatewayBusy == false)
    GatewayHTTPStub.handler = nil
  }

  @Test("testGateway reports probe failures")
  func testGatewayFailure() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in throw URLError(.cannotConnectToHost) }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    await model.testGateway()
    #expect(model.gatewayProbe == nil)
    #expect(model.gatewayMessage != nil)
    GatewayHTTPStub.handler = nil
  }

  @Test("saveGateway persists, clears the key field and notifies listeners")
  func saveGatewaySuccess() async throws {
    let (settings, session) = try settingsGatewayFixture()
    final class NotifyFlag: @unchecked Sendable {
      var value = false
    }
    let notified = NotifyFlag()
    let token = NotificationCenter.default.addObserver(
      forName: .botsGatewayChanged,
      object: nil,
      queue: .main
    ) { _ in notified.value = true }
    defer { NotificationCenter.default.removeObserver(token) }
    GatewayHTTPStub.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("POST", "/v1/settings/test"):
        return (
          200,
          Data(
            #"{"result":{"ok":true,"status":200,"message":"连接成功","latencyMs":1,"models":1}}"#
              .utf8)
        )
      case ("PUT", "/v1/settings"):
        let body = gatewayHTTPBody(request)
        let parsed = try JSONSerialization.jsonObject(with: try #require(body)) as? [String: Any]
        #expect(parsed?["baseUrl"] as? String == "http://gw/v1")
        #expect(parsed?["model"] as? String == "m2")
        #expect(parsed?["apiKey"] as? String == "fresh-key")
        return (
          200,
          Data(
            #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m2","hasApiKey":true}}"#
              .utf8)
        )
      default:
        return (404, Data())
      }
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = " http://gw/v1 "
    model.gatewayModel = " m2 "
    model.gatewayAPIKey = "fresh-key"
    await model.testGateway()
    #expect(model.gatewayProbe?.ok == true)
    await model.saveGateway()
    #expect(model.gateway?.model == "m2")
    #expect(model.gatewayAPIKey.isEmpty)
    #expect(model.gatewayProbe == nil)
    #expect(model.gatewayMessage == "已保存，Bot 会使用这个网关")
    #expect(notified.value)
    GatewayHTTPStub.handler = nil
  }

  @Test("saveGateway surfaces daemon errors")
  func saveGatewayFailure() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (409, Data("{\"error\":{\"kind\":\"internal\",\"message\":\"bad gateway\"}}".utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    await model.saveGateway()
    #expect(model.gatewayMessage == "bad gateway")
    GatewayHTTPStub.handler = nil
  }
}

@Suite("Settings models")
struct SettingsModelTests {
  @Test("permission cycles through every case")
  func permissionNext() {
    var permission = MachinePermission.always
    let seen = Set(
      (0..<MachinePermission.allCases.count).map { _ in
        permission = permission.next
        return permission
      }
    )
    #expect(seen.count == MachinePermission.allCases.count)
  }

  @Test("machine rows expose platform symbols and status copy")
  func machinePresentation() {
    let mac = MachineDevice(id: "m", name: "Mac", platform: "电脑", online: true)
    #expect(mac.symbol == "display")
    #expect(mac.status == "电脑 · 当前在线")

    let phone = MachineDevice(
      id: "p", name: "Phone", platform: "iOS", online: false, lastOpened: "1小时前")
    #expect(phone.symbol == "iphone")
    #expect(phone.status == "iOS · 上次打开：1小时前")

    let offline = MachineDevice(id: "o", name: "Off", platform: "电脑", online: false)
    #expect(offline.status == "电脑 · 离线")
  }

  @Test("mock usage fixtures stay populated")
  func mockUsage() {
    #expect(MockSettings.machines.count >= 2)
    #expect(MockSettings.usage.planName == "Pro")
    #expect(MockSettings.usage.percentUsed > 0)
  }
}

@Suite("Account menu")
struct AccountMenuTests {
  @Test("rows keep the reference order and one separator")
  func rows() {
    let model = AccountMenuViewModel()
    #expect(model.rows.map(\.id) == ["plan", "mobile", "support", "settings", "add", "signout"])
    #expect(model.rows.filter(\.separatorBefore).map(\.id) == ["add"])
    #expect(model.rows.last?.destructive == true)
    #expect(model.rows.first?.detail == "73% 已用")
    #expect(model.rows.first?.showsChevron == true)
  }
}
