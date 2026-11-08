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
@Suite("Bots window", .serialized)
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
    gateway: Bool? = true,
    catalog: StubCatalog = StubCatalog(),
    triggers: StubTriggers = StubTriggers()
  ) async throws -> (
    BotsWorkspaceViewModel, AppViewModel, StubConversation, OutboxStore
  ) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-window-\(UUID().uuidString)", isDirectory: true)
    if catalog.bots.isEmpty {
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
    }
    let conversationPort = StubConversation()
    let outbox = OutboxStore(directory: directory)
    let conversation = ConversationViewModel(
      botId: "",
      conversation: conversationPort,
      outbox: outbox
    )
    let app = AppViewModel(
      catalog: catalog, conversation: conversation, outbox: outbox, triggers: triggers)
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]),
      makeApp: { _ in app },
      gatewayProbe: { gateway }
    )
    await bots.start()
    await settlePublish(bots)
    bots.select("b_1")
    conversationPort.emit(.connection(.ready))
    conversationPort.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    await settlePublish(bots)
    try await waitUntil {
      app.conversation.connection == .ready && app.conversation.hasSnapshot
    }
    try await waitUntil {
      bots.connection == .ready && bots.subtitle == "已连接"
    }
    await settlePublish(bots, passes: 12)
    return (bots, app, conversationPort, outbox)
  }

  @Test("the composer and the conversation share one draft")
  func singleDraft() async throws {
    let (bots, app, conversationPort, _) = try await window()
    bots.setDraft("hello from Eagle")
    #expect(bots.composer.text == "hello from Eagle")
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
    try await waitUntil { bots.composer.text == "hello from Eagle" }
    #expect(bots.composer.text == "hello from Eagle", "the restored draft is what the user sees")
  }

  @Test("a queued message carries a waiting action until it is placed")
  func queuedMessage() async throws {
    let (bots, _, conversationPort, _) = try await window()
    bots.setDraft("排队的问题")
    bots.send()
    try await waitUntil { !conversationPort.sent.isEmpty }
    let requestId = try #require(conversationPort.sent.last?.requestId)
    conversationPort.emit(
      .submission(Submission(id: "s_1", requestId: requestId, status: .queued)))
    try await waitUntil { bots.queuedMessages["local_\(requestId)"] != nil }
    #expect(bots.queuedMessages["local_\(requestId)"]?.promoted == false)

    bots.promoteQueued(requestId)
    try await waitUntil { conversationPort.promoted == [requestId] }
    conversationPort.emit(
      .status(
        running: true,
        inbox: [InboxItem(id: "s_1", mode: "steer")],
        streaming: nil
      ))
    try await waitUntil { bots.queuedMessages["local_\(requestId)"]?.promoted == true }

    // Placement removes the waiting state: the real entry is an ordinary user turn.
    conversationPort.emit(
      .submission(Submission(id: "s_1", requestId: requestId, status: .placed, entryId: "e_9")))
    conversationPort.emit(
      .append(
        message: Message(
          id: "e_9",
          role: .user,
          state: .complete,
          createdAt: "x",
          blocks: [.text("排队的问题")]
        ),
        replaces: nil
      ))
    try await waitUntil { bots.queuedMessages.isEmpty }
  }

  @Test("an oversized message stays visible with a clear error")
  func oversizedDraft() async throws {
    let (bots, app, port, outbox) = try await window()
    let draft = String(repeating: "界", count: 8_001)
    bots.setDraft(draft)
    bots.send()
    try await waitUntil { bots.error?.contains("8,000") == true }
    #expect(bots.composer.text == draft)
    #expect(app.conversation.draft == draft)
    #expect(port.sent.isEmpty)
    #expect(try outbox.entries(for: "b_1").isEmpty)
  }

  @Test("canonically equivalent edits preserve exact scalars before the length check")
  func exactUnicodeDraft() async throws {
    let (bots, app, port, outbox) = try await window()
    let composed = String(repeating: "é", count: 4_001)
    let decomposed = String(repeating: "e\u{301}", count: 4_001)
    bots.setDraft(composed)
    bots.setDraft(decomposed)
    bots.send()
    try await waitUntil { bots.error != nil || !port.sent.isEmpty }
    #expect(bots.composer.text.utf8.elementsEqual(decomposed.utf8))
    #expect(app.conversation.draft.utf8.elementsEqual(decomposed.utf8))
    #expect(bots.error?.contains("8,000") == true)
    #expect(port.sent.isEmpty)
    #expect(try outbox.entries(for: "b_1").isEmpty)

    bots.setDraft("é")
    bots.setDraft("e\u{301}")
    bots.send()
    try await waitUntil { port.sent.count == 1 }
    #expect(port.sent.first?.text.utf8.elementsEqual("e\u{301}".utf8) == true)
    #expect(try outbox.entries(for: "b_1").first?.text.utf8.elementsEqual("e\u{301}".utf8) == true)
  }

  @Test("a repeated refusal republishes the restored draft without losing newer input")
  func repeatedRefusalRestoresDraft() async throws {
    let (bots, app, conversationPort, _) = try await window()
    bots.setDraft("原文")
    bots.send()
    try await waitUntil { conversationPort.sent.count == 1 }
    let firstRequest = try #require(conversationPort.sent.last?.requestId)
    conversationPort.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "same refusal",
        failure: "f_1",
        requestId: firstRequest
      )
    )
    try await waitUntil { bots.composer.text == "原文" }

    bots.send()
    try await waitUntil { conversationPort.sent.count == 2 }
    let secondRequest = try #require(conversationPort.sent.last?.requestId)
    bots.setDraft("新草稿")
    conversationPort.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "same refusal",
        failure: "f_2",
        requestId: secondRequest
      )
    )
    try await waitUntil { bots.composer.text == "新草稿\n\n原文" }

    let next = "新草稿\n\n原文！"
    bots.setDraft(next)
    #expect(app.conversation.draft == next, "later typing cannot overwrite the restored text")
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
    try await waitUntil { bots.items.first?.subtitle == "可以正常轮询。 下一行" }
    port.emit(.connection(.reconnecting(attempt: 1)))
    try await waitUntil { bots.items.first?.subtitle == "可以正常轮询。 下一行" }
    port.emit(.connection(.ready))
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { bots.items.first?.subtitle == "" }
  }

  @Test("draft and error-only changes do not republish the transcript")
  func transcriptPublicationIsolation() async throws {
    let (bots, _, port, _) = try await window()
    await settlePublish(bots)
    var publications = 0
    var shellPublications = 0
    let observer = bots.transcript.$entries.dropFirst().sink { _ in publications += 1 }
    let shellObserver = bots.objectWillChange.sink { shellPublications += 1 }
    defer {
      observer.cancel()
      shellObserver.cancel()
    }
    // Count from quiescence rather than from a fixed pause: a loaded runner can deliver the
    // settled baseline after any deadline, and that arrival is not a draft edit.
    var previous = -1
    while publications != previous {
      previous = publications
      try await Task.sleep(for: .milliseconds(20))
    }
    publications = 0
    shellPublications = 0
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
    try await waitUntil { bots.running }
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
    try await waitUntil {
      bots.participantStatus.phase == .connecting
        && bots.participantStatus.label == "正在重连（第 1 次）"
    }
    #expect(bots.participantStatus.phase == .connecting)
    #expect(bots.participantStatus.label == "正在重连（第 1 次）")
    #expect(!bots.participantStatus.canStop)
    bots.abort()
    try await Task.sleep(nanoseconds: 40_000_000)
    #expect(port.aborted == 1)

    port.emit(.connection(.stopped))
    try await waitUntil { bots.participantStatus.phase == .offline }
    #expect(bots.participantStatus.phase == .offline)
    #expect(!bots.participantStatus.isActive)
    port.emit(.connection(.ready))
    try await waitUntil {
      bots.participantStatus.phase == .connecting && bots.participantStatus.label == "正在同步…"
    }
    #expect(bots.participantStatus.phase == .connecting)
    #expect(bots.participantStatus.label == "正在同步…")
    #expect(!bots.participantStatus.canStop, "welcome is not a fresh conversation snapshot")
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { bots.participantStatus.phase == .idle }
    #expect(bots.participantStatus.phase == .idle)
    #expect(!bots.participantStatus.isActive)
    #expect(!bots.participantStatus.canStop)
  }

  @Test("a capsule error stays readable and dismissible without losing stop")
  func participantError() async throws {
    let (bots, _, port, _) = try await window()
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true)))
    try await waitUntil { bots.running }
    port.emit(
      .error(
        kind: .invalidCommand, disposition: .notAdmitted,
        message: "refused", failure: "f_header", requestId: nil))
    try await waitUntil { bots.participantStatus.error == "refused" }
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
    try await waitUntil {
      if case .streamingAssistant(_, let blocks) = bots.transcript.entries.last,
        case .paragraph("回答") = blocks.first
      {
        return true
      }
      return false
    }
    let rows = bots.transcript.entries
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

  @Test("the window publishes the selected bot's live tasks for the inspector")
  func tasksPublished() async throws {
    let (bots, _, conversationPort, _) = try await window()
    #expect(bots.tasks.isEmpty, "a connected bot with no work shows the empty section")
    conversationPort.emit(
      .tasks([
        TaskSummary(id: "t_1", kind: "pi.generation", status: .running),
        TaskSummary(id: "t_2", kind: "pi.tool", status: .waiting, owner: "t_1"),
      ])
    )
    try await waitUntil { bots.tasks.count == 2 }
    #expect(bots.tasks.map(\.title) == ["生成回答", "工具调用"])
    #expect(bots.tasks.map(\.depth) == [0, 1])
    #expect(bots.tasks.map(\.isRunning) == [true, false])

    conversationPort.emit(.tasks([]))
    try await waitUntil { bots.tasks.isEmpty }
  }

  @Test("the sidebar exposes the daemon's groups and files every bot under one")
  func sidebarGroups() async throws {
    let catalog = StubCatalog()
    catalog.groups = [BotGroup(id: "g_1", title: "工作"), BotGroup(id: "g_2", title: "研究")]
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle, groupId: "g_1"),
      BotSummary(
        id: "b_2", title: "二", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle),
      BotSummary(
        id: "b_3", title: "三", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle, groupId: "g_gone"),
    ]
    let (bots, _, _, _) = try await window(catalog: catalog)
    #expect(bots.groups.map(\.id) == ["g_1", "g_2"])
    #expect(
      bots.sections.map(\.id)
        == ["g_1", "g_2", SidebarComposition.ungroupedSectionID])
    #expect(botIDs(in: "g_1", of: bots) == ["b_1"])
    #expect(botIDs(in: "g_2", of: bots).isEmpty)
    #expect(
      botIDs(in: nil, of: bots) == ["b_2", "b_3"],
      "an ungrouped bot and one filed under a missing group")
  }

  @Test("group actions reach the daemon and republish the sidebar")
  func groupActions() async throws {
    let catalog = StubCatalog()
    catalog.groups = [BotGroup(id: "g_1", title: "工作"), BotGroup(id: "g_2", title: "研究")]
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle, groupId: "g_1")
    ]
    let (bots, _, _, _) = try await window(catalog: catalog)

    await bots.createGroup()
    #expect(catalog.createdGroupTitles == ["新分组"], "a new group gets a distinct default name")
    #expect(bots.groups.map(\.title) == ["工作", "研究", "新分组"])

    await bots.renameGroup("g_2", to: "学习")
    #expect(catalog.renamedGroups.map { "\($0.0)=\($0.1)" } == ["g_2=学习"])
    #expect(bots.groups.map(\.title) == ["工作", "学习", "新分组"])

    let third = try #require(catalog.groups.last?.id)
    await bots.reorderGroups(moving: "g_2", by: -1)
    #expect(catalog.reordered == [["g_2", "g_1", third]])
    #expect(bots.groups.first?.id == "g_2", "上移 is one reordered list, not a per-group write")

    await bots.moveBot("b_1", toGroup: "g_2")
    #expect(catalog.moved.map { "\($0.0)=\($0.1 ?? "nil")" } == ["b_1=g_2"])
    #expect(botIDs(in: "g_2", of: bots) == ["b_1"])

    await bots.moveBot("b_1", toGroup: nil)
    #expect(botIDs(in: nil, of: bots) == ["b_1"])

    await bots.deleteGroup("g_2")
    #expect(catalog.deletedGroups == ["g_2"])
    #expect(bots.groups.map(\.id).contains("g_2") == false)
  }

  @Test("a refused group delete is shown in the window and the group stays")
  func groupDeleteRefusal() async throws {
    let catalog = StubCatalog()
    catalog.groups = [BotGroup(id: "g_1", title: "工作")]
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "一", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle, groupId: "g_1")
    ]
    let (bots, _, _, _) = try await window(catalog: catalog)
    catalog.refuseDelete = ClientError("the group still holds bots")

    await bots.deleteGroup("g_1")
    #expect(bots.error == "the group still holds bots")
    #expect(bots.groups.map(\.id) == ["g_1"])
  }

  @Test("the window publishes the transcript, the status and the actions")
  func publishedState() async throws {
    let (bots, app, conversationPort, _) = try await window()
    #expect(app.bots.count == 1)
    #expect(bots.items.count == 1, "the sidebar gets a row per bot")
    #expect(bots.connection == .ready)
    #expect(bots.subtitle == "已连接")

    conversationPort.emit(.status(running: true, inbox: [], streaming: nil))
    try await waitUntil { bots.running }
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
  var groups: [BotGroup] = []
  var createdGroupTitles: [String] = []
  var renamedGroups: [(String, String)] = []
  var deletedGroups: [String] = []
  var reordered: [[String]] = []
  var moved: [(String, String?)] = []
  var refuseDelete: Error?
  var models: [String] = ["auto/gpt-6-luna"]
  /// The discovery failure the daemon reports beside the ids it kept.
  var modelDiscoveryError: String?
  var agentChanges: [(String, String?, String?)] = []
  /// Held open, so a save can be observed in flight.
  var agentGate: Gate?
  /// The daemon's refusal for the next change.
  var agentError: Error?
  /// The catalog takes the pair even when the conversation refuses it (saved, not applied).
  var applyOnAgentError = false
  var retriedTasks: [(String, String)] = []
  /// Held open, so a create can be observed in flight.
  var createGate: Gate?

  /// A latch a test opens when it wants a held call to finish.
  final class Gate: @unchecked Sendable {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false

    func wait() async {
      if opened { return }
      await withCheckedContinuation { continuation = $0 }
    }

    func open() async {
      opened = true
      continuation?.resume()
      continuation = nil
      await Task.yield()
    }
  }

  var providers: [ProviderSettings] = []
  var savedProviders: [(String, String?, Bool?)] = []

  func loadProviders() async throws -> [ProviderSettings] { providers }

  func saveProvider(
    id: String, apiKey: String?, enabled: Bool?, baseUrl: String?, model: String?
  ) async throws -> ProviderSettings {
    savedProviders.append((id, apiKey, enabled))
    throw ClientError("not used")
  }

  func testProvider(id: String) async throws -> ProviderProbe {
    throw ClientError("not used")
  }

  func loadUsage(days: Int) async throws -> UsageReport {
    UsageReport(
      retentionDays: 90,
      today: UsageReport.Totals(totalTokens: 0, costUsd: 0),
      week: UsageReport.Totals(totalTokens: 0, costUsd: 0),
      month: UsageReport.Totals(totalTokens: 0, costUsd: 0),
      days: [],
      bots: []
    )
  }

  func loadModels() async throws -> GatewayModels {
    GatewayModels(
      ids: models,
      details: models.map {
        ModelDetail(
          id: $0, contextWindow: 200_000, maxTokens: 8_192, reasoning: true,
          thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      },
      discoveryError: modelDiscoveryError
    )
  }

  func setAgent(id: String, model: String?, thinkingLevel: String?) async throws -> BotSummary {
    agentChanges.append((id, model, thinkingLevel))
    if let gate = agentGate {
      agentGate = nil
      await gate.wait()
    }
    guard let index = bots.firstIndex(where: { $0.id == id }) else {
      throw ClientError("no bot \(id)")
    }
    if applyOnAgentError, let model { bots[index].model.modelId = model }
    if let agentError { throw agentError }
    if let model { bots[index].model.modelId = model }
    return bots[index]
  }
  var stoppedTasks: [(String, String)] = []

  func retryTask(bot: String, task: String) async throws {
    retriedTasks.append((bot, task))
  }

  func abortTask(bot: String, task: String) async throws {
    stoppedTasks.append((bot, task))
  }

  func load() async throws -> BotCatalog { BotCatalog(bots: bots, groups: groups) }

  func createGroup(title: String) async throws -> BotGroup {
    createdGroupTitles.append(title)
    let group = BotGroup(id: "g_\(groups.count + 1)", title: title)
    groups.append(group)
    return group
  }

  func renameGroup(id: String, title: String) async throws -> BotGroup {
    renamedGroups.append((id, title))
    guard let index = groups.firstIndex(where: { $0.id == id }) else {
      throw ClientError("no group \(id)")
    }
    groups[index].title = title
    return groups[index]
  }

  func deleteGroup(id: String) async throws {
    if let refuseDelete { throw refuseDelete }
    deletedGroups.append(id)
    groups.removeAll { $0.id == id }
  }

  func reorderGroups(ids: [String]) async throws -> [BotGroup] {
    reordered.append(ids)
    groups = ids.compactMap { id in groups.first { $0.id == id } }
    return groups
  }

  func moveBot(id: String, groupId: String?) async throws -> BotSummary {
    moved.append((id, groupId))
    guard let index = bots.firstIndex(where: { $0.id == id }) else {
      throw ClientError("unknown bot")
    }
    bots[index].groupId = groupId
    return bots[index]
  }
  func create(
    title: String, label: String?, appearance: BotCreationAppearance
  ) async throws -> BotSummary {
    if let createGate { await createGate.wait() }
    let bot = BotSummary(
      id: "b_new",
      title: title,
      label: label,
      appearance: BotAppearance(shape: appearance.shape, tint: appearance.tint ?? .violet),
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
  func catalogEvents() -> AsyncStream<BotCatalog> { AsyncStream { $0.finish() } }
}

final class StubConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
  }

  struct Answered {
    let entryId: String
    let chosen: [String]
    let skipped: Bool
  }

  var sent: [Sent] = []
  var answered: [Answered] = []
  var aborted = 0
  var lastBotId: String?
  /// Every `open`, so a reconnect is observable.
  var opens = 0
  private var continuation: AsyncStream<ConversationEvent>.Continuation?
  private var pending: [ConversationEvent] = []

  func open(botId: String) -> AsyncStream<ConversationEvent> {
    opens += 1
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

  var promoted: [String] = []

  func promote(requestId: String, context: CommandContext, botId: String) async throws {
    promoted.append(requestId)
    lastBotId = botId
  }

  func answer(
    entryId: String,
    chosen: [String],
    skipped: Bool,
    context: CommandContext,
    botId: String
  ) async throws {
    answered.append(Answered(entryId: entryId, chosen: chosen, skipped: skipped))
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

/// The trigger surface a window test drives: its list, detail and one recorded switch.
final class StubTriggers: TriggerPort, @unchecked Sendable {
  var details: [TriggerDetail] = []
  var switches: [(String, String, Bool)] = []
  var failure: Error?

  func list(botId: String) async throws -> [TriggerDetail] {
    if let failure { throw failure }
    return details
  }

  func setEnabled(botId: String, triggerId: String, enabled: Bool) async throws -> TriggerDetail {
    switches.append((botId, triggerId, enabled))
    if let failure { throw failure }
    guard let index = details.firstIndex(where: { $0.id == triggerId }) else {
      throw ClientError("no such trigger")
    }
    var summary = details[index].summary
    summary.enabled = enabled
    let detail = TriggerDetail(
      summary: summary, prompt: details[index].prompt, endpoint: details[index].endpoint)
    details[index] = detail
    return detail
  }
}

@MainActor
@Suite("Bots triggers", .serialized)
struct BotsTriggerTests {
  private func waitUntil(
    timeout: TimeInterval = 2, _ condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    Issue.record("condition not met within \(timeout)s")
  }

  private func summary(
    id: String = "t_9f2a1c3d04", enabled: Bool = true
  ) -> TriggerSummary {
    TriggerSummary(
      id: id,
      kind: .schedule,
      name: "morning triage",
      enabled: enabled,
      schedule: TriggerSummary.Schedule(
        cron: "0 9 * * *", timezone: "Asia/Shanghai",
        nextDueAt: "2026-10-29T01:00:00.000Z"),
      counters: TriggerSummary.Counters(fired: 2)
    )
  }

  private func ready(
    triggers: StubTriggers = StubTriggers(), list: [TriggerSummary]? = nil
  ) async throws -> (BotsWorkspaceViewModel, StubConversation, StubTriggers) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-trigger-\(UUID().uuidString)", isDirectory: true)
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "研究员", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle)
    ]
    let port = StubConversation()
    let outbox = OutboxStore(directory: directory)
    let conversation = ConversationViewModel(botId: "", conversation: port, outbox: outbox)
    let app = AppViewModel(
      catalog: catalog, conversation: conversation, outbox: outbox, triggers: triggers)
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]), makeApp: { _ in app },
      gatewayProbe: { true })
    await bots.start()
    await settlePublish(bots)
    bots.select("b_1")
    port.emit(.connection(.ready))
    let snapshot = ConversationSnapshot(
      botId: "b_1", triggers: list ?? [summary()])
    port.emit(.snapshot(snapshot))
    await settlePublish(bots)
    try await waitUntil { app.conversation.hasSnapshot }
    triggers.details = [
      TriggerDetail(summary: summary(), prompt: "triage the queue")
    ]
    return (bots, port, triggers)
  }

  @Test("a bot's triggers live in its own panel with one switch per definition")
  func section() async throws {
    let (bots, _, _) = try await ready()
    #expect(
      !bots.sections.contains { $0.title == "触发器" },
      "the sidebar lists bots, never their triggers")
    #expect(bots.triggerItems.count == 1)
    let row = try #require(bots.triggerItems.first)
    #expect(row.name == "morning triage")
    #expect(row.detail.contains("定时"))
    #expect(row.isOn)
  }

  @Test("one switch sends the chosen value and follows the daemon's event")
  func toggle() async throws {
    let (bots, port, triggers) = try await ready()
    let row = try #require(bots.triggerItems.first)
    bots.setTriggerEnabled(row.id, false)
    try await waitUntil { triggers.switches.count == 1 }
    #expect(triggers.switches[0].2 == false, "the switch sends what the person chose")

    port.emit(.triggers([summary(enabled: false)]))
    await settlePublish(bots)
    try await waitUntil { bots.triggerItems.first?.isOn == false }
  }
}

@MainActor
@Suite("Bots daemon reconnect", .serialized)
struct BotsDaemonReconnectTests {
  private func window() async throws -> (BotsWorkspaceViewModel, StubConversation, AppViewModel) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-reconnect-\(UUID().uuidString)", isDirectory: true)
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "研究员", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle)
    ]
    let port = StubConversation()
    let outbox = OutboxStore(directory: directory)
    let conversation = ConversationViewModel(botId: "", conversation: port, outbox: outbox)
    let app = AppViewModel(catalog: catalog, conversation: conversation, outbox: outbox)
    let bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]), makeApp: { _ in app },
      gatewayProbe: { true })
    await bots.start()
    await settlePublish(bots)
    bots.select("b_1")
    port.emit(.connection(.ready))
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    await settlePublish(bots)
    return (bots, port, app)
  }

  @Test("a dead connection offers one retry and does not retry by itself")
  func retryAffordance() async throws {
    let (bots, port, _) = try await window()
    #expect(bots.participantStatus.canRetry == false)

    port.emit(.connection(.failed(reason: ConversationSocket.daemonDownMessage)))
    let deadline = Date().addingTimeInterval(2)
    while !bots.participantStatus.canRetry, Date() < deadline {
      try await Task.sleep(nanoseconds: 20_000_000)
      await settlePublish(bots)
    }

    #expect(bots.participantStatus.canRetry, "the person is offered a retry")
    #expect(bots.subtitle == ConversationSocket.daemonDownMessage, "and told to start it")

    let opens = port.opens
    bots.retryConnection()
    #expect(port.opens == opens + 1, "the retry opens one fresh connection")
  }
}

@MainActor
@Suite("Bots daemon absent", .serialized)
struct BotsDaemonAbsentTests {
  @Test("a closed port reports the daemon as down and never reconnects on its own")
  func deadPort() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-absent-\(UUID().uuidString)", isDirectory: true)
    let outbox = OutboxStore(directory: directory)
    // Port 9 is the discard port: nothing listens on it here, so the upgrade is refused.
    let connection = BotsConnection(
      baseURL: URL(string: "http://127.0.0.1:9")!, token: "unused")
    let model = ConversationViewModel(botId: "", conversation: connection, outbox: outbox)
    model.select(botId: "b_1")

    // Closed-port failure can take longer on loaded CI runners than on a quiet machine.
    let deadline = Date().addingTimeInterval(60)
    while !model.connection.isFailed, Date() < deadline {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    #expect(model.connection.isFailed, "the socket stops instead of retrying forever")
    #expect(
      model.connection == .failed(reason: ConversationSocket.daemonDownMessage),
      "and says what to do about it")
    #expect(model.canSend == false, "a dead connection cannot send")

    // Give the old behaviour time to show up: it reconnected within a few hundred ms.
    try await Task.sleep(nanoseconds: 1_500_000_000)
    #expect(model.connection.isFailed, "still failed: no blind retry loop")
  }
}

/// Lets deferred main-actor publish passes run: the shell schedules a follow-up publish, so a
/// test that just emitted an event must yield before asserting on what it produced.
@MainActor
private func settlePublish(_ bots: BotsWorkspaceViewModel, passes: Int = 6) async {
  for _ in 0..<passes {
    await Task.yield()
    try? await Task.sleep(nanoseconds: 2_000_000)
  }
}

/// The rows the sidebar shows under one section; `nil` is the ungrouped section.
@MainActor
private func botIDs(in section: String?, of bots: BotsWorkspaceViewModel) -> [String] {
  let id = section ?? SidebarComposition.ungroupedSectionID
  return bots.sections.first { $0.id == id }?.items.map(\.id) ?? []
}
