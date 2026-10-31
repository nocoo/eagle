import BotsCore
import BotsFeatures
import BotsTransport
import Combine
import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

/// What the shell binds: the Bots window keeps one draft in the conversation view model,
/// publishes the transcript and the actions, and a refusal's restored text is the value the
/// composer shows.
@MainActor
@Suite("Bots window", .serialized)
struct BotsWindowTests {
  @Test("owned native head selection and merge feed the original composer and actual SDK")
  func nativeContextChain() async throws {
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../").standardizedFileURL
    let fixture = Process()
    let output = Pipe()
    let input = Pipe()
    let errors = Pipe()
    fixture.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    fixture.arguments = ["node", "apps/bots/test/support/native-context.fixture.ts"]
    fixture.currentDirectoryURL = repository
    fixture.standardOutput = output
    fixture.standardInput = input
    fixture.standardError = errors
    try fixture.run()
    defer {
      try? input.fileHandleForWriting.close()
      if fixture.isRunning { fixture.waitUntilExit() }
    }
    func response() throws -> DeviceJSON {
      var line = Data()
      while line.last != 10 {
        let chunk = output.fileHandleForReading.availableData
        guard !chunk.isEmpty else {
          fixture.waitUntilExit()
          let stderr =
            String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
          throw ClientError("owned fixture exited \(fixture.terminationStatus): \(stderr)")
        }
        line.append(chunk)
      }
      return try JSONDecoder().decode(DeviceJSON.self, from: line)
    }
    let info = try response()
    let root = try #require(info["root"]?.string)
    let port = Int(try #require(info["port"]?.number))
    let bot = try #require(info["bot"]?.string)
    let headValues = info["heads"]?.array?.compactMap(\.string)
    let heads = try #require(headValues)
    let settings = BotsSettings(rootPath: root, port: String(port))
    let bots = BotsWorkspaceViewModel(settings: settings, gatewayProbe: { true })
    await bots.start()
    defer { bots.disconnect() }
    bots.select(bot)
    try await waitUntil(timeout: 10) { bots.connection == .ready }
    let history = try #require(bots.history)
    await history.loadHeads()
    #expect(heads.allSatisfy { head in history.heads.contains { $0.head == head && $0.ready } })
    await history.prepareMerge(heads: heads)
    let preview = try #require(history.mergePreview)
    #expect(preview.conflicts.isEmpty)
    let file = try #require(preview.resources.first { $0.name == "AGENTS.md" })
    let version = try #require(file.versions.first { $0.heads.contains(heads[0]) })
    await history.merge(
      choices: [], resources: [ReplicaResourceChoice(name: file.name, sha256: version.sha256)])
    #expect(history.historyError == nil)
    let selected = try #require(history.conversation.contextId)
    try await waitUntil(timeout: 10) {
      let text = String(describing: bots.entries)
      return bots.connection == .ready && text.contains("left 分支原文") && text.contains("right 分支原文")
    }
    func evidence() throws -> DeviceJSON {
      try input.fileHandleForWriting.write(
        contentsOf: JSONEncoder().encode(
          DeviceJSON.object(["method": .string("evidence"), "contextId": .string(selected)]))
          + Data([10]))
      return try response()
    }
    let passive = try evidence()
    #expect(passive["calls"] == info["baselineCalls"], "selection and merge admit no provider work")
    bots.setDraft("从原生 composer 继续")
    bots.send()
    let outbox = OutboxStore(directory: settings.clientDirectory)
    let pending = try #require(try outbox.entries(for: bot).first)
    #expect(pending.contextId == selected)
    #expect(pending.resourceHead == history.conversation.resourceHead)
    try await waitUntil(timeout: 10) {
      String(describing: bots.entries).contains("原生合并继续完成")
        && (try? outbox.entries(for: bot).isEmpty) == true
    }
    let settled = try #require(
      try outbox.settledRequests().first { $0.requestId == pending.requestId })
    #expect(settled.contextId == selected && settled.status == .done)
    let result = try evidence()
    #expect(result["calls"]?.number == (info["baselineCalls"]?.number ?? 0) + 1)
    let provider =
      String(data: try JSONEncoder().encode(result["providerInputs"]), encoding: .utf8) ?? ""
    #expect(provider.contains("left 分支原文") && provider.contains("right 分支原文"))
    let activeResources =
      String(data: try JSONEncoder().encode(result["providerResources"]), encoding: .utf8) ?? ""
    #expect(
      activeResources.contains("left native instructions")
        && !activeResources.contains("right native instructions"),
      "the current SDK system sections use the selected resource; historical sections stay in their original contributions"
    )
    #expect(result["originalParentsUnchanged"] == .array([.bool(true), .bool(true)]))
    #expect(result["originalToolBytes"] == .string("original native tool bytes"))
    #expect(result["records"] == .array([]))
    bots.disconnect()
    let reopened = BotsWorkspaceViewModel(settings: settings, gatewayProbe: { true })
    await reopened.start()
    defer { reopened.disconnect() }
    reopened.select(bot)
    try await waitUntil(timeout: 10) { String(describing: reopened.entries).contains("原生合并继续完成") }
    #expect(reopened.history?.conversation.contextId == selected)
    #expect(
      try evidence()["calls"] == result["calls"], "reopening does not replay provider/tool work")
  }

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
    await bots.awaitScheduledPublishDrain()
    bots.select("b_1")
    conversationPort.emit(.connection(.ready))
    conversationPort.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    await bots.awaitScheduledPublishDrain()
    try await waitUntil {
      app.conversation.connection == .ready && app.conversation.hasSnapshot
    }
    try await waitUntil {
      bots.connection == .ready && bots.subtitle == "已连接"
    }
    await bots.awaitShellQuiescence()
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
    try await waitUntil { bots.draft == "hello from Eagle" }
    #expect(bots.draft == "hello from Eagle", "the restored draft is what the user sees")
  }

  @Test("sidebar previews use the last received chat text rather than lifecycle state")
  func sidebarPreview() async throws {
    let (bots, app, port, _) = try await window()
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
    // Emitting queues the event; drain shell publication only after the model consumes it.
    try await waitUntil {
      app.conversation.hasSnapshot && app.conversation.state.messages.last?.id == "tool"
    }
    await bots.awaitScheduledPublishDrain()
    #expect(bots.items.first?.subtitle == "可以正常轮询。 下一行")
    port.emit(.connection(.reconnecting(attempt: 1)))
    try await waitUntil { app.conversation.connection == .reconnecting(attempt: 1) }
    await bots.awaitScheduledPublishDrain()
    #expect(bots.items.first?.subtitle == "可以正常轮询。 下一行")
    port.emit(.connection(.ready))
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil {
      app.conversation.connection == .ready && app.conversation.hasSnapshot
        && app.conversation.state.messages.isEmpty
    }
    await bots.awaitScheduledPublishDrain()
    #expect(bots.items.first?.subtitle == "")
  }

  @Test("draft and error-only changes do not republish the transcript")
  func transcriptPublicationIsolation() async throws {
    let (bots, _, port, _) = try await window()
    await bots.awaitScheduledPublishDrain()
    // A loaded runner can deliver the baseline state after the drain; count from a quiet
    // baseline so the assertion is about draft edits, not about when the socket settled.
    try await Task.sleep(for: .milliseconds(120))
    var publications = 0
    var shellPublications = 0
    let observer = bots.transcript.$entries.dropFirst().sink { _ in publications += 1 }
    let shellObserver = bots.objectWillChange.sink { shellPublications += 1 }
    defer {
      observer.cancel()
      shellObserver.cancel()
    }
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
      if case .streamingAssistant(_, let blocks) = bots.entries.last,
        case .paragraph("回答") = blocks.first
      {
        return true
      }
      return false
    }
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
    #expect(bots.bots(in: "g_1").map(\.id) == ["b_1"])
    #expect(bots.bots(in: "g_2").isEmpty)
    #expect(
      bots.bots(in: nil).map(\.id) == ["b_2", "b_3"],
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
    #expect(bots.bots(in: "g_2").map(\.id) == ["b_1"])

    await bots.moveBot("b_1", toGroup: nil)
    #expect(bots.bots(in: nil).map(\.id) == ["b_1"])

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
  var agentChanges: [(String, String?, String?)] = []
  var retriedTasks: [(String, String)] = []

  var providers: [ProviderSettings] = []
  var savedProviders: [(String, String?, Bool?)] = []

  func loadProviders() async throws -> [ProviderSettings] { providers }

  func saveProvider(id: String, apiKey: String?, enabled: Bool?) async throws -> ProviderSettings {
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

  func loadModels() async throws -> [String] { models }

  func setAgent(id: String, model: String?, thinkingLevel: String?) async throws -> BotSummary {
    agentChanges.append((id, model, thinkingLevel))
    guard let index = bots.firstIndex(where: { $0.id == id }) else {
      throw ClientError("no bot \(id)")
    }
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
  func catalogEvents() -> AsyncStream<BotCatalog> { AsyncStream { $0.finish() } }
}

final class StubConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
  }

  var sent: [Sent] = []
  var aborted = 0
  var lastBotId: String?
  /// Every `open`, so a reconnect is observable.
  var opens = 0
  private var continuation: AsyncStream<ConversationEvent>.Continuation?
  private var pending: [ConversationEvent] = []

  func open(botId: String, contextId: String? = nil) -> AsyncStream<ConversationEvent> {
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
    await bots.awaitScheduledPublishDrain()
    bots.select("b_1")
    port.emit(.connection(.ready))
    let snapshot = ConversationSnapshot(
      botId: "b_1", triggers: list ?? [summary()])
    port.emit(.snapshot(snapshot))
    await bots.awaitScheduledPublishDrain()
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
    await bots.awaitScheduledPublishDrain()
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
    await bots.awaitScheduledPublishDrain()
    bots.select("b_1")
    port.emit(.connection(.ready))
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    await bots.awaitScheduledPublishDrain()
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
      await bots.awaitScheduledPublishDrain()
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

    let deadline = Date().addingTimeInterval(30)
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
