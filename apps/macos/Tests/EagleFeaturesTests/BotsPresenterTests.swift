import BotsCore
import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Bots presentation")
struct BotsPresenterTests {
  private let presenter = BotsPresenter()

  @Test("connection loss overrides a stale running snapshot in the header")
  func disconnectedActivity() {
    let state = ConversationState(botId: "b_1", running: true)
    #expect(presenter.subtitle(for: state, connection: .reconnecting(attempt: 2)) == "正在重连（第 2 次）")
    #expect(presenter.subtitle(for: state, connection: .stopped) == "已断开")
    #expect(presenter.subtitle(for: state, connection: .failed(reason: "Offline")) == "Offline")
  }

  @Test("the header distinguishes processing from a visible answer")
  func answeringActivity() {
    var state = ConversationState(botId: "b_1", running: true)
    #expect(presenter.subtitle(for: state, connection: .ready) == "处理中")
    state.messages = [message("p_a1", role: .assistant, state: .streaming, text: "Hello")]
    state.streaming = "p_a1"
    #expect(presenter.subtitle(for: state, connection: .ready) == "回答中")
    state.running = false
    #expect(presenter.subtitle(for: state, connection: .ready) == "已连接")
  }

  private func message(
    _ id: String,
    role: MessageRole,
    state: MessageState = .complete,
    text: String
  ) -> Message {
    Message(
      id: id,
      role: role,
      state: state,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: [.text(text)]
    )
  }

  @Test("a transcript maps user, assistant and notice rows")
  func transcript() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(message: message("e_7", role: .user, text: "问题"), replaces: nil),
      to: state
    )
    state = Reducer.apply(
      .append(message: message("e_10", role: .assistant, text: "回答"), replaces: nil),
      to: state
    )
    state = Reducer.apply(
      .append(
        message: message("e_11", role: .notice, text: "回答超出传输上限"),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 3)
    #expect(
      {
        if case .user(_, "问题", _) = entries[0] { return true } else { return false }
      }())
    #expect(
      {
        if case .assistant(_, [.paragraph("回答")], _) = entries[1] {
          return true
        } else {
          return false
        }
      }())
    #expect(
      {
        if case .assistant(_, [.note("回答超出传输上限")], _) = entries[2] {
          return true
        } else {
          return false
        }
      }())
  }

  @Test("streaming text grows in place and a silent attempt reports waiting")
  func streaming() {
    var state = ConversationState(botId: "b_1", running: true)
    state = Reducer.apply(
      .append(
        message: message("p_a1", role: .assistant, state: .streaming, text: ""),
        replaces: nil
      ),
      to: state
    )
    #expect(presenter.isWaiting(for: state))

    state = Reducer.apply(
      .delta(messageId: "p_a1", changes: [.text(index: 0, append: "巴黎")]),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(
      entries.contains {
        if case .streamingAssistant(_, [.paragraph("巴黎")]) = $0 { true } else { false }
      })
    #expect(!presenter.isWaiting(for: state))
  }

  @Test("an unavailable bot says so and a sidebar item carries its state")
  func unavailable() {
    let state = ConversationState(
      botId: "b_1",
      unavailable: BotUnavailable(reason: .storageFailed, message: "session closed")
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 1)
    #expect(noteText(entries[0])?.contains("不可用") == true)

    let bot = BotSummary(
      id: "b_1",
      title: "研究员",
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .running
    )
    let item = presenter.sidebarItem(for: bot)
    #expect(item.title == "研究员")
    // A working bot animates its own face instead of wearing a tag.
    #expect(item.busy)
    #expect(item.tag != "回答中")
    #expect((0..<Theme.Palette.avatarTints.count).contains(item.tintIndex))
  }

  private func noteText(_ entry: TranscriptEntry?) -> String? {
    guard case .assistant(_, let blocks, _) = entry else { return nil }
    for block in blocks {
      if case .note(let text) = block { return text }
    }
    return nil
  }

  @Test("thinking and tool results stay out of the answer bubble")
  func hiddenBlocks() {
    var state = ConversationState(botId: "b_1")
    let message = Message(
      id: "e_10",
      role: .assistant,
      state: .complete,
      createdAt: "x",
      blocks: [
        .thinking("内心独白"),
        .text("可见"),
        .toolCall(callId: "c_1", name: "search", args: ["q": .string("paris")]),
        .toolResult(
          callId: "c_1", name: "search", text: "工具结果", isError: false, durationMs: nil),
      ],
      stopReason: .length
    )
    state = Reducer.apply(.append(message: message, replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    // The answer is its own bubble: no thinking, no call, no result text inside it.
    #expect(
      {
        if case .assistant(_, let blocks, _) = entries.first {
          return blocks == [.paragraph("可见")]
        }
        return false
      }())
    // The call is a row of its own, and the length note follows as a separate row.
    #expect(
      entries.contains {
        if case .tool(_, let row) = $0 { row.name == "search" } else { false }
      })
    #expect(
      entries.contains {
        if case .assistant(_, [.note("回答因为长度上限被截断。")], _) = $0 { true } else { false }
      })
  }

  @Test("an aborted answer says it was aborted")
  func aborted() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message("e_10", role: .assistant, state: .aborted, text: "一半"),
        replaces: nil
      ),
      to: state
    )
    let entry = presenter.transcript(for: state).first
    #expect(
      {
        if case .assistant(_, [.paragraph("一半"), .note("回答已中止")], _) = entry { return true }
        return false
      }())
  }
}

@Suite("Bot faces")
struct BotFaceTests {
  private let presenter = BotsPresenter()

  @Test("the sidebar item carries the chosen face and the optional label")
  func faceAndLabel() {
    let bot = BotSummary(
      id: "b_1",
      title: "研究员",
      label: "研究",
      appearance: BotAppearance(shape: .star, tint: .violet),
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .idle
    )
    let item = presenter.sidebarItem(for: bot)
    #expect(item.tag == "研究")
    #expect(item.face?.shape == .star)
    #expect(item.face?.tint == .violet)
  }

  @Test("a bot written before appearance draws the default face")
  func defaultFace() {
    let bot = BotSummary(
      id: "b_1",
      title: "旧的",
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "p", modelId: "m"),
      state: .idle
    )
    #expect(bot.face == .standard)
    let item = presenter.sidebarItem(for: bot)
    #expect(item.face?.shape == .blob)
    #expect(item.face?.tint == .green)
  }
}

@Suite("Bots tool rows")
struct BotsToolRowTests {
  private let presenter = BotsPresenter()

  private func message(
    _ id: String,
    role: MessageRole,
    state: MessageState = .complete,
    blocks: [ContentBlock]
  ) -> Message {
    Message(id: id, role: role, state: state, createdAt: "2026-01-01T00:00:00.000Z", blocks: blocks)
  }

  private func call(_ callId: String = "c_1") -> Message {
    message(
      "e_10",
      role: .assistant,
      blocks: [
        .text("我先看一下。"),
        .toolCall(
          callId: callId,
          name: "read_file",
          args: ["path": .string("notes.txt"), "limit": .number(50)]
        ),
      ]
    )
  }

  private func result(
    _ callId: String = "c_1",
    isError: Bool = false,
    durationMs: Int? = 21
  ) -> Message {
    message(
      "e_11",
      role: .tool,
      blocks: [
        .toolResult(
          callId: callId,
          name: "read_file",
          text: "工作区里的内容",
          isError: isError,
          durationMs: durationMs
        )
      ]
    )
  }

  private func toolRows(_ entries: [TranscriptEntry]) -> [ToolRow] {
    entries.flatMap { entry -> [ToolRow] in
      switch entry {
      case .tool(_, let row): return [row]
      case .toolRun(_, let rows): return rows
      default: return []
      }
    }
  }

  @Test("a call without its result is a running row while the run works")
  func runningRow() {
    var state = ConversationState(botId: "b_1", running: true)
    state = Reducer.apply(.append(message: call(), replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.count == 1)
    #expect(rows.first?.name == "read_file")
    #expect(rows.first?.subtitle == "path=notes.txt · limit=50")
    #expect(rows.first?.isRunning == true)
    #expect(rows.first?.output == nil)
    #expect(rows.first?.input.contains("\"path\": \"notes.txt\"") == true)
    // A running tool is its own sign of work: the waiting line stays away.
    #expect(!presenter.isWaiting(for: state))
  }

  @Test("the result pairs with its call by id, live and after a snapshot")
  func pairedResult() {
    var state = ConversationState(botId: "b_1", running: false)
    state = Reducer.apply(.append(message: call(), replaces: nil), to: state)
    state = Reducer.apply(.append(message: result(), replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.count == 1, "the result message is consumed by the call row")
    #expect(rows.first?.isRunning == false)
    #expect(rows.first?.output == "工作区里的内容")
    #expect(rows.first?.durationLabel == "21 ms")
    #expect(rows.first?.isError == false)
    // The answer text on the same message keeps its own bubble, in order.
    #expect(
      entries.contains {
        if case .assistant(_, [.paragraph("我先看一下。")], _) = $0 { true } else { false }
      })
  }

  @Test("a failed tool colors the row and shows its error text")
  func failedRow() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(.append(message: call(), replaces: nil), to: state)
    state = Reducer.apply(
      .append(message: result(isError: true, durationMs: nil), replaces: nil),
      to: state
    )
    let rows = toolRows(presenter.transcript(for: state))
    #expect(rows.first?.isError == true)
    #expect(rows.first?.output == "工作区里的内容")
    #expect(rows.first?.durationLabel == nil)
  }

  @Test("a result whose call left the page is still shown")
  func standaloneResult() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(.append(message: result("c_9"), replaces: nil), to: state)
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.count == 1)
    #expect(rows.first?.name == "read_file")
    #expect(rows.first?.output == "工作区里的内容")
    #expect(rows.first?.isRunning == false)
  }

  @Test("consecutive calls collapse into one run line")
  func groupedRun() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message(
          "e_10",
          role: .assistant,
          blocks: [
            .toolCall(callId: "c_1", name: "read_file", args: ["path": .string("a")]),
            .toolCall(callId: "c_2", name: "run_command", args: ["command": .string("make")]),
          ]
        ),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 1, "the two rows become one collapsed run")
    guard case .toolRun(_, let rows) = entries.first else {
      return #expect(Bool(false), "expected a tool run")
    }
    #expect(rows.map(\.name) == ["read_file", "run_command"])
    #expect(rows.allSatisfy { $0.isRunning == false })
  }

  @Test("a plain answer is still one bubble with the message id")
  func plainAnswerUnchanged() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message("e_13", role: .assistant, blocks: [.text("回答")]),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(entries.count == 1)
    if case .assistant(let id, let blocks, _) = entries[0] {
      #expect(id == "e_13")
      #expect(blocks == [.paragraph("回答")])
    } else {
      Issue.record("a plain answer must stay an assistant bubble")
    }
  }

  @Test("a run with only an aborted tool call still says the answer was aborted")
  func abortedToolRun() {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: message(
          "p_a1",
          role: .assistant,
          state: .aborted,
          blocks: [
            .toolCall(callId: "c_1", name: "run_command", args: ["command": .string("make")])
          ]
        ),
        replaces: nil
      ),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(toolRows(entries).count == 1)
    #expect(
      entries.contains { if case .assistant(_, [.note("回答已中止")], _) = $0 { true } else { false } }
    )
  }
}

@Suite("Bots tool row pairing")
struct BotsToolPairingTests {
  private let presenter = BotsPresenter()

  private func message(_ id: String, role: MessageRole, blocks: [ContentBlock]) -> Message {
    Message(
      id: id,
      role: role,
      state: .complete,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: blocks
    )
  }

  private func toolRows(_ entries: [TranscriptEntry]) -> [ToolRow] {
    entries.flatMap { entry -> [ToolRow] in
      switch entry {
      case .tool(_, let row): return [row]
      case .toolRun(_, let rows): return rows
      default: return []
      }
    }
  }

  private func toolIds(_ entries: [TranscriptEntry]) -> [String] {
    toolRows(entries).map(\.id)
  }

  @Test("two rounds that reuse a call id keep their own results and unique row ids")
  func duplicateCallIds() {
    var state = ConversationState(botId: "b_1")
    for round in 1...2 {
      state = Reducer.apply(
        .append(
          message: message(
            "e_\(round * 10)",
            role: .assistant,
            blocks: [
              .toolCall(callId: "c_1", name: "read_file", args: ["path": .string("\(round)")])
            ]
          ),
          replaces: nil
        ),
        to: state
      )
      state = Reducer.apply(
        .append(
          message: message(
            "e_\(round * 10 + 1)",
            role: .tool,
            blocks: [
              .toolResult(
                callId: "c_1", name: "read_file", text: "round \(round)", isError: false,
                durationMs: nil)
            ]
          ),
          replaces: nil
        ),
        to: state
      )
    }
    let entries = presenter.transcript(for: state)
    let rows = toolRows(entries)
    #expect(rows.map(\.output) == ["round 1", "round 2"])
    #expect(Set(toolIds(entries)).count == 2, "ForEach ids are unique")
  }

  @Test("an old call without a result does not run again when a new run starts")
  func staleCallDoesNotRevive() {
    var state = ConversationState(botId: "b_1", running: true)
    state = Reducer.apply(
      .append(
        message: message(
          "e_10",
          role: .assistant,
          blocks: [
            .toolCall(callId: "c_1", name: "run_command", args: ["command": .string("make")])
          ]
        ),
        replaces: nil
      ),
      to: state
    )
    #expect(toolRows(presenter.transcript(for: state)).first?.isRunning == true)

    state = Reducer.apply(
      .append(message: message("e_12", role: .user, blocks: [.text("再试一次")]), replaces: nil),
      to: state
    )
    let entries = presenter.transcript(for: state)
    #expect(toolRows(entries).first?.isRunning == false, "the finished run's call stays settled")
    #expect(presenter.isWaiting(for: state))
  }
}

@Suite("Bots tool rows in a trimmed page")
struct BotsTrimmedToolPageTests {
  private let presenter = BotsPresenter()

  private func message(_ id: String, role: MessageRole, blocks: [ContentBlock]) -> Message {
    Message(
      id: id,
      role: role,
      state: .complete,
      createdAt: "2026-01-01T00:00:00.000Z",
      blocks: blocks
    )
  }

  @Test("a trimmed call leaves its result orphaned instead of taking the next call's place")
  func trimmedFirstCall() {
    let state = ConversationState(
      botId: "b_1",
      messages: [
        message(
          "e_12",
          role: .tool,
          blocks: [
            .toolResult(
              callId: "c_1", name: "run_command", text: "FIRST", isError: false, durationMs: nil)
          ]
        ),
        message(
          "e_13",
          role: .assistant,
          blocks: [
            .toolCall(callId: "c_1", name: "run_command", args: ["command": .string("second")])
          ]
        ),
        message(
          "e_14",
          role: .tool,
          blocks: [
            .toolResult(
              callId: "c_1", name: "run_command", text: "SECOND", isError: false, durationMs: nil)
          ]
        ),
      ]
    )
    let entries = presenter.transcript(for: state)
    let rows = entries.flatMap { entry -> [ToolRow] in
      switch entry {
      case .tool(_, let row): return [row]
      case .toolRun(_, let rows): return rows
      default: return []
      }
    }
    // The visible round keeps its own result; the first round's result is still shown.
    #expect(rows.map(\.output) == ["FIRST", "SECOND"])
    #expect(rows[1].input.contains("second"))
    #expect(rows[0].input.isEmpty, "an orphan result has no call to show")
  }
}

/// Trigger rows and the inspector's trigger detail are pure presentation.
@MainActor
@Suite("Bots trigger presentation")
struct BotsTriggerPresenterTests {
  private let presenter = BotsPresenter()

  private func summary(
    kind: TriggerSummary.Kind = .schedule,
    enabled: Bool = true,
    next: String? = "2026-10-29T01:00:00.000Z",
    dropped: Int = 0
  ) -> TriggerSummary {
    TriggerSummary(
      id: "t_9f2a1c3d04",
      kind: kind,
      name: "morning triage",
      enabled: enabled,
      schedule: kind == .schedule
        ? TriggerSummary.Schedule(cron: "0 9 * * *", timezone: "Asia/Shanghai", nextDueAt: next)
        : nil,
      counters: TriggerSummary.Counters(fired: 12, dropped: dropped)
    )
  }

  @Test("a row says what it is, when it is next due, and what it lost")
  func subtitle() {
    #expect(presenter.triggerSubtitle(summary()) == "定时 · 下次 10-29 09:00")
    #expect(presenter.triggerSubtitle(summary(enabled: false)) == "定时 · 下次 10-29 09:00 · 已停用")
    #expect(
      presenter.triggerSubtitle(summary(kind: .webhook)).hasPrefix("Webhook"),
      "a webhook has no schedule to show")
    #expect(
      presenter.triggerSubtitle(summary(dropped: 4)).contains("丢弃 4"),
      "a loss is visible on the row")
  }

  @Test("an instant is shown in the trigger's own zone")
  func dueLabel() {
    #expect(
      BotsPresenter.dueLabel("2026-10-29T01:00:00.000Z", zone: "Asia/Shanghai") == "10-29 09:00")
    #expect(
      BotsPresenter.dueLabel("2026-10-29T01:00:00.000Z", zone: "UTC") == "10-29 01:00")
    #expect(BotsPresenter.dueLabel("not a date", zone: "UTC") == nil)
    #expect(
      BotsPresenter.dueLabel("2026-10-29T01:00:00.000Z", zone: "Mars/Olympus") != nil,
      "an unknown zone falls back instead of dropping the row")
  }
}

@Suite("Peers in the transcript")
struct BotsPresenterPeerTests {
  private let presenter = BotsPresenter()

  /// Each message lands one step after the last, so an exchange's place in the chat is decided by
  /// time and not by the order this test happened to build.
  private final class Clock { var value = 0 }
  private let clock = Clock()

  private func message(
    _ id: String,
    role: MessageRole,
    text: String,
    origin: MessageOrigin? = nil,
    blocks: [ContentBlock]? = nil
  ) -> Message {
    clock.value += 1
    return Message(
      id: id,
      role: role,
      state: .complete,
      createdAt: String(format: "2026-10-29T12:%02d:00.000Z", clock.value),
      blocks: blocks ?? [.text(text)],
      origin: origin
    )
  }

  private func state(_ messages: [Message]) -> ConversationState {
    var state = ConversationState(botId: "b_1")
    for message in messages {
      state = Reducer.apply(.append(message: message, replaces: nil), to: state)
    }
    return state
  }

  private func summary(updatedAt: String = "2026-10-29T12:03:30.000Z") -> PeerExchangeSummary {
    PeerExchangeSummary(
      id: "x_0123456789ab",
      participants: [
        PeerExchangeParticipant(id: "b_a", title: "A"),
        PeerExchangeParticipant(id: "b_b", title: "B"),
      ],
      count: 4,
      status: "open",
      startedAt: "2026-10-29T12:00:30.000Z",
      updatedAt: updatedAt
    )
  }

  @Test("a peer message never becomes a bubble: the chat keeps one folded row")
  func folded() {
    let peer = MessageOrigin(kind: .peer, label: "A", exchangeId: "x_0123456789ab")
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "去和 B 讨论"),
        message("e_2", role: .assistant, text: "已发给 B"),
        message("e_3", role: .user, text: "问题一", origin: peer),
        message("e_4", role: .assistant, text: "只给 A 的回答"),
        message("e_5", role: .user, text: "再问一句"),
        message("e_6", role: .assistant, text: "结论"),
        message("e_7", role: .user, text: "追问", origin: peer),
      ]),
      exchanges: [summary()],
      bots: []
    )

    // One row for the exchange, placed after the turn it last moved in; the person's own turns
    // and the answers given to them stay.
    let rows = entries.map(\.id)
    #expect(rows == ["e_1", "e_2", "x_0123456789ab", "e_5", "e_6"])
    guard case .peerExchange(_, let exchange) = entries[2] else {
      Issue.record("the folded row is an exchange")
      return
    }
    #expect(exchange.count == 4)
    #expect(exchange.participants.map(\.title) == ["A", "B"])
  }

  @Test("the tools a bot uses on another bot stay out of the chat")
  func peerToolsHidden() {
    let call = ContentBlock.toolCall(callId: "call-1", name: "peer_send", args: [:])
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "去问 B"),
        message("e_2", role: .assistant, text: "", blocks: [call]),
        message(
          "e_3", role: .tool, text: "",
          blocks: [
            .toolResult(
              callId: "call-1", name: "peer_send", text: "admitted", isError: false, durationMs: 3)
          ]),
        message("e_4", role: .assistant, text: "已发出"),
      ]),
      exchanges: [summary()],
      bots: []
    )
    #expect(entries.map(\.id) == ["e_1", "e_4", "x_0123456789ab"])
  }

  @Test("the answer a peer message caused stays inside the exchange too")
  func peerRunHidden() {
    let peer = MessageOrigin(kind: .peer, label: "A", exchangeId: "x_0123456789ab")
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "问题", origin: peer),
        message("e_2", role: .assistant, text: "只给 A 的回答"),
        message("e_3", role: .user, text: "人问的话"),
        message("e_4", role: .assistant, text: "给人的回答"),
      ]),
      exchanges: [summary()],
      bots: []
    )
    // The recipient's own chat keeps the row and the person's turn, never the exchange's answer.
    #expect(entries.map(\.id) == ["e_3", "e_4", "x_0123456789ab"])
  }

  @Test("a peer run stays out of the chat until the daemon can name and count it")
  func withoutSummary() {
    let peer = MessageOrigin(kind: .peer, label: "A", exchangeId: "x_0123456789ab")
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "问题", origin: peer),
        message("e_2", role: .assistant, text: "只给 A 的回答"),
      ]),
      exchanges: [],
      bots: []
    )
    #expect(entries.isEmpty, "no row with an invented count, and no leaked answer")
  }

  @Test("the sender's own chat carries the same entry, without any peer message in it")
  func senderSide() {
    // This bot only sent: no peer message ever reached this transcript.
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "去和 B 讨论"),
        message("e_2", role: .assistant, text: "已发给 B"),
        message("e_3", role: .assistant, text: "结论"),
      ]),
      exchanges: [summary()],
      bots: []
    )
    #expect(entries.map(\.id) == ["e_1", "e_2", "e_3", "x_0123456789ab"])
    guard case .peerExchange(_, let exchange) = entries[3] else {
      Issue.record("the sender's chat has the folded row")
      return
    }
    #expect(exchange.count == 4)
    #expect(exchange.participants.map(\.title) == ["A", "B"])
  }

  @Test("a send that happened in one run keeps its row under that run's answer")
  func rowAfterItsRun() {
    // e_1 → e_2 is the run that sent; e_3 starts the next turn, so the row belongs before it.
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "去和 B 讨论"),
        message("e_2", role: .assistant, text: "问题已发出，本轮不等待或编造回答。"),
        message("e_3", role: .user, text: "再说一句"),
        message("e_4", role: .assistant, text: "好"),
      ]),
      exchanges: [summary(updatedAt: "2026-10-29T12:02:30.000Z")],
      bots: []
    )
    #expect(entries.map(\.id) == ["e_1", "e_2", "x_0123456789ab", "e_3", "e_4"])
  }

  @Test("a peer message recorded before exchanges had ids leaves no row behind")
  func legacyPeerMessage() {
    let legacy = MessageOrigin(kind: .peer, label: "A")
    let entries = presenter.transcript(
      for: state([
        message("e_1", role: .user, text: "问题", origin: legacy),
        message("e_2", role: .assistant, text: "只给 A 的回答"),
        message("e_3", role: .user, text: "人问的话"),
      ]),
      exchanges: [summary()],
      bots: []
    )
    #expect(entries.map(\.id) == ["e_3", "x_0123456789ab"])
  }
}
