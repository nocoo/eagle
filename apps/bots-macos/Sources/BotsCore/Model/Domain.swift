import Foundation

/// Domain types mirroring the daemon's `core/domain.ts` one to one, so a fixture, a log
/// line and a Swift value use the same words (docs/bots/PROTOCOL.md, "Entities").

public enum ErrorKind: String, Codable, Sendable {
  case authFailed = "auth_failed"
  case unknownBot = "unknown_bot"
  case invalidCommand = "invalid_command"
  case limitExceeded = "limit_exceeded"
  case versionMismatch = "version_mismatch"
  case modelError = "model_error"
  case sessionFailed = "session_failed"
  case taskFaulted = "task_faulted"
  case taskParked = "task_parked"
  case extensionError = "extension_error"
  case storageFailed = "storage_failed"
  case internalError = "internal"
}

public enum ErrorDisposition: String, Codable, Sendable {
  case notAdmitted = "not_admitted"
  case unknown
  case runtime
}

public enum MessageRole: String, Codable, Sendable {
  case user, assistant, notice, tool, system
}

public enum MessageState: String, Codable, Sendable {
  case streaming, complete, aborted, error
}

public enum StopReason: String, Codable, Sendable {
  case stop, length, toolUse, aborted, error, deferred
}

public enum ContentBlock: Codable, Sendable, Equatable {
  case text(String)
  case thinking(String)
  case toolCall(callId: String, name: String, args: [String: JSONValue])
  case toolResult(callId: String, name: String, text: String, isError: Bool, durationMs: Int?)

  private enum CodingKeys: String, CodingKey {
    case type, text, callId, name, args, isError, durationMs
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .type) {
    case "text":
      self = .text(try container.decode(String.self, forKey: .text))
    case "thinking":
      self = .thinking(try container.decode(String.self, forKey: .text))
    case "toolCall":
      self = .toolCall(
        callId: try Self.requiredText(container, .callId),
        name: try Self.requiredText(container, .name),
        args: try container.decode([String: JSONValue].self, forKey: .args)
      )
    case "toolResult":
      // Follow the daemon codec exactly: `null` is not "absent", and the bound is the
      // largest safe integer, because the value crosses a JSON number boundary.
      if container.contains(.durationMs), try container.decodeNil(forKey: .durationMs) {
        throw DecodingError.dataCorruptedError(
          forKey: .durationMs,
          in: container,
          debugDescription: "durationMs must be a number"
        )
      }
      let durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
      if let durationMs, durationMs < 0 || durationMs > 9_007_199_254_740_991 {
        throw DecodingError.dataCorruptedError(
          forKey: .durationMs,
          in: container,
          debugDescription: "durationMs must be a non-negative safe integer"
        )
      }
      self = .toolResult(
        callId: try Self.requiredText(container, .callId),
        name: try Self.requiredText(container, .name),
        text: try container.decode(String.self, forKey: .text),
        isError: try container.decode(Bool.self, forKey: .isError),
        durationMs: durationMs
      )
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type,
        in: container,
        debugDescription: "unknown block type"
      )
    }
  }

  /// The daemon's codec refuses an empty required string; the client must agree on what
  /// a legal frame is (PROTOCOL.md, "ContentBlock").
  private static func requiredText(
    _ container: KeyedDecodingContainer<CodingKeys>,
    _ key: CodingKeys
  ) throws -> String {
    let text = try container.decode(String.self, forKey: key)
    guard !text.isEmpty else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: container,
        debugDescription: "\(key.stringValue) must not be empty"
      )
    }
    return text
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let text):
      try container.encode("text", forKey: .type)
      try container.encode(text, forKey: .text)
    case .thinking(let text):
      try container.encode("thinking", forKey: .type)
      try container.encode(text, forKey: .text)
    case .toolCall(let callId, let name, let args):
      try container.encode("toolCall", forKey: .type)
      try container.encode(callId, forKey: .callId)
      try container.encode(name, forKey: .name)
      try container.encode(args, forKey: .args)
    case .toolResult(let callId, let name, let text, let isError, let durationMs):
      try container.encode("toolResult", forKey: .type)
      try container.encode(callId, forKey: .callId)
      try container.encode(name, forKey: .name)
      try container.encode(text, forKey: .text)
      try container.encode(isError, forKey: .isError)
      try container.encodeIfPresent(durationMs, forKey: .durationMs)
    }
  }

  /// The text a transcript shows for this block: thinking and tool blocks are rows of
  /// their own (docs/bots/PRODUCT.md, "Delegation"), never part of the answer.
  public var displayText: String {
    switch self {
    case .text(let text), .thinking(let text): return text
    case .toolResult(_, _, let text, _, _): return text
    case .toolCall: return ""
    }
  }
}

/// Who admitted a user message (docs/bots/TRIGGERS.md §6). Absent means the daemon has no
/// record, which renders as `.unknown` — never as a person.
public struct MessageOrigin: Codable, Sendable, Equatable, Hashable {
  public enum Kind: String, Codable, Sendable {
    case human, schedule, webhook, peer, unknown
  }

  public var kind: Kind
  /// The trigger's name, or the sending bot's title; presentation only.
  public var label: String?
  /// A peer message's exchange: the transcript folds the whole round trip into one row.
  public var exchangeId: String?

  public init(kind: Kind, label: String? = nil, exchangeId: String? = nil) {
    self.kind = kind
    self.label = label
    self.exchangeId = exchangeId
  }

  /// The chip a transcript shows, or nil for a plain human message.
  public var chip: String? {
    switch kind {
    case .human: return nil
    case .schedule: return label ?? "定时"
    case .webhook: return label ?? "Webhook"
    case .peer: return label ?? "其他 Bot"
    case .unknown: return nil
    }
  }
}

public struct Message: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var role: MessageRole
  public var state: MessageState
  public var createdAt: String
  public var blocks: [ContentBlock]
  public var requestId: String?
  public var stopReason: StopReason?
  /// User messages only: who caused them, when the daemon recorded it.
  public var origin: MessageOrigin?

  public init(
    id: String,
    role: MessageRole,
    state: MessageState,
    createdAt: String,
    blocks: [ContentBlock],
    requestId: String? = nil,
    stopReason: StopReason? = nil,
    origin: MessageOrigin? = nil
  ) {
    self.id = id
    self.role = role
    self.state = state
    self.createdAt = createdAt
    self.blocks = blocks
    self.requestId = requestId
    self.stopReason = stopReason
    self.origin = origin
  }

  public var text: String { blocks.map(\.displayText).joined() }

  /// What a transcript shows for the answer: text blocks only. Thinking stays hidden and
  /// tool calls and results are their own rows.
  public var visibleText: String {
    blocks.compactMap { block in
      if case .text(let text) = block { return text }
      return nil
    }.joined()
  }

  /// `p_a1` is a provisional streamed message; `e_7` is a committed entry.
  public var isProvisional: Bool { id.hasPrefix("p_") }
}

public enum BotState: String, Codable, Sendable {
  case catalogued, opening, idle, running, unavailable, quarantined
}

/// A sidebar group the person owns (docs/bots/PROTOCOL.md, "Group rules"). The id is the
/// daemon's; the title is what the sidebar shows.
public struct BotGroup: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: String
  public var title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}

/// What a catalog read or a pushed catalog carries: the bots and the groups in display
/// order. The two travel together because a membership only means something with the
/// groups beside it.
public struct BotCatalog: Sendable, Equatable {
  public var bots: [BotSummary]
  public var groups: [BotGroup]

  public init(bots: [BotSummary] = [], groups: [BotGroup] = []) {
    self.bots = bots
    self.groups = groups
  }
}

public struct ModelRef: Codable, Hashable, Sendable {
  public var provider: String
  public var modelId: String

  public init(provider: String, modelId: String) {
    self.provider = provider
    self.modelId = modelId
  }
}

public struct BotUnavailable: Codable, Sendable, Equatable {
  public var reason: ErrorKind
  public var message: String

  public init(reason: ErrorKind, message: String) {
    self.reason = reason
    self.message = message
  }
}

/// How a bot draws itself: one silhouette from a closed set and one tint. The daemon
/// stores both; the client only renders them.
public struct BotAppearance: Codable, Sendable, Equatable, Hashable {
  public enum Shape: String, Codable, Sendable, CaseIterable {
    case blob, pebble, squircle, star, cloud, shield, drop, hex, heart, flower
  }

  public enum Tint: String, Codable, Sendable, CaseIterable {
    case paper, clay, red, orange, yellow, green, teal, sky, blue, violet, pink, graphite
  }

  public var shape: Shape
  public var tint: Tint

  public init(shape: Shape = .blob, tint: Tint = .green) {
    self.shape = shape
    self.tint = tint
  }

  public static let standard = BotAppearance()
}

public struct BotSummary: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var title: String
  public var label: String?
  public var appearance: BotAppearance?
  public var createdAt: String
  public var updatedAt: String
  public var model: ModelRef
  public var state: BotState
  public var unavailable: BotUnavailable?
  /// The sidebar group this bot is filed under; absent means ungrouped.
  public var groupId: String?
  /// The line the bot wrote about itself (`note_set`); absent means it never did.
  public var note: String?

  public init(
    id: String,
    title: String,
    label: String? = nil,
    appearance: BotAppearance? = nil,
    createdAt: String,
    updatedAt: String,
    model: ModelRef,
    state: BotState,
    unavailable: BotUnavailable? = nil,
    groupId: String? = nil,
    note: String? = nil
  ) {
    self.id = id
    self.title = title
    self.label = label
    self.appearance = appearance
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.model = model
    self.state = state
    self.unavailable = unavailable
    self.groupId = groupId
    self.note = note
  }

  /// The face to draw, with the default for a bot written before appearance existed.
  public var face: BotAppearance { appearance ?? .standard }
}

public enum SubmissionStatus: String, Codable, Sendable {
  case queued, placed, done, unanswered

  /// `queued < placed < done = unanswered`: a record only moves up (PROTOCOL I14).
  public var rank: Int {
    switch self {
    case .queued: return 0
    case .placed: return 1
    case .done, .unanswered: return 2
    }
  }

  public var isTerminal: Bool { self == .done || self == .unanswered }
}

public struct Submission: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var requestId: String
  public var status: SubmissionStatus
  public var entryId: String?
  public var answerEntryId: String?
  public var reason: String?

  public init(
    id: String,
    requestId: String,
    status: SubmissionStatus,
    entryId: String? = nil,
    answerEntryId: String? = nil,
    reason: String? = nil
  ) {
    self.id = id
    self.requestId = requestId
    self.status = status
    self.entryId = entryId
    self.answerEntryId = answerEntryId
    self.reason = reason
  }

  private enum CodingKeys: String, CodingKey {
    case id, submissionId, requestId, status, entryId, answerEntryId, reason
  }

  /// A snapshot's `pending` names the record by `submissionId`; everything else calls it
  /// `id` in this client (PROTOCOL.md, `ConversationSnapshot.pending`).
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let id = try container.decodeIfPresent(String.self, forKey: .id) {
      self.id = id
    } else {
      self.id = try container.decode(String.self, forKey: .submissionId)
    }
    requestId = try container.decode(String.self, forKey: .requestId)
    status = try container.decode(SubmissionStatus.self, forKey: .status)
    entryId = try container.decodeIfPresent(String.self, forKey: .entryId)
    answerEntryId = try container.decodeIfPresent(String.self, forKey: .answerEntryId)
    reason = try container.decodeIfPresent(String.self, forKey: .reason)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .submissionId)
    try container.encode(requestId, forKey: .requestId)
    try container.encode(status, forKey: .status)
    try container.encodeIfPresent(entryId, forKey: .entryId)
    try container.encodeIfPresent(answerEntryId, forKey: .answerEntryId)
    try container.encodeIfPresent(reason, forKey: .reason)
  }
}

public struct InboxItem: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var mode: String

  public init(id: String, mode: String) {
    self.id = id
    self.mode = mode
  }
}

/// One live task of a bot: the work its conversations are running right now
/// (PROTOCOL.md, "Live tasks"). The status is a raw string, so a status the daemon adds
/// later is shown as it arrives instead of making the whole frame unreadable.
public struct TaskStatus: RawRepresentable, Codable, Sendable, Hashable {
  public var rawValue: String

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static let pending = TaskStatus(rawValue: "pending")
  public static let running = TaskStatus(rawValue: "running")
  public static let waiting = TaskStatus(rawValue: "waiting")
  public static let sleeping = TaskStatus(rawValue: "sleeping")
  public static let completing = TaskStatus(rawValue: "completing")
}

public struct TaskSummary: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  /// The task definition's own name (`pi.generation`, an extension's kind, …).
  public var kind: String
  public var status: TaskStatus
  public var phase: String?
  public var background: Bool
  /// Why it cannot run here; absent means it can.
  public var blocked: String?
  /// The parent task, when this one is a child.
  public var owner: String?
  public var conversationId: String?

  public init(
    id: String,
    kind: String,
    status: TaskStatus,
    phase: String? = nil,
    background: Bool = false,
    blocked: String? = nil,
    owner: String? = nil,
    conversationId: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.status = status
    self.phase = phase
    self.background = background
    self.blocked = blocked
    self.owner = owner
    self.conversationId = conversationId
  }

  private enum CodingKeys: String, CodingKey {
    case id, kind, status, phase, background, blocked, owner, conversationId
  }

  /// Only `id`, `kind` and `status` are always on the wire; the rest is optional, and a
  /// missing `background` reads as `false`.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    kind = try container.decode(String.self, forKey: .kind)
    status = try container.decode(TaskStatus.self, forKey: .status)
    phase = try container.decodeIfPresent(String.self, forKey: .phase)
    background = try container.decodeIfPresent(Bool.self, forKey: .background) ?? false
    blocked = try container.decodeIfPresent(String.self, forKey: .blocked)
    owner = try container.decodeIfPresent(String.self, forKey: .owner)
    conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
  }
}

/// What one conversation has spent, as the daemon sums it from `pi.usage`.
public struct Usage: Codable, Hashable, Sendable {
  public var inputTokens: Int
  public var outputTokens: Int
  public var totalTokens: Int
  /// Absent when the provider reports no cost (a local gateway usually does).
  public var costUsd: Double?

  public init(inputTokens: Int, outputTokens: Int, totalTokens: Int, costUsd: Double? = nil) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.totalTokens = totalTokens
    self.costUsd = costUsd
  }
}

/// A third-party service a bot's tools may call (docs/bots/PROTOCOL.md, "Providers").
public struct ProviderSettings: Codable, Sendable, Equatable, Identifiable {
  public var id: String
  public var title: String
  public var kind: String
  public var baseUrl: String
  public var docsUrl: String
  public var keyLabel: String
  public var hasApiKey: Bool
  public var enabled: Bool

  public init(
    id: String, title: String, kind: String, baseUrl: String, docsUrl: String,
    keyLabel: String, hasApiKey: Bool, enabled: Bool
  ) {
    self.id = id
    self.title = title
    self.kind = kind
    self.baseUrl = baseUrl
    self.docsUrl = docsUrl
    self.keyLabel = keyLabel
    self.hasApiKey = hasApiKey
    self.enabled = enabled
  }
}

/// The daemon's probe of one provider: reachable, accepted and how long it took.
public struct ProviderProbe: Codable, Sendable, Equatable {
  public var ok: Bool
  public var message: String
  public var latencyMs: Int
  public var results: Int?

  public init(ok: Bool, message: String, latencyMs: Int, results: Int? = nil) {
    self.ok = ok
    self.message = message
    self.latencyMs = latencyMs
    self.results = results
  }
}

/// Usage statistics over the daemon's retained window (docs/bots/PROTOCOL.md).
public struct UsageReport: Codable, Sendable, Equatable {
  public struct Totals: Codable, Sendable, Equatable {
    public var totalTokens: Int
    public var calls: Int?
    public var costUsd: Double

    public init(totalTokens: Int, calls: Int? = nil, costUsd: Double) {
      self.totalTokens = totalTokens
      self.calls = calls
      self.costUsd = costUsd
    }
  }

  /// One source's share of the work: models spend tokens, search spends calls.
  public struct SourceTotals: Codable, Sendable, Equatable, Identifiable {
    public var source: String
    public var totalTokens: Int
    public var calls: Int
    public var costUsd: Double
    public var id: String { source }

    public init(source: String, totalTokens: Int, calls: Int, costUsd: Double) {
      self.source = source
      self.totalTokens = totalTokens
      self.calls = calls
      self.costUsd = costUsd
    }
  }

  public struct Day: Codable, Sendable, Equatable, Identifiable {
    public var day: String
    public var totalTokens: Int
    public var costUsd: Double
    public var id: String { day }

    public init(day: String, totalTokens: Int, costUsd: Double) {
      self.day = day
      self.totalTokens = totalTokens
      self.costUsd = costUsd
    }
  }

  public struct Bot: Codable, Sendable, Equatable, Identifiable {
    public var botId: String
    public var title: String
    public var totalTokens: Int
    /// Search spends calls instead of tokens; absent from a daemon that predates the split.
    public var calls: Int?
    public var costUsd: Double
    public var id: String { botId }

    public init(botId: String, title: String, totalTokens: Int, calls: Int? = nil, costUsd: Double)
    {
      self.botId = botId
      self.title = title
      self.totalTokens = totalTokens
      self.calls = calls
      self.costUsd = costUsd
    }
  }

  public var retentionDays: Int
  public var today: Totals
  public var week: Totals
  public var month: Totals
  public var days: [Day]
  public var bots: [Bot]
  /// Absent from a daemon that predates the source split.
  public var sources: [SourceTotals]?

  public init(
    retentionDays: Int,
    today: Totals,
    week: Totals,
    month: Totals,
    days: [Day],
    bots: [Bot],
    sources: [SourceTotals]? = nil
  ) {
    self.retentionDays = retentionDays
    self.today = today
    self.week = week
    self.month = month
    self.days = days
    self.bots = bots
    self.sources = sources
  }
}

/// What a bot runs with, as the snapshot reports it (`agent` capability).
public struct AgentView: Codable, Hashable, Sendable {
  public var model: ModelRef
  public var thinkingLevel: String
  public var instructions: String

  public init(model: ModelRef, thinkingLevel: String, instructions: String) {
    self.model = model
    self.thinkingLevel = thinkingLevel
    self.instructions = instructions
  }
}

/// One pull request a bot reported: the link opens it, the status decides its colour. The
/// daemon stores reports and never queries a forge, so this is exactly what the model said.
public struct PullSummary: Codable, Sendable, Equatable, Hashable, Identifiable {
  public var url: String
  public var title: String
  /// draft, open, reviewing, merged, closed or failed.
  public var status: String
  /// github.com, dev.azure.com, … — the row's label for any forge.
  public var host: String
  public var updatedAt: String

  public var id: String { url }

  public init(url: String, title: String, status: String, host: String, updatedAt: String) {
    self.url = url
    self.title = title
    self.status = status
    self.host = host
    self.updatedAt = updatedAt
  }
}

public struct ConversationSnapshot: Codable, Sendable, Equatable {
  public var botId: String
  public var messages: [Message]
  public var truncatedBefore: String?
  public var streaming: String?
  public var pending: [Submission]
  public var inbox: [InboxItem]
  public var running: Bool
  public var unavailable: BotUnavailable?
  /// A parked task keeps `recover` meaningful across clients; absent means healthy.
  public var parked: Bool?
  /// Live work of every conversation this bot owns; absent means nothing runs.
  public var tasks: [TaskSummary]
  /// The bot's own triggers; empty means none, and the capability decides whether to show
  /// the section at all (PROTOCOL.md, "Triggers").
  public var triggers: [TriggerSummary]
  /// Pull requests the bot reported; empty means it reported none.
  public var pulls: [PullSummary]
  /// Tokens and cost so far; absent until the first answered turn.
  public var usage: Usage?
  /// What the bot runs with, when the daemon reports it.
  public var agent: AgentView?

  public init(
    botId: String,
    messages: [Message] = [],
    truncatedBefore: String? = nil,
    streaming: String? = nil,
    pending: [Submission] = [],
    inbox: [InboxItem] = [],
    running: Bool = false,
    unavailable: BotUnavailable? = nil,
    parked: Bool? = nil,
    tasks: [TaskSummary] = [],
    triggers: [TriggerSummary] = [],
    pulls: [PullSummary] = [],
    usage: Usage? = nil,
    agent: AgentView? = nil
  ) {
    self.botId = botId
    self.messages = messages
    self.truncatedBefore = truncatedBefore
    self.streaming = streaming
    self.pending = pending
    self.inbox = inbox
    self.running = running
    self.unavailable = unavailable
    self.parked = parked
    self.tasks = tasks
    self.triggers = triggers
    self.pulls = pulls
    self.usage = usage
    self.agent = agent
  }

  private enum CodingKeys: String, CodingKey {
    case botId, messages, truncatedBefore, streaming, pending, inbox, running, unavailable, parked
    case tasks, triggers, pulls, agent, usage
  }

  /// `streaming` is `{ "messageId": "p_a1" }` on the wire and `null` when no attempt is in
  /// flight; the client only needs the id.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    botId = try container.decode(String.self, forKey: .botId)
    messages = try container.decodeIfPresent([Message].self, forKey: .messages) ?? []
    truncatedBefore = try container.decodeIfPresent(String.self, forKey: .truncatedBefore)
    pending = try container.decodeIfPresent([Submission].self, forKey: .pending) ?? []
    inbox = try container.decodeIfPresent([InboxItem].self, forKey: .inbox) ?? []
    running = try container.decodeIfPresent(Bool.self, forKey: .running) ?? false
    unavailable = try container.decodeIfPresent(BotUnavailable.self, forKey: .unavailable)
    parked = try container.decodeIfPresent(Bool.self, forKey: .parked)
    tasks = try container.decodeIfPresent([TaskSummary].self, forKey: .tasks) ?? []
    triggers = try container.decodeIfPresent([TriggerSummary].self, forKey: .triggers) ?? []
    pulls = try container.decodeIfPresent([PullSummary].self, forKey: .pulls) ?? []
    usage = try container.decodeIfPresent(Usage.self, forKey: .usage)
    agent = try container.decodeIfPresent(AgentView.self, forKey: .agent)
    if let pointer = try container.decodeIfPresent(StreamingPointer.self, forKey: .streaming) {
      streaming = pointer.messageId
    } else {
      streaming = nil
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(botId, forKey: .botId)
    try container.encode(messages, forKey: .messages)
    try container.encodeIfPresent(truncatedBefore, forKey: .truncatedBefore)
    try container.encodeIfPresent(pending, forKey: .pending)
    try container.encode(inbox, forKey: .inbox)
    try container.encode(running, forKey: .running)
    try container.encodeIfPresent(unavailable, forKey: .unavailable)
    try container.encodeIfPresent(parked, forKey: .parked)
    try container.encode(tasks, forKey: .tasks)
    try container.encode(triggers, forKey: .triggers)
    try container.encode(pulls, forKey: .pulls)
    try container.encodeIfPresent(usage, forKey: .usage)
    try container.encodeIfPresent(agent, forKey: .agent)
    if let streaming {
      try container.encode(StreamingPointer(messageId: streaming), forKey: .streaming)
    } else {
      try container.encodeNil(forKey: .streaming)
    }
  }

  private struct StreamingPointer: Codable {
    let messageId: String
  }
}

/// One step of a toolcall delta's path. pi streams a call's arguments as JSON text and
/// names array positions with numbers, so the type is preserved across the wire; a
/// numeric-looking object key stays a key (PROTOCOL I13).
public enum JSONPathComponent: Codable, Sendable, Hashable {
  case key(String)
  case index(Int)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let index = try? container.decode(Int.self) {
      self = .index(index)
      return
    }
    if let key = try? container.decode(String.self) {
      self = .key(key)
      return
    }
    throw DecodingError.dataCorruptedError(
      in: container,
      debugDescription: "not a path component"
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .key(let key): try container.encode(key)
    case .index(let index): try container.encode(index)
    }
  }
}

extension JSONPathComponent: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) { self = .key(value) }
}

extension JSONPathComponent: ExpressibleByIntegerLiteral {
  public init(integerLiteral value: Int) { self = .index(value) }
}

public enum DeltaChange: Codable, Sendable, Equatable {
  case text(index: Int, append: String)
  case thinking(index: Int, append: String)
  case toolCall(index: Int, callId: String, path: [JSONPathComponent], append: String)
  case block(index: Int, block: ContentBlock)
  case message(Message)

  private enum CodingKeys: String, CodingKey {
    case kind, index, append, callId, path, block, message
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .kind) {
    case "text":
      self = .text(
        index: try container.decode(Int.self, forKey: .index),
        append: try container.decode(String.self, forKey: .append)
      )
    case "thinking":
      self = .thinking(
        index: try container.decode(Int.self, forKey: .index),
        append: try container.decode(String.self, forKey: .append)
      )
    case "toolcall":
      self = .toolCall(
        index: try container.decode(Int.self, forKey: .index),
        callId: try container.decodeIfPresent(String.self, forKey: .callId) ?? "",
        path: try container.decodeIfPresent([JSONPathComponent].self, forKey: .path) ?? [],
        append: try container.decodeIfPresent(String.self, forKey: .append) ?? ""
      )
    case "block":
      self = .block(
        index: try container.decode(Int.self, forKey: .index),
        block: try container.decode(ContentBlock.self, forKey: .block)
      )
    case "message":
      self = .message(try container.decode(Message.self, forKey: .message))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .kind,
        in: container,
        debugDescription: "unknown delta kind"
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let index, let append):
      try container.encode("text", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(append, forKey: .append)
    case .thinking(let index, let append):
      try container.encode("thinking", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(append, forKey: .append)
    case .toolCall(let index, let callId, let path, let append):
      try container.encode("toolcall", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(callId, forKey: .callId)
      try container.encode(path, forKey: .path)
      try container.encode(append, forKey: .append)
    case .block(let index, let block):
      try container.encode("block", forKey: .kind)
      try container.encode(index, forKey: .index)
      try container.encode(block, forKey: .block)
    case .message(let message):
      try container.encode("message", forKey: .kind)
      try container.encode(message, forKey: .message)
    }
  }

  /// A tool path mixes object keys and array indexes; the client never writes one.

}

public enum BusyMode: String, Codable, Sendable {
  case followUp, steer, reject
}

public struct HistoryPage: Sendable, Equatable {
  public var messages: [Message]
  public var hasMore: Bool

  public init(messages: [Message], hasMore: Bool) {
    self.messages = messages
    self.hasMore = hasMore
  }
}

/// What a sidebar renders about one trigger (docs/bots/PROTOCOL.md, "Triggers"). The prompt
/// and a webhook endpoint come over HTTP; the event never carries a credential.
public struct TriggerSummary: Codable, Sendable, Equatable, Identifiable, Hashable {
  public struct Schedule: Codable, Sendable, Equatable, Hashable {
    public var cron: String
    public var timezone: String
    /// The durable delivery cursor; absent while disabled or before the first tick.
    public var nextDueAt: String?

    public init(cron: String, timezone: String, nextDueAt: String? = nil) {
      self.cron = cron
      self.timezone = timezone
      self.nextDueAt = nextDueAt
    }
  }

  public struct Counters: Codable, Sendable, Equatable, Hashable {
    public var fired: Int
    public var dropped: Int
    public var refused: Int

    public init(fired: Int = 0, dropped: Int = 0, refused: Int = 0) {
      self.fired = fired
      self.dropped = dropped
      self.refused = refused
    }
  }

  public struct Skipped: Codable, Sendable, Equatable, Hashable {
    public var at: String
    public var reason: String

    public init(at: String, reason: String) {
      self.at = at
      self.reason = reason
    }
  }

  public enum Kind: String, Codable, Sendable {
    case schedule, webhook
  }

  public var id: String
  public var kind: Kind
  public var name: String
  public var enabled: Bool
  public var schedule: Schedule?
  public var counters: Counters
  public var lastFiredAt: String?
  public var lastSkipped: Skipped?

  public init(
    id: String,
    kind: Kind,
    name: String,
    enabled: Bool,
    schedule: Schedule? = nil,
    counters: Counters = Counters(),
    lastFiredAt: String? = nil,
    lastSkipped: Skipped? = nil
  ) {
    self.id = id
    self.kind = kind
    self.name = name
    self.enabled = enabled
    self.schedule = schedule
    self.counters = counters
    self.lastFiredAt = lastFiredAt
    self.lastSkipped = lastSkipped
  }

  /// The badge a sidebar row shows when the queue lost or refused something.
  public var warning: String? {
    if let skipped = lastSkipped { return skipped.reason == "missed" ? "错过" : skipped.reason }
    if counters.dropped > 0 { return "丢弃 \(counters.dropped)" }
    return nil
  }
}
