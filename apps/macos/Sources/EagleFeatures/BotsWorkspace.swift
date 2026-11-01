import BotsCore
import BotsFeatures
import BotsTransport
import Combine
import EagleDesign
import EagleDevices
import Foundation
import SwiftUI

/// Where the shell finds the daemon. The token always comes from `<root>/token`; the port
/// is the daemon's default 43117. A development shell can point elsewhere with the
/// `BOTS_ROOT` / `BOTS_PORT` environment variables.
public struct BotsSettings {
  public let rootPath: String
  public let port: String
  public let isIsolated: Bool

  public init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    bundle: URL = Bundle.main.bundleURL
  ) {
    let candidate =
      (try? DeviceHostConfiguration.load(bundle: bundle))?.profile == "device-candidate"
    let development = bundle.pathExtension != "app"
    let overrides = development ? environment : [:]
    isIsolated = candidate || overrides["BOTS_ROOT"] != nil
    rootPath =
      overrides["BOTS_ROOT"]
      ?? (candidate
        ? TokenStore.defaultRoot.path + "-device-candidate" : TokenStore.defaultRoot.path)
    port = overrides["BOTS_PORT"] ?? (candidate ? "43118" : "43117")
  }

  /// Explicit host/test injection is separate from ambient shell configuration.
  public init(rootPath: String, port: String) {
    self.rootPath = rootPath
    self.port = port
    isIsolated = true
  }

  public var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }
  public var clientDirectory: URL {
    isIsolated
      ? rootURL.appendingPathComponent("client", isDirectory: true) : AppPaths.supportDirectory
  }

  public var baseURL: URL {
    URL(string: "http://127.0.0.1:\(Int(port) ?? 43117)") ?? URL(string: "http://127.0.0.1:43117")!
  }
}

/// The Bots group in the shell's sidebar and the conversation it opens. This is the
/// window's view model for Bots: it owns the connection, the catalog, the selected bot and
/// the draft, and it republishes the domain state as Eagle's transcript entries. The views
/// only bind to it.
@MainActor
final class BotsWorkspaceViewModel: ObservableObject {
  @Published private(set) var items: [SidebarItem] = []
  /// The daemon's groups in display order, and the sidebar sections built from them.
  @Published private(set) var groups: [BotGroup] = []
  @Published private(set) var sections: [SidebarSection] = []
  /// Sections the person folded away. It is view state, so it lives with the window.
  @Published private(set) var collapsed: Set<String> = []
  let transcript = BotsTranscriptViewModel()
  let composer = BotsComposerViewModel()
  @Published private(set) var title = "Bots"
  @Published private(set) var subtitle = "正在连接…"
  @Published private(set) var tintIndex = 0
  @Published private(set) var selectedId: String?
  @Published private(set) var error: String?
  @Published private(set) var canRecover = false
  @Published private(set) var running = false
  /// A run with nothing to show yet: the wave line above the composer, not a transcript row.
  @Published private(set) var waiting = false
  /// The selected bot's live tasks, already named and nested for the inspector's 任务 section.
  @Published private(set) var tasks: [InspectorTaskRow] = []
  /// The selected bot's spend, already formatted for the inspector's 用量 section.
  @Published private(set) var usage: [InspectorUsageRow] = []
  /// The selected bot's model and reasoning level, as menus.
  @Published private(set) var choices: [InspectorChoiceRow] = []
  /// Every trigger this bot owns, with its plan and a switch: they live in the bot's own panel.
  @Published private(set) var triggerItems: [InspectorTriggerRow] = []
  @Published private(set) var connection: ConnectionState = .connecting
  /// The bot's exchanges with other bots, as the transcript folds them into one row each.
  @Published private(set) var exchanges: [PeerExchangeSummary] = []
  /// The exchange a person opened from a row; nil while no dialog is up.
  @Published private(set) var openedExchange: PeerExchange?
  private var loadingExchanges = false
  /// Whether the previous publish saw a run in flight: an exchange can only start inside one.
  private var wasRunning = false

  /// The placeholder's retry runs in a task: `start()` is async, the button is not.
  func retryConnectionAsync() async {
    guard app == nil else {
      retryConnection()
      return
    }
    subtitle = "正在连接…"
    await start()
  }

  /// The connection ended for good (no daemon): the person restarts it and asks again.
  func retryConnection() {
    guard app != nil else {
      Task { await start() }
      return
    }
    if error != nil { error = nil }
    app?.conversation.reconnect()
    publish()
  }

  var participantStatus: ParticipantStatus {
    let ready = connection == .ready && app?.conversation.hasSnapshot == true
    let phase: ParticipantStatus.Phase
    let label: String
    if !ready {
      switch connection {
      case .connecting, .reconnecting, .ready: phase = .connecting
      default: phase = .offline
      }
      label = connection == .ready ? "正在同步…" : subtitle
    } else if canRecover || connection.isFailed
      || (error != nil && !running)
    {
      phase = .attention
      label = canRecover ? "等待恢复" : (connection.isFailed ? subtitle : "遇到问题")
    } else {
      phase = running ? .working : .idle
      label = subtitle
    }
    return ParticipantStatus(
      label: label, phase: phase, canStop: ready && running,
      canRecover: ready && canRecover,
      canRetry: connection.isFailed,
      error: error
    )
  }
  /// Set only after a send was refused for a missing gateway: progressive, never a nag.
  @Published private(set) var needsModelSetup = false
  var onOpenSettings: (() -> Void)?
  private var gatewayConfigured: Bool?

  /// The shell owns the sidebar's selection; the view model reports the bot it selected.
  var onSelect: ((String) -> Void)?

  /// Builds the connected client for a shell. Injectable so the window's contract (one
  /// draft, published state) can be tested without a daemon.
  typealias AppFactory = @MainActor (BotsSettings) async throws -> AppViewModel

  private let settings: BotsSettings
  private let makeApp: AppFactory
  /// Reports the daemon's gateway state; a test injects it so start() never touches HTTP.
  private let gatewayProbe: @MainActor () async -> Bool?
  private let presenter = BotsPresenter()
  private var app: AppViewModel?
  private var connectionTask: Task<Void, Never>?
  private var connectionGeneration = UUID()
  private var rows: [SidebarBotRow] = []
  private var cancellables = Set<AnyCancellable>()
  private var publicationScheduled = false
  private var pendingRepublish = false
  private var previews: [String: (source: String, text: String)] = [:]

  init(
    settings: BotsSettings = BotsSettings(),
    makeApp: @escaping AppFactory = BotsWorkspaceViewModel.liveApp,
    gatewayProbe: (@MainActor () async -> Bool?)? = nil
  ) {
    self.settings = settings
    self.makeApp = makeApp
    self.gatewayProbe =
      gatewayProbe ?? {
        do {
          let token = try TokenStore(root: settings.rootURL).read()
          let client = CatalogHTTPClient(baseURL: settings.baseURL, token: token)
          return try await client.loadGateway().settings.configured
        } catch {
          return nil
        }
      }
  }

  /// The production factory: token from the root, the HTTP catalog and one socket per bot.
  static func liveApp(settings: BotsSettings) async throws -> AppViewModel {
    let token = try TokenStore(root: settings.rootURL).read()
    let catalog = CatalogHTTPClient(baseURL: settings.baseURL, token: token)
    // A health check first: a missing token or a stopped daemon is a setup problem, not an
    // empty catalog.
    _ = try await catalog.load()
    let connection = BotsConnection(baseURL: settings.baseURL, token: token)
    let outbox = OutboxStore(directory: settings.clientDirectory)
    return AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(conversation: connection, outbox: outbox),
      outbox: outbox,
      triggers: TriggerHTTPClient(baseURL: settings.baseURL, token: token),
      peers: PeerHTTPClient(baseURL: settings.baseURL, token: token)
    )
  }

  var isConnected: Bool { app != nil }

  /// The group a bot is filed under right now, resolved the same way, for a drop.
  func groupId(of botId: String) -> String? {
    let known = Set(groups.map(\.id))
    guard let bot = app?.bots.first(where: { $0.id == botId }) else { return nil }
    return SidebarComposition.membership(bot.groupId, known: known)
  }

  func owns(_ id: String?) -> Bool {
    guard let id else { return false }
    // Membership follows the catalog, not whether a deferred publish has projected rows yet.
    return app?.bots.contains { $0.id == id } ?? false
  }

  /// Whether a section id belongs to this window's groups (a daemon group or 未分组).
  func ownsSection(_ id: String) -> Bool {
    sections.contains { $0.id == id }
  }

  func toggleSection(_ id: String) {
    if collapsed.contains(id) {
      collapsed.remove(id)
    } else {
      collapsed.insert(id)
    }
    syncSections()
  }

  // MARK: - Groups

  /// A new group is empty and named so it is told apart from the existing ones.
  func createGroup() async {
    guard let app else { return }
    await app.createGroup(title: SidebarComposition.newGroupTitle(existing: groups.map(\.title)))
    publish()
  }

  func renameGroup(_ id: String, to title: String) async {
    guard let app else { return }
    await app.renameGroup(id, to: title)
    publish()
  }

  func deleteGroup(_ id: String) async {
    guard let app else { return }
    await app.deleteGroup(id)
    collapsed.remove(id)
    publish()
  }

  /// 上移/下移 sends the whole order once; the ends are no-ops because the menu items are
  /// disabled there.
  func reorderGroups(moving id: String, by offset: Int) async {
    guard let app else { return }
    guard let order = SidebarComposition.moved(groups.map(\.id), moving: id, by: offset) else {
      return
    }
    await app.reorderGroups(order)
    publish()
  }

  /// The gateway's model list, for the per-bot menu; loaded once per launch.
  func loadModels() async {
    await app?.loadModelsIfNeeded()
    publish()
  }

  /// Picks one of the bot's own agent values from the inspector menus.
  func choose(_ row: String, value: String) async {
    switch row {
    case "model":
      await app?.setAgent(model: value, thinkingLevel: nil)
    case "thinking":
      await app?.setAgent(model: nil, thinkingLevel: value)
    default:
      break
    }
    publish()
  }

  /// Runs one parked task again; the task list follows the daemon.
  func retryTask(_ taskId: String) async {
    await app?.retryTask(taskId)
    publish()
  }

  /// Stops one live task.
  func stopTask(_ taskId: String) async {
    await app?.stopTask(taskId)
    publish()
  }

  /// Files a bot; nil unfiles it. The bot's place inside a group is the catalog's, never
  /// something the drop changes (the daemon keeps no order of its own).
  func moveBot(_ id: String, toGroup groupId: String?) async {
    guard let app, app.bots.contains(where: { $0.id == id }) else { return }
    if let groupId, !groups.contains(where: { $0.id == groupId }) { return }
    await app.moveBot(id, toGroup: groupId)
    publish()
  }

  /// Connects once. A failure is shown in the sidebar's subtitle, not as a new surface.
  func start() async {
    guard !Task.isCancelled else { return }
    if let connectionTask {
      await connectionTask.value
      return
    }
    guard app == nil else { return }
    let generation = connectionGeneration
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.connect(generation: generation)
    }
    connectionTask = task
    await task.value
    if generation == connectionGeneration { connectionTask = nil }
  }

  private func connect(generation: UUID) async {
    do {
      let model = try await makeApp(settings)
      guard generation == connectionGeneration, !Task.isCancelled else {
        model.conversation.disconnect()
        return
      }
      await model.refresh()
      guard generation == connectionGeneration, !Task.isCancelled else {
        model.conversation.disconnect()
        return
      }
      app = model
      bind(model)
      publish()
      // The shell keeps its own landing selection (the demo workspace) unless a
      // development shell asks to open Bots directly.
      if ProcessInfo.processInfo.environment["BOTS_OPEN"] == "1", let first = app?.bots.first {
        select(first.id)
      }
      Task { await refreshExchanges() }
      NotificationCenter.default.publisher(for: .botsGatewayChanged)
        .sink { [weak self] _ in
          Task { @MainActor [weak self] in await self?.refreshGateway() }
        }
        .store(in: &cancellables)
      await refreshGateway()
    } catch {
      guard generation == connectionGeneration, !Task.isCancelled else { return }
      subtitle = (error as? ClientError)?.message ?? error.localizedDescription
      self.error = subtitle
    }
  }

  func select(_ id: String) {
    guard let app, owns(id) else { return }
    // The sender's side starts an exchange without ever receiving a peer message, so the list is
    // read on selection and again when a run settles, not only when peer traffic arrives.
    selectedId = id
    app.select(id)
    // The sidebar's selection is the shell's, so a programmatic selection (a new bot, a
    // development shell) moves the list too.
    onSelect?(id)
    publish()
    Task { await refreshExchanges() }
  }

  /// One click on a switch in the bot's own panel; the daemon republishes the list.
  func setTriggerEnabled(_ triggerId: String, _ enabled: Bool) {
    guard let app, let botId = selectedId else { return }
    Task {
      do {
        _ = try await app.setTriggerEnabled(
          botId: botId, triggerId: triggerId, enabled: enabled)
      } catch {
        self.error = (error as? ClientError)?.message ?? error.localizedDescription
      }
    }
  }

  /// One read of the bot's exchanges, for selection and for the moment a run settles.
  private func refreshExchanges() async {
    guard let app, !loadingExchanges else { return }
    loadingExchanges = true
    await app.loadExchanges()
    exchanges = app.exchanges
    loadingExchanges = false
    publish()
  }

  /// A peer message the transcript has not been told about yet: read the list once, then stop.
  /// A failure leaves the row without its count rather than inventing one.
  private func loadExchangesIfNeeded() {
    guard let app, !loadingExchanges else { return }
    let known = Set(exchanges.map(\.id))
    let seen = conversationExchangeIds(app.conversation.state)
    guard !seen.subtracting(known).isEmpty else { return }
    loadingExchanges = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      await app.loadExchanges()
      self.exchanges = app.exchanges
      self.loadingExchanges = false
      self.publish()
    }
  }

  private func conversationExchangeIds(_ state: ConversationState) -> Set<String> {
    var ids: Set<String> = []
    for message in state.messages {
      if let origin = message.origin, origin.kind == .peer, let id = origin.exchangeId {
        ids.insert(id)
      }
    }
    return ids
  }

  /// Opens one exchange: the row only carries the summary, so the round trip is read now.
  func openExchange(_ exchangeId: String) async {
    guard let app else { return }
    guard let detail = await app.peerDetail(exchangeId) else { return }
    let refs = detail.participants.map {
      presenter.peerRef(id: $0.id, title: $0.title, bots: app.bots)
    }
    var messages: [PeerMessage] = []
    for turn in detail.messages {
      let at = PeerTimeline.date(turn.at)
      if !turn.text.isEmpty {
        messages.append(
          PeerMessage(id: "\(turn.id)-q", senderId: turn.fromBotId, text: turn.text, at: at))
      }
      if let answer = turn.answer, !answer.isEmpty {
        messages.append(
          PeerMessage(id: "\(turn.id)-a", senderId: turn.toBotId, text: answer, at: nil))
      }
    }
    openedExchange = PeerExchange(
      id: detail.id,
      participants: refs,
      messages: messages,
      count: detail.messages.reduce(0) { $0 + 1 + ($1.answer == nil ? 0 : 1) }
    )
  }

  func closeExchange() {
    if openedExchange != nil { openedExchange = nil }
  }

  /// The selected bot as the catalog describes it, for the inspector's profile.
  /// The reported pull requests as the 编码 section draws them, newest first.
  var pullRows: [InspectorPullRow] {
    (app?.conversation.pulls ?? []).map { pull in
      InspectorPullRow(
        id: pull.url,
        title: pull.title,
        host: pull.host,
        status: pull.status,
        url: pull.url
      )
    }
  }

  var selectedBot: BotSummary? {
    guard let app, let selectedId else { return nil }
    return app.bots.first { $0.id == selectedId }
  }

  var selectedFace: BotFace.Style? {
    selectedBot.map { presenter.faceStyle(for: $0) }
  }

  var selectedLabel: String? {
    selectedBot?.label
  }

  /// Name, label (empty clears it) or face edit for the selected bot.
  func updateSelected(
    title: String? = nil,
    label: String? = nil,
    appearance: BotAppearance? = nil
  ) async {
    guard let app, let bot = selectedBot else { return }
    await app.update(bot, title: title, label: label, appearance: appearance)
    publish()
  }

  /// A created bot is real immediately: the daemon writes it, the catalog returns it, and
  /// the sidebar selects it.
  func createBot(title: String, label: String?, appearance: BotAppearance) async {
    guard let app else { return }
    await app.createBot(title: title, label: label, appearance: appearance)
    if let created = app.selection {
      selectedId = created
      onSelect?(created)
    }
    publish()
  }

  func rename(_ id: String, to title: String) async {
    guard let app, let bot = app.bots.first(where: { $0.id == id }) else { return }
    await app.rename(bot, to: title)
    publish()
  }

  func remove(_ id: String) async {
    guard let app, let bot = app.bots.first(where: { $0.id == id }) else { return }
    await app.delete(bot)
    if selectedId == id {
      selectedId = app.selection
      if let next = app.selection { onSelect?(next) }
    }
    publish()
  }

  func setDraft(_ value: String) {
    guard let conversation = app?.conversation else { return }
    conversation.writeDraft(value)
    if composer.text != value { composer.text = value }
  }

  func send(inserting: Bool = false) {
    guard let app else { return }
    // Only a known-missing gateway blocks; an unreachable settings endpoint must not turn
    // a working bot into a dead composer.
    if gatewayConfigured == false {
      needsModelSetup = true
      return
    }
    app.conversation.send(inserting: inserting)
    mirrorConversationDraftIntoComposer()
    publish()
  }

  func dismissModelSetup() {
    needsModelSetup = false
  }

  /// Reads the daemon's gateway state silently; it is shown only when a send is refused.
  private func refreshGateway() async {
    guard let current = app else { return }
    let configured = await gatewayProbe()
    guard app === current, !Task.isCancelled else { return }
    gatewayConfigured = configured
    if gatewayConfigured == true { needsModelSetup = false }
  }

  func recover() {
    app?.conversation.recover()
    publish()
  }

  func abort() {
    guard participantStatus.canStop else { return }
    app?.conversation.abort()
    publish()
  }

  /// The window is gone: its socket must go too, or the daemon keeps a subscriber.
  func disconnect() {
    connectionGeneration = UUID()
    connectionTask?.cancel()
    connectionTask = nil
    cancellables.removeAll()
    // `disconnect` cancels the event task and closes the transport; the daemon then
    // releases the subscriber slot.
    app?.conversation.disconnect()
    app = nil
    selectedId = nil
    connection = .stopped
    running = false
    waiting = false
    canRecover = false
    gatewayConfigured = nil
    needsModelSetup = false
    error = nil
    publish()
  }

  func dismissError() {
    app?.conversation.dismissError()
    app?.dismissError()
    publish()
  }

  /// Domain state in, Eagle's transcript out. Called after every published change.
  private func publish() {
    guard let app else {
      if !items.isEmpty { items = [] }
      if !groups.isEmpty { groups = [] }
      if !sections.isEmpty { sections = [] }
      rows = []
      transcript.clear()
      if !tasks.isEmpty { tasks = [] }
      if !usage.isEmpty { usage = [] }
      if !choices.isEmpty { choices = [] }
      if !triggerItems.isEmpty { triggerItems = [] }
      if waiting { waiting = false }
      return
    }
    let conversation = app.conversation
    if conversation.hasSnapshot {
      let state = conversation.state
      let source = presenter.previewSource(for: state)
      if previews[state.botId]?.source != source {
        previews[state.botId] = (source, MarkdownDocument.plainText(source))
      }
    }
    let ids = Set(app.bots.map(\.id))
    previews = previews.filter { ids.contains($0.key) }
    if groups != app.groups { groups = app.groups }
    let nextRows = app.bots.map { bot in
      SidebarBotRow(
        groupId: bot.groupId,
        item: presenter.sidebarItem(
          for: bot,
          preview: previews[bot.id]?.text ?? "",
          running: bot.id == app.selection ? conversation.state.running : nil
        )
      )
    }
    if rows != nextRows { rows = nextRows }
    let nextItems = nextRows.map(\.item)
    if items != nextItems { items = nextItems }
    syncSections()
    if app.selection != selectedId, let next = app.selection {
      selectedId = next
      onSelect?(next)
      mirrorConversationDraftIntoComposer()
    }
    guard let selected = app.bots.first(where: { $0.id == app.selection }) else {
      title = "Bots"
      subtitle = app.bots.isEmpty ? "还没有 Bot，点 + 新建一个" : "选择一个 Bot"
      transcript.clear()
      canRecover = false
      running = false
      waiting = false
      error = nil
      // Keep the socket state visible while the catalog still lists bots to choose from.
      connection = app.bots.isEmpty ? .stopped : conversation.connection
      if !tasks.isEmpty { tasks = [] }
      if !usage.isEmpty { usage = [] }
      if !choices.isEmpty { choices = [] }
      if !triggerItems.isEmpty { triggerItems = [] }
      return
    }
    if title != selected.title { title = selected.title }
    let nextTint = presenter.tintIndex(for: selected)
    if tintIndex != nextTint { tintIndex = nextTint }
    let nextSubtitle = presenter.subtitle(
      for: conversation.state, connection: conversation.connection)
    if subtitle != nextSubtitle { subtitle = nextSubtitle }
    transcript.update(conversation.state, exchanges: exchanges, bots: app.bots)
    loadExchangesIfNeeded()
    let nextTasks = presenter.inspectorTasks(for: conversation.state.tasks)
    if tasks != nextTasks { tasks = nextTasks }
    let nextUsage = presenter.inspectorUsage(for: conversation.state.usage)
    if usage != nextUsage { usage = nextUsage }
    let nextChoices = presenter.agentChoices(
      for: selected, agent: conversation.state.agent, models: app.models)
    if choices != nextChoices { choices = nextChoices }
    let nextTriggers = conversation.state.triggers.map { trigger in
      InspectorTriggerRow(
        id: trigger.id,
        name: trigger.name,
        detail: presenter.triggerSubtitle(trigger),
        isOn: trigger.enabled
      )
    }
    if triggerItems != nextTriggers { triggerItems = nextTriggers }
    if running != conversation.state.running { running = conversation.state.running }
    let nextWaiting = presenter.isWaiting(for: conversation.state)
    if waiting != nextWaiting { waiting = nextWaiting }
    noteRunSettled(conversation.state.running)
    if connection != conversation.connection { connection = conversation.connection }
    let nextRecover = conversation.state.unavailable != nil || conversation.parked
    if canRecover != nextRecover { canRecover = nextRecover }
    let nextError = conversation.errorBanner ?? app.error
    if error != nextError {
      error = nextError
      mirrorConversationDraftIntoComposer()
    }
  }

  /// The sidebar is rebuilt only when its sections actually change: a delta repaint must
  /// not invalidate it.
  private func syncSections() {
    let botSections = SidebarComposition.groupSections(
      rows: rows,
      groups: groups.map { SidebarItemGroup(id: $0.id, title: $0.title) },
      collapsed: collapsed
    )
    let next = botSections
    if sections != next { sections = next }
  }

  private func mirrorConversationDraftIntoComposer() {
    guard let conversation = app?.conversation else { return }
    let next = conversation.draft
    if composer.text != next { composer.text = next }
  }

  /// The conversation view model publishes many times per answer (one delta each), so the
  /// mapping runs on the next run loop turn rather than inside the notification.
  private func bind(_ app: AppViewModel) {
    cancellables.removeAll()
    let conversation = app.conversation
    app.objectWillChange
      .sink { [weak self] _ in self?.schedulePublish() }
      .store(in: &cancellables)
    // Draft edits repaint only the composer; they must not remap the sidebar or transcript.
    Publishers.MergeMany(
      conversation.$connection.map { _ in }.eraseToAnyPublisher(),
      conversation.$hasSnapshot.map { _ in }.eraseToAnyPublisher(),
      conversation.$state.map { _ in }.eraseToAnyPublisher(),
      conversation.$errorBanner.map { _ in }.eraseToAnyPublisher(),
      conversation.$parked.map { _ in }.eraseToAnyPublisher(),
      conversation.$isSending.map { _ in }.eraseToAnyPublisher(),
      conversation.$hasOlder.map { _ in }.eraseToAnyPublisher()
    )
    .sink { [weak self] _ in self?.schedulePublish() }
    .store(in: &cancellables)
    conversation.$hasSnapshot.removeDuplicates()
      .sink { [weak transcript] _ in transcript?.objectWillChange.send() }
      .store(in: &cancellables)
  }

  /// A run settling is when a peer send can have created an exchange: read the list once.
  private func noteRunSettled(_ isRunning: Bool) {
    if wasRunning, !isRunning {
      Task { await refreshExchanges() }
    }
    wasRunning = isRunning
  }

  private func schedulePublish() {
    if publicationScheduled {
      pendingRepublish = true
      return
    }
    publicationScheduled = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      repeat {
        self.pendingRepublish = false
        self.publish()
      } while self.pendingRepublish
      self.publicationScheduled = false
    }
  }
}

/// Pure presentation: domain state in, Eagle's transcript entries out
/// (docs/bots/PLAN.md, stage 5 — view models own the mapping, views only render).
struct BotsPresenter {
  /// Tools a Bot uses to talk to another Bot. They are not the person's conversation, so the
  /// transcript folds them away with the peer messages themselves (see `peerExchangeRow`).
  static let peerTools: Set<String> = ["peer_list", "peer_send", "peer_read"]

  func transcript(
    for state: ConversationState,
    exchanges: [PeerExchangeSummary] = [],
    bots: [BotSummary] = []
  ) -> [TranscriptEntry] {
    let (paired, consumed) = pairTools(state.messages)
    // A call can only be executing within the run that sent it: once a newer user message
    // exists, an old call without a result belongs to a finished run and must not spin.
    let lastUserIndex = state.messages.lastIndex { $0.role == .user }
    var rows: [TranscriptEntry] = []
    var pendingTools: [ToolRow] = []
    func flushTools() {
      guard !pendingTools.isEmpty else { return }
      if pendingTools.count == 1, let only = pendingTools.first {
        rows.append(.tool(id: only.id, row: only))
      } else {
        rows.append(.toolRun(id: "run-\(pendingTools[0].id)", rows: pendingTools))
      }
      pendingTools.removeAll()
    }
    let peerCalls = peerCallIds(state.messages)
    /// Every exchange this bot is in becomes one row, placed where it started: the sender's side
    /// shows it too, so both chats carry the same entry.
    var pending =
      exchanges
      .compactMap { summary -> (updatedAt: String, exchange: PeerExchange)? in
        guard
          let row = peerExchangeRow(exchangeId: summary.id, exchanges: exchanges, bots: bots)
        else { return nil }
        return (summary.updatedAt, row)
      }
      .sorted { $0.updatedAt < $1.updatedAt }
    var nextExchange = 0
    func flushExchanges(upTo instant: String?) {
      while nextExchange < pending.count {
        let item = pending[nextExchange]
        guard instant == nil || item.updatedAt <= instant! else { return }
        rows.append(.peerExchange(id: item.exchange.id, exchange: item.exchange))
        nextExchange += 1
      }
    }
    /// True while the transcript is still inside the run a peer message started: that answer and
    /// its tool rows belong to the exchange, not to this chat with the person.
    var insidePeerRun = false
    for (index, message) in state.messages.enumerated() {
      if message.role == .user {
        // A person's turn ends the run before it: an exchange that moved in that run belongs
        // above this message, after the answer the run gave.
        if message.origin?.kind != .peer {
          insidePeerRun = false
          flushExchanges(upTo: message.createdAt)
        } else {
          insidePeerRun = true
          continue
        }
      }
      if insidePeerRun { continue }
      for row in entries(
        for: message,
        paired: paired,
        consumed: consumed,
        running: state.running,
        current: index > (lastUserIndex ?? -1),
        skipCalls: peerCalls
      ) {
        if case .tool(_, let tool) = row {
          pendingTools.append(tool)
        } else {
          flushTools()
          rows.append(row)
        }
      }
    }
    flushTools()
    flushExchanges(upTo: nil)
    if let unavailable = state.unavailable {
      rows.append(
        .assistant(id: "unavailable", blocks: [.note("这个 Bot 暂时不可用：\(unavailable.message)")])
      )
    }
    return rows
  }

  /// The one line a chat keeps about an exchange: how many messages passed, and between whom.
  /// Nil while the daemon's list has not arrived: a row with an invented count is worse than none.
  private func peerExchangeRow(
    exchangeId: String,
    exchanges: [PeerExchangeSummary],
    bots: [BotSummary]
  ) -> PeerExchange? {
    guard
      let summary = exchanges.first(where: { $0.id == exchangeId }),
      !summary.participants.isEmpty
    else { return nil }
    return PeerExchange(
      id: exchangeId,
      participants: summary.participants.map { peerRef(id: $0.id, title: $0.title, bots: bots) },
      messages: [],
      count: summary.count
    )
  }

  /// A participant with the bot's own face and tint, so two bots never look alike.
  func peerRef(id: String, title: String, bots: [BotSummary]) -> PeerRef {
    guard let bot = bots.first(where: { $0.id == id }) else {
      return PeerRef(
        id: id, title: title, face: nil,
        tintIndex: abs(id.hashValue) % Theme.Palette.avatarTints.count)
    }
    return PeerRef(
      id: id,
      title: bot.title,
      face: faceStyle(for: bot),
      tintIndex: tintIndex(for: bot)
    )
  }

  private struct ToolResult {
    let messageId: String
    let text: String
    let isError: Bool
    let durationMs: Int?
  }

  private struct ToolCallKey: Hashable {
    let messageId: String
    let block: Int
  }

  private struct CallRef {
    let key: ToolCallKey
    let messageIndex: Int
    let callId: String
  }

  /// A result pairs with the **latest unmatched call of the same id before it**. A repeated
  /// `callId` therefore keeps each round's own result, and a call trimmed out of the page
  /// leaves its result orphaned instead of shifting every later pairing by one. A result
  /// with no preceding unmatched call stays unconsumed, so it is rendered as its own row.
  private func pairTools(_ messages: [Message]) -> ([ToolCallKey: ToolResult], Set<String>) {
    var calls: [CallRef] = []
    for (messageIndex, message) in messages.enumerated() where message.role == .assistant {
      for (blockIndex, block) in message.blocks.enumerated() {
        guard case .toolCall(let callId, _, _) = block else { continue }
        calls.append(
          CallRef(
            key: ToolCallKey(messageId: message.id, block: blockIndex),
            messageIndex: messageIndex,
            callId: callId
          )
        )
      }
    }
    var used: Set<Int> = []
    var paired: [ToolCallKey: ToolResult] = [:]
    var consumed: Set<String> = []
    for (messageIndex, message) in messages.enumerated() where message.role == .tool {
      for block in message.blocks {
        guard case .toolResult(let callId, _, let text, let isError, let durationMs) = block else {
          continue
        }
        let match = calls.indices.last { index in
          let call = calls[index]
          return call.callId == callId && call.messageIndex < messageIndex
            && !used.contains(index)
        }
        guard let match else { continue }
        used.insert(match)
        paired[calls[match].key] = ToolResult(
          messageId: message.id,
          text: text,
          isError: isError,
          durationMs: durationMs
        )
        consumed.insert(message.id)
      }
    }
    return (paired, consumed)
  }

  /// Every call id that belongs to a peer tool, so the call row and its result both stay out of
  /// the transcript: the exchange row speaks for them.
  private func peerCallIds(_ messages: [Message]) -> Set<String> {
    var ids: Set<String> = []
    for message in messages where message.role == .assistant {
      for block in message.blocks {
        if case .toolCall(let callId, let name, _) = block, Self.peerTools.contains(name) {
          ids.insert(callId)
        }
      }
    }
    return ids
  }

  private func entries(
    for message: Message,
    paired: [ToolCallKey: ToolResult],
    consumed: Set<String>,
    running: Bool,
    current: Bool,
    skipCalls: Set<String> = []
  ) -> [TranscriptEntry] {
    switch message.role {
    case .user:
      // A message whose cause was not a person typing says so above its text.
      return [.user(id: message.id, text: message.text, origin: message.origin?.chip)]
    case .tool:
      // A result whose call is on the page was consumed by that call's row; one whose call
      // was trimmed away (or never seen) is still shown, so nothing disappears.
      if consumed.contains(message.id) { return [] }
      for block in message.blocks {
        if case .toolResult(let callId, let name, let text, let isError, let durationMs) = block {
          if skipCalls.contains(callId) { return [] }
          return [
            .tool(
              id: "result-\(message.id)-\(callId)",
              row: ToolRow(
                id: "result-\(message.id)-\(callId)",
                name: name,
                subtitle: "",
                output: text,
                isError: isError,
                durationMs: durationMs
              )
            )
          ]
        }
      }
      return []
    case .assistant:
      var rows: [TranscriptEntry] = []
      var text = ""
      var runs = 0
      var hasTool = false
      func flush() {
        guard !text.isEmpty else { return }
        rows.append(
          .assistant(
            id: runs == 0 ? message.id : "\(message.id)-t\(runs)",
            blocks: [.paragraph(text)]
          )
        )
        text = ""
        runs += 1
      }
      for (blockIndex, block) in message.blocks.enumerated() {
        switch block {
        case .text(let value):
          text += value
        case .thinking:
          continue
        case .toolCall(let callId, let name, let args):
          if skipCalls.contains(callId) { continue }
          hasTool = true
          flush()
          let result = paired[ToolCallKey(messageId: message.id, block: blockIndex)]
          rows.append(
            .tool(
              id: "call-\(message.id)-\(blockIndex)",
              row: ToolRow(
                id: "call-\(message.id)-\(blockIndex)",
                name: name,
                subtitle: summary(of: args),
                input: args.isEmpty ? "" : JSONValue.object(args).pretty,
                output: result?.text,
                isError: result?.isError ?? false,
                isRunning: result == nil && running && current,
                durationMs: result?.durationMs
              )
            )
          )
        case .toolResult:
          continue
        }
      }
      flush()
      if rows.isEmpty, message.state == .streaming { return [] }
      if message.state == .streaming, let last = rows.last,
        case .assistant(let id, let blocks, _) = last
      {
        rows[rows.count - 1] = .streamingAssistant(id: id, blocks: blocks)
      }
      let notes = noteBlocks(for: message)
      if notes.isEmpty { return rows }
      if !hasTool, let last = rows.popLast() {
        // A plain answer keeps its single row: the notes belong to the same bubble.
        if case .assistant(let id, let blocks, let from) = last {
          return rows + [.assistant(id: id, blocks: blocks + notes, from: from)]
        }
        return rows + [last] + [.assistant(id: "\(message.id)-note", blocks: notes)]
      }
      return rows + [.assistant(id: "\(message.id)-note", blocks: notes)]
    case .notice, .system:
      return [.assistant(id: message.id, blocks: [.note(message.text)])]
    }
  }

  private func noteBlocks(for message: Message) -> [AssistantBlock] {
    if message.state == .aborted { return [.note("回答已中止")] }
    if message.state == .error { return [.note("回答失败，可以重新发送。")] }
    if message.stopReason == .length { return [.note("回答因为长度上限被截断。")] }
    return []
  }

  /// One line for the row: the arguments a person would ask for first.
  private func summary(of args: [String: JSONValue]) -> String {
    let preferred = ["command", "path", "target", "text", "kind", "name"]
    var parts: [String] = []
    var used: Set<String> = []
    for key in preferred {
      guard let value = args[key] else { continue }
      parts.append("\(key)=\(scalar(value))")
      used.insert(key)
      if parts.count == 2 { break }
    }
    if parts.count < 2 {
      for key in args.keys.sorted() where !used.contains(key) {
        guard let value = args[key] else { continue }
        parts.append("\(key)=\(scalar(value))")
        if parts.count == 2 { break }
      }
    }
    let joined = parts.joined(separator: " · ")
    return joined.count > 96 ? String(joined.prefix(95)) + "…" : joined
  }

  private func scalar(_ value: JSONValue) -> String {
    switch value {
    case .string(let text):
      return text.count > 48 ? String(text.prefix(47)) + "…" : text
    case .null:
      return "null"
    case .bool, .number:
      return value.compact
    case .array, .object:
      let compact = value.compact
      return compact.count > 48 ? String(compact.prefix(47)) + "…" : compact
    }
  }

  /// Whether the bot is working with nothing to show yet: no growing text and no tool of its
  /// own still executing. The window draws this as the wave line above the composer, never as
  /// a transcript row, so starting and settling cannot move a message.
  func isWaiting(for state: ConversationState) -> Bool {
    guard state.unavailable == nil, state.running else { return false }
    if let streaming = state.streamingMessage, !streaming.text.isEmpty { return false }
    return !hasRunningTool(state)
  }

  /// A call inside the newest run that has no result yet: the tool row is already the sign of
  /// work, so the wave line stays away.
  private func hasRunningTool(_ state: ConversationState) -> Bool {
    let (paired, _) = pairTools(state.messages)
    let lastUserIndex = state.messages.lastIndex { $0.role == .user }
    for (messageIndex, message) in state.messages.enumerated() where message.role == .assistant {
      for (blockIndex, block) in message.blocks.enumerated() {
        guard case .toolCall(_, let name, _) = block,
          !Self.peerTools.contains(name),
          paired[ToolCallKey(messageId: message.id, block: blockIndex)] == nil,
          messageIndex > (lastUserIndex ?? -1)
        else { continue }
        return true
      }
    }
    return false
  }

  func subtitle(for state: ConversationState, connection: ConnectionState) -> String {
    switch connection {
    case .connecting: return "正在连接…"
    case .ready:
      if state.unavailable != nil { return "不可用" }
      if state.running {
        return state.streamingMessage?.text.isEmpty == false ? "回答中" : "处理中"
      }
      return "已连接"
    case .reconnecting(let attempt): return "正在重连（第 \(attempt) 次）"
    case .failed(let reason): return reason
    case .stopped: return "已断开"
    }
  }

  func tintIndex(for bot: BotSummary) -> Int {
    abs(bot.id.hashValue) % Theme.Palette.avatarTints.count
  }

  /// `running` overrides the catalog for the open bot: its own socket knows the run before the
  /// daemon's catalog round trip does, so every surface showing that bot moves together.
  /// The bot's own note wins: it is written for this row. A bot that never wrote one falls
  /// back to the preview the opened conversation produced, and to nothing otherwise.
  func sidebarItem(for bot: BotSummary, preview: String = "", running: Bool? = nil) -> SidebarItem {
    let note = (bot.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return SidebarItem(
      id: bot.id,
      title: bot.title,
      subtitle: note.isEmpty ? preview : note,
      tag: bot.label,
      tintIndex: tintIndex(for: bot),
      face: faceStyle(for: bot),
      busy: running ?? (bot.state == .running)
    )
  }

  /// The daemon's closed sets and Eagle's are the same ids, so the picker and the row
  /// draw what the user chose.
  func faceStyle(for bot: BotSummary) -> BotFace.Style {
    BotFace.Style(
      shape: BotFace.Shape(rawValue: bot.face.shape.rawValue) ?? .blob,
      tint: Theme.Palette.BotTint(rawValue: bot.face.tint.rawValue) ?? .green
    )
  }

  // MARK: - Inspector tasks

  /// The task kind in the person's words. A kind the client does not know keeps its wire
  /// name, which is still more useful than a guess.
  func taskTitle(for kind: String) -> String {
    switch kind {
    case "pi.generation": return "生成回答"
    case "pi.tool": return "工具调用"
    case "pi.compaction": return "上下文压缩"
    default: return Self.isSubAgent(kind) ? "子 Agent" : kind
    }
  }

  func taskSymbol(for kind: String) -> String {
    switch kind {
    case "pi.generation": return "sparkles"
    case "pi.tool": return "wrench.and.screwdriver"
    case "pi.compaction": return "rectangle.compress.vertical"
    default: return Self.isSubAgent(kind) ? "person.2" : "circle.dashed"
    }
  }

  /// A task that cannot run here says why, because "等待" would hide a task that never moves.
  func taskStatusLabel(_ status: TaskStatus, blocked: String?) -> String {
    if let blocked { return "已停放：\(Self.blockedReason(blocked))" }
    switch status {
    case .pending: return "排队"
    case .running: return "运行中"
    case .waiting: return "等待"
    case .sleeping: return "休眠"
    case .completing: return "收尾"
    default: return status.rawValue
    }
  }

  /// The inspector's 模型 rows: the bot's own model and reasoning level, each a menu of the
  /// values the daemon accepts.
  func agentChoices(
    for bot: BotSummary, agent: AgentView?, models: [String]
  ) -> [InspectorChoiceRow] {
    let modelChoices =
      models.contains(bot.model.modelId) || models.isEmpty
      ? models
      : [bot.model.modelId] + models
    return [
      InspectorChoiceRow(
        id: "model",
        label: "模型",
        value: bot.model.modelId,
        selected: bot.model.modelId,
        choices: modelChoices.map { InspectorChoiceRow.Choice(id: $0, title: $0) }
      ),
      InspectorChoiceRow(
        id: "thinking",
        label: "思考等级",
        value: Self.thinkingLabel(agent?.thinkingLevel ?? "medium"),
        selected: agent?.thinkingLevel ?? "medium",
        choices: Self.thinkingLevels.map {
          InspectorChoiceRow.Choice(id: $0, title: $0)
        }
      ),
    ]
  }

  static let thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

  static func thinkingLabel(_ level: String) -> String {
    switch level {
    case "off": return "关闭"
    case "minimal": return "极低"
    case "low": return "低"
    case "medium": return "中"
    case "high": return "高"
    case "xhigh": return "极高"
    case "max": return "最高"
    default: return level
    }
  }

  // MARK: - Triggers

  /// One row's second line: what it is, when it is next due, and whether it lost anything.
  func triggerSubtitle(_ trigger: TriggerSummary) -> String {
    let kind = trigger.kind == .schedule ? "定时" : "Webhook"
    var parts = [kind]
    if let schedule = trigger.schedule {
      if let next = schedule.nextDueAt, let shown = Self.dueLabel(next, zone: schedule.timezone) {
        parts.append("下次 \(shown)")
      } else {
        parts.append(schedule.cron)
      }
    }
    if let warning = trigger.warning { parts.append(warning) }
    if !trigger.enabled { parts.append("已停用") }
    return parts.joined(separator: " · ")
  }

  /// An ISO instant in the trigger's own zone, so the row and the schedule agree.
  static func dueLabel(_ iso: String, zone: String) -> String? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
      return nil
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: zone) ?? .current
    formatter.dateFormat = "MM-dd HH:mm"
    return formatter.string(from: date)
  }

  /// The inspector's 用量 rows. Absent usage is an empty list, so the section shows its own
  /// empty state instead of three zeros.
  func inspectorUsage(for usage: Usage?) -> [InspectorUsageRow] {
    guard let usage else { return [] }
    var rows = [
      InspectorUsageRow(id: "input", label: "输入", value: UsageFormat.tokens(usage.inputTokens)),
      InspectorUsageRow(id: "output", label: "输出", value: UsageFormat.tokens(usage.outputTokens)),
      InspectorUsageRow(id: "total", label: "合计", value: UsageFormat.tokens(usage.totalTokens)),
    ]
    if let cost = usage.costUsd {
      rows.append(
        InspectorUsageRow(id: "cost", label: "花费", value: UsageFormat.cost(cost) ?? "$0"))
    }
    return rows
  }

  /// The inspector's 任务 rows: parents before children, a child indented under its owner.
  /// A task whose owner is missing — or that sits in a cycle — stays a root instead of
  /// disappearing or nesting forever.
  func inspectorTasks(for tasks: [TaskSummary]) -> [InspectorTaskRow] {
    let depths = taskDepths(tasks)
    var children: [String: [TaskSummary]] = [:]
    var roots: [TaskSummary] = []
    for task in tasks {
      let depth = depths[task.id] ?? 0
      if depth == 0 {
        roots.append(task)
      } else if let owner = task.owner {
        children[owner, default: []].append(task)
      }
    }
    var rows: [InspectorTaskRow] = []
    var emitted: Set<String> = []
    func emit(_ task: TaskSummary, _ depth: Int) {
      guard emitted.insert(task.id).inserted else { return }
      rows.append(row(for: task, depth: min(depth, Self.maxTaskDepth)))
      for child in children[task.id] ?? [] {
        emit(child, depth + 1)
      }
    }
    for root in roots {
      emit(root, 0)
    }
    // Anything a cycle kept out of the tree is still shown, flat, rather than dropped.
    for task in tasks {
      emit(task, depths[task.id] ?? 0)
    }
    return rows
  }

  /// How many owners a task has above it; a cycle has no root, so it reads as a root, and an
  /// owner the frame no longer lists is not an owner at all.
  func taskDepths(_ tasks: [TaskSummary]) -> [String: Int] {
    let known = Set(tasks.map(\.id))
    var owners: [String: String] = [:]
    for task in tasks {
      guard let owner = task.owner, known.contains(owner) else { continue }
      owners[task.id] = owner
    }
    var depths: [String: Int] = [:]
    for task in tasks {
      var depth = 0
      var visited: Set<String> = [task.id]
      var owner = owners[task.id]
      while let current = owner {
        guard visited.insert(current).inserted else {
          depth = 0
          break
        }
        depth += 1
        owner = owners[current]
      }
      depths[task.id] = min(depth, Self.maxTaskDepth)
    }
    return depths
  }

  private static let maxTaskDepth = 3

  private static func isSubAgent(_ kind: String) -> Bool {
    kind == "bots.agents" || kind.hasPrefix("bots.agents.")
  }

  private static func blockedReason(_ code: String) -> String {
    switch code {
    case "restart_limit": return "重试次数过多"
    case "missing_task": return "任务定义缺失"
    case "task_too_old": return "任务过旧"
    case "migration_failed": return "迁移失败"
    default: return code
    }
  }

  private func row(for task: TaskSummary, depth: Int) -> InspectorTaskRow {
    InspectorTaskRow(
      id: task.id,
      title: taskTitle(for: task.kind),
      symbolName: taskSymbol(for: task.kind),
      status: taskStatusLabel(task.status, blocked: task.blocked),
      depth: depth,
      isRunning: task.status == .running,
      isBlocked: task.blocked != nil
    )
  }

  func previewSource(for state: ConversationState) -> String {
    for message in state.messages.reversed()
    where message.role == .user || message.role == .assistant {
      var source = ""
      for block in message.blocks {
        guard case .text(let text) = block else { continue }
        source += text.prefix(160 - source.count)
        if source.count == 160 { break }
      }
      let preview = source.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      if !preview.isEmpty { return preview }
    }
    return ""
  }
}

/// Shown only after a send was refused because no model gateway is configured. It is a
/// hint, not a startup nag: the conversation stays usable for reading until then.
struct BotsModelSetupBanner: View {
  let onOpen: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "sparkles")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.Palette.info)
      VStack(alignment: .leading, spacing: 2) {
        Text("还没有配置模型网关")
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(Theme.Palette.textPrimary)
        Text("在设置里填入网关地址、API Key 和模型后，这个 Bot 就能回答。")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      Spacer(minLength: 8)
      Button("去设置", action: onOpen)
        .buttonStyle(.plain)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.Palette.info)
      IconButton(systemName: "xmark", label: "关闭提示", size: 20, style: .plain, action: onDismiss)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 9)
    .background(Theme.Palette.infoFill)
  }
}
