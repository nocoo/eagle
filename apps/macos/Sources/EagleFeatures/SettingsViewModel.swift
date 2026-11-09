import AppKit
import BotsCore
import BotsTransport
import Combine
import EagleDesign
import Foundation

extension Notification.Name {
  /// The stored gateway settings changed: the Bots surface re-reads them before send.
  static let botsGatewayChanged = Notification.Name("eagle.bots.gatewayChanged")
}

/// State and behaviour of the settings window.
@MainActor
public final class SettingsViewModel: ObservableObject {
  @Published public var selection: SettingsSection = .bots
  /// Third-party providers for the two services (search and decision), loaded when the
  /// 服务 tab opens.
  @Published public var providers: [ProviderSettings] = []
  @Published public var providerKeys: [String: String] = [:]
  /// Address and model drafts for a decision provider: the daemon stores them only when they
  /// differ from the catalogue, and an empty field asks for the catalogue value again.
  @Published public var providerAddresses: [String: String] = [:]
  @Published public var providerModels: [String: String] = [:]
  @Published public var providerBusy = false
  @Published public var providerProbe: [String: ProviderProbe] = [:]
  /// A failed read of the whole list, which belongs to neither card.
  @Published public var providerLoadError: String?
  /// The daemon's usage statistics; nil until the 用量 tab is opened.
  @Published public var usageReport: UsageReport?
  @Published public var usageBusy = false
  /// The bots the catalog still lists, with the face each one draws; nil while the catalog has
  /// not answered, so a failed read never calls a bot deleted.
  private var usageBotFaces: [String: BotFace.Style]?
  /// The daemon's password records. The value is never in this state: only the metadata.
  @Published public var secrets: [Secret] = []
  /// A refused read belongs to the page: it says so instead of showing "no passwords".
  @Published public var secretLoadError: String?
  @Published public var secretBusy = false
  /// The values a person asked to see; a second click hides them again.
  @Published public var revealedSecrets: [String: String] = [:]
  /// A page visit: a reveal that lands after the page was left must not fill it back in.
  private var secretsGeneration = 0
  /// The bot names behind a record's creator.
  @Published public var secretBotTitles: [String: String] = [:]
  @Published public var launchAtLogin = true
  @Published public var showUnfocusedSpaces = true
  @Published public var updateState: UpdateState = .idle
  /// The app's own version and where it looks; injectable so a test never touches the network.
  public let appVersion: AppVersion
  public let links: ProductLinks
  /// One automatic check per launch, and never for a development build.
  private var checkedForUpdates = false
  /// The model gateway tab: values are loaded only when that tab is opened.
  @Published public var gateway: GatewaySettings?
  @Published public var gatewayBaseURL = ""
  @Published public var gatewayModel = ""
  @Published public var gatewayAPIKey = ""
  @Published public var gatewayThinkingLevel = SettingsViewModel.defaultThinkingLevel
  @Published public var gatewayToolGroups = SettingsViewModel.defaultToolGroups
  /// The Herdr page's three role rows: drafts until its save button writes them.
  @Published public var gatewayHcRoles = HcRoles.fallback
  /// What this machine reports about the two command-line tools, per tool.
  @Published public var herdrToolStates: [HerdrTool: HerdrToolState] = [:]
  @Published public var herdrInstalling: HerdrTool?
  /// Detection and installation are injectable, so a test never runs a real command.
  public var herdrToolchain = HerdrToolchain.live()
  /// The person's standing instruction, edited on the 提示词 page and shared by every bot.
  @Published public var gatewayCorePrompt = ""
  @Published public var gatewayCorePromptChosen = false
  /// What the machine contributes and nobody edits here: the file the daemon read.
  @Published public var gatewayMachinePrompt: MachinePromptPreview?
  /// What each group gives a bot today; empty until the daemon has answered once.
  @Published public var toolCatalog: [ToolGroupCatalog] = []
  @Published public var gatewayProbe: GatewayProbe?
  @Published public var gatewayBusy = false
  /// A refused read of the shared gateway form: the settings page says so instead of showing
  /// defaults as if they were stored.
  @Published public var gatewayLoadError: String?
  /// What the last action said. It is a toast: it reports, then leaves, and never changes the
  /// height of the card under it.
  public let toasts: ToastCenter
  /// The daemon's reasoning levels, in increasing effort, as the menu lists them.
  public let thinkingLevels: [(value: String, label: String)] = [
    ("off", "关闭"), ("minimal", "极低"), ("low", "低"), ("medium", "中"),
    ("high", "高"), ("xhigh", "极高"), ("max", "最高"),
  ]
  public static let defaultThinkingLevel = "medium"
  /// Every group the daemon knows, in display order; the daemon owns which are installed.
  /// The two core prompts lead, because they are the first sections of the system prompt.
  public static let toolGroups = [
    "persona", "machine", "core", "core-ui", "coding", "memory", "secrets", "hc", "agents",
    "search", "decision", "trigger", "peers",
  ]
  /// What a daemon that predates a new group is assumed to run: both core prompts are on,
  /// memory is on because remembering is a habit, and the rest is opt-in but for the Bot's
  /// own terminal collaborator, which `herdr` used to be.
  public static let defaultToolGroups = [
    "persona", "machine", "core", "core-ui", "coding", "memory", "secrets", "hc", "agents",
    "trigger",
  ]
  public static let mandatoryToolGroups: Set<String> = ["core", "core-ui", "coding"]
  public static let personaToolGroup = "persona"
  public static let machineToolGroup = "machine"
  public static let coreUIToolGroup = "core-ui"
  public static let memoryToolGroup = "memory"
  public static let secretsToolGroup = "secrets"
  public static let hcToolGroup = "hc"
  public static let agentsToolGroup = "agents"
  public static let searchToolGroup = "search"
  public static let decisionToolGroup = "decision"
  public static let triggerToolGroup = "trigger"
  public static let peersToolGroup = "peers"
  private var gatewayThinkingLevelChosen = false
  private var gatewayToolGroupsChosen = false
  private var gatewayHcRolesChosen = false
  /// The queue of switch writes; the page flips faster than the daemon answers.
  private var toolSave: Task<Void, Never>?
  private var gatewayLoaded = false
  private let botsSettings: BotsSettings
  private let urlSession: URLSession

  public init(
    botsSettings: BotsSettings = BotsSettings(),
    urlSession: URLSession = .shared,
    toasts: ToastCenter = ToastCenter(),
    appVersion: AppVersion = .current(),
    links: ProductLinks = .current()
  ) {
    self.botsSettings = botsSettings
    self.urlSession = urlSession
    self.toasts = toasts
    self.appVersion = appVersion
    self.links = links
  }

  /// Reads the daemon's gateway settings once, when the Bots tab is first opened.
  public func loadGatewayIfNeeded() async {
    guard !gatewayLoaded else { return }
    await loadGateway()
  }

  public func loadGateway() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let snapshot = try await client().loadGateway()
      let settings = snapshot.settings
      gateway = settings
      gatewayMachinePrompt = snapshot.machinePrompt
      if let tools = snapshot.tools { toolCatalog = tools }
      gatewayLoaded = true
      if gatewayBaseURL.isEmpty { gatewayBaseURL = settings.baseUrl }
      if gatewayModel.isEmpty { gatewayModel = settings.model }
      if !gatewayThinkingLevelChosen { gatewayThinkingLevel = settings.thinkingLevel }
      if !gatewayToolGroupsChosen {
        gatewayToolGroups = Self.normalizeToolGroups(settings.toolGroups)
      }
      if !gatewayCorePromptChosen { gatewayCorePrompt = settings.corePrompt }
      if !gatewayHcRolesChosen { gatewayHcRoles = settings.hc }
      // Reading the form is not an action: nobody just did something, so nothing is reported.
      gatewayLoadError = nil
    } catch {
      gatewayLoadError = "无法读取 Bots 设置：\(error.localizedDescription)"
    }
  }

  /// The chosen level as the menu shows it; an unknown value falls back to the default's label.
  public var gatewayThinkingLevelLabel: String {
    (thinkingLevels.first { $0.value == gatewayThinkingLevel }
      ?? thinkingLevels.first { $0.value == Self.defaultThinkingLevel })?.label
      ?? Self.defaultThinkingLevel
  }

  /// A pick is a draft until saved; loading must not overwrite it with the stored level.
  public func setGatewayThinkingLevel(_ value: String) {
    gatewayThinkingLevelChosen = true
    gatewayThinkingLevel = value
  }

  public func isToolGroupEnabled(_ name: String) -> Bool {
    gatewayToolGroups.contains(name)
  }

  public func setToolGroup(_ name: String, isOn: Bool) {
    guard !Self.mandatoryToolGroups.contains(name) else { return }
    gatewayToolGroupsChosen = true
    var chosen = Set(gatewayToolGroups)
    if isOn { chosen.insert(name) } else { chosen.remove(name) }
    gatewayToolGroups = Self.normalizeToolGroups(Array(chosen))
  }

  /// Probes the typed values; an empty key field tests the one already stored.
  /// A read-only probe when the page opens, so a stale or unreachable address is visible
  /// without asking. Once per page appearance, and only when an address is configured.
  public func probeGatewayIfNeeded() async {
    guard gateway?.configured == true, gatewayProbe == nil, !gatewayBusy else { return }
    let baseURL = gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !baseURL.isEmpty else { return }
    gatewayProbe = try? await client().testGateway(
      baseURL: baseURL,
      model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
      apiKey: gatewayAPIKey
    )
  }

  public func testGateway() async {
    gatewayBusy = true
    gatewayProbe = nil
    defer { gatewayBusy = false }
    do {
      gatewayProbe = try await client().testGateway(
        baseURL: gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
        model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
        apiKey: gatewayAPIKey
      )
    } catch {
      toasts.show(.failure(error.localizedDescription))
    }
  }

  public func saveGateway() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let snapshot = try await client().saveGateway(
        baseURL: gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
        model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
        thinkingLevel: gatewayThinkingLevel.trimmingCharacters(in: .whitespacesAndNewlines),
        toolGroups: resolvedToolGroups,
        apiKey: gatewayAPIKey
      )
      gateway = snapshot.settings
      gatewayMachinePrompt = snapshot.machinePrompt
      gatewayLoaded = true
      gatewayAPIKey = ""
      gatewayProbe = nil
      gatewayLoadError = nil
      toasts.show(.success("已保存，Bot 会使用这个网关"))
      NotificationCenter.default.post(name: .botsGatewayChanged, object: nil)
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// The 提示词 page's save: the standing instruction and the two prompt switches. The page
  /// owns the persona and machine groups, so it saves the whole group set with them.
  public func savePrompts() async {
    guard let saved = await saveToolSettings(corePrompt: gatewayCorePrompt) else { return }
    gatewayCorePrompt = saved.corePrompt
    gatewayCorePromptChosen = false
    toasts.show(.success("已保存，提示词从下一轮开始生效"))
  }

  /// The Herdr page's drafts: a typed model or a picked level is stored only by its save.
  public func setHcModel(_ role: HcRole, model: String) {
    gatewayHcRolesChosen = true
    gatewayHcRoles[role].model = model
  }

  public func setHcThinkingLevel(_ role: HcRole, level: String) {
    gatewayHcRolesChosen = true
    gatewayHcRoles[role].thinkingLevel = level
  }

  /// The Herdr page's one write: the hc switch travels with the group set, and the three role
  /// rows replace the stored block together.
  public func saveHerdrSettings() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let snapshot = try await client().saveHerdrSettings(
        roles: gatewayHcRoles, toolGroups: resolvedToolGroups)
      gateway = snapshot.settings
      gatewayMachinePrompt = snapshot.machinePrompt
      if let tools = snapshot.tools { toolCatalog = tools }
      gatewayHcRoles = snapshot.settings.hc
      gatewayHcRolesChosen = false
      gatewayToolGroupsChosen = false
      gatewayLoaded = true
      NotificationCenter.default.post(name: .botsGatewayChanged, object: nil)
      toasts.show(.success("已保存，Bot 派活时按这些模型启动"))
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// Reads the two command-line tools on a page visit; a failed read is its own row, never a
  /// page-wide failure.
  public func refreshHerdrTools() async {
    for tool in HerdrTool.allCases where herdrToolStates[tool] == nil {
      herdrToolStates[tool] = .checking
    }
    for tool in HerdrTool.allCases {
      let state = await herdrToolchain.detect(tool)
      herdrToolStates[tool] = state
    }
  }

  /// Runs the vendor's installer for one tool, then re-reads what it installed.
  public func install(_ tool: HerdrTool) async {
    guard herdrInstalling == nil else { return }
    herdrInstalling = tool
    defer { herdrInstalling = nil }
    let failure = await herdrToolchain.install(tool)
    let state = await herdrToolchain.detect(tool)
    herdrToolStates[tool] = state
    if let failure {
      toasts.show(.failure(failure))
    } else if state.isInstalled {
      toasts.show(.success("\(tool.command) 已安装"))
    } else {
      toasts.show(.failure("安装脚本结束了，但没有找到 \(tool.command)"))
    }
  }

  /// The 工具 page writes each switch on its own and reports that one switch. The daemon stores
  /// the whole set, so one queued write at a time keeps the order a person flipped them and
  /// never lands an older set after a newer one. The standing instruction belongs to the 提示词
  /// page, so a switch keeps the stored one instead of its draft.
  public func commitToolGroup(_ name: String, title: String, isOn: Bool) {
    setToolGroup(name, isOn: isOn)
    let previous = toolSave
    toolSave = Task { [weak self] in
      await previous?.value
      await self?.writeToolGroups(tool: title, isOn: isOn)
    }
  }

  /// Tests wait for every queued write; a page never needs to.
  func awaitToolSaves() async {
    await toolSave?.value
  }

  private func writeToolGroups(tool: String, isOn: Bool) async {
    guard let storedPrompt = gateway?.corePrompt else { return }
    guard await saveToolSettings(corePrompt: storedPrompt) != nil else { return }
    toasts.show(.success(isOn ? "已开启 \(tool)" : "已关闭 \(tool)"))
  }

  private func saveToolSettings(corePrompt: String) async -> GatewaySettings? {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let snapshot = try await client().saveToolSettings(
        corePrompt: corePrompt, toolGroups: resolvedToolGroups)
      gateway = snapshot.settings
      gatewayMachinePrompt = snapshot.machinePrompt
      if let tools = snapshot.tools { toolCatalog = tools }
      // The answer is the set that was just sent: a switch flipped while the write was in
      // flight is the newer draft, and the queued write behind this one carries it.
      gatewayToolGroupsChosen = false
      gatewayLoaded = true
      NotificationCenter.default.post(name: .botsGatewayChanged, object: nil)
      return snapshot.settings
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
      return nil
    }
  }

  private var resolvedToolGroups: [String] {
    Self.normalizeToolGroups(gatewayToolGroups)
  }

  private static func normalizeToolGroups(_ groups: [String]) -> [String] {
    let chosen = Set(groups).union(mandatoryToolGroups)
    return toolGroups.filter { chosen.contains($0) }
  }

  private func client() throws -> CatalogHTTPClient {
    let token = try TokenStore(root: botsSettings.rootURL).read()
    return CatalogHTTPClient(baseURL: botsSettings.baseURL, token: token, session: urlSession)
  }

  // MARK: - Secrets

  /// Reads the daemon's password records. A store that cannot be read is a refusal, so the
  /// page reports it instead of showing an empty list that reads as "there are none".
  public func loadSecrets() async {
    guard !secretBusy else { return }
    secretBusy = true
    defer { secretBusy = false }
    secretsGeneration += 1
    secretLoadError = nil
    // A revealed value lives for one look at this page, never across a reload.
    revealedSecrets.removeAll()
    do {
      secrets = try await client().secrets()
      await loadSecretBotTitles()
    } catch {
      secrets = []
      secretLoadError = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  /// Leaving the page forgets every revealed value and every message it produced.
  public func leaveSecrets() {
    secretsGeneration += 1
    revealedSecrets.removeAll()
  }

  /// The records every Bot on this machine reads.
  public var sharedSecrets: [Secret] { secrets.filter { $0.scope == .shared } }

  /// The records one Bot reads.
  public var botSecrets: [Secret] { secrets.filter { $0.scope == .bot } }

  /// Reveals one value, or hides it again: a value is only ever read when a person asks.
  public func revealSecret(_ secret: Secret) async {
    guard !secretBusy else { return }
    if revealedSecrets[secret.id] != nil {
      revealedSecrets.removeValue(forKey: secret.id)
      return
    }
    secretBusy = true
    defer { secretBusy = false }
    let generation = secretsGeneration
    do {
      let value = try await client().revealSecret(
        key: secret.key, scope: secret.scope, botId: secret.botId)
      // The page may have been left while this was in flight: a late value must not appear.
      guard generation == secretsGeneration else { return }
      revealedSecrets[secret.id] = value
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// Copies one value to the clipboard. The click is the only thing that writes it there.
  public func copySecret(_ secret: Secret) async {
    guard !secretBusy else { return }
    secretBusy = true
    defer { secretBusy = false }
    do {
      let value = try await client().revealSecret(
        key: secret.key, scope: secret.scope, botId: secret.botId)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(value, forType: .string)
      toasts.show(.success("已复制 \(secret.key)"))
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// Removes one record; the daemon answers 204 and the row goes with it.
  public func deleteSecret(_ secret: Secret) async {
    guard !secretBusy else { return }
    secretBusy = true
    defer { secretBusy = false }
    do {
      try await client().deleteSecret(
        key: secret.key, scope: secret.scope, botId: secret.botId)
      revealedSecrets.removeValue(forKey: secret.id)
      secrets.removeAll { $0.id == secret.id }
      toasts.show(.success("已删除 \(secret.key)"))
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// The bot that answered the card, by name when the catalog knows it.
  public func secretOwner(_ secret: Secret) -> String {
    guard let botId = secret.botId else { return "未知 Bot" }
    return secretBotTitles[botId] ?? botId
  }

  /// When the record was made.
  public func secretCreated(_ secret: Secret) -> String {
    guard let date = Self.secretDate(secret.createdAt) else { return secret.createdAt }
    return Self.secretMoment(date)
  }

  /// How long the record lives: a permanent one says so, the others count down.
  public func secretValidity(_ secret: Secret, now: Date = Date()) -> String {
    guard let expiresAt = secret.expiresAt, let date = Self.secretDate(expiresAt) else {
      return "永久"
    }
    let minutes = Int(ceil(date.timeIntervalSince(now) / 60))
    guard minutes > 0 else { return "已过期" }
    if minutes < 60 { return "剩余 \(minutes) 分钟" }
    return "剩余 \(Int(ceil(Double(minutes) / 60))) 小时"
  }

  /// When the record was read last, and by whom.
  public func secretLastUsed(_ secret: Secret) -> String {
    guard let at = secret.lastUsedAt, let date = Self.secretDate(at) else { return "最近使用：无" }
    let who = secret.lastUsedBy == "person" ? "人" : "Bot"
    return "最近使用：\(Self.secretMoment(date))（\(who)）"
  }

  /// The bots behind the records, so a row names a bot instead of an id.
  private func loadSecretBotTitles() async {
    guard let catalog = try? await client().load() else { return }
    secretBotTitles = Dictionary(
      catalog.bots.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
  }

  private static func secretDate(_ iso: String) -> Date? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }

  private static func secretMoment(_ date: Date) -> String {
    RelativeMoment.short(date)
  }

  // MARK: - Providers

  public func loadProviders() async {
    guard !providerBusy else { return }
    providerBusy = true
    defer { providerBusy = false }
    // A read is not an action: it clears its own refusal and reports nothing.
    providerLoadError = nil
    do {
      providers = try await client().loadProviders()
      for provider in providers where provider.isDecision {
        if providerAddresses[provider.id] == nil {
          providerAddresses[provider.id] = provider.baseUrl
        }
        if providerModels[provider.id] == nil { providerModels[provider.id] = provider.model }
      }
    } catch {
      providerLoadError = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  public func providers(in service: String) -> [ProviderSettings] {
    providers.filter { $0.service == service }
  }

  public var searchProviders: [ProviderSettings] { providers(in: ProviderSettings.searchService) }

  public var decisionProviders: [ProviderSettings] {
    providers(in: ProviderSettings.decisionService)
  }

  /// The one provider of a service in use, or nothing: the daemon enforces the same rule, and a
  /// page shows a selection this app cannot see as "no choice".
  public func selectedProvider(in service: String) -> ProviderSettings? {
    let chosen = providers.filter { $0.enabled && $0.service == service }
    return chosen.count == 1 ? chosen.first : nil
  }

  public var selectedSearchProvider: ProviderSettings? {
    selectedProvider(in: ProviderSettings.searchService)
  }

  public var selectedDecisionProvider: ProviderSettings? {
    selectedProvider(in: ProviderSettings.decisionService)
  }

  /// What the row's own buttons may offer right now: a draft must be saved before a probe, and a
  /// provider that requires a key is not testable until one is stored.
  public func canSaveProvider(_ provider: ProviderSettings) -> Bool {
    providerHasChanges(provider)
  }

  public func canTestProvider(_ provider: ProviderSettings) -> Bool {
    guard !providerHasChanges(provider) else { return false }
    return provider.hasApiKey || !provider.keyRequired
  }

  /// A typed key is a draft; for a decision provider the address and model are drafts too.
  public func providerHasChanges(_ provider: ProviderSettings) -> Bool {
    let typed = (providerKeys[provider.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !typed.isEmpty { return true }
    guard provider.isDecision else { return false }
    let address = (providerAddresses[provider.id] ?? provider.baseUrl)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let model = (providerModels[provider.id] ?? provider.model)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return address != provider.baseUrl || model != provider.model
  }

  /// Saves every draft of one provider at once: the key when one was typed, and for a decision
  /// provider the address and model, where an empty field asks for the catalogue value.
  public func saveProvider(_ id: String) async {
    guard !providerBusy else { return }
    guard let provider = providers.first(where: { $0.id == id }) else { return }
    providerBusy = true
    defer { providerBusy = false }
    let typed = (providerKeys[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let address =
      provider.isDecision
      ? (providerAddresses[id] ?? provider.baseUrl).trimmingCharacters(in: .whitespacesAndNewlines)
      : nil
    let model =
      provider.isDecision
      ? (providerModels[id] ?? provider.model).trimmingCharacters(in: .whitespacesAndNewlines)
      : nil
    do {
      let saved = try await client().saveProvider(
        id: id, apiKey: typed.isEmpty ? nil : typed, enabled: nil, baseUrl: address, model: model)
      providers = providers.map { $0.id == id ? saved : $0 }
      providerKeys[id] = ""
      if provider.isDecision {
        providerAddresses[id] = saved.baseUrl
        providerModels[id] = saved.model
      }
      providerProbe[id] = nil
      toasts.show(.success("已保存"))
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// Clears a key the provider does not need: a relay can go back to carrying its own credential.
  public func clearProviderKey(_ id: String) async {
    guard !providerBusy else { return }
    guard let provider = providers.first(where: { $0.id == id }), !provider.keyRequired else {
      return
    }
    providerBusy = true
    defer { providerBusy = false }
    do {
      let saved = try await client().saveProvider(
        id: id, apiKey: "", enabled: nil, baseUrl: nil, model: nil)
      providers = providers.map { $0.id == id ? saved : $0 }
      providerKeys[id] = ""
      providerProbe[id] = nil
      toasts.show(.success("已清除 Key"))
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  public func setProviderEnabled(_ id: String, _ enabled: Bool) async {
    guard !providerBusy else { return }
    guard let provider = providers.first(where: { $0.id == id }) else { return }
    if enabled && provider.keyRequired && !provider.hasApiKey {
      toasts.show(.failure("请先保存这个服务商的 API Key"))
      return
    }
    guard enabled ? selectedProvider(in: provider.service)?.id != id : provider.enabled else {
      return
    }
    providerBusy = true
    defer { providerBusy = false }
    do {
      let saved = try await client().saveProvider(
        id: id, apiKey: nil, enabled: enabled, baseUrl: nil, model: nil)
      providers = providers.map { other in
        if other.id == id { return saved }
        var updated = other
        // Only the same service is exclusive; the other service keeps its own choice.
        if saved.enabled && other.service == provider.service { updated.enabled = false }
        return updated
      }
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  public func testProvider(_ id: String) async {
    guard !providerBusy else { return }
    providerBusy = true
    providerProbe[id] = nil
    defer { providerBusy = false }
    do {
      providerProbe[id] = try await client().testProvider(id: id)
    } catch {
      toasts.show(.failure((error as? ClientError)?.message ?? error.localizedDescription))
    }
  }

  /// The 消耗最多 card: a bot that only searched has calls and no tokens. A bot the catalog no
  /// longer lists spent its tokens before it was deleted, so those shares add up to one 其他
  /// row instead of naming bots that are gone.
  public var usageBotRows: [UsageBotRow] {
    guard let report = usageReport else { return [] }
    let faces = usageBotFaces
    let listed = faces == nil ? report.bots : report.bots.filter { faces?[$0.botId] != nil }
    let removed = faces == nil ? [] : report.bots.filter { faces?[$0.botId] == nil }
    var rows = listed.prefix(5).map { bot in
      UsageBotRow(
        id: bot.botId, title: bot.title, detail: "",
        value: Self.usageLine(tokens: bot.totalTokens, calls: bot.calls, costUsd: bot.costUsd),
        face: faces?[bot.botId]
      )
    }
    guard !removed.isEmpty else { return rows }
    let calls = removed.compactMap(\.calls)
    rows.append(
      UsageBotRow(
        id: "other", title: "其他", detail: "\(removed.count) 个已删除的 Bot",
        value: Self.usageLine(
          tokens: removed.reduce(0) { $0 + $1.totalTokens },
          calls: calls.isEmpty ? nil : calls.reduce(0, +),
          costUsd: removed.reduce(0) { $0 + $1.costUsd }
        ),
        aggregate: true
      )
    )
    return rows
  }

  /// The 用量 sources card: models spend tokens, search spends calls.
  public var usageSourceRows: [(id: String, title: String, value: String)] {
    guard let report = usageReport, let sources = report.sources else { return [] }
    return sources.map { source in
      let title =
        switch source.source {
        case "model": "模型"
        case "search": "搜索"
        default: source.source
        }
      return (
        source.source, title,
        Self.usageLine(tokens: source.totalTokens, calls: source.calls, costUsd: source.costUsd)
      )
    }
  }

  /// One spend in words: tokens, calls and money, with the zero parts left out.
  private static func usageLine(tokens: Int, calls: Int?, costUsd: Double) -> String {
    var parts: [String] = []
    if tokens > 0 { parts.append(UsageFormat.tokens(tokens)) }
    if let calls, calls > 0 { parts.append("\(calls) 次") }
    if let cost = UsageFormat.cost(costUsd), cost != "$0" { parts.append(cost) }
    return parts.isEmpty ? "—" : parts.joined(separator: " · ")
  }

  /// One read per visit; the daemon aggregates 90 days and answers the requested window.
  public func loadUsage(days: Int = 30) async {
    guard !usageBusy else { return }
    usageBusy = true
    defer { usageBusy = false }
    let presenter = BotsPresenter()
    usageBotFaces = nil
    if let catalog = try? await client().load() {
      usageBotFaces = Dictionary(
        catalog.bots.map { ($0.id, presenter.faceStyle(for: $0)) },
        uniquingKeysWith: { first, _ in first })
    }
    do {
      usageReport = try await client().loadUsage(days: days)
    } catch {
      usageReport = nil
    }
  }

  /// The three headline numbers, already formatted for the settings rows.
  public var usageSummaryRows: [(id: String, title: String, detail: String, value: String)] {
    guard let report = usageReport else { return [] }
    func line(_ totals: UsageReport.Totals) -> String {
      Self.usageLine(tokens: totals.totalTokens, calls: totals.calls, costUsd: totals.costUsd)
    }
    return [
      ("today", "今日", "所有 Bot 的 token、调用与花费", line(report.today)),
      ("week", "近 7 天", "滚动 7 天", line(report.week)),
      ("month", "近 30 天", "滚动 30 天", line(report.month)),
    ]
  }

  /// One check per launch with a published version to reach; a development build reports its
  /// own version instead of asking.
  public func checkForUpdatesIfNeeded() async {
    guard !checkedForUpdates else { return }
    checkedForUpdates = true
    await checkForUpdates()
  }

  /// Asks the live endpoint which app version is published. A missing endpoint or an
  /// unreachable one settles quietly: no prompt is not an error.
  public func checkForUpdates() async {
    guard appVersion.isRelease else {
      updateState = .development(appVersion.short)
      return
    }
    guard let endpoint = links.updates else {
      updateState = .unavailable
      return
    }
    updateState = .checking
    var request = URLRequest(url: endpoint)
    request.timeoutInterval = 8
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard
      let (data, response) = try? await urlSession.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200,
      let published = PublishedAppVersion.parse(data)
    else {
      updateState = .unavailable
      return
    }
    updateState =
      AppVersion.isNewer(published.latest, than: appVersion.short)
      ? .available(latest: published.latest, release: published.releaseURL ?? links.release)
      : .current(appVersion.short)
  }
}

/// Rows of the account popover and the plan summary it shows.
public final class AccountMenuViewModel: ObservableObject {
  @Published public var planName: String
  @Published public var percentUsed: Int
  @Published public var userName: String

  public init(
    planName: String = "Pro",
    percentUsed: Int = 73,
    userName: String = "Zheng Li"
  ) {
    self.planName = planName
    self.percentUsed = percentUsed
    self.userName = userName
  }

  public var rows: [AccountMenuRow] {
    [
      AccountMenuRow(
        id: "plan",
        systemName: "gauge.with.dots.needle.33percent",
        title: planName,
        detail: "\(percentUsed)% 已用",
        showsChevron: true,
        kind: .plan
      ),
      AccountMenuRow(id: "mobile", systemName: "iphone", title: "获取移动版 Eagle"),
      AccountMenuRow(
        id: "support", systemName: "book", title: "支持", showsChevron: true),
      AccountMenuRow(id: "settings", systemName: "gearshape", title: "设置"),
      AccountMenuRow(
        id: "add", systemName: "person.badge.plus", title: "添加账户", separatorBefore: true),
      AccountMenuRow(
        id: "signout", systemName: "rectangle.portrait.and.arrow.right", title: "退出登录",
        destructive: true),
    ]
  }
}
