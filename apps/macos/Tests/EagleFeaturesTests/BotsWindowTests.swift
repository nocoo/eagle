import BotsCore
import BotsFeatures
import BotsTransport
import Combine
import Foundation
import Testing

@testable import EagleFeatures

/// What the shell binds: the Bots window keeps one draft in the conversation view model,
/// publishes the transcript and the actions, and a refusal's restored text is the value the
/// composer shows.
@MainActor
@Suite("Bots window")
struct BotsWindowTests {
  private func waitUntil(
    timeout: TimeInterval = 2,
    _ condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    Issue.record("condition not met within \(timeout)s")
  }

  private func window(
    gateway: Bool? = true
  ) async throws -> (
    BotsWorkspaceViewModel, AppViewModel, StubConversation, OutboxStore
  ) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-window-\(UUID().uuidString)", isDirectory: true)
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: "b_1",
        title: "研究员",
        createdAt: "x",
        updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"),
        state: .idle
      )
    ]
    let conversationPort = StubConversation()
    let outbox = OutboxStore(directory: directory)
    let conversation = ConversationViewModel(
      botId: "",
      conversation: conversationPort,
      outbox: outbox
    )
    let app = AppViewModel(catalog: catalog, conversation: conversation, outbox: outbox)
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]),
      makeApp: { _ in app },
      gatewayProbe: { gateway }
    )
    await bots.start()
    bots.select("b_1")
    conversationPort.emit(.connection(.ready))
    conversationPort.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil {
      app.conversation.connection == .ready && app.conversation.hasSnapshot
    }
    try await waitUntil {
      bots.connection == .ready && bots.subtitle == "已连接"
    }
    await bots.awaitScheduledPublishDrain()
    return (bots, app, conversationPort, outbox)
  }

  @Test("the composer and the conversation share one draft")
  func singleDraft() async throws {
    let (bots, app, conversationPort, _) = try await window()
    bots.setDraft("hello from Eagle")
    #expect(bots.draft == "hello from Eagle")
    #expect(app.conversation.draft == "hello from Eagle", "there is no second draft")

    bots.send()
    try await waitUntil { conversationPort.sent.last?.text == "hello from Eagle" }

    // A refusal restores the text through the same accessor the composer binds.
    let requestId = try #require(conversationPort.sent.last?.requestId)
    conversationPort.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.draft == "hello from Eagle", "the restored draft is what the user sees")
  }

  @Test("sidebar previews use the last received chat text rather than lifecycle state")
  func sidebarPreview() async throws {
    let (bots, _, port, _) = try await window()
    #expect(bots.items.first?.subtitle == "")
    port.emit(
      .snapshot(
        ConversationSnapshot(
          botId: "b_1",
          messages: [
            Message(
              id: "question", role: .user, state: .complete, createdAt: "x",
              blocks: [.text("Question")]),
            Message(
              id: "answer", role: .assistant, state: .complete, createdAt: "x",
              blocks: [.thinking("hidden"), .text("**可以正常轮询。**\n下一行")]),
            Message(
              id: "tool", role: .tool, state: .complete, createdAt: "x",
              blocks: [.text("tool output")]),
          ])))
    try await Task.sleep(for: .milliseconds(60))
    #expect(bots.items.first?.subtitle == "可以正常轮询。 下一行")
    port.emit(.connection(.reconnecting(attempt: 1)))
    try await Task.sleep(for: .milliseconds(60))
    #expect(bots.items.first?.subtitle == "可以正常轮询。 下一行")
    port.emit(.connection(.ready))
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(for: .milliseconds(60))
    #expect(bots.items.first?.subtitle == "")
  }

  @Test("draft and error-only changes do not republish the transcript")
  func transcriptPublicationIsolation() async throws {
    let (bots, _, port, _) = try await window()
    var publications = 0
    var shellPublications = 0
    let observer = bots.transcript.$entries.dropFirst().sink { _ in publications += 1 }
    let shellObserver = bots.objectWillChange.sink { shellPublications += 1 }
    defer {
      observer.cancel()
      shellObserver.cancel()
    }
    await bots.awaitScheduledPublishDrain()
    for index in 0..<30 { bots.setDraft("Draft \(index)") }
    try await Task.sleep(nanoseconds: 80_000_000)
    #expect(publications == 0)
    #expect(shellPublications == 0)
    port.emit(
      .error(
        kind: .invalidCommand, disposition: .notAdmitted,
        message: "refused", failure: "f_render", requestId: nil))
    try await Task.sleep(nanoseconds: 80_000_000)
    #expect(bots.error == "refused")
    #expect(publications == 0)
  }

  @Test("a send without a gateway is refused into the setup hint, not the daemon")
  func missingGatewayHaltsSend() async throws {
    let (bots, _, conversationPort, _) = try await window(gateway: false)
    bots.setDraft("hello")
    bots.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(bots.needsModelSetup, "the user is told to configure the gateway")
    #expect(conversationPort.sent.isEmpty, "nothing was sent")
    bots.dismissModelSetup()
    #expect(!bots.needsModelSetup)
  }

  @Test("a parked task offers recover and the action reaches the daemon")
  func parkedIsRecoverable() async throws {
    let (bots, _, conversationPort, _) = try await window()
    conversationPort.emit(
      .error(
        kind: .taskParked,
        disposition: .runtime,
        message: "a task was parked",
        failure: "f_parked",
        requestId: nil
      )
    )
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.canRecover, "a parked task is a recoverable state")
    #expect(bots.participantStatus.phase == .attention)
    #expect(bots.participantStatus.canRecover)
    #expect(bots.participantStatus.error == "a task was parked")
    bots.recover()
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(conversationPort.recovered == 1, "recover reaches the daemon")
    #expect(conversationPort.lastBotId == "b_1")
  }

  @Test("the name capsule follows runtime state and stops only a connected running bot")
  func participantControls() async throws {
    let (bots, _, port, _) = try await window()
    #expect(bots.participantStatus.phase == .idle)
    #expect(!bots.participantStatus.canStop)
    bots.abort()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(port.aborted == 0)

    port.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true)))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.participantStatus.phase == .working)
    #expect(bots.participantStatus.isActive)
    #expect(bots.participantStatus.label == "处理中")
    #expect(bots.participantStatus.canStop)
    bots.abort()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(port.aborted == 1)
    #expect(port.lastBotId == "b_1")
    #expect(bots.participantStatus.canStop, "a sent abort is not a settled run")

    port.emit(.connection(.reconnecting(attempt: 1)))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.participantStatus.phase == .connecting)
    #expect(bots.participantStatus.label == "正在重连（第 1 次）")
    #expect(!bots.participantStatus.canStop)
    bots.abort()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(port.aborted == 1)

    port.emit(.connection(.stopped))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.participantStatus.phase == .offline)
    #expect(!bots.participantStatus.isActive)
    port.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.participantStatus.phase == .connecting)
    #expect(bots.participantStatus.label == "正在同步…")
    #expect(!bots.participantStatus.canStop, "welcome is not a fresh conversation snapshot")
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.participantStatus.phase == .idle)
    #expect(!bots.participantStatus.isActive)
    #expect(!bots.participantStatus.canStop)
  }

  @Test("a capsule error stays readable and dismissible without losing stop")
  func participantError() async throws {
    let (bots, _, port, _) = try await window()
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true)))
    port.emit(
      .error(
        kind: .invalidCommand, disposition: .notAdmitted,
        message: "refused", failure: "f_header", requestId: nil))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.participantStatus.phase == .working)
    #expect(bots.participantStatus.isActive, "an old error does not hide a live answer")
    #expect(bots.participantStatus.error == "refused")
    #expect(bots.participantStatus.canStop)
    bots.dismissError()
    #expect(bots.participantStatus.error == nil)
    #expect(bots.participantStatus.phase == .working)
  }

  @Test("the transcript is published from append and delta events")
  func transcriptPublished() async throws {
    let (bots, _, conversationPort, _) = try await window()
    conversationPort.emit(
      .append(
        message: Message(
          id: "e_7",
          role: .user,
          state: .complete,
          createdAt: "x",
          blocks: [.text("问题")],
          requestId: "r_1"
        ),
        replaces: nil
      )
    )
    conversationPort.emit(
      .append(
        message: Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [.text("回")]
        ),
        replaces: nil
      )
    )
    conversationPort.emit(.delta(messageId: "p_a1", changes: [.text(index: 0, append: "答")]))
    try await Task.sleep(nanoseconds: 80_000_000)
    let rows = bots.entries
    #expect(rows.count >= 2, "the transcript grows with the stream")
    #expect(
      {
        if case .streamingAssistant(_, let blocks) = rows.last,
          case .paragraph("回答") = blocks.first
        {
          return true
        }
        return false
      }(), "the streamed answer is what the window renders")
  }

  @Test("the window publishes the transcript, the status and the actions")
  func publishedState() async throws {
    let (bots, app, conversationPort, _) = try await window()
    #expect(app.bots.count == 1)
    #expect(bots.items.count == 1, "the sidebar gets a row per bot")
    #expect(bots.connection == .ready)
    #expect(bots.subtitle == "已连接")

    conversationPort.emit(.status(running: true, inbox: [], streaming: nil))
    try await Task.sleep(nanoseconds: 60_000_000)
    #expect(bots.running, "the stop affordance is driven by the run state")

    bots.abort()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(conversationPort.aborted == 1, "stop goes through the bot it belongs to")
    #expect(conversationPort.lastBotId == "b_1")
  }
}

/// The two ports this window needs, with just enough behaviour for the bindings.
final class StubCatalog: CatalogPort {
  var bots: [BotSummary] = []

  func load() async throws -> [BotSummary] { bots }
  func create(title: String, label: String?, appearance: BotAppearance) async throws -> BotSummary {
    let bot = BotSummary(
      id: "b_new",
      title: title,
      label: label,
      appearance: appearance,
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .idle
    )
    bots.append(bot)
    return bot
  }
  var updated: [(String?, String?, BotAppearance?)] = []

  func update(
    id: String,
    title: String?,
    label: String?,
    appearance: BotAppearance?
  ) async throws -> BotSummary {
    guard let index = bots.firstIndex(where: { $0.id == id }) else { return bots[0] }
    var bot = bots[index]
    if let title { bot.title = title }
    if let label { bot.label = label.isEmpty ? nil : label }
    if let appearance { bot.appearance = appearance }
    bots[index] = bot
    updated.append((title, label, appearance))
    return bot
  }
  func rename(id: String, title: String) async throws -> BotSummary { bots[0] }
  func delete(id: String) async throws { bots.removeAll { $0.id == id } }
  func catalogEvents() -> AsyncStream<[BotSummary]> { AsyncStream { $0.finish() } }
}

final class StubConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
  }

  var sent: [Sent] = []
  var aborted = 0
  var lastBotId: String?
  private var continuation: AsyncStream<ConversationEvent>.Continuation?
  private var pending: [ConversationEvent] = []

  func open(botId: String) -> AsyncStream<ConversationEvent> {
    continuation?.finish()
    continuation = nil
    return AsyncStream { continuation in
      self.continuation = continuation
      for event in self.pending { continuation.yield(event) }
      self.pending.removeAll()
    }
  }

  func emit(_ event: ConversationEvent) {
    if let continuation {
      continuation.yield(event)
    } else {
      pending.append(event)
    }
  }

  func send(
    _ text: String,
    whenBusy: BusyMode,
    context: CommandContext,
    botId: String
  ) async throws {
    sent.append(Sent(text: text, requestId: context.requestId ?? ""))
    lastBotId = botId
  }

  func abort(context: CommandContext, botId: String) async throws {
    aborted += 1
    lastBotId = botId
  }

  var recovered = 0

  func recover(context: CommandContext, botId: String) async throws {
    recovered += 1
    lastBotId = botId
  }

  func resync(context: CommandContext, botId: String) async throws {
    lastBotId = botId
  }

  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws {
    lastBotId = botId
  }

  func close() {
    continuation?.finish()
    continuation = nil
    pending.removeAll()
  }
}
