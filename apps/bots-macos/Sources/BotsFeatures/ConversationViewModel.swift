import BotsCore
import BotsTransport
import Foundation
import SwiftUI

/// One selected bot: connection, transcript, composer and the error surface. All daemon
/// interaction goes through the ports, so this layer can be tested with fakes
/// (docs/bots/ARCHITECTURE.md, "Layers").
@MainActor
public final class ConversationViewModel: ObservableObject {
  private static let oversizedDraftError = "消息超过 8,000 个 Unicode 字符，原文仍在输入框中。"
  @Published public private(set) var state: ConversationState
  @Published public private(set) var connection: ConnectionState = .connecting
  @Published public private(set) var hasSnapshot = false
  @Published public private(set) var errorBanner: String?
  @Published public private(set) var isSending = false
  @Published public private(set) var hasOlder = false
  /// A parked task is recoverable: `recover` retries it.
  @Published public private(set) var parked = false
  private var draftStorage = ""
  private var drafts: [String: String] = [:]
  public var draft: String {
    get { draftStorage }
    set { updateDraft(newValue) }
  }

  /// Updates draft storage without `ObservableObject` fan-out (the shell mirrors into `composer`).
  public func writeDraft(_ value: String) {
    updateDraft(value)
  }

  private let conversation: ConversationPort
  private let outbox: OutboxStore
  private let now: () -> Date
  private var eventsTask: Task<Void, Never>?
  private var selectedBotId: String?
  /// The outbox is reconciled after the first snapshot of the selected bot, never after
  /// the handshake: a send before the subscription exists is refused as `not_admitted`.
  private var reconciled = false
  /// Requests the daemon refused. They are never replayed by a reconciliation, even if
  /// their outbox entry could not be removed (the user decides whether to retry).
  private var refused: Set<String> = []
  /// Sends the user asked for that have not been confirmed yet.
  private var inFlight: [String: OutboxEntry] = [:]
  /// The absolute catalog a `bots` frame carries, for the window's sidebar.
  public var onCatalog: ((BotCatalog) -> Void)?

  public init(
    botId: String = "",
    conversation: ConversationPort,
    outbox: OutboxStore,
    now: @escaping () -> Date = { Date() }
  ) {
    self.state = ConversationState(botId: botId)
    self.conversation = conversation
    self.outbox = outbox
    self.now = now
  }

  public var title: String { selectedBotId ?? "" }
  /// The live work of the selected bot, for the inspector's 任务 section.
  public var tasks: [TaskSummary] { state.tasks }
  /// The bot's own triggers, as the sidebar's trigger section renders them.
  public var triggers: [TriggerSummary] { state.triggers }
  /// The pull requests the bot reported, newest first.
  public var pulls: [PullSummary] { state.pulls }
  /// Tokens and cost so far, for the inspector's 用量 section.
  public var usage: Usage? { state.usage }
  public var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && connection == .ready
      && state.unavailable == nil
  }

  /// Connects to a bot and replaces the transcript with its snapshot. Selecting the same bot
  /// again is a no-op, so a list refresh does not reconnect.
  public func select(botId: String) {
    if selectedBotId == botId, eventsTask != nil { return }
    eventsTask?.cancel()
    selectedBotId = botId
    draftStorage = drafts[botId] ?? ""
    reconciled = false
    hasSnapshot = false
    state = ConversationState(botId: botId)
    applySettledRecords(for: botId)
    if let durable = try? outbox.refusedRequests() {
      refused.formUnion(durable)
    }
    connection = .connecting
    errorBanner = nil
    let stream = conversation.open(botId: botId)
    eventsTask = Task { [weak self] in
      for await event in stream {
        guard let self, !Task.isCancelled else { return }
        self.apply(event)
      }
    }
  }

  /// A connection that ended for good (the daemon is not running): open it again instead
  /// of hoping the socket retries, and keep the transcript that is already on screen.
  public func reconnect() {
    guard let botId = selectedBotId else { return }
    eventsTask?.cancel()
    eventsTask = nil
    select(botId: botId)
  }

  public func disconnect() {
    eventsTask?.cancel()
    eventsTask = nil
    selectedBotId = nil
    draftStorage = ""
    conversation.close()
    connection = .stopped
    hasSnapshot = false
  }

  public func send() {
    send(inserting: false)
  }

  /// `inserting` steers the run that is answering instead of queueing behind it; while the
  /// bot is idle the daemon places it like any other input.
  public func send(inserting: Bool) {
    let text = draft
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      connection == .ready, let botId = selectedBotId
    else { return }
    guard text.unicodeScalars.dropFirst(8_000).isEmpty else {
      errorBanner = Self.oversizedDraftError
      return
    }
    if errorBanner == Self.oversizedDraftError { errorBanner = nil }
    let requestId = Identifiers.request()
    draft = ""
    send(
      text: text, requestId: requestId, botId: botId, optimistic: true,
      whenBusy: inserting ? .steer : .followUp)
  }

  /// Retrying keeps the original requestId, which is how it is recovered, including after a
  /// restart of the app (`OutboxStore`).
  public func retry(_ entry: OutboxEntry) {
    refused.remove(entry.requestId)
    send(
      text: entry.text, requestId: entry.requestId, botId: entry.botId, optimistic: true,
      whenBusy: entry.whenBusy)
  }

  /// Answers an ask_user card. The daemon composes the hidden message, so this sends labels
  /// and nothing else; the card closes when that hidden message comes back.
  public func answer(entryId: String, chosen: [String], skipped: Bool) {
    guard connection == .ready, let botId = selectedBotId else { return }
    let context = CommandContext.command("answer")
    Task { [weak self] in
      do {
        try await self?.conversation.answer(
          entryId: entryId, chosen: chosen, skipped: skipped, context: context, botId: botId)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func abort() {
    guard let botId = selectedBotId else { return }
    let context = CommandContext.command("abort")
    Task { [weak self] in
      do {
        try await self?.conversation.abort(context: context, botId: botId)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  /// Pulls this person's queued input ahead of the follow-ups already waiting. The daemon
  /// keeps the submission id, so a second click is harmless and the outbox entry stays.
  public func promote(_ requestId: String) {
    guard connection == .ready, let botId = selectedBotId else { return }
    let context = CommandContext.command("promote")
    Task { [weak self] in
      do {
        try await self?.conversation.promote(
          requestId: requestId, context: context, botId: botId)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func recover() {
    guard let botId = selectedBotId else { return }
    let context = CommandContext.command("recover")
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.conversation.recover(context: context, botId: botId)
        // Only a command that reached the daemon clears the parked state: a recover
        // dropped while reconnecting must leave the affordance in place.
        self.parked = false
      } catch {
        self.errorBanner = Self.describe(error)
      }
    }
  }

  public func loadOlder() {
    guard let oldest = state.messages.first(where: { !$0.isOptimistic })?.id,
      let botId = selectedBotId
    else { return }
    let context = CommandContext.command("history")
    Task { [weak self] in
      do {
        try await self?.conversation.loadHistory(before: oldest, context: context, botId: botId)
      } catch {
        self?.errorBanner = Self.describe(error)
      }
    }
  }

  public func dismissError() {
    errorBanner = nil
  }

  private func updateDraft(_ value: String) {
    guard draftStorage != value else { return }
    draftStorage = value
    if let selectedBotId { drafts[selectedBotId] = value }
  }

  private func restoreDraft(_ text: String, for botId: String) {
    let current = drafts[botId] ?? ""
    let restored = current.isEmpty ? text : current + "\n\n" + text
    drafts[botId] = restored
    if selectedBotId == botId { draftStorage = restored }
  }

  // MARK: - Sending

  private func send(
    text: String,
    requestId: String,
    botId: String,
    optimistic: Bool,
    whenBusy: BusyMode = .followUp
  ) {
    // The entry is stored before the frame is written; if it cannot be stored, nothing is
    // sent and the draft comes back (PROTOCOL.md, client duties 1).
    let entry = OutboxEntry(botId: botId, requestId: requestId, text: text, whenBusy: whenBusy)
    do {
      try outbox.add(entry)
    } catch {
      draft = text
      errorBanner = "无法保存待发送的消息，消息没有发出。"
      return
    }
    isSending = true
    if optimistic {
      state = Reducer.apply(
        .append(message: .optimistic(requestId: requestId, text: text), replaces: nil),
        to: state
      )
    }
    inFlight[requestId] = entry
    let context = CommandContext.send(requestId)
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.conversation.send(
          text,
          whenBusy: whenBusy,
          context: context,
          botId: botId
        )
        self.isSending = false
      } catch {
        self.isSending = false
        self.errorBanner = Self.describe(error)
      }
    }
  }

  /// Replays every stored entry with its own requestId; pi answers with the stored record
  /// (PROTOCOL.md, client duties 2).
  private func reconcileOutbox() {
    guard let botId = selectedBotId else { return }
    persistPendingRefusals()
    let durableRefusals: Set<String>
    do {
      durableRefusals = Set(try outbox.refusedRequests())
    } catch {
      errorBanner = "本地待发消息暂时读不出来，稍后重试。"
      reconciled = false
      return
    }
    let entries: [OutboxEntry]
    do {
      entries = try outbox.entries(for: botId)
    } catch {
      // An unreadable outbox is unknown, not empty: report it and try again on the next
      // snapshot instead of pretending there is nothing to send.
      errorBanner = "本地待发消息暂时读不出来，稍后重试。"
      reconciled = false
      return
    }
    for entry in entries
    where !refused.contains(entry.requestId)
      && !durableRefusals.contains(entry.requestId)
    {
      send(
        text: entry.text,
        requestId: entry.requestId,
        botId: entry.botId,
        optimistic: !state.messages.contains { $0.requestId == entry.requestId },
        whenBusy: entry.whenBusy
      )
    }
  }

  /// Refusals whose durable write failed are retried on the next successful read.
  private func persistPendingRefusals() {
    guard !refused.isEmpty else { return }
    var written: [String] = []
    for requestId in refused {
      do {
        try outbox.refuse(requestId: requestId)
        written.append(requestId)
      } catch {
        return
      }
    }
    // They are durable now; the in-memory set is only a cache of them.
    _ = written
  }

  /// A terminal record stored before the app closed is applied again, so a settlement is
  /// not lost when the snapshot no longer carries it.
  private func applySettledRecords(for botId: String) {
    let stored: [SettledRequest]
    do {
      stored = try outbox.settledRequests()
    } catch {
      errorBanner = "本地结算记录暂时读不出来。"
      return
    }
    for record in stored where record.botId == botId {
      state = Reducer.applySubmission(
        Submission(
          id: record.submissionId,
          requestId: record.requestId,
          status: record.status,
          entryId: record.entryId,
          answerEntryId: record.answerEntryId,
          reason: record.reason
        ),
        to: state
      )
    }
  }

  // MARK: - Events

  private func apply(_ event: ConversationEvent) {
    switch event {
    case .connection(let next):
      if case .ready = next {
        // the first snapshot after any connection reconciles
      } else {
        reconciled = false
        hasSnapshot = false
      }
      connection = next

    case .snapshot(let value):
      state = Reducer.snapshot(
        value,
        rev: state.lastRev.map { $0 + 1 },
        keeping: state.ranks,
        previousMessages: state.messages
      )
      hasSnapshot = true
      parked = state.parked
      hasOlder = value.truncatedBefore != nil
      // Every snapshot is a chance to make a refusal durable, even when no reconciliation
      // is due.
      persistPendingRefusals()
      if !reconciled {
        reconciled = true
        reconcileOutbox()
      }
    case .append(let message, let replaces):
      state = Reducer.apply(.append(message: message, replaces: replaces), to: state)
    case .delta(let messageId, let changes):
      state = Reducer.apply(.delta(messageId: messageId, changes: changes), to: state)
    case .status(let running, let inbox, let streaming):
      state = Reducer.apply(
        .status(running: running, inbox: inbox, streaming: streaming),
        to: state
      )
    case .submission(let record):
      state = Reducer.apply(.submission(record), to: state)
      if record.status.isTerminal {
        inFlight.removeValue(forKey: record.requestId)
        // The terminal record is stored in the same atomic write that removes the entry
        // (PROTOCOL.md, client duties 2); a placement in a snapshot is not a settlement.
        try? outbox.settle(record, botId: selectedBotId ?? "")
      }
    case .history(let page):
      state = Reducer.apply(.history(page: page), to: state)
      hasOlder = page.hasMore
    case .tasks(let tasks):
      state = Reducer.apply(.tasks(tasks), to: state)
    case .triggers(let triggers):
      state = Reducer.apply(.triggers(triggers), to: state)
    case .pulls(let pulls):
      state = Reducer.apply(.pulls(pulls), to: state)
    case .usage(let usage):
      state = Reducer.apply(.usage(usage), to: state)
    case .agent(let agent):
      state = Reducer.apply(.agent(agent), to: state)
    case .catalog(let catalog):
      onCatalog?(catalog)
    case .error(let kind, let disposition, let message, _, let requestId):
      errorBanner = message
      if kind == .taskParked { parked = true }
      state = applyUnavailable(kind: kind)
      switch disposition {
      case .notAdmitted:
        // The daemon refused before admission: drop the bubble and the entry, and put the
        // text back so the user can fix or retry it (PROTOCOL.md, client duties 3).
        if let requestId {
          let entry = inFlight.removeValue(forKey: requestId)
          refused.insert(requestId)
          do {
            try outbox.refuse(requestId: requestId)
          } catch {
            // The store is not writable right now: the refusal stays in memory and is
            // written as soon as a read succeeds again, so the entry is never replayed in
            // the meantime. The failure is shown rather than swallowed.
            errorBanner = "消息被拒绝，本地待发记录暂时没有删掉。"
          }
          state.messages.removeAll { $0.id == "local_\(requestId)" }
          if let entry { restoreDraft(entry.text, for: entry.botId) }
        }
      case .unknown:
        // Admission could not be confirmed: keep the bubble and the entry for a retry.
        break
      case .runtime:
        break
      }
      if let requestId, state.pending.contains(where: { $0.requestId == requestId }) {
        state.pending.removeAll { $0.requestId == requestId }
      }
    }
  }

  private func applyUnavailable(kind: ErrorKind) -> ConversationState {
    guard kind == .storageFailed || kind == .internalError else { return state }
    var next = state
    next.unavailable = BotUnavailable(reason: kind, message: "the bot is unavailable")
    next.messages = []
    next.pending = []
    next.inbox = []
    next.streaming = nil
    next.running = false
    next.tasks = []
    next.triggers = []
    next.pulls = []
    return next
  }

  private static func describe(_ error: Error) -> String {
    if let client = error as? ClientError { return client.message }
    return error.localizedDescription
  }
}
