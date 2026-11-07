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
  private var drafts: [String: String] = [:]
  private var draftRevision = 0
  private var draftRevisions: [String: Int] = [:]
  private var selectedFilesByBot: [String: [URL]] = [:]
  @Published public private(set) var selectedFiles: [URL] = []
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
  private let filePort: FilePort?
  private let now: () -> Date
  private var eventsTask: Task<Void, Never>?
  private var selectedBotId: String?
  /// The outbox is reconciled after the first snapshot of the selected bot, never after
  /// the handshake: a send before the subscription exists is refused as `not_admitted`.
  private var reconciled = false
  /// Requests the daemon refused. They are never replayed by a reconciliation, even if
  /// their outbox entry could not be removed (the user decides whether to retry).
  private var refused: Set<String> = []
  private var restoredRefusals: Set<String> = []
  /// Sends the user asked for that have not been confirmed yet.
  private var inFlight: [String: OutboxEntry] = [:]
  private var uploadTasks: [String: Task<Void, Never>] = [:]
  private var activeUploads: Set<String> = []
  private var sendFiles = false
  /// The absolute catalog a `bots` frame carries, for the window's sidebar.
  public var onCatalog: ((BotCatalog) -> Void)?

  public init(
    botId: String = "",
    conversation: ConversationPort,
    outbox: OutboxStore,
    now: @escaping () -> Date = { Date() },
    filePort: FilePort? = nil
  ) {
    self.state = ConversationState(botId: botId)
    self.conversation = conversation
    self.outbox = outbox
    self.filePort =
      filePort
      ?? (conversation as? ManagedFileUploadPort).map {
        DiskFilePort(directory: outbox.directory.appendingPathComponent("staging"), uploader: $0)
      }
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
    (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !selectedFiles.isEmpty)
      && connection == .ready
      && state.unavailable == nil
  }

  /// Connects to a bot and replaces the transcript with its snapshot. Selecting the same bot
  /// again is a no-op, so a list refresh does not reconnect.
  public func select(botId: String) {
    if selectedBotId == botId, eventsTask != nil { return }
    cancelUploadTasks()
    eventsTask?.cancel()
    selectedBotId = botId
    draftStorage = drafts[botId] ?? ""
    selectedFiles = selectedFilesByBot[botId] ?? []
    draftRevision = draftRevisions[botId] ?? 0
    reconciled = false
    hasSnapshot = false
    state = ConversationState(botId: botId)
    applySettledRecords(for: botId)
    if let durable = try? outbox.refusedRequests() {
      refused.formUnion(durable)
    }
    if let recoverable = try? outbox.recoverableRefusals(for: botId) {
      Task { @MainActor [weak self] in
        guard let self else { return }
        for entry in recoverable {
          guard self.selectedBotId == botId,
            !self.restoredRefusals.contains(entry.requestId)
          else { continue }
          let staged = StagedSend(text: entry.text, files: entry.files)
          do {
            let stagedText = try await self.filePort?.originalText(staged) ?? entry.text
            let selected = try await self.filePort?.selectedURLs(staged) ?? []
            self.restoreDraft(stagedText, for: botId)
            self.restoredRefusals.insert(entry.requestId)
            if !selected.isEmpty {
              self.selectedFiles = selected
              self.selectedFilesByBot[botId] = selected
            }
          } catch {
            self.errorBanner = "拒绝前原文快照不可恢复，本地待发记录仍已保留。"
          }
        }
      }
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
    cancelUploadTasks()
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

  public func selectFiles(_ urls: [URL]) {
    guard let botId = selectedBotId else { return }
    selectedFiles = urls
    selectedFilesByBot[botId] = urls
  }

  public func clearSelectedFiles() {
    guard let botId = selectedBotId else { return }
    selectedFiles = []
    selectedFilesByBot[botId] = []
  }

  /// `inserting` steers the run that is answering instead of queueing behind it; while the
  /// bot is idle the daemon places it like any other input.
  public func send(inserting: Bool) {
    let text = draft
    let selected = selectedFiles
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !selected.isEmpty,
      connection == .ready,
      let botId = selectedBotId
    else { return }

    let requestId = Identifiers.request()
    let capturedRevision = draftRevision
    if !selected.isEmpty || text.unicodeScalars.count > 8_000 {
      guard sendFiles else {
        errorBanner = "此 daemon 不支持附件发送"
        return
      }
      guard let filePort else {
        errorBanner = "这个客户端不能上传文件"
        return
      }
      Task { @MainActor [weak self] in
        guard let self else { return }
        do {
          let staged = try await filePort.stage(
            text: text,
            selectedFiles: selected,
            botId: botId,
            requestId: requestId
          )
          let optimisticText = (try? await filePort.originalText(staged)) ?? staged.text
          self.commitSend(
            staged: staged,
            optimisticText: optimisticText,
            requestId: requestId,
            botId: botId,
            capturedRevision: capturedRevision,
            inserting: inserting
          )
        } catch {
          self.errorBanner = Self.describe(error)
        }
      }
    } else {
      commitSend(
        staged: StagedSend(text: text),
        optimisticText: text,
        requestId: requestId,
        botId: botId,
        capturedRevision: capturedRevision,
        inserting: inserting
      )
    }
  }

  private func commitSend(
    staged: StagedSend,
    optimisticText: String,
    requestId: String,
    botId: String,
    capturedRevision: Int,
    inserting: Bool
  ) {
    let entry = OutboxEntry(
      botId: botId,
      requestId: requestId,
      text: staged.text,
      whenBusy: inserting ? .steer : .followUp,
      files: staged.files
    )
    do {
      try outbox.add(entry)
    } catch {
      errorBanner = "无法保存待发送的消息，消息没有发出。"
      return
    }
    if draftRevision == capturedRevision {
      draft = ""
      clearSelectedFiles()
    }
    isSending = true
    state = Reducer.apply(
      .append(message: .optimistic(requestId: requestId, text: optimisticText), replaces: nil),
      to: state
    )
    inFlight[requestId] = entry
    startUploadAndSend(entry)
  }

  /// Retrying keeps the original requestId, which is how it is recovered, including after a
  /// restart of the app (`OutboxStore`).
  public func retry(_ entry: OutboxEntry) {
    guard entry.botId == selectedBotId else { return }
    refused.remove(entry.requestId)
    do { try outbox.resumeUpload(requestId: entry.requestId) } catch {
      errorBanner = "待发记录暂时无法恢复"
      return
    }
    inFlight[entry.requestId] = entry
    startUploadAndSend(entry, optimistic: true)
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
    draftRevision += 1
    draftStorage = value
    if let selectedBotId {
      drafts[selectedBotId] = value
      draftRevisions[selectedBotId] = draftRevision
    }
  }

  private func restoreDraft(_ text: String, for botId: String) {
    let current = drafts[botId] ?? ""
    let restored = current.isEmpty ? text : current + "\n\n" + text
    drafts[botId] = restored
    draftRevisions[botId] = (draftRevisions[botId] ?? 0) + 1
    if selectedBotId == botId { updateDraft(restored) }
  }

  // MARK: - Sending

  private func cancelUploadTasks() {
    for task in uploadTasks.values { task.cancel() }
    uploadTasks.removeAll()
  }

  private func startUploadAndSend(_ entry: OutboxEntry, optimistic: Bool = false) {
    guard activeUploads.insert(entry.requestId).inserted else { return }
    isSending = true
    uploadTasks[entry.requestId] = Task { [weak self] in
      guard let self else { return }
      defer {
        self.activeUploads.remove(entry.requestId)
        if self.uploadTasks[entry.requestId] != nil {
          self.uploadTasks.removeValue(forKey: entry.requestId)
        }
      }
      do {
        if optimistic && !state.messages.contains(where: { $0.requestId == entry.requestId }) {
          let text =
            (try? await filePort?.originalText(
              StagedSend(text: entry.text, files: entry.files)
            )) ?? entry.text
          state = Reducer.apply(
            .append(message: .optimistic(requestId: entry.requestId, text: text), replaces: nil),
            to: state
          )
        }
        var fileIds: [String] = []
        for file in entry.files where file.fileId == nil {
          try Task.checkCancellation()
          let id = try await filePort?.upload(file, botId: entry.botId)
          guard let id else { throw ClientError("这个客户端不能上传文件") }
          try outbox.recordFileId(requestId: entry.requestId, uploadId: file.uploadId, fileId: id)
          fileIds.append(id)
        }
        fileIds.append(
          contentsOf: entry.files.compactMap(
            \.fileId
          ))
        let unique = Array(NSOrderedSet(array: fileIds).compactMap { $0 as? String })
        try Task.checkCancellation()
        guard selectedBotId == entry.botId,
          connection == .ready,
          sendFiles || entry.files.isEmpty
        else { return }
        let context = CommandContext.send(entry.requestId)
        if !unique.isEmpty {
          guard let fileConversation = conversation as? FileConversationPort else {
            throw ClientError("此连接不支持附件发送")
          }
          try await fileConversation.send(
            entry.text,
            whenBusy: entry.whenBusy,
            context: context,
            botId: entry.botId,
            fileIds: unique
          )
        } else {
          try await conversation.send(
            entry.text,
            whenBusy: entry.whenBusy,
            context: context,
            botId: entry.botId
          )
        }
        isSending = false
      } catch is CancellationError {
        // A bot switch or disconnect owns cancellation; the durable entry stays for retry.
        isSending = false
      } catch let failure as FileTransportFailure {
        isSending = false
        if failure == .authentication {
          try? outbox.pauseUpload(requestId: entry.requestId)
          errorBanner = "认证失败，待发附件已暂停自动重试"
        } else {
          errorBanner = Self.describe(failure)
        }
      } catch {
        isSending = false
        errorBanner = Self.describe(error)
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
      guard !entry.uploadPaused else { continue }
      startUploadAndSend(
        entry,
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
    case .capabilities(let nextSendFiles):
      sendFiles = nextSendFiles
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
        if let requestId {
          let entry =
            inFlight.removeValue(forKey: requestId)
            ?? (try? outbox.entry(requestId: requestId))
          guard let entry, entry.botId == selectedBotId else {
            errorBanner = "拒绝记录不属于当前 Bot，本地待发记录已保留。"
            break
          }
          Task { @MainActor [weak self] in
            guard let self else { return }
            let staged = StagedSend(text: entry.text, files: entry.files)
            do {
              let original = try await self.filePort?.originalText(staged) ?? entry.text
              let selected = try await self.filePort?.selectedURLs(staged) ?? []
              try self.outbox.refuse(requestId: requestId)
              self.refused.insert(requestId)
              self.uploadTasks[requestId]?.cancel()
              self.uploadTasks.removeValue(forKey: requestId)
              self.activeUploads.remove(requestId)
              self.state.messages.removeAll { $0.id == "local_\(requestId)" }
              self.restoreDraft(original, for: entry.botId)
              if !selected.isEmpty {
                self.selectedFiles = selected
                self.selectedFilesByBot[entry.botId] = selected
              }
            } catch {
              self.errorBanner = "拒绝前原文快照不可恢复，本地待发记录和附件仍已保留。"
            }
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
