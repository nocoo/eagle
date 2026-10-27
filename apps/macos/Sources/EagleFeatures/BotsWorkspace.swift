import BotsCore
import BotsFeatures
import BotsTransport
import Combine
import EagleDesign
import Foundation
import SwiftUI

/// Where the shell finds the daemon. The token always comes from `<root>/token`; the port
/// is the daemon's default 43117. A development shell can point elsewhere with the
/// `BOTS_ROOT` / `BOTS_PORT` environment variables.
public struct BotsSettings {
  public let rootPath: String
  public let port: String

  public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
    rootPath = environment["BOTS_ROOT"] ?? TokenStore.defaultRoot.path
    port = environment["BOTS_PORT"] ?? "43117"
  }

  public var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }

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
  var entries: [TranscriptEntry] { transcript.entries }
  @Published private(set) var title = "Bots"
  @Published private(set) var subtitle = "正在连接…"
  @Published private(set) var tintIndex = 0
  @Published private(set) var selectedId: String?
  @Published private(set) var error: String?
  @Published private(set) var canRecover = false
  @Published private(set) var running = false
  /// The selected bot's live tasks, already named and nested for the inspector's 任务 section.
  @Published private(set) var tasks: [InspectorTaskRow] = []
  /// The selected bot's spend, already formatted for the inspector's 用量 section.
  @Published private(set) var usage: [InspectorUsageRow] = []
  /// The selected bot's model and reasoning level, as menus.
  @Published private(set) var choices: [InspectorChoiceRow] = []
  @Published private(set) var connection: ConnectionState = .connecting

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
    } else if canRecover || (error != nil && !running) {
      phase = .attention
      label = canRecover ? "等待恢复" : "遇到问题"
    } else {
      phase = running ? .working : .idle
      label = subtitle
    }
    return ParticipantStatus(
      label: label, phase: phase, canStop: ready && running,
      canRecover: ready && canRecover, error: error
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
          return try await client.loadGateway().configured
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
    let outbox = OutboxStore()
    return AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(conversation: connection, outbox: outbox),
      outbox: outbox
    )
  }

  var isConnected: Bool { app != nil }

  /// Every bot the sidebar can show, filed under its group; nil is 未分组. A membership
  /// that points at a group the daemon no longer lists counts as ungrouped.
  func bots(in groupId: String?) -> [BotSummary] {
    let known = Set(groups.map(\.id))
    return (app?.bots ?? []).filter {
      SidebarComposition.membership($0.groupId, known: known) == groupId
    }
  }

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
    guard app == nil else { return }
    do {
      let model = try await makeApp(settings)
      app = model
      await model.refresh()
      bind(model)
      publish()
      // The shell keeps its own landing selection (the demo workspace) unless a
      // development shell asks to open Bots directly.
      if ProcessInfo.processInfo.environment["BOTS_OPEN"] == "1", let first = app?.bots.first {
        select(first.id)
      }
      NotificationCenter.default.publisher(for: .botsGatewayChanged)
        .sink { [weak self] _ in
          Task { @MainActor [weak self] in await self?.refreshGateway() }
        }
        .store(in: &cancellables)
      await refreshGateway()
    } catch {
      subtitle = (error as? ClientError)?.message ?? error.localizedDescription
      self.error = subtitle
    }
  }

  func select(_ id: String) {
    guard let app, owns(id) else { return }
    selectedId = id
    app.select(id)
    // The sidebar's selection is the shell's, so a programmatic selection (a new bot, a
    // development shell) moves the list too.
    onSelect?(id)
    publish()
  }

  /// The selected bot as the catalog describes it, for the inspector's profile.
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

  func createBot() async {
    await createBot(title: "", label: nil, appearance: .standard)
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

  /// The conversation view model owns the only draft; the composer reads and writes it
  /// through these two members, so there is no second copy to drift.
  var draft: String { composer.text }

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
    gatewayConfigured = await gatewayProbe()
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
    // `disconnect` cancels the event task and closes the transport; the daemon then
    // releases the subscriber slot.
    app?.conversation.disconnect()
    selectedId = nil
    publish()
  }

  func dismissError() {
    app?.conversation.dismissError()
    app?.dismissError()
    publish()
  }

  func refresh() async {
    await app?.refresh()
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
        item: presenter.sidebarItem(for: bot, preview: previews[bot.id]?.text ?? "")
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
      error = nil
      // Keep the socket state visible while the catalog still lists bots to choose from.
      connection = app.bots.isEmpty ? .stopped : conversation.connection
      if !tasks.isEmpty { tasks = [] }
      if !usage.isEmpty { usage = [] }
      if !choices.isEmpty { choices = [] }
      return
    }
    if title != selected.title { title = selected.title }
    let nextTint = presenter.tintIndex(for: selected)
    if tintIndex != nextTint { tintIndex = nextTint }
    let nextSubtitle = presenter.subtitle(
      for: conversation.state, connection: conversation.connection)
    if subtitle != nextSubtitle { subtitle = nextSubtitle }
    transcript.update(conversation.state)
    let nextTasks = presenter.inspectorTasks(for: conversation.state.tasks)
    if tasks != nextTasks { tasks = nextTasks }
    let nextUsage = presenter.inspectorUsage(for: conversation.state.usage)
    if usage != nextUsage { usage = nextUsage }
    let nextChoices = presenter.agentChoices(
      for: selected, agent: conversation.state.agent, models: app.models)
    if choices != nextChoices { choices = nextChoices }
    if running != conversation.state.running { running = conversation.state.running }
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
    let next = SidebarComposition.groupSections(
      rows: rows,
      groups: groups.map { SidebarItemGroup(id: $0.id, title: $0.title) },
      collapsed: collapsed
    )
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

  /// Waits until deferred shell publish passes finish (handshake, status, etc.).
  func awaitScheduledPublishDrain() async {
    while publicationScheduled {
      await Task.yield()
      try? await Task.sleep(nanoseconds: 2_000_000)
    }
  }

  /// Yields until in-flight main-actor work (e.g. transcript projection) settles.
  func awaitShellQuiescence() async {
    await awaitScheduledPublishDrain()
    for _ in 0..<6 {
      await Task.yield()
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }
}

/// Pure presentation: domain state in, Eagle's transcript entries out
/// (docs/bots/PLAN.md, stage 5 — view models own the mapping, views only render).
struct BotsPresenter {
  func transcript(for state: ConversationState) -> [TranscriptEntry] {
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
    for (index, message) in state.messages.enumerated() {
      for row in entries(
        for: message,
        paired: paired,
        consumed: consumed,
        running: state.running,
        current: index > (lastUserIndex ?? -1)
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
    // A running tool already shows its own row; the typing row is for a silent model.
    let toolRunning = rows.contains { entry in
      switch entry {
      case .tool(_, let row): return row.isRunning
      case .toolRun(_, let rows): return rows.contains { $0.isRunning }
      default: return false
      }
    }
    if !toolRunning, let typing = typingEntry(for: state) {
      rows.append(typing)
    }
    if let unavailable = state.unavailable {
      rows.append(
        .assistant(id: "unavailable", blocks: [.note("这个 Bot 暂时不可用：\(unavailable.message)")])
      )
    }
    return rows
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

  func entries(for message: Message) -> [TranscriptEntry] {
    let (paired, consumed) = pairTools([message])
    return entries(
      for: message,
      paired: paired,
      consumed: consumed,
      running: false,
      current: true
    )
  }

  private func entries(
    for message: Message,
    paired: [ToolCallKey: ToolResult],
    consumed: Set<String>,
    running: Bool,
    current: Bool
  ) -> [TranscriptEntry] {
    switch message.role {
    case .user:
      return [.user(id: message.id, text: message.text)]
    case .tool:
      // A result whose call is on the page was consumed by that call's row; one whose call
      // was trimmed away (or never seen) is still shown, so nothing disappears.
      if consumed.contains(message.id) { return [] }
      for block in message.blocks {
        if case .toolResult(let callId, let name, let text, let isError, let durationMs) = block {
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
        case .assistant(let id, let blocks) = last
      {
        rows[rows.count - 1] = .streamingAssistant(id: id, blocks: blocks)
      }
      let notes = noteBlocks(for: message)
      if notes.isEmpty { return rows }
      if !hasTool, let last = rows.popLast() {
        // A plain answer keeps its single row: the notes belong to the same bubble.
        if case .assistant(let id, let blocks) = last {
          return rows + [.assistant(id: id, blocks: blocks + notes)]
        }
        return rows + [last] + [.assistant(id: "\(message.id)-note", blocks: notes)]
      }
      return rows + [.assistant(id: "\(message.id)-note", blocks: notes)]
    case .notice, .system:
      return [.assistant(id: message.id, blocks: [.note(message.text)])]
    }
  }

  private func noteBlocks(for message: Message) -> [AssistantTurn.Block] {
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

  /// While a run works and there is no growing text yet, the transcript shows the typing
  /// row: the first token has not arrived, or the run moved on to another round.
  func typingEntry(for state: ConversationState) -> TranscriptEntry? {
    guard state.unavailable == nil, state.running else { return nil }
    if let streaming = state.streamingMessage, !streaming.text.isEmpty { return nil }
    return .typing(id: "typing-run")
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

  func sidebarItem(for bot: BotSummary, preview: String = "") -> SidebarItem {
    SidebarItem(
      id: bot.id,
      title: bot.title,
      subtitle: preview,
      tag: bot.state == .running ? "回答中" : bot.label,
      tintIndex: tintIndex(for: bot),
      face: faceStyle(for: bot)
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

  /// The inspector's 用量 rows. Absent usage is an empty list, so the section shows its own
  /// empty state instead of three zeros.
  func inspectorUsage(for usage: Usage?) -> [InspectorUsageRow] {
    guard let usage else { return [] }
    var rows = [
      InspectorUsageRow(id: "input", label: "输入", value: Self.tokenLabel(usage.inputTokens)),
      InspectorUsageRow(id: "output", label: "输出", value: Self.tokenLabel(usage.outputTokens)),
      InspectorUsageRow(id: "total", label: "合计", value: Self.tokenLabel(usage.totalTokens)),
    ]
    if let cost = usage.costUsd {
      rows.append(InspectorUsageRow(id: "cost", label: "花费", value: Self.costLabel(cost)))
    }
    return rows
  }

  /// `812`, `12.3k`, `1.2M`: enough to read at a glance, never a long digit string.
  static func tokenLabel(_ tokens: Int) -> String {
    if tokens < 1_000 { return String(tokens) }
    if tokens < 1_000_000 {
      return String(format: "%.1fk", Double(tokens) / 1_000)
    }
    return String(format: "%.1fM", Double(tokens) / 1_000_000)
  }

  static func costLabel(_ usd: Double) -> String {
    if usd > 0 && usd < 0.01 { return "<$0.01" }
    return String(format: "$%.2f", usd)
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
