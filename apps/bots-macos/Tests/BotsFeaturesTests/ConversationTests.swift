import BotsCore
import BotsFeatures
import Foundation
import XCTest

@MainActor
final class ConversationTests: XCTestCase {
  private var outboxDirectory: URL!

  override func setUp() async throws {
    outboxDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-outbox-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: outboxDirectory)
  }

  private func makeModel(
    botId: String = "b_1"
  ) -> (ConversationViewModel, FakeConversation, OutboxStore) {
    let conversation = FakeConversation()
    let outbox = OutboxStore(directory: outboxDirectory)
    let model = ConversationViewModel(botId: botId, conversation: conversation, outbox: outbox)
    return (model, conversation, outbox)
  }

  private func ready(_ model: ConversationViewModel) {
    model.select(botId: "b_1")
  }

  func testAnAgentUpdatePreservesLoadedHistoryAndUnconfirmedSends() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true, parked: true)))
    try await waitUntil { model.hasSnapshot }
    let older = Message(
      id: "e_1", role: .user, state: .complete, createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [.text("已经加载的旧消息")])
    fake.emit(.history(page: HistoryPage(messages: [older], hasMore: true)))
    try await waitUntil { model.state.messages.count == 1 }
    model.draft = "尚未确认的新消息"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    let before = model.state
    let pending = try outbox.entries(for: "b_1").map(\.requestId)
    XCTAssertEqual(before.messages.count, 2)
    XCTAssertTrue(before.messages.last?.isOptimistic == true)
    let agent = AgentView(
      model: ModelRef(provider: "faux", modelId: "faux-1"),
      thinkingLevel: "high", instructions: "Keep the conversation intact.")
    fake.emit(.agent(agent))
    try await waitUntil { model.state.agent == agent }

    var expected = before
    expected.agent = agent
    XCTAssertEqual(model.state, expected)
    XCTAssertTrue(model.hasOlder)
    XCTAssertTrue(model.parked)
    XCTAssertEqual(try outbox.entries(for: "b_1").map(\.requestId), pending)
  }

  func testInsertingSendsASteerAndAPlainSendQueues() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.hasSnapshot }

    model.draft = "先排队"
    model.send()
    model.draft = "改方向"
    model.send(inserting: true)
    try await waitUntil { fake.busyModes.count == 2 }

    // Two sends started from one turn race each other on the wire; what the person asked for
    // is that one queues and one steers, not which of them the socket wrote first.
    XCTAssertEqual(
      fake.busyModes.sorted { "\($0)" < "\($1)" }, [.followUp, .steer].sorted { "\($0)" < "\($1)" })
  }

  func testSteeredSendKeepsItsModeAcrossReconnect() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.hasSnapshot }

    model.draft = "Change direction"
    model.send(inserting: true)
    try await waitUntil { fake.sent.count == 1 }
    let stored = try XCTUnwrap(try outbox.entries(for: "b_1").first)
    XCTAssertEqual(stored.whenBusy, .steer)

    model.disconnect()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { fake.sent.count == 2 }
    XCTAssertEqual(fake.sent[1].requestId, stored.requestId)
    XCTAssertEqual(fake.busyModes, [.steer, .steer])
  }

  func testAnsweringACardSendsTheChosenLabelsAndNeverTheText() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(for: .milliseconds(30))

    model.answer(entryId: "e_11", chosen: ["继续"], skipped: false)
    try await Task.sleep(for: .milliseconds(40))
    model.answer(entryId: "e_12", chosen: [], skipped: true)
    try await Task.sleep(for: .milliseconds(40))

    XCTAssertEqual(fake.answered.count, 2)
    XCTAssertEqual(fake.answered.first?.entryId, "e_11")
    XCTAssertEqual(fake.answered.first?.chosen, ["继续"])
    XCTAssertEqual(fake.answered.first?.skipped, false)
    XCTAssertEqual(fake.answered.last?.skipped, true)
    XCTAssertTrue(fake.sent.isEmpty, "an answer is not a send: the daemon writes the message")
  }

  func testSnapshotReadinessResetsAcrossReconnectSelectionAndDisconnect() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1", running: true)))
    try await waitUntil { model.hasSnapshot }

    fake.emit(.connection(.reconnecting(attempt: 1)))
    try await waitUntil { model.connection == .reconnecting(attempt: 1) }
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.hasSnapshot }

    model.select(botId: "b_2")
    XCTAssertFalse(model.hasSnapshot)
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_2")))
    try await waitUntil { model.hasSnapshot }
    model.disconnect()
    XCTAssertFalse(model.hasSnapshot)
  }

  func testOversizedDraftRemainsVisibleAndIsNotSent() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }

    for draft in [
      "  \(String(repeating: "界", count: 8_001))\n",
      String(repeating: "😀", count: 90_000),
      "\(String(repeating: "x", count: 8_000)) ",
    ] {
      model.draft = draft
      model.send()
      XCTAssertEqual(model.draft, draft)
      XCTAssertTrue(model.errorBanner?.contains("8,000") == true)
      XCTAssertTrue(model.state.messages.isEmpty)
      XCTAssertTrue(try outbox.entries(for: "b_1").isEmpty)
      XCTAssertTrue(fake.sent.isEmpty)
    }

    model.draft = String(repeating: "界", count: 8_000)
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertNil(model.errorBanner, "a valid retry clears the limit warning")
  }

  func testSendPreservesLeadingTrailingWhitespaceAndNewlines() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    let text = "  First line\r\nSecond line  \n"
    model.draft = text
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertEqual(Array(fake.sent[0].text.utf8), Array(text.utf8))
  }

  func testTextLimitCountsUnicodeScalarsNotGraphemeClusters() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }

    model.draft = String(repeating: "😀", count: 8_000)
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertEqual(fake.sent[0].text.unicodeScalars.count, 8_000)

    let decomposed = String(repeating: "e\u{301}", count: 4_001)
    model.draft = decomposed
    model.send()
    XCTAssertEqual(model.draft, decomposed)
    XCTAssertTrue(model.errorBanner?.contains("8,000") == true)
    XCTAssertEqual(fake.sent.count, 1)
  }

  func testComposerSendsOptimisticallyAndTheEntryReplacesTheBubble() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }

    model.draft = "法国的首都是哪里？"
    model.send()

    XCTAssertEqual(model.draft, "", "the composer clears when the send leaves")
    XCTAssertEqual(model.state.messages.count, 1, "the bubble is shown before the daemon answers")
    XCTAssertTrue(model.state.messages[0].isOptimistic)
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 1, "the outbox is stored before the frame")
    let requestId = try XCTUnwrap(try outbox.entries(for: "b_1").first?.requestId)
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertEqual(fake.sent.last?.requestId, requestId)

    fake.emit(
      .append(
        message: Message(
          id: "e_7",
          role: .user,
          state: .complete,
          createdAt: "2026-01-01T00:00:00.000Z",
          blocks: [.text("法国的首都是哪里？")],
          requestId: requestId
        ),
        replaces: nil
      )
    )
    fake.emit(
      .submission(
        Submission(
          id: "s_1", requestId: requestId, status: .done, entryId: "e_7", answerEntryId: "e_10")
      )
    )
    try await waitUntil { model.state.messages.count == 1 && !model.state.messages[0].isOptimistic }
    XCTAssertEqual(model.state.messages[0].id, "e_7")
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0, "a terminal record removes the entry")
  }

  func testNotAdmittedRemovesTheBubbleAndTheOutboxEntry() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    model.draft = "太长"
    model.send()
    let requestId = try XCTUnwrap(try outbox.entries(for: "b_1").first?.requestId)

    fake.emit(
      .error(
        kind: .limitExceeded,
        disposition: .notAdmitted,
        message: "the command was refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await waitUntil { model.state.messages.isEmpty }
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0, "a refusal clears the entry")
    XCTAssertEqual(model.draft, "太长", "and the text comes back so it can be fixed")
    XCTAssertNotNil(model.errorBanner)
  }

  func testAnUnconfirmedAdmissionKeepsTheOutboxEntry() async throws {
    let (model, fake, outbox) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    model.draft = "重要的问题"
    model.send()
    let requestId = try XCTUnwrap(try outbox.entries(for: "b_1").first?.requestId)

    fake.emit(
      .error(
        kind: .internalError,
        disposition: .unknown,
        message: "admission could not be confirmed",
        failure: "f_2",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(
      try outbox.entries(for: "b_1").count,
      1,
      "an unknown outcome keeps the entry for a retry with the same requestId"
    )
  }

  func testASessionFailureShowsUnavailableAndRecoverAsksTheDaemon() async throws {
    let (model, fake, _) = makeModel()
    ready(model)
    fake.emit(.connection(.ready))
    try await waitUntil { model.connection == .ready }
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    fake.emit(
      .error(
        kind: .storageFailed,
        disposition: .runtime,
        message: "the session closed",
        failure: "f_3",
        requestId: nil
      )
    )
    try await waitUntil { model.state.unavailable != nil }
    XCTAssertTrue(model.state.messages.isEmpty)
    XCTAssertFalse(model.canSend)

    model.recover()
    try await waitUntil { fake.recovered == 1 }
  }

  func testTheStoredOutboxIsReplayedAfterTheFirstSnapshot() async throws {
    let outbox = OutboxStore(directory: outboxDirectory)
    let stored = OutboxEntry(botId: "b_1", requestId: "r_stored_1", text: "断网时写的")
    try outbox.add(stored)
    let fake = FakeConversation()
    let model = ConversationViewModel(botId: "b_1", conversation: fake, outbox: outbox)
    ready(model)
    fake.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(fake.sent.isEmpty, "a send before the subscription would be refused")

    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { fake.sent.contains { $0.requestId == "r_stored_1" } }
    XCTAssertEqual(
      fake.sent.last?.text,
      "断网时写的",
      "reconciliation re-sends the stored entry with its original requestId"
    )
  }

  private func waitUntil(
    _ condition: () -> Bool,
    timeout: TimeInterval = 2
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("condition not met within \(timeout) s")
  }
}

final class FakeConversation: ConversationPort {
  struct Sent {
    let text: String
    let requestId: String
  }

  var sent: [Sent] = []
  var lastBotId: String?
  var recovered = 0
  var failRecover = false
  var answered: [(entryId: String, chosen: [String], skipped: Bool)] = []
  var aborted = 0
  var promoted: [String] = []
  var historyRequests: [String] = []
  private var continuation: AsyncStream<ConversationEvent>.Continuation?

  var busyModes: [BusyMode] = []

  func open(botId: String) -> AsyncStream<ConversationEvent> {
    AsyncStream { continuation in
      self.continuation = continuation
    }
  }

  func emit(_ event: ConversationEvent) {
    continuation?.yield(event)
  }

  func send(
    _ text: String,
    whenBusy: BusyMode,
    context: CommandContext,
    botId: String
  ) async throws {
    sent.append(Sent(text: text, requestId: context.requestId ?? ""))
    busyModes.append(whenBusy)
    lastBotId = botId
  }

  func answer(
    entryId: String,
    chosen: [String],
    skipped: Bool,
    context: CommandContext,
    botId: String
  ) async throws {
    answered.append((entryId: entryId, chosen: chosen, skipped: skipped))
    lastBotId = botId
  }

  func abort(context: CommandContext, botId: String) async throws {
    aborted += 1
    lastBotId = botId
  }

  func promote(requestId: String, context: CommandContext, botId: String) async throws {
    promoted.append(requestId)
    lastBotId = botId
  }

  func recover(context: CommandContext, botId: String) async throws {
    if failRecover { throw ClientError("there is no connection") }
    recovered += 1
    lastBotId = botId
  }

  func resync(context: CommandContext, botId: String) async throws {
    lastBotId = botId
  }

  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws {
    historyRequests.append(messageId)
    lastBotId = botId
  }

  func close() {
    continuation?.finish()
    continuation = nil
  }
}

@MainActor
final class ConversationLifecycleTests: XCTestCase {
  private func make() -> (ConversationViewModel, FakeConversation) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-life-\(UUID().uuidString)", isDirectory: true)
    let conversation = FakeConversation()
    let model = ConversationViewModel(
      botId: "b_1",
      conversation: conversation,
      outbox: OutboxStore(directory: directory)
    )
    return (model, conversation)
  }

  func testSendingRequiresAReadyConnectionAndANonEmptyDraft() async throws {
    let (model, fake) = make()
    model.draft = "还没连接"
    model.send()
    XCTAssertTrue(fake.sent.isEmpty, "a draft before the handshake is not sent")
    XCTAssertEqual(model.draft, "还没连接", "and the text stays in the composer")

    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 30_000_000)
    model.draft = "   "
    model.send()
    XCTAssertTrue(fake.sent.isEmpty, "a blank draft is not sent")

    model.draft = "好"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.sent.count, 1)
  }

  func testPromotePullsTheQueuedRequestThroughThePort() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 30_000_000)

    model.promote("r_queued_1")
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.promoted, ["r_queued_1"])
    XCTAssertEqual(fake.lastBotId, "b_1")
  }

  func testAbortRecoverAndHistoryGoThroughThePort() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(
      .snapshot(
        ConversationSnapshot(
          botId: "b_1",
          messages: [
            Message(
              id: "e_7",
              role: .user,
              state: .complete,
              createdAt: "x",
              blocks: [.text("旧")],
              requestId: "r_1"
            )
          ],
          truncatedBefore: "e_7"
        )
      )
    )
    try await Task.sleep(nanoseconds: 30_000_000)
    model.abort()
    model.recover()
    model.loadOlder()
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.aborted, 1)
    XCTAssertEqual(fake.recovered, 1)
    XCTAssertEqual(fake.historyRequests, ["e_7"])
  }

  func testAStatusAndADeltaUpdateTheTranscriptLive() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.status(running: true, inbox: [], streaming: "p_a1"))
    fake.emit(
      .append(
        message: Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [.text("")]
        ),
        replaces: nil
      )
    )
    fake.emit(.delta(messageId: "p_a1", changes: [.text(index: 0, append: "巴黎")]))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.state.running)
    XCTAssertEqual(model.state.streaming, "p_a1")
    XCTAssertEqual(model.state.messages.first?.text, "巴黎")
  }

  func testTasksFollowTheSelectedBotAndAreClearedByASelection() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(
      .snapshot(
        ConversationSnapshot(
          botId: "b_1",
          tasks: [TaskSummary(id: "t_1", kind: "pi.generation", status: .running)]
        ))
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(model.tasks.map(\.id), ["t_1"])

    fake.emit(.tasks([TaskSummary(id: "t_2", kind: "pi.tool", status: .waiting)]))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(model.tasks.map(\.id), ["t_2"], "the event replaces the list")

    model.select(botId: "b_2")
    XCTAssertEqual(model.tasks, [], "another bot starts without the previous bot's tasks")
  }

  func testACatalogEventIsForwardedAndAnErrorCanBeDismissed() async throws {
    let (model, fake) = make()
    var forwarded: BotCatalog?
    model.onCatalog = { forwarded = $0 }
    model.select(botId: "b_1")
    fake.emit(
      .catalog(
        BotCatalog(
          bots: [
            BotSummary(
              id: "b_1",
              title: "一",
              createdAt: "x",
              updatedAt: "x",
              model: ModelRef(provider: "p", modelId: "m"),
              state: .idle
            )
          ]
        ))
    )
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: nil
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(forwarded?.bots.map(\.id), ["b_1"])
    XCTAssertEqual(model.errorBanner, "refused")
    model.dismissError()
    XCTAssertNil(model.errorBanner)
  }

  func testARefusalKeepsARejectedTextAndANewerDraft() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "A"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    model.draft = "B"
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.draft.contains("A"), "the refused text is recoverable")
    XCTAssertTrue(model.draft.contains("B"), "and the newer draft is not overwritten")
  }

  func testARefusedDraftStaysWithTheBotThatSentIt() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "原文"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    model.draft = "新草稿"
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(model.draft, "新草稿\n\n原文")

    model.select(botId: "b_2")
    XCTAssertEqual(model.draft, "", "the refused draft does not move to another bot")
    model.draft = "另一个 Bot 的草稿"
    model.select(botId: "b_1")
    XCTAssertEqual(model.draft, "新草稿\n\n原文")
    model.select(botId: "b_2")
    XCTAssertEqual(model.draft, "另一个 Bot 的草稿")
  }

  func testAReconnectReconcilesTheOutboxAgain() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "第一次"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let firstSends = fake.sent.count

    fake.emit(.connection(.reconnecting(attempt: 1)))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 60_000_000)
    XCTAssertGreaterThan(
      fake.sent.count,
      firstSends,
      "the stored request is re-sent with its original requestId after a reconnect"
    )
    XCTAssertEqual(
      fake.sent.last?.requestId,
      fake.sent.first?.requestId,
      "reconciliation never invents a new request id"
    )
  }

  func testASettledRecordIsRestoredWhenTheBotIsSelected() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-settled-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = OutboxStore(directory: directory)
    try outbox.add(OutboxEntry(botId: "b_1", requestId: "r_settled", text: "问"))
    try outbox.settle(
      Submission(id: "s_1", requestId: "r_settled", status: .unanswered, reason: "aborted"),
      botId: "b_1"
    )
    let fake = FakeConversation()
    let model = ConversationViewModel(botId: "", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    try await Task.sleep(nanoseconds: 30_000_000)
    XCTAssertEqual(model.state.ranks["s_1"]?.status, .unanswered)
    XCTAssertEqual(model.state.ranks["s_1"]?.reason, "aborted")
    XCTAssertTrue(model.state.pending.isEmpty)
  }

  func testARefusedRequestIsNotReplayedWhenItsEntryCannotBeRemoved() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-refused-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }
    let fake = FakeConversation()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(botId: "b_1", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 40_000_000)
    model.draft = "A"
    model.send()
    try await Task.sleep(nanoseconds: 40_000_000)
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    let sendsBefore = fake.sent.count

    // The refusal cannot be removed because the directory refuses the atomic write.
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    fake.emit(
      .error(
        kind: .invalidCommand,
        disposition: .notAdmitted,
        message: "refused",
        failure: "f_1",
        requestId: requestId
      )
    )
    try await Task.sleep(nanoseconds: 60_000_000)
    XCTAssertNotNil(
      model.errorBanner,
      "a refusal whose entry could not be removed is reported, not swallowed"
    )
    // A reconnect reconciles the outbox; the refused request must not be re-sent.
    fake.emit(.connection(.reconnecting(attempt: 1)))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 80_000_000)
    XCTAssertEqual(fake.sent.count, sendsBefore, "a refused request is never replayed")

    // The refusal is durable even while the support directory is unwritable: the
    // tombstone falls back to a user-private temporary directory, so a new process that
    // starts from the same file still does not replay it.
    XCTAssertTrue(
      try OutboxStore(directory: directory).refusedRequests().contains(requestId),
      "the refusal survives a restart"
    )
    let restarted = FakeConversation()
    let reopened = OutboxStore(directory: directory)
    let next = ConversationViewModel(botId: "b_1", conversation: restarted, outbox: reopened)
    next.select(botId: "b_1")
    restarted.emit(.connection(.ready))
    restarted.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await Task.sleep(nanoseconds: 80_000_000)
    XCTAssertEqual(restarted.sent.count, 0, "a restarted client never replays a refused request")
  }

  func testAFailedRecoverKeepsTheParkedAffordance() async throws {
    let (model, fake) = make()
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    fake.emit(
      .error(
        kind: .taskParked,
        disposition: .runtime,
        message: "a task was parked",
        failure: "f_parked",
        requestId: nil
      )
    )
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.parked)
    fake.failRecover = true
    model.recover()
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertTrue(model.parked, "a recover that never reached the daemon leaves the entry")
    XCTAssertNotNil(model.errorBanner)
  }

  func testRetryReusesTheStoredRequestId() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-retry-\(UUID().uuidString)", isDirectory: true)
    let fake = FakeConversation()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(botId: "b_1", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    fake.emit(.connection(.ready))
    try await Task.sleep(nanoseconds: 30_000_000)
    model.retry(OutboxEntry(botId: "b_1", requestId: "r_retry_1", text: "再发一次"))
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(fake.sent.last?.requestId, "r_retry_1")
    XCTAssertEqual(fake.sent.last?.text, "再发一次")
  }
}

@MainActor
final class SettledRankTests: XCTestCase {
  func testARestoredSettlementKeepsItsSubmissionId() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-settled-key-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = OutboxStore(directory: directory)
    try outbox.add(OutboxEntry(botId: "b_1", requestId: "r_saved", text: "问"))
    try outbox.settle(
      Submission(
        id: "s_saved",
        requestId: "r_saved",
        status: .done,
        entryId: "e_7",
        answerEntryId: "e_10"
      ),
      botId: "b_1"
    )
    let fake = FakeConversation()
    let model = ConversationViewModel(botId: "", conversation: fake, outbox: outbox)
    model.select(botId: "b_1")
    try await Task.sleep(nanoseconds: 40_000_000)
    XCTAssertEqual(
      model.state.ranks["s_saved"]?.status,
      .done,
      "the rank is keyed by the submission id, not the request id"
    )
    XCTAssertNil(model.state.ranks["r_saved"], "a request id is not a rank key")
  }
}
