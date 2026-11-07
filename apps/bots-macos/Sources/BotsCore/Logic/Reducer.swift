import Foundation

/// The transcript the client renders. Pure: it folds transport events and never performs
/// I/O, so every rule here is testable without a socket
/// (docs/bots/ARCHITECTURE.md, "Layers").
public struct ConversationState: Sendable, Equatable {
  public var botId: String
  public var messages: [Message]
  public var truncatedBefore: String?
  public var streaming: String?
  public var running: Bool
  public var inbox: [InboxItem]
  public var pending: [Submission]
  public var unavailable: BotUnavailable?
  /// A parked task needs `recover`; the daemon says so in the snapshot.
  public var parked: Bool
  /// Live work of every conversation the bot owns, newest list wins.
  public var tasks: [TaskSummary]
  /// The bot's own triggers; a snapshot or a `triggers` event replaces the list whole.
  public var triggers: [TriggerSummary]
  /// Pull requests the bot reported; a snapshot or a `pulls` event replaces the list whole.
  public var pulls: [PullSummary]
  /// Tokens and cost so far; a snapshot is the first place it appears.
  public var usage: Usage?
  /// What the bot runs with, when the daemon reports it.
  public var agent: AgentView?
  /// The newest revision applied; a snapshot resets the baseline (PROTOCOL I1/I3).
  public var lastRev: Int?
  /// Highest-ranked record per submission id, so a late reply never downgrades one (I14).
  public var ranks: [String: Submission]

  public init(
    botId: String,
    messages: [Message] = [],
    truncatedBefore: String? = nil,
    streaming: String? = nil,
    running: Bool = false,
    inbox: [InboxItem] = [],
    pending: [Submission] = [],
    unavailable: BotUnavailable? = nil,
    parked: Bool = false,
    tasks: [TaskSummary] = [],
    triggers: [TriggerSummary] = [],
    pulls: [PullSummary] = [],
    usage: Usage? = nil,
    agent: AgentView? = nil,
    lastRev: Int? = nil,
    ranks: [String: Submission] = [:]
  ) {
    self.botId = botId
    self.messages = messages
    self.truncatedBefore = truncatedBefore
    self.streaming = streaming
    self.running = running
    self.inbox = inbox
    self.pending = pending
    self.unavailable = unavailable
    self.parked = parked
    self.tasks = tasks
    self.triggers = triggers
    self.pulls = pulls
    self.usage = usage
    self.agent = agent
    self.lastRev = lastRev
    self.ranks = ranks
  }

  public var isBusy: Bool { running || !pending.isEmpty || !inbox.isEmpty }

  /// The message currently streaming, when there is one.
  public var streamingMessage: Message? {
    guard let streaming else { return nil }
    return messages.first { $0.id == streaming }
  }
}

public enum Reducer {
  /// A snapshot replaces state and merges its pending list into the ranks already seen, so
  /// a settlement a snapshot no longer lists is not forgotten. Records the snapshot lists
  /// are part of `pending`; a terminal record never comes back.
  public static func snapshot(
    _ value: ConversationSnapshot,
    rev: Int?,
    keeping previous: [String: Submission] = [:],
    previousMessages: [Message] = []
  ) -> ConversationState {
    var ranks = previous
    for record in value.pending {
      if let known = ranks[record.id], known.status.rank > record.status.rank { continue }
      ranks[record.id] = record
    }
    // A settlement that the snapshot no longer lists still stands (I14), so a queued
    // record cannot come back as pending.
    let pending = value.pending.filter { record in
      guard let known = ranks[record.id] else { return true }
      return !known.status.isTerminal
    }
    return ConversationState(
      botId: value.botId,
      messages: value.messages + stillQueued(previousMessages, in: value),
      truncatedBefore: value.truncatedBefore,
      streaming: value.streaming,
      running: value.running,
      inbox: value.inbox,
      pending: pending,
      unavailable: value.unavailable,
      parked: value.parked ?? false,
      tasks: value.tasks,
      triggers: value.triggers,
      pulls: value.pulls,
      usage: value.usage,
      agent: value.agent,
      lastRev: rev,
      ranks: ranks
    )
  }

  /// Applies one event. `rev` is the envelope's revision, absent on connection-scoped
  /// replies and on `bots`/`pong` (PROTOCOL I11).
  public static func apply(
    _ event: ConversationEvent,
    to state: ConversationState,
    rev: Int? = nil
  ) -> ConversationState {
    var next = state
    switch event {
    case .snapshot(let value):
      return snapshot(value, rev: rev, previousMessages: state.messages)
    case .append(let message, let replaces):
      next.messages = upsert(next.messages, message, replaces: replaces)
      if !message.isOptimistic {
        next.messages = next.messages.filter { candidate in
          // The optimistic bubble and the daemon's entry describe one send (PROTOCOL I4).
          guard let requestId = message.requestId, candidate.isOptimistic else { return true }
          return candidate.requestId != requestId
        }
      }
      if message.state == .streaming {
        next.streaming = message.id
      } else if next.streaming == message.id || next.streaming == replaces {
        next.streaming = nil
      }
    case .delta(let messageId, let changes):
      next.messages = next.messages.map { message in
        message.id == messageId ? applyChanges(changes, to: message) : message
      }
    case .status(let running, let inbox, let streaming):
      next.running = running
      next.inbox = inbox
      next.streaming = streaming
    case .submission(let record):
      next = applySubmission(record, to: next)
    case .history(let page):
      let known = Set(next.messages.map(\.id))
      let older = page.messages.filter { !known.contains($0.id) }
      next.messages = older + next.messages
      next.truncatedBefore = page.hasMore ? (next.truncatedBefore ?? older.first?.id) : nil
    case .tasks(let tasks):
      // A whole-list replacement: settled work leaves the list instead of going terminal.
      next.tasks = tasks
    case .triggers(let triggers):
      next.triggers = triggers
    case .pulls(let pulls):
      // Whole-list replacement: the newest report is the row's state, never a merge.
      next.pulls = pulls
    case .usage(let usage):
      next.usage = usage
    case .agent(let agent):
      next.agent = agent
    case .connection, .catalog:
      break
    case .error(let kind, _, _, _, _):
      if kind == .taskParked { next.parked = true }
    }
    if let rev, rev > (next.lastRev ?? rev - 1) {
      next.lastRev = rev
    }
    return next
  }

  /// A snapshot replaces the committed window, but a send that is still queued has no
  /// entry there yet. Keeping its local bubble is what makes "waiting" visible across a
  /// reconnect or resync; once it is placed, the real entry arrives and the bubble goes.
  private static func stillQueued(
    _ previous: [Message],
    in value: ConversationSnapshot
  ) -> [Message] {
    let queued = Set(value.pending.filter { $0.status == .queued }.map(\.requestId))
    let committed = Set(value.messages.compactMap(\.requestId))
    return previous.filter { message in
      guard message.isOptimistic, let requestId = message.requestId else { return false }
      return queued.contains(requestId) && !committed.contains(requestId)
    }
  }

  /// A submission record only moves up: `queued < placed < done = unanswered`.
  public static func applySubmission(
    _ record: Submission,
    to state: ConversationState
  ) -> ConversationState {
    var next = state
    if let known = state.ranks[record.id], known.status.rank > record.status.rank {
      return state
    }
    next.ranks[record.id] = record
    if let entryId = record.entryId {
      next.messages = attachRequestId(
        record.requestId,
        to: next.messages,
        entryId: entryId
      )
      // The entry is now in the transcript: the optimistic bubble it replaced is a
      // duplicate, and the append that carried the entry may have had no requestId
      // (the daemon attaches it when the submission names the entry).
      next.messages = next.messages.filter { message in
        !(message.isOptimistic && message.requestId == record.requestId)
      }
    }
    let others = next.pending.filter { $0.id != record.id }
    next.pending = record.status.isTerminal ? others : others + [record]
    return next
  }

  /// The placement names the user entry, so the transcript can tie it to the send.
  public static func attachRequestId(
    _ requestId: String,
    to messages: [Message],
    entryId: String
  ) -> [Message] {
    guard let index = messages.firstIndex(where: { $0.id == entryId }) else { return messages }
    guard messages[index].requestId == nil else { return messages }
    var next = messages
    next[index].requestId = requestId
    return next
  }

  /// `append` is an upsert by id; `replaces` finalizes a provisional (PROTOCOL I10).
  public static func upsert(
    _ messages: [Message],
    _ message: Message,
    replaces: String? = nil
  ) -> [Message] {
    var next = messages
    // The finalized entry is the newest commit: drop the provisional it replaces and let
    // the entry land at the end, after anything committed while the attempt streamed.
    if let replaces, let index = next.firstIndex(where: { $0.id == replaces }) {
      next.remove(at: index)
    }
    if let index = next.firstIndex(where: { $0.id == message.id }) {
      next[index] = message
    } else {
      next.append(message)
    }
    return next
  }

  /// Applies delta changes in order: a message change swaps the whole message and later
  /// changes in the same list apply to the new one.
  public static func applyChanges(_ changes: [DeltaChange], to message: Message) -> Message {
    var current = message
    for change in changes {
      switch change {
      case .text(let index, let append):
        current = appendToBlock(current, index: index, append: append, kind: .text)
      case .thinking(let index, let append):
        current = appendToBlock(current, index: index, append: append, kind: .thinking)
      case .toolCall(let index, _, let path, let append):
        current = appendToolCall(current, index: index, path: path, append: append)
      case .block(let index, let block):
        if index < current.blocks.count {
          current.blocks[index] = block
        } else if index == current.blocks.count {
          // A block delta can open a new block, exactly like the daemon's own fold.
          current.blocks.append(block)
        }
      case .message(let replacement):
        current = replacement
      }
    }
    return current
  }

  private enum BlockKind { case text, thinking }

  private static func appendToBlock(
    _ message: Message,
    index: Int,
    append: String,
    kind: BlockKind
  ) -> Message {
    guard index < message.blocks.count else { return message }
    var next = message
    switch (kind, message.blocks[index]) {
    case (.text, .text(let text)):
      next.blocks[index] = .text(text + append)
    case (.thinking, .thinking(let text)):
      next.blocks[index] = .thinking(text + append)
    default:
      break
    }
    return next
  }

  /// A toolcall delta walks the block's own args, like the daemon's fold does, so the
  /// row grows with the arguments the model is still writing.
  private static func appendToolCall(
    _ message: Message,
    index: Int,
    path: [JSONPathComponent],
    append: String
  ) -> Message {
    guard index < message.blocks.count else { return message }
    guard case .toolCall(let callId, let name, let args) = message.blocks[index] else {
      return message
    }
    // The wire's path is rooted at the block with an `args` head (PROTOCOL I13); the
    // arguments themselves are what grows.
    guard path.first == .key("args") else { return message }
    // A negative position can never be folded; refusing the whole delta keeps the client
    // and the daemon on the same result instead of inventing a container for it.
    guard
      !path.contains(where: {
        if case .index(let index) = $0 { return index < 0 }
        return false
      })
    else { return message }
    var next = message
    if case .object(let grown) = appendValue(.object(args), path.dropFirst(), append) {
      next.blocks[index] = .toolCall(callId: callId, name: name, args: grown)
    } else {
      next.blocks[index] = .toolCall(callId: callId, name: name, args: args)
    }
    return next
  }

  /// Folds one delta into the arguments, creating the container the next component names.
  /// A position that does not exist yet is appended only at the end of an array; anything
  /// else is ignored, never indexed blindly.
  private static func appendValue(
    _ value: JSONValue,
    _ path: ArraySlice<JSONPathComponent>,
    _ append: String
  ) -> JSONValue {
    guard let component = path.first else {
      if case .string(let text) = value { return .string(text + append) }
      return .string(append)
    }
    let rest = path.dropFirst()
    switch (value, component) {
    case (.object(var object), .key(let key)):
      if rest.isEmpty {
        let prior: String = {
          if case .string(let text) = object[key] { return text }
          return ""
        }()
        object[key] = .string(prior + append)
        return .object(object)
      }
      object[key] = appendValue(object[key] ?? emptyContainer(for: rest.first), rest, append)
      return .object(object)
    case (.array(var array), .index(let index)):
      guard index >= 0 else { return value }
      if rest.isEmpty {
        if index == array.count { array.append(.string("")) }
        guard index < array.count else { return value }
        let prior: String = {
          if case .string(let text) = array[index] { return text }
          return ""
        }()
        array[index] = .string(prior + append)
        return .array(array)
      }
      if index == array.count { array.append(emptyContainer(for: rest.first)) }
      guard index < array.count else { return value }
      array[index] = appendValue(array[index], rest, append)
      return .array(array)
    default:
      return value
    }
  }

  private static func emptyContainer(for component: JSONPathComponent?) -> JSONValue {
    guard let component else { return .string("") }
    if case .index = component { return .array([]) }
    return .object([:])
  }

}

extension Message {
  /// A bubble the client rendered before the daemon confirmed it (PROTOCOL I4).
  public var isOptimistic: Bool { id.hasPrefix("local_") }

  public static func optimistic(requestId: String, text: String) -> Message {
    Message(
      id: "local_\(requestId)",
      role: .user,
      state: .complete,
      createdAt: ISO8601DateFormatter().string(from: Date()),
      blocks: [.text(text)],
      requestId: requestId
    )
  }
}
