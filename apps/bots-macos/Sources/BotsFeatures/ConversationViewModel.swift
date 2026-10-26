import BotsCore
import BotsTransport
import Foundation
import SwiftUI

/// One selected bot: connection, transcript, composer and the error surface. All daemon
/// interaction goes through the ports, so this layer can be tested with fakes
/// (docs/bots/ARCHITECTURE.md, "Layers").
@MainActor
public final class ConversationViewModel: ObservableObject {
  @Published public private(set) var state: ConversationState
  @Published public private(set) var connection: ConnectionState = .connecting
  @Published public private(set) var hasSnapshot = false
  @Published public private(set) var errorBanner: String?
  @Published public private(set) var isSending = false
  @Published public private(set) var hasOlder = false
  /// A parked task is recoverable: `recover` retries it.
  @Published public private(set) var parked = false
  private var draftStorage = ""
  public var draft: String {
    get { draftStorage }
    set { updateDraft(newValue) }
  }

  /// Updates draft storage without `ObservableObject` fan-out (the shell mirrors into `composer`).
  public func writeDraft(_ value: String) {
    guard draftStorage != value else { return }
    draftStorage = value
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
  private var inFlight: [String: String] = [:]
  /// The absolute catalog a `bots` frame carries, for the window's sidebar.
  public var onCatalog: (([BotSummary]) -> Void)?

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

  public func disconnect() {
    eventsTask?.cancel()
    eventsTask = nil
    selectedBotId = nil
    conversation.close()
    connection = .stopped
    hasSnapshot = false
  }

  public func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, connection == .ready, let botId = selectedBotId else { return }
    let requestId = Identifiers.request()
    draft = ""
    send(text: text, requestId: requestId, botId: botId, optimistic: true)
  }

  /// Retrying keeps the original requestId, which is how it is recovered, including after a
  /// restart of the app (`OutboxStore`).
  public func retry(_ entry: OutboxEntry) {
    refused.remove(entry.requestId)
    send(text: entry.text, requestId: entry.requestId, botId: entry.botId, optimistic: true)
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
  }

  // MARK: - Sending

  private func send(text: String, requestId: String, botId: String, optimistic: Bool) {
    // The entry is stored before the frame is written; if it cannot be stored, nothing is
    // sent and the draft comes back (PROTOCOL.md, client duties 1).
    do {
      try outbox.add(OutboxEntry(botId: botId, requestId: requestId, text: text))
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
    inFlight[requestId] = text
    let context = CommandContext.send(requestId)
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.conversation.send(
          text,
          whenBusy: .followUp,
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
        optimistic: !state.messages.contains { $0.requestId == entry.requestId }
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
      state = Reducer.snapshot(value, rev: state.lastRev.map { $0 + 1 }, keeping: state.ranks)
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
    case .catalog(let bots):
      onCatalog?(bots)
    case .error(let kind, let disposition, let message, _, let requestId):
      errorBanner = message
      if kind == .taskParked { parked = true }
      state = applyUnavailable(kind: kind)
      switch disposition {
      case .notAdmitted:
        // The daemon refused before admission: drop the bubble and the entry, and put the
        // text back so the user can fix or retry it (PROTOCOL.md, client duties 3).
        if let requestId {
          let text = inFlight.removeValue(forKey: requestId)
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
          if let text {
            // Neither the refused text nor a newer draft may be lost.
            draft = draft.isEmpty ? text : draft + "\n\n" + text
          }
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
    return next
  }

  private static func describe(_ error: Error) -> String {
    if let client = error as? ClientError { return client.message }
    return error.localizedDescription
  }
}
