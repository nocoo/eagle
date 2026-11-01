import BotsCore
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

  @Test("a development build reports itself as the build in hand, never a newer one")
  func updatesInDevelopment() async {
    let model = SettingsViewModel(
      appVersion: AppVersion(short: "0.15.0", build: "1", isRelease: false),
      links: ProductLinks(
        github: nil, release: nil, updates: URL(string: "https://example.com/api/live"))
    )
    await model.checkForUpdates()
    #expect(model.updateState == .development("0.15.0"))
  }

  @Test("a release build without a check endpoint settles quietly too")
  func updatesWithoutEndpoint() async {
    let model = SettingsViewModel(
      appVersion: AppVersion(short: "0.15.0", build: "1", isRelease: true),
      links: ProductLinks(github: nil, release: nil, updates: nil)
    )
    await model.checkForUpdates()
    #expect(model.updateState == .unavailable)
  }

  @Test("setPermission writes the chosen option")
  func setPermission() {
    let model = SettingsViewModel()
    let id = try! #require(model.machines.first?.id)
    model.setPermission(id, .deny)
    #expect(model.machines.first { $0.id == id }?.permission == .deny)
  }

  @Test("the rail names the model tab plainly")
  func sectionTitles() {
    #expect(SettingsSection.bots.rawValue == "模型")
    #expect(SettingsSection.general.rawValue == "通用")
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

/// The daemon fixture both settings pages read: one configured search provider.
let settingsProviderJSON = #"""
  {"id":"deepseek-search","title":"DeepSeek 搜索","kind":"deepseek-search",
   "baseUrl":"https://api.deepseek.com","docsUrl":"https://api-docs.deepseek.com/guides/search/",
   "keyLabel":"DeepSeek API Key","hasApiKey":true,"enabled":true}
  """#

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

  @Test("the tab lists each provider and reports a refused read")
  func load() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers")
      return (200, Data(#"{"providers":[\#(settingsProviderJSON)]}"#.utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadProviders()
    #expect(model.providers.map(\.id) == ["deepseek-search"])
    #expect(model.providers.first?.hasApiKey == true)
    #expect(model.providerBusy == false)

    GatewayHTTPStub.handler = { _ in (401, Data()) }
    await model.loadProviders()
    #expect(model.providerMessage != nil)
    GatewayHTTPStub.handler = nil
  }

  @Test("a typed key is sent once and the draft clears")
  func saveKey() async throws {
    let (settings, session) = try settingsGatewayFixture()
    var body: [String: Any] = [:]
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers/deepseek-search")
      if let data = gatewayHTTPBody(request) {
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      }
      return (200, Data(#"{"provider":\#(settingsProviderJSON)}"#.utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      ProviderSettings(
        id: "deepseek-search", title: "DeepSeek 搜索", kind: "deepseek-search",
        baseUrl: "https://api.deepseek.com", docsUrl: "", keyLabel: "DeepSeek API Key",
        hasApiKey: false, enabled: false)
    ]
    model.providerKeys["deepseek-search"] = "  sk-typed  "
    await model.saveProvider("deepseek-search")
    #expect(body["apiKey"] as? String == "sk-typed")
    #expect(body["enabled"] == nil, "saving the key leaves the switch alone")
    #expect(model.providerKeys["deepseek-search"] == "")
    #expect(model.providerMessage == "已保存")
    #expect(model.providers.first?.hasApiKey == true)
    GatewayHTTPStub.handler = nil
  }

  @Test("the enable switch flips at once and a refusal puts it back")
  func toggle() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in (200, Data(#"{"provider":\#(settingsProviderJSON)}"#.utf8)) }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      ProviderSettings(
        id: "deepseek-search", title: "DeepSeek 搜索", kind: "deepseek-search",
        baseUrl: "https://api.deepseek.com", docsUrl: "", keyLabel: "DeepSeek API Key",
        hasApiKey: true, enabled: false)
    ]
    await model.setProviderEnabled("deepseek-search", true)
    #expect(model.providers.first?.enabled == true, "the saved state is the server's answer")
    #expect(model.providerMessage == nil)

    GatewayHTTPStub.handler = { _ in
      (400, Data(#"{"error":{"kind":"invalid_command","message":"拒绝"}}"#.utf8))
    }
    await model.setProviderEnabled("deepseek-search", false)
    #expect(model.providers.first?.enabled == true, "a refused save keeps the stored flag")
    #expect(model.providerMessage?.contains("拒绝") == true)
    await model.setProviderEnabled("unknown", true)
    GatewayHTTPStub.handler = nil
  }

  @Test("choosing a search provider deselects the previous one without losing either key")
  func exclusiveSearchProvider() async throws {
    let (settings, session) = try settingsGatewayFixture()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      ProviderSettings(
        id: "deepseek-search", title: "DeepSeek", kind: "deepseek-search",
        baseUrl: "https://api.deepseek.com", docsUrl: "", keyLabel: "API Key",
        hasApiKey: true, enabled: true),
      ProviderSettings(
        id: "tavily-search", title: "Tavily", kind: "tavily-search",
        baseUrl: "https://api.tavily.com", docsUrl: "", keyLabel: "API Key",
        hasApiKey: true, enabled: false),
    ]
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers/tavily-search")
      var body: [String: Any] = [:]
      if let data = gatewayHTTPBody(request) {
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      }
      #expect(body["apiKey"] == nil)
      #expect(body["enabled"] as? Bool == true)
      return (
        200,
        Data(
          #"{"provider":{"id":"tavily-search","title":"Tavily","kind":"tavily-search","baseUrl":"https://api.tavily.com","docsUrl":"","keyLabel":"API Key","hasApiKey":true,"enabled":true}}"#
            .utf8)
      )
    }
    await model.setProviderEnabled("tavily-search", true)
    #expect(model.providers.filter(\.enabled).map(\.id) == ["tavily-search"])
    #expect(model.providers.map(\.hasApiKey) == [true, true])
    #expect(model.selectedSearchProvider?.id == "tavily-search")
    GatewayHTTPStub.handler = { _ in
      (400, Data(#"{"error":{"kind":"invalid_command","message":"拒绝切换"}}"#.utf8))
    }
    await model.setProviderEnabled("deepseek-search", true)
    #expect(model.selectedSearchProvider?.id == "tavily-search")
    #expect(model.providerMessage == "拒绝切换")
    GatewayHTTPStub.handler = nil
  }

  @Test("search selection requires a saved key and busy provider work cannot race")
  func searchSelectionGuards() async throws {
    let (settings, session) = try settingsGatewayFixture()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      ProviderSettings(
        id: "tavily-search", title: "Tavily", kind: "tavily-search",
        baseUrl: "https://api.tavily.com", docsUrl: "", keyLabel: "API Key",
        hasApiKey: false, enabled: false)
    ]
    #expect(model.selectedSearchProvider == nil)
    await model.setProviderEnabled("tavily-search", true)
    #expect(model.selectedSearchProvider == nil)
    #expect(model.providerMessage?.contains("先保存") == true)
    model.providerMessage = nil
    model.providerBusy = true
    await model.loadProviders()
    await model.saveProvider("tavily-search")
    await model.testProvider("tavily-search")
    await model.setProviderEnabled("tavily-search", true)
    #expect(model.providerMessage == nil)
    #expect(model.providerKeys.isEmpty)
    model.providerBusy = false
    model.providers[0].hasApiKey = true
    model.providers[0].enabled = true
    var duplicate = model.providers[0]
    duplicate.id = "deepseek-search"
    model.providers.append(duplicate)
    #expect(model.selectedSearchProvider == nil, "an ambiguous state does not select by order")
  }

  @Test("a probe reports its latency, and a failed probe reports why")
  func probe() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers/deepseek-search/test")
      return (
        200,
        Data(#"{"result":{"ok":true,"message":"连接成功","latencyMs":42,"results":1}}"#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.testProvider("deepseek-search")
    #expect(model.providerProbe["deepseek-search"]?.ok == true)
    #expect(model.providerProbe["deepseek-search"]?.latencyMs == 42)
    #expect(model.providerBusy == false)

    GatewayHTTPStub.handler = { _ in (500, Data()) }
    await model.testProvider("deepseek-search")
    #expect(model.providerMessage != nil)
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
    model.setToolGroup("herdr", isOn: false)
    await model.loadGateway()
    #expect(model.gatewayBaseURL == "http://typed/v1")
    #expect(model.gatewayModel == "typed-model")
    #expect(
      model.gatewayToolGroups == ["persona", "machine", "core", "coding", "agents", "trigger"])
    GatewayHTTPStub.handler = nil
  }

  @Test("loadGateway reads the stored thinking level into the form")
  func loadGatewayThinkingLevel() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"thinkingLevel":"xhigh"}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gateway?.thinkingLevel == "xhigh")
    #expect(model.gatewayThinkingLevel == "xhigh")
    #expect(model.gatewayThinkingLevelLabel == "极高")
    GatewayHTTPStub.handler = nil
  }

  @Test("a payload without a thinking level falls back to medium")
  func loadGatewayWithoutThinkingLevel() async throws {
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
    await model.loadGateway()
    #expect(model.gateway?.thinkingLevel == "medium")
    #expect(model.gatewayThinkingLevel == "medium")
    GatewayHTTPStub.handler = nil
  }

  @Test("the seven levels name themselves in increasing effort")
  func thinkingLevelLabels() {
    let model = SettingsViewModel()
    #expect(
      model.thinkingLevels.map(\.value) == [
        "off", "minimal", "low", "medium", "high", "xhigh", "max",
      ])
    #expect(model.thinkingLevels.map(\.label) == ["关闭", "极低", "低", "中", "高", "极高", "最高"])
    #expect(model.gatewayThinkingLevel == "medium")
    #expect(model.gatewayThinkingLevelLabel == "中")
  }

  @Test("loadGateway reads the enabled tool groups into the form")
  func loadGatewayToolGroups() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"thinkingLevel":"medium","toolGroups":["core", "coding"]}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gateway?.toolGroups == ["core", "coding"])
    #expect(model.gatewayToolGroups == ["core", "coding"])
    #expect(model.isToolGroupEnabled("core"))
    #expect(model.isToolGroupEnabled("herdr") == false)
    GatewayHTTPStub.handler = nil
  }

  @Test("a payload without tool groups falls back to both groups")
  func loadGatewayWithoutToolGroups() async throws {
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
    await model.loadGateway()
    #expect(
      model.gateway?.toolGroups
        == ["persona", "machine", "core", "coding", "herdr", "agents", "trigger"])
    #expect(
      model.gatewayToolGroups
        == ["persona", "machine", "core", "coding", "herdr", "agents", "trigger"])
    GatewayHTTPStub.handler = nil
  }

  @Test("core and coding cannot be switched off or dropped")
  func toolGroupCoreIsMandatory() {
    let model = SettingsViewModel()
    model.setToolGroup("core", isOn: false)
    #expect(model.isToolGroupEnabled("core"))
    model.setToolGroup("coding", isOn: false)
    #expect(model.isToolGroupEnabled("coding"))
    #expect(model.isToolGroupEnabled("herdr"))
    model.setToolGroup("herdr", isOn: false)
    #expect(model.isToolGroupEnabled("herdr") == false)
    model.setToolGroup("herdr", isOn: true)
    #expect(
      model.gatewayToolGroups
        == ["persona", "machine", "core", "coding", "herdr", "agents", "trigger"])
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

  @Test("saveGateway sends the chosen thinking level")
  func saveGatewayThinkingLevel() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      #expect(request.httpMethod == "PUT")
      let body = gatewayHTTPBody(request)
      let parsed = try JSONSerialization.jsonObject(with: try #require(body)) as? [String: Any]
      #expect(parsed?["thinkingLevel"] as? String == "high")
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"thinkingLevel":"high"}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    model.setGatewayThinkingLevel("high")
    await model.saveGateway()
    #expect(model.gatewayMessage == "已保存，Bot 会使用这个网关")
    GatewayHTTPStub.handler = nil
  }

  @Test("saveGateway sends both tool groups by default")
  func saveGatewayToolGroups() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      let body = gatewayHTTPBody(request)
      let parsed = try JSONSerialization.jsonObject(with: try #require(body)) as? [String: Any]
      #expect(
        parsed?["toolGroups"] as? [String]
          == ["persona", "machine", "core", "coding", "herdr", "agents", "trigger"])
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"toolGroups":["persona","machine","core","coding","herdr","agents","trigger"]}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    await model.saveGateway()
    #expect(model.gatewayMessage == "已保存，Bot 会使用这个网关")
    GatewayHTTPStub.handler = nil
  }

  @Test("saveGateway keeps the other groups when the terminal group is off")
  func saveGatewayWithoutHerdr() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      let body = gatewayHTTPBody(request)
      let parsed = try JSONSerialization.jsonObject(with: try #require(body)) as? [String: Any]
      #expect(
        parsed?["toolGroups"] as? [String]
          == ["persona", "machine", "core", "coding", "agents", "trigger"])
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"toolGroups":["persona","machine","core","coding","agents","trigger"]}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    model.setToolGroup("herdr", isOn: false)
    await model.saveGateway()
    GatewayHTTPStub.handler = nil
  }

  @Test("the search group is off until a daemon reports it, and never silently dropped")
  func searchGroup() async throws {
    let (settings, session) = try settingsGatewayFixture()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    #expect(model.isToolGroupEnabled("search") == false, "a new optional group starts off")
    model.setToolGroup("search", isOn: true)
    #expect(model.isToolGroupEnabled("search"))

    var saved: [String]?
    GatewayHTTPStub.handler = { request in
      let body = gatewayHTTPBody(request)
      let parsed = try JSONSerialization.jsonObject(with: try #require(body)) as? [String: Any]
      saved = parsed?["toolGroups"] as? [String]
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"toolGroups":["core","coding","herdr","agents","search"]}}"#
            .utf8)
      )
    }
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    await model.saveGateway()
    #expect(
      saved == ["persona", "machine", "core", "coding", "herdr", "agents", "search", "trigger"])

    GatewayHTTPStub.handler = { request in
      #expect(request.httpMethod == "GET")
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"toolGroups":["core","coding","herdr","agents","search"]}}"#
            .utf8)
      )
    }
    let reloaded = SettingsViewModel(botsSettings: settings, urlSession: session)
    await reloaded.loadGateway()
    #expect(reloaded.isToolGroupEnabled("search"), "a stored search group survives the read")
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

  @Test("loadGateway reads the persona and the machine file")
  func loadsCorePrompts() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"""
          {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"只说结论。"},"machinePrompt":{"path":"/m/AGENTS.md","text":"机器规则"}}
          """#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gatewayCorePrompt == "只说结论。")
    #expect(model.gatewayMachinePrompt?.path == "/m/AGENTS.md")
    #expect(model.gatewayMachinePrompt?.text == "机器规则")
    GatewayHTTPStub.handler = nil
  }

  @Test("saveTools sends only the persona and the groups, and takes the answer back")
  func savesTools() async throws {
    let (settings, session) = try settingsGatewayFixture()
    var body: [String: Any]?
    GatewayHTTPStub.handler = { request in
      if let data = gatewayHTTPBody(request) {
        body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      }
      return (
        200,
        Data(
          #"""
          {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"新的人格","toolGroups":["persona","machine","core","coding"]},"machinePrompt":{"path":"/m/AGENTS.md","text":"机器规则"}}
          """#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayCorePrompt = "新的人格"
    await model.saveTools()
    #expect(body?["corePrompt"] as? String == "新的人格")
    #expect(body?["baseUrl"] == nil, "the tools page never rewrites the gateway")
    #expect(model.gatewayCorePrompt == "新的人格")
    #expect(model.gatewayMachinePrompt?.path == "/m/AGENTS.md")
    #expect(model.gatewayMessage == "已保存，工具与人格从下一轮开始生效")
    GatewayHTTPStub.handler = nil
  }

  @Test("both core prompts are on by default and can be switched off")
  func defaults() {
    let model = SettingsViewModel()
    #expect(model.isToolGroupEnabled("persona"))
    #expect(model.isToolGroupEnabled("machine"))
    model.setToolGroup("persona", isOn: false)
    #expect(model.isToolGroupEnabled("persona") == false)
    #expect(model.isToolGroupEnabled("machine"))
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

@Suite("Settings usage statistics")
@MainActor
struct SettingsUsageTests {
  private func report() -> UsageReport {
    UsageReport(
      retentionDays: 90,
      today: UsageReport.Totals(totalTokens: 1_234, costUsd: 0.02),
      week: UsageReport.Totals(totalTokens: 45_000, costUsd: 0.4),
      month: UsageReport.Totals(totalTokens: 1_200_000, costUsd: 3.5),
      days: [
        UsageReport.Day(day: "2026-10-20", totalTokens: 0, costUsd: 0),
        UsageReport.Day(day: "2026-10-21", totalTokens: 1_234, costUsd: 0.02),
      ],
      bots: [
        UsageReport.Bot(botId: "b_1", title: "研究员", totalTokens: 1_200_000, costUsd: 3.5)
      ]
    )
  }

  @Test("the page shows today, a week and a month, in that order")
  func rows() {
    let model = SettingsViewModel()
    model.usageReport = report()
    let rows = model.usageSummaryRows
    #expect(rows.map(\.title) == ["今日", "近 7 天", "近 30 天"])
    #expect(rows[0].value == "1.2k · $0.02")
    #expect(rows[1].value == "45.0k · $0.40")
    #expect(rows[2].value == "1.2M · $3.50")
  }

  @Test("no report yet is no rows, so the page shows its empty state")
  func empty() {
    #expect(SettingsViewModel().usageSummaryRows.isEmpty)
  }

  @Test("the busiest bots show calls too, and a search-only bot has no token row")
  func botRows() {
    let model = SettingsViewModel()
    var report = report()
    report.bots = [
      UsageReport.Bot(botId: "b_1", title: "研究员", totalTokens: 12_345, calls: 4, costUsd: 0.42),
      UsageReport.Bot(botId: "b_2", title: "搜索员", totalTokens: 0, calls: 9, costUsd: 0),
    ]
    model.usageReport = report
    let rows = model.usageBotRows
    #expect(rows.map(\.title) == ["研究员", "搜索员"])
    #expect(rows[0].value == "12.3k · 4 次 · $0.42")
    #expect(rows[1].value == "9 次")
    #expect(rows.allSatisfy { $0.detail.isEmpty })
  }

  @Test("sources read in Chinese, with calls for search and tokens for models")
  func sources() {
    let model = SettingsViewModel()
    var report = report()
    report.sources = [
      UsageReport.SourceTotals(source: "model", totalTokens: 12_345, calls: 0, costUsd: 0.42),
      UsageReport.SourceTotals(source: "search", totalTokens: 0, calls: 7, costUsd: 0),
    ]
    model.usageReport = report
    let rows = model.usageSourceRows
    #expect(rows.map(\.title) == ["模型", "搜索"])
    #expect(rows[0].value == "12.3k · $0.42")
    #expect(rows[1].value == "7 次")
  }
}
