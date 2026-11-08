import BotsCore
import Foundation
import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Settings")
@MainActor
struct SettingsTests {
  @Test("the rail names the model tab plainly")
  func sectionTitles() {
    #expect(SettingsSection.bots.rawValue == "模型")
    #expect(SettingsSection.general.rawValue == "通用")
  }

  @Test("the tool page lists the decision group between search and triggers")
  func decisionGroupIsListed() {
    let groups = SettingsViewModel.toolGroups
    let decision = try? #require(groups.firstIndex(of: SettingsViewModel.decisionToolGroup))
    let search = try? #require(groups.firstIndex(of: SettingsViewModel.searchToolGroup))
    let trigger = try? #require(groups.firstIndex(of: SettingsViewModel.triggerToolGroup))
    #expect(decision != nil && search != nil && trigger != nil)
    #expect(decision == search.map { $0 + 1 })
    #expect(decision.map { $0 + 1 } == trigger)
    #expect(
      SettingsViewModel.defaultToolGroups.contains(SettingsViewModel.decisionToolGroup) == false,
      "a judgment spends money per call, so it is opt-in")
  }

  @Test("the two prompts own a tab of their own, right after 工具")
  func promptsSection() {
    #expect(SettingsSection.prompts.rawValue == "提示词")
    #expect(
      SettingsSection.allCases.map(\.rawValue)
        == [
          "通用", "模型", "工具", "技能", "提示词", "服务", "密码", "设备", "CLI", "用量", "关于",
        ])
    // The Super Bot has no settings tab of its own: its model and level live in the inspector
    // 模型 tab, exactly where a bot's pair lives.
    #expect(SettingsSection.allCases.contains(where: { $0.rawValue == "Super Bot" }) == false)
  }

  @Test("the skills own a tab of their own, right after 工具")
  func skillsSection() {
    #expect(SettingsSection.skills.rawValue == "技能")
    let cases = SettingsSection.allCases.map(\.rawValue)
    #expect(cases.firstIndex(of: "技能") == cases.firstIndex(of: "工具").map { $0 + 1 })
    #expect(cases.firstIndex(of: "提示词") == cases.firstIndex(of: "技能").map { $0 + 1 })
    #expect(SettingsSection.skills.symbol == "square.stack.3d.up")
  }

  @Test("the passwords own a tab of their own, right after 服务")
  func passwordsSection() {
    #expect(SettingsSection.passwords.rawValue == "密码")
    let cases = SettingsSection.allCases.map(\.rawValue)
    #expect(cases.firstIndex(of: "密码") == cases.firstIndex(of: "服务").map { $0 + 1 })
  }
}

/// The daemon fixture both settings pages read: one configured search provider.
let settingsProviderJSON = #"""
  {"id":"deepseek-search","title":"DeepSeek 搜索","service":"search","kind":"deepseek-search",
   "baseUrl":"https://api.deepseek.com","model":"",
   "docsUrl":"https://api-docs.deepseek.com/guides/search/",
   "keyLabel":"DeepSeek API Key","keyRequired":true,"hasApiKey":true,"enabled":true,
   "defaults":{"baseUrl":"https://api.deepseek.com","model":""}}
  """#

/// One decision provider as the daemon reports it: Falcon's local root, a catalogue model and a
/// key that is required.
let settingsDecisionProviderJSON = #"""
  {"id":"falcon","title":"Falcon","service":"decision","kind":"systemone",
   "baseUrl":"http://127.0.0.1:19823","model":"jev-latest",
   "docsUrl":"https://github.com/nocoo/falcon/blob/main/docs/03-protocol.md",
   "keyLabel":"Falcon Source Key","keyRequired":true,"hasApiKey":true,"enabled":true,
   "defaults":{"baseUrl":"http://127.0.0.1:19823","model":"jev-latest"}}
  """#

/// A provider row for a test, without spelling out the fields it does not care about.
func settingsProvider(
  id: String,
  title: String,
  service: String = ProviderSettings.searchService,
  kind: String = "deepseek-search",
  baseUrl: String = "https://api.deepseek.com",
  model: String = "",
  docsUrl: String = "",
  keyLabel: String = "API Key",
  keyRequired: Bool = true,
  hasApiKey: Bool,
  enabled: Bool
) -> ProviderSettings {
  ProviderSettings(
    id: id, title: title, service: service, kind: kind, baseUrl: baseUrl, model: model,
    docsUrl: docsUrl, keyLabel: keyLabel, keyRequired: keyRequired, hasApiKey: hasApiKey,
    enabled: enabled, defaults: ProviderDefaults(baseUrl: baseUrl, model: model))
}

@Suite("Settings gateway", .serialized)
@MainActor
struct SettingsGatewayTests {
  @Test("loadGateway fills the form without writing an action result")
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
    #expect(model.toasts.toast == nil, "reading the form is not an action result")
    #expect(model.gatewayBusy == false)
    GatewayHTTPStub.handler = nil
  }

  @Test("an unconfigured gateway loads empty, with nothing to report")
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
    #expect(model.toasts.toast == nil)
    GatewayHTTPStub.handler = nil
  }

  @Test("loadGateway surfaces read failures")
  func loadGatewayFailure() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in (401, Data()) }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.gatewayLoadError?.contains("无法读取 Bots 设置") == true)
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
    #expect(model.providerLoadError != nil, "a refused read is a page-level failure")
    #expect(model.toasts.toast == nil)
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
      settingsProvider(
        id: "deepseek-search", title: "DeepSeek 搜索", baseUrl: "https://api.deepseek.com",
        keyLabel: "DeepSeek API Key", hasApiKey: false, enabled: false)
    ]
    model.providerKeys["deepseek-search"] = "  sk-typed  "
    await model.saveProvider("deepseek-search")
    #expect(body["apiKey"] as? String == "sk-typed")
    #expect(body["enabled"] == nil, "saving the key leaves the switch alone")
    #expect(model.providerKeys["deepseek-search"] == "")
    #expect(model.toasts.toast?.notice == .success("已保存"))
    #expect(model.providers.first?.hasApiKey == true)
    GatewayHTTPStub.handler = nil
  }

  @Test("the enable switch flips at once and a refusal puts it back")
  func toggle() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in (200, Data(#"{"provider":\#(settingsProviderJSON)}"#.utf8)) }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "deepseek-search", title: "DeepSeek 搜索", baseUrl: "https://api.deepseek.com",
        keyLabel: "DeepSeek API Key", hasApiKey: true, enabled: false)
    ]
    await model.setProviderEnabled("deepseek-search", true)
    #expect(model.providers.first?.enabled == true, "the saved state is the server's answer")
    #expect(model.toasts.toast == nil)

    GatewayHTTPStub.handler = { _ in
      (400, Data(#"{"error":{"kind":"invalid_command","message":"拒绝"}}"#.utf8))
    }
    await model.setProviderEnabled("deepseek-search", false)
    #expect(model.providers.first?.enabled == true, "a refused save keeps the stored flag")
    #expect(model.toasts.toast?.notice.text.contains("拒绝") == true)
    await model.setProviderEnabled("unknown", true)
    GatewayHTTPStub.handler = nil
  }

  @Test("choosing a search provider deselects the previous one without losing either key")
  func exclusiveSearchProvider() async throws {
    let (settings, session) = try settingsGatewayFixture()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "deepseek-search", title: "DeepSeek", baseUrl: "https://api.deepseek.com",
        hasApiKey: true, enabled: true),
      settingsProvider(
        id: "tavily-search", title: "Tavily", kind: "tavily-search",
        baseUrl: "https://api.tavily.com", hasApiKey: true, enabled: false),
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
          Data(
            #"{"provider":{"id":"tavily-search","title":"Tavily","service":"search","kind":"tavily-search","baseUrl":"https://api.tavily.com","model":"","docsUrl":"","keyLabel":"API Key","keyRequired":true,"hasApiKey":true,"enabled":true,"defaults":{"baseUrl":"https://api.tavily.com","model":""}}}"#
              .utf8))
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
    #expect(model.toasts.toast?.notice == .failure("拒绝切换"))
    GatewayHTTPStub.handler = nil
  }

  @Test("search selection requires a saved key and busy provider work cannot race")
  func searchSelectionGuards() async throws {
    let (settings, session) = try settingsGatewayFixture()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "tavily-search", title: "Tavily", kind: "tavily-search",
        baseUrl: "https://api.tavily.com", hasApiKey: false, enabled: false)
    ]
    #expect(model.selectedSearchProvider == nil)
    await model.setProviderEnabled("tavily-search", true)
    #expect(model.selectedSearchProvider == nil)
    #expect(model.toasts.toast?.notice.text.contains("先保存") == true)
    let reported = model.toasts.toast
    model.providerBusy = true
    await model.loadProviders()
    await model.saveProvider("tavily-search")
    await model.testProvider("tavily-search")
    await model.setProviderEnabled("tavily-search", true)
    #expect(model.toasts.toast == reported, "a busy guard reports nothing new")
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
    #expect(model.toasts.toast != nil)
    GatewayHTTPStub.handler = nil
  }

  @Test("the two services are listed and chosen apart")
  func decisionServiceListedApart() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers")
      return (
        200,
        Data(
          #"{"providers":[\#(settingsProviderJSON),\#(settingsDecisionProviderJSON)]}"#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadProviders()
    #expect(model.searchProviders.map(\.id) == ["deepseek-search"])
    #expect(model.decisionProviders.map(\.id) == ["falcon"])
    #expect(model.selectedSearchProvider?.id == "deepseek-search")
    #expect(model.selectedDecisionProvider?.id == "falcon")
    #expect(
      model.providerAddresses["falcon"] == "http://127.0.0.1:19823",
      "the address draft starts from what the daemon uses")
    #expect(model.providerModels["falcon"] == "jev-latest")
    GatewayHTTPStub.handler = nil
  }

  @Test("a decision provider saves its key, address and model in one call")
  func decisionSaveSendsEveryDraft() async throws {
    let (settings, session) = try settingsGatewayFixture()
    var body: [String: Any] = [:]
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers/falcon")
      if let data = gatewayHTTPBody(request) {
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      }
      return (
        200,
        Data(
          #"{"provider":{"id":"falcon","title":"Falcon","service":"decision","kind":"systemone","baseUrl":"http://127.0.0.1:19999","model":"jev-preview","docsUrl":"","keyLabel":"Falcon Source Key","keyRequired":true,"hasApiKey":true,"enabled":false,"defaults":{"baseUrl":"http://127.0.0.1:19823","model":"jev-latest"}}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "falcon", title: "Falcon", service: ProviderSettings.decisionService,
        kind: "systemone", baseUrl: "http://127.0.0.1:19823", model: "jev-latest",
        keyLabel: "Falcon Source Key", hasApiKey: false, enabled: false)
    ]
    #expect(model.providerHasChanges(model.providers[0]) == false, "nothing typed, nothing to save")
    model.providerKeys["falcon"] = "  falcon_key  "
    model.providerAddresses["falcon"] = "http://127.0.0.1:19999/v1"
    model.providerModels["falcon"] = "jev-preview"
    #expect(model.providerHasChanges(model.providers[0]))
    await model.saveProvider("falcon")
    #expect(body["apiKey"] as? String == "falcon_key")
    #expect(body["baseUrl"] as? String == "http://127.0.0.1:19999/v1")
    #expect(body["model"] as? String == "jev-preview")
    #expect(body["enabled"] == nil, "saving the fields leaves the selection alone")
    #expect(model.providerKeys["falcon"] == "")
    #expect(
      model.providerAddresses["falcon"] == "http://127.0.0.1:19999",
      "the drafts take the daemon's normalized answer")
    #expect(model.toasts.toast?.notice == .success("已保存"))
    GatewayHTTPStub.handler = nil
  }

  @Test("clearing the address and model asks the daemon for the catalogue value again")
  func decisionAddressReverts() async throws {
    let (settings, session) = try settingsGatewayFixture()
    var body: [String: Any] = [:]
    GatewayHTTPStub.handler = { request in
      if let data = gatewayHTTPBody(request) {
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      }
      return (200, Data(#"{"provider":\#(settingsDecisionProviderJSON)}"#.utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "falcon", title: "Falcon", service: ProviderSettings.decisionService,
        kind: "systemone", baseUrl: "http://127.0.0.1:19999", model: "jev-preview",
        hasApiKey: true, enabled: true)
    ]
    model.providerAddresses["falcon"] = ""
    model.providerModels["falcon"] = ""
    await model.saveProvider("falcon")
    #expect(body["baseUrl"] as? String == "")
    #expect(body["model"] as? String == "")
    #expect(body["apiKey"] == nil, "an empty key field keeps the stored key")
    #expect(model.providerAddresses["falcon"] == "http://127.0.0.1:19823")
    #expect(model.providerModels["falcon"] == "jev-latest")
    GatewayHTTPStub.handler = nil
  }

  @Test("a relay that needs no key can be chosen and probed")
  func keylessDecisionProvider() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { request in
      switch request.url?.path {
      case "/v1/providers/jev-relay":
        return (
          200,
          Data(
            #"{"provider":{"id":"jev-relay","title":"Jev 中转站","service":"decision","kind":"systemone","baseUrl":"http://127.0.0.1:3425","model":"typesafe/jev-latest","docsUrl":"","keyLabel":"中转站 API Key","keyRequired":false,"hasApiKey":false,"enabled":true,"defaults":{"baseUrl":"http://127.0.0.1:3425","model":"typesafe/jev-latest"}}}"#
              .utf8)
        )
      case "/v1/providers/jev-relay/test":
        return (
          200,
          Data(
            #"{"result":{"ok":true,"message":"连接成功 · jev-1.14.0 · test 0.62","latencyMs":9,"model":"typesafe/jev-latest","resolvedModel":"jev-1.14.0"}}"#
              .utf8)
        )
      default:
        return (404, Data())
      }
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "jev-relay", title: "Jev 中转站", service: ProviderSettings.decisionService,
        kind: "systemone", baseUrl: "http://127.0.0.1:3425", model: "typesafe/jev-latest",
        keyLabel: "中转站 API Key", keyRequired: false, hasApiKey: false, enabled: false)
    ]
    await model.setProviderEnabled("jev-relay", true)
    #expect(model.selectedDecisionProvider?.id == "jev-relay")
    await model.testProvider("jev-relay")
    #expect(model.providerProbe["jev-relay"]?.ok == true)
    #expect(model.providerProbe["jev-relay"]?.resolvedModel == "jev-1.14.0")
    #expect(model.toasts.toast == nil)
    GatewayHTTPStub.handler = nil
  }

  @Test("a relay's optional key can be cleared again")
  func clearOptionalKey() async throws {
    let (settings, session) = try settingsGatewayFixture()
    var body: [String: Any] = [:]
    GatewayHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/providers/jev-relay")
      if let data = gatewayHTTPBody(request) {
        body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      }
      return (
        200,
        Data(
          #"{"provider":{"id":"jev-relay","title":"Jev 中转站","service":"decision","kind":"systemone","baseUrl":"http://127.0.0.1:3425","model":"typesafe/jev-latest","docsUrl":"","keyLabel":"中转站 API Key","keyRequired":false,"hasApiKey":false,"enabled":true,"defaults":{"baseUrl":"http://127.0.0.1:3425","model":"typesafe/jev-latest"}}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "jev-relay", title: "Jev 中转站", service: ProviderSettings.decisionService,
        kind: "systemone", baseUrl: "http://127.0.0.1:3425", model: "typesafe/jev-latest",
        keyRequired: false, hasApiKey: true, enabled: true)
    ]
    await model.clearProviderKey("jev-relay")
    #expect(body["apiKey"] as? String == "", "an empty key is the way back to no key")
    #expect(model.providers.first?.hasApiKey == false)
    #expect(model.toasts.toast?.notice == .success("已清除 Key"))
    await model.clearProviderKey("unknown")
    GatewayHTTPStub.handler = nil
  }

  @Test("a failed read belongs to the page rather than to the last card that acted")
  func providerLoadErrorIsPageLevel() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (200, Data(#"{"provider":\#(settingsDecisionProviderJSON)}"#.utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "falcon", title: "Falcon", service: ProviderSettings.decisionService,
        kind: "systemone", baseUrl: "http://127.0.0.1:19823", model: "jev-latest",
        hasApiKey: true, enabled: true)
    ]
    model.providerKeys["falcon"] = "falcon_key"
    await model.saveProvider("falcon")
    GatewayHTTPStub.handler = { _ in (401, Data()) }
    await model.loadProviders()
    #expect(model.providerLoadError != nil)
    #expect(
      model.toasts.toast?.notice == .success("已保存"),
      "a read neither reports nor clears what the last action said")
    GatewayHTTPStub.handler = nil
  }

  @Test("the row's buttons follow the key rule and the draft")
  func providerButtonPredicates() async throws {
    let (settings, session) = try settingsGatewayFixture()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    let keyless = settingsProvider(
      id: "jev-relay", title: "Jev 中转站", service: ProviderSettings.decisionService,
      kind: "systemone", baseUrl: "http://127.0.0.1:3425", model: "typesafe/jev-latest",
      keyRequired: false, hasApiKey: false, enabled: true)
    let demanding = settingsProvider(
      id: "raven", title: "Raven", service: ProviderSettings.decisionService,
      kind: "systemone", baseUrl: "http://127.0.0.1:7024", model: "microsoft-decision-1",
      hasApiKey: false, enabled: false)
    model.providers = [keyless, demanding]
    #expect(model.canTestProvider(keyless), "a relay with no key is testable")
    #expect(model.canTestProvider(demanding) == false, "a missing required key is not")
    #expect(model.canSaveProvider(keyless) == false, "nothing typed, nothing to save")
    model.providerModels["jev-relay"] = "typesafe/jev-preview"
    #expect(model.canSaveProvider(model.providers[0]))
    #expect(model.canTestProvider(model.providers[0]) == false, "a draft is saved before probing")
  }

  @Test("choosing a decision provider leaves the search choice alone")
  func decisionSelectionIsIndependent() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"{"provider":{"id":"falcon","title":"Falcon","service":"decision","kind":"systemone","baseUrl":"http://127.0.0.1:19823","model":"jev-latest","docsUrl":"","keyLabel":"Falcon Source Key","keyRequired":true,"hasApiKey":true,"enabled":true,"defaults":{"baseUrl":"http://127.0.0.1:19823","model":"jev-latest"}}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.providers = [
      settingsProvider(
        id: "tavily-search", title: "Tavily", kind: "tavily-search",
        baseUrl: "https://api.tavily.com", hasApiKey: true, enabled: true),
      settingsProvider(
        id: "falcon", title: "Falcon", service: ProviderSettings.decisionService,
        kind: "systemone", baseUrl: "http://127.0.0.1:19823", model: "jev-latest",
        hasApiKey: true, enabled: false),
    ]
    await model.setProviderEnabled("falcon", true)
    #expect(model.providers.filter(\.enabled).map(\.id) == ["tavily-search", "falcon"])
    #expect(model.selectedSearchProvider?.id == "tavily-search")
    #expect(model.selectedDecisionProvider?.id == "falcon")
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
      model.gatewayToolGroups
        == [
          "persona", "machine", "core", "core-ui", "coding", "memory", "secrets", "agents",
          "trigger",
        ])
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
    #expect(model.gatewayToolGroups == ["core", "core-ui", "coding"])
    #expect(model.isToolGroupEnabled("core"))
    #expect(model.isToolGroupEnabled("herdr") == false)
    GatewayHTTPStub.handler = nil
  }

  @Test("a payload without tool groups falls back to every default group")
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
        == [
          "persona", "machine", "core", "core-ui", "coding", "memory", "secrets",
          "herdr", "agents", "trigger",
        ])
    #expect(
      model.gatewayToolGroups
        == [
          "persona", "machine", "core", "core-ui", "coding", "memory", "secrets",
          "herdr", "agents", "trigger",
        ])
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
        == [
          "persona", "machine", "core", "core-ui", "coding", "memory", "secrets",
          "herdr", "agents", "trigger",
        ])
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
    #expect(model.toasts.toast != nil)
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
    #expect(model.toasts.toast?.notice == .success("已保存，Bot 会使用这个网关"))
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
    #expect(model.toasts.toast?.notice == .success("已保存，Bot 会使用这个网关"))
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
          == [
            "persona", "machine", "core", "core-ui", "coding", "memory", "secrets",
            "herdr", "agents", "trigger",
          ])
      return (
        200,
        Data(
          #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"toolGroups":["persona","machine","core","coding","memory","herdr","agents","trigger"]}}"#
            .utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayBaseURL = "http://gw/v1"
    model.gatewayModel = "m1"
    await model.saveGateway()
    #expect(model.toasts.toast?.notice == .success("已保存，Bot 会使用这个网关"))
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
          == [
            "persona", "machine", "core", "core-ui", "coding", "memory", "secrets", "agents",
            "trigger",
          ])
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
      saved
        == [
          "persona", "machine", "core", "core-ui", "coding", "memory", "secrets", "herdr",
          "agents", "search", "trigger",
        ])

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

  @Test("the memory group is on by default and can be switched off")
  func memoryGroup() {
    let model = SettingsViewModel()
    #expect(model.isToolGroupEnabled("memory"), "a new group starts on")
    model.setToolGroup("memory", isOn: false)
    #expect(model.isToolGroupEnabled("memory") == false)
    #expect(
      model.gatewayToolGroups
        == [
          "persona", "machine", "core", "core-ui", "coding", "secrets", "herdr", "agents",
          "trigger",
        ])
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
    #expect(model.toasts.toast?.notice == .failure("bad gateway"))
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

  @Test("savePrompts sends the standing instruction and takes the answer back")
  func savesPrompts() async throws {
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
          {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"只说结论。","toolGroups":["persona","machine","core","coding"]},"machinePrompt":{"path":"/m/AGENTS.md","text":"机器规则"}}
          """#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.gatewayCorePrompt = "只说结论。"
    await model.savePrompts()
    #expect(body?["corePrompt"] as? String == "只说结论。")
    #expect(body?["baseUrl"] == nil, "the prompts page never rewrites the gateway")
    #expect(model.gatewayCorePrompt == "只说结论。")
    #expect(model.gatewayMachinePrompt?.path == "/m/AGENTS.md")
    #expect(model.toasts.toast?.notice == .success("已保存，提示词从下一轮开始生效"))
    GatewayHTTPStub.handler = nil
  }

  @Test("saving the prompts keeps the switches the 工具 page set")
  func promptsSaveKeepsToolGroups() async throws {
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
          {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true,"corePrompt":"","toolGroups":["persona","core","coding","herdr","agents","search"]}}
          """#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    model.setToolGroup("search", isOn: true)
    model.setToolGroup("machine", isOn: false)
    model.setToolGroup("trigger", isOn: false)
    await model.savePrompts()
    #expect(
      body?["toolGroups"] as? [String]
        == [
          "persona", "core", "core-ui", "coding", "memory", "secrets", "herdr", "agents", "search",
        ],
      "only the two prompt groups changed, and the order is the daemon's")
    GatewayHTTPStub.handler = nil
  }

  @Test("the tools page learns what each group holds from the daemon")
  func loadsToolCatalog() async throws {
    let (settings, session) = try settingsGatewayFixture()
    GatewayHTTPStub.handler = { _ in
      (
        200,
        Data(
          #"""
          {"settings":{"configured":true,"provider":"magpie","baseUrl":"http://gw/v1","model":"m1","hasApiKey":true},"machinePrompt":null,"tools":[{"group":"coding","tools":[{"name":"bash","description":"Run a command."},{"name":"read","description":"Read a file."}]},{"group":"search","tools":[]}]}
          """#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadGateway()
    #expect(model.toolCatalog.map(\.group) == ["coding", "search"])
    #expect(model.toolCatalog.first?.tools.map(\.name) == ["bash", "read"])
    #expect(model.toolCatalog.first?.tools.first?.description == "Run a command.")
    #expect(model.toolCatalog.last?.tools.isEmpty == true, "an empty group stays listed")
    GatewayHTTPStub.handler = nil
  }

  @Test("a daemon without a catalogue leaves the tool list empty rather than guessing")
  func loadsWithoutToolCatalog() async throws {
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
    #expect(model.toolCatalog.isEmpty)
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
    #expect(rows.allSatisfy { $0.face == nil }, "a report set without a catalog draws no face")
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
