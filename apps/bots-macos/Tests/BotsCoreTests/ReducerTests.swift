import BotsCore
import XCTest

/// Rows 56-58 and 60: the pure fold — upsert, replaces, deltas, snapshot replacement, and
/// the ranked submission rule that keeps a late reply from undoing a settlement.
final class ReducerTests: XCTestCase {
  private let botId = "b_1"

  private func message(
    _ id: String,
    role: MessageRole = .assistant,
    state: MessageState = .complete,
    text: String,
    requestId: String? = nil
  ) -> Message {
    Message(
      id: id,
      role: role,
      state: state,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [.text(text)],
      requestId: requestId
    )
  }

  func testAnAppendUpsertsByIdAndReplacesTheProvisional() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .append(message: message("p_a1", state: .streaming, text: "巴黎"), replaces: nil), to: state)
    XCTAssertEqual(state.messages.map(\.id), ["p_a1"])
    XCTAssertEqual(state.streaming, "p_a1")

    state = Reducer.apply(
      .append(message: message("e_10", text: "巴黎。"), replaces: "p_a1"),
      to: state
    )
    XCTAssertEqual(state.messages.map(\.id), ["e_10"], "the final entry replaces the attempt")
    XCTAssertEqual(state.messages.first?.text, "巴黎。")
    XCTAssertNil(state.streaming)

    // A second append for the same id is an upsert, not a duplicate.
    state = Reducer.apply(.append(message: message("e_10", text: "巴黎！"), replaces: nil), to: state)
    XCTAssertEqual(state.messages.count, 1)
    XCTAssertEqual(state.messages.first?.text, "巴黎！")
  }

  func testAnOptimisticBubbleBecomesTheCommittedEntry() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .append(message: .optimistic(requestId: "r_1", text: "问题"), replaces: nil),
      to: state
    )
    XCTAssertTrue(state.messages.first?.isOptimistic == true)

    state = Reducer.apply(
      .append(message: message("e_7", role: .user, text: "问题", requestId: "r_1"), replaces: nil),
      to: state
    )
    XCTAssertEqual(state.messages.count, 1, "the bubble and the entry are one message")
    XCTAssertEqual(state.messages.first?.id, "e_7")
    XCTAssertFalse(state.messages.first?.isOptimistic == true)
  }

  func testADeltaAppliesTextBlockAndMessageChangesInOrder() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .append(message: message("p_a2", state: .streaming, text: "巴黎"), replaces: nil),
      to: state
    )
    // The block change is asserted on its own: the whole-message change that follows
    // would hide a dropped block otherwise.
    state = Reducer.apply(
      .delta(messageId: "p_a2", changes: [.block(index: 0, block: .text("巴黎是法国的首都"))]),
      to: state
    )
    XCTAssertEqual(state.messages.first?.text, "巴黎是法国的首都")

    state = Reducer.apply(
      .delta(
        messageId: "p_a2",
        changes: [
          .block(index: 1, block: .text("新块")),
          .message(message("p_a2", state: .streaming, text: "巴黎是法国的首都。")),
          .text(index: 0, append: "真的"),
        ]
      ),
      to: state
    )
    XCTAssertEqual(
      state.messages.first?.text,
      "巴黎是法国的首都。真的",
      "a message change replaces content and later changes apply to the replacement"
    )
  }

  private func task(_ id: String, owner: String? = nil) -> TaskSummary {
    TaskSummary(
      id: id,
      kind: "pi.tool",
      status: .running,
      phase: "run",
      owner: owner,
      conversationId: "c_1"
    )
  }

  func testTasksAreAWholeListReplacement() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .snapshot(
        ConversationSnapshot(
          botId: botId,
          tasks: [task("t_1"), task("t_2", owner: "t_1")]
        )),
      to: state
    )
    XCTAssertEqual(state.tasks.map(\.id), ["t_1", "t_2"])

    state = Reducer.apply(.tasks([task("t_3")]), to: state)
    XCTAssertEqual(state.tasks.map(\.id), ["t_3"], "the event replaces the list, never merges it")

    state = Reducer.apply(.tasks([]), to: state)
    XCTAssertEqual(state.tasks, [], "an empty list means nothing runs")

    // A snapshot without the field is the same statement as an empty list.
    state = Reducer.apply(.tasks([task("t_4")]), to: state)
    state = Reducer.apply(.snapshot(ConversationSnapshot(botId: botId)), to: state)
    XCTAssertEqual(state.tasks, [])
  }

  func testASnapshotReplacesStateAndResetsTheBaseline() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(.append(message: message("e_1", text: "旧的"), replaces: nil), to: state)
    let snapshot = ConversationSnapshot(
      botId: botId,
      messages: [message("e_7", role: .user, text: "新的")],
      streaming: nil,
      running: true
    )
    let next = Reducer.apply(.snapshot(snapshot), to: state, rev: 42)
    XCTAssertEqual(next.messages.map(\.id), ["e_7"], "the snapshot replaces the window")
    XCTAssertEqual(next.lastRev, 42)
    XCTAssertTrue(next.running)
  }

  func testAPlacementRemovesTheOptimisticBubbleEvenWithoutARequestIdOnTheEntry() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .append(message: .optimistic(requestId: "r_1", text: "问题"), replaces: nil),
      to: state
    )
    // The daemon's append for the committed entry carries no requestId: only the
    // placement names it.
    state = Reducer.apply(
      .append(message: message("e_7", role: .user, text: "问题"), replaces: nil),
      to: state
    )
    state = Reducer.apply(
      .submission(Submission(id: "s_1", requestId: "r_1", status: .placed, entryId: "e_7")),
      to: state
    )
    XCTAssertEqual(state.messages.map(\.id), ["e_7"], "one send is one bubble")
    XCTAssertEqual(state.messages.first?.requestId, "r_1")
  }

  func testASubmissionOnlyMovesUpAndSettlesItsEntry() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .append(message: message("e_7", role: .user, text: "问题", requestId: nil), replaces: nil),
      to: state
    )
    let queued = Submission(id: "s_1", requestId: "r_1", status: .queued)
    state = Reducer.apply(.submission(queued), to: state)
    XCTAssertEqual(state.pending.map(\.status), [.queued])

    let placed = Submission(id: "s_1", requestId: "r_1", status: .placed, entryId: "e_7")
    state = Reducer.apply(.submission(placed), to: state)
    XCTAssertEqual(state.messages.first?.requestId, "r_1", "placement ties the entry to its send")

    let done = Submission(
      id: "s_1",
      requestId: "r_1",
      status: .done,
      entryId: "e_7",
      answerEntryId: "e_10"
    )
    state = Reducer.apply(.submission(done), to: state)
    XCTAssertTrue(state.pending.isEmpty)

    // A duplicate connection-scoped reply with a lower rank cannot undo the settlement.
    state = Reducer.apply(.submission(queued), to: state)
    XCTAssertTrue(state.pending.isEmpty, "queued never comes back after done")
    XCTAssertEqual(state.ranks["s_1"]?.status, .done)
  }

  func testASnapshotCannotResurrectASettledSubmissionAsPending() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .submission(Submission(id: "s_1", requestId: "r_1", status: .done, answerEntryId: "e_10")),
      to: state
    )
    let snapshot = ConversationSnapshot(
      botId: botId,
      pending: [Submission(id: "s_1", requestId: "r_1", status: .queued)]
    )
    let next = Reducer.snapshot(snapshot, rev: 9, keeping: state.ranks)
    XCTAssertTrue(next.pending.isEmpty, "a settled submission is never pending again")
    XCTAssertEqual(next.ranks["s_1"]?.status, .done, "and its rank stays settled")
  }

  func testAParkedSnapshotCarriesTheRecoveryState() {
    let state = Reducer.snapshot(
      ConversationSnapshot(botId: botId, running: true, parked: true),
      rev: 3
    )
    XCTAssertTrue(state.parked)
  }

  func testAnOlderHistoryPageIsPrependedWithoutDuplicates() {
    var state = ConversationState(botId: botId)
    state = Reducer.apply(
      .snapshot(
        ConversationSnapshot(
          botId: botId,
          messages: [message("e_19", role: .user, text: "新"), message("e_22", text: "新答")],
          truncatedBefore: "e_16"
        )
      ),
      to: state,
      rev: 5
    )
    let page = HistoryPage(
      messages: [
        message("e_13", role: .user, text: "旧"),
        message("e_16", text: "旧答"),
        message("e_19", role: .user, text: "新"),
      ],
      hasMore: true
    )
    state = Reducer.apply(.history(page: page), to: state)
    XCTAssertEqual(state.messages.map(\.id), ["e_13", "e_16", "e_19", "e_22"])
    XCTAssertEqual(state.truncatedBefore, "e_16")
  }

  func testGapDetectionAcceptsConsecutiveRevisionsOnly() {
    var gap = RevisionGap()
    XCTAssertTrue(gap.accept(1))
    XCTAssertTrue(gap.accept(2))
    XCTAssertFalse(gap.accept(4), "a missing revision is a gap")
    XCTAssertTrue(gap.isStale(2))
    gap.reset(to: 10)
    XCTAssertTrue(gap.accept(11))
  }
}

extension ReducerTests {
  func testANestedToolCallDeltaGrowsTheArguments() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [
            .toolCall(
              callId: "c_1",
              name: "search",
              args: ["nested": .object(["q": .string("a")]), "items": .array([.string("a")])]
            )
          ]
        ),
        replaces: nil
      ),
      to: state
    )
    state = Reducer.apply(
      .delta(
        messageId: "p_a1",
        changes: [
          .toolCall(index: 0, callId: "c_1", path: ["args", "nested", "q"], append: "Z"),
          .toolCall(index: 0, callId: "c_1", path: ["args", "items", 0], append: "Z"),
        ]
      ),
      to: state
    )
    guard case .toolCall(_, _, let args) = state.messages.first?.blocks[0] else {
      return XCTFail("the tool call is still there")
    }
    XCTAssertEqual(args["nested"], .object(["q": .string("aZ")]))
    XCTAssertEqual(args["items"], .array([.string("aZ")]))
  }

  func testToolDeltaCreatesContainersAndRefusesNegativeIndexes() {
    func fold(_ path: [JSONPathComponent], append: String = "Z") -> [String: JSONValue] {
      let message = Reducer.apply(
        .delta(
          messageId: "p_a1",
          changes: [.toolCall(index: 0, callId: "c_1", path: ["args"] + path, append: append)]
        ),
        to: ConversationState(
          botId: "b_1",
          messages: [
            Message(
              id: "p_a1",
              role: .assistant,
              state: .streaming,
              createdAt: "x",
              blocks: [.toolCall(callId: "c_1", name: "search", args: [:])]
            )
          ]
        )
      )
      guard case .toolCall(_, _, let args) = message.messages.first?.blocks[0] else { return [:] }
      return args
    }
    XCTAssertEqual(fold(["nested", "-1"]), ["nested": .object(["-1": .string("Z")])])
    XCTAssertEqual(fold(["items", 0]), ["items": .array([.string("Z")])])
    XCTAssertEqual(fold(["items", -1]), [:], "a negative index is ignored, never indexed")
  }

  func testThinkingToolAndUnknownTargetsAreTolerated() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: Message(
          id: "p_a1",
          role: .assistant,
          state: .streaming,
          createdAt: "x",
          blocks: [.text("巴黎"), .toolCall(callId: "c_1", name: "search", args: [:])]
        ),
        replaces: nil
      ),
      to: state
    )
    state = Reducer.apply(
      .delta(
        messageId: "p_a1",
        changes: [
          .thinking(index: 0, append: "忽略：不是 thinking 块"),
          .thinking(index: 5, append: "越界"),
          .toolCall(index: 1, callId: "c_1", path: ["args", "q"], append: "x"),
          .toolCall(index: 0, callId: "c_9", path: [], append: "y"),
          .block(index: 9, block: .text("越界")),
          .text(index: 1, append: "忽略：不是文本块"),
        ]
      ),
      to: state
    )
    XCTAssertEqual(state.messages.first?.text, "巴黎")
    if case .toolCall(_, _, let args) = try? XCTUnwrap(state.messages.first?.blocks[1]),
      case .string(let value) = args["q"]
    {
      XCTAssertEqual(value, "x", "a toolcall delta grows the call's own arguments")
    } else {
      XCTFail("the toolcall delta did not reach the block")
    }

    // A delta for a message that is not in the window is ignored, not appended.
    state = Reducer.apply(
      .delta(messageId: "missing", changes: [.text(index: 0, append: "x")]), to: state)
    XCTAssertEqual(state.messages.count, 1)

    // A replace that names an unknown provisional falls back to upsert by id.
    state = Reducer.apply(
      .append(message: message("e_10", text: "最终"), replaces: "p_missing"),
      to: state
    )
    XCTAssertEqual(state.messages.map(\.id), ["p_a1", "e_10"])
  }
}

func testTriggerListIsReplacedWholeAndSurvivesASnapshot() {
  let first = TriggerSummary(
    id: "t_9f2a1c3d04",
    kind: .schedule,
    name: "morning triage",
    enabled: true,
    schedule: TriggerSummary.Schedule(
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      nextDueAt: "2026-10-29T01:00:00.000Z"
    ),
    counters: TriggerSummary.Counters(fired: 2)
  )
  let second = TriggerSummary(
    id: "t_7b1e55aa10",
    kind: .webhook,
    name: "deploy notify",
    enabled: false,
    counters: TriggerSummary.Counters(fired: 3, dropped: 4)
  )

  var state = Reducer.snapshot(ConversationSnapshot(botId: "b_1", triggers: [first]), rev: 1)
  XCTAssertEqual(state.triggers, [first], "a snapshot carries the list")

  state = Reducer.apply(.triggers([first, second]), to: state, rev: 2)
  XCTAssertEqual(state.triggers, [first, second], "the event replaces the whole list")

  state = Reducer.apply(.triggers([second]), to: state, rev: 3)
  XCTAssertEqual(state.triggers, [second], "a removed trigger leaves the list")

  state = Reducer.snapshot(ConversationSnapshot(botId: "b_1"), rev: 4)
  XCTAssertEqual(state.triggers, [], "a snapshot without triggers means none")

  XCTAssertEqual(second.warning, "丢弃 4", "a dropped delivery is visible on the row")
  XCTAssertNil(first.warning)
}

func testAnOriginSurvivesTheSubmissionThatNamesTheEntry() {
  let origin = MessageOrigin(
    kind: .webhook,
    label: "deploy notify"
  )
  let message = Message(
    id: "e_1",
    role: .user,
    state: .complete,
    createdAt: "2026-10-28T00:00:00.000Z",
    blocks: [.text("deploy finished")],
    origin: origin
  )
  var state = Reducer.snapshot(ConversationSnapshot(botId: "b_1", messages: [message]), rev: 1)
  state = Reducer.apply(
    .submission(
      Submission(id: "s_1", requestId: "r_1", status: .placed, entryId: "e_1")
    ),
    to: state,
    rev: 2
  )
  XCTAssertEqual(state.messages.first?.origin, origin, "attaching an id keeps the label")
  XCTAssertEqual(state.messages.first?.requestId, "r_1")
  XCTAssertEqual(origin.chip, "deploy notify")
  XCTAssertNil(MessageOrigin(kind: .human).chip, "a person's message needs no chip")
}
