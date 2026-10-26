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
  let transcript = BotsTranscriptViewModel()
  var entries: [TranscriptEntry] { transcript.entries }
  @Published private(set) var title = "Bots"
  @Published private(set) var subtitle = "正在连接…"
  @Published private(set) var tintIndex = 0
  @Published private(set) var selectedId: String?
  @Published private(set) var error: String?
  @Published private(set) var canRecover = false
  @Published private(set) var running = false
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

  var section: SidebarSection? {
    guard !items.isEmpty else { return nil }
    return SidebarSection(id: "bots", title: "Bots", items: items)
  }

  var isConnected: Bool { app != nil }

  func owns(_ id: String?) -> Bool {
    guard let id else { return false }
    return items.contains { $0.id == id }
  }

  /// Connects once. A failure is shown in the sidebar's subtitle, not as a new surface.
  func start() async {
    guard app == nil else { return }
    do {
      let model = try await makeApp(settings)
      app = model
      bind(model)
      await model.refresh()
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
  var draft: String { app?.conversation.draft ?? "" }

  func setDraft(_ value: String) {
    app?.conversation.draft = value
  }

  func send() {
    guard let app else { return }
    // Only a known-missing gateway blocks; an unreachable settings endpoint must not turn
    // a working bot into a dead composer.
    if gatewayConfigured == false {
      needsModelSetup = true
      return
    }
    app.conversation.send()
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
      transcript.clear()
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
    let nextItems = app.bots.map { bot in
      presenter.sidebarItem(for: bot, preview: previews[bot.id]?.text ?? "")
    }
    if items != nextItems { items = nextItems }
    if app.selection != selectedId, let next = app.selection {
      selectedId = next
      onSelect?(next)
    }
    guard let selected = app.bots.first(where: { $0.id == app.selection }) else {
      title = "Bots"
      subtitle = app.bots.isEmpty ? "还没有 Bot，点 + 新建一个" : "选择一个 Bot"
      transcript.clear()
      canRecover = false
      running = false
      error = nil
      connection = .stopped
      return
    }
    if title != selected.title { title = selected.title }
    let nextTint = presenter.tintIndex(for: selected)
    if tintIndex != nextTint { tintIndex = nextTint }
    let nextSubtitle = presenter.subtitle(
      for: conversation.state, connection: conversation.connection)
    if subtitle != nextSubtitle { subtitle = nextSubtitle }
    transcript.update(conversation.state)
    if running != conversation.state.running { running = conversation.state.running }
    if connection != conversation.connection { connection = conversation.connection }
    let nextRecover = conversation.state.unavailable != nil || conversation.parked
    if canRecover != nextRecover { canRecover = nextRecover }
    let nextError = conversation.errorBanner ?? app.error
    if error != nextError { error = nextError }
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
    conversation.onDraftChange = { [weak self] in
      self?.transcript.objectWillChange.send()
    }
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

  /// Lets tests wait until a deferred `publish()` pass finishes after handshake events.
  func awaitScheduledPublishDrain() async {
    while publicationScheduled {
      await Task.yield()
      try? await Task.sleep(nanoseconds: 2_000_000)
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
