import Foundation

/// What the client receives from the transport. Wire decoding lives there; this is the
/// domain vocabulary the reducer and the view models speak (docs/bots/ARCHITECTURE.md,
/// "Ports").
public enum ConversationEvent: Sendable, Equatable {
  case connection(ConnectionState)
  case snapshot(ConversationSnapshot)
  case append(message: Message, replaces: String?)
  case delta(messageId: String, changes: [DeltaChange])
  case status(running: Bool, inbox: [InboxItem], streaming: String?)
  case submission(Submission)
  case history(page: HistoryPage)
  /// The whole live-task list of the bot; an empty list means nothing runs.
  case tasks([TaskSummary])
  /// The bot's own triggers, whole-list replacement (PROTOCOL.md, "Triggers").
  case triggers([TriggerSummary])
  /// The bot's reported pull requests, whole-list replacement.
  case pulls([PullSummary])
  /// Tokens and cost so far, whenever the daemon's totals move.
  case usage(Usage)
  /// The bot's complete current model, thinking level and instructions.
  case agent(AgentView)
  case catalog(BotCatalog)
  case error(
    kind: ErrorKind,
    disposition: ErrorDisposition,
    message: String,
    failure: String?,
    requestId: String?
  )
}

public enum ConnectionState: Sendable, Equatable {
  case connecting
  case ready
  case reconnecting(attempt: Int)
  case failed(reason: String)
  case stopped

  /// The connection is over and the socket will not retry it: the person must act (start
  /// the daemon) and ask again. `reconnecting` is not this.
  public var isFailed: Bool {
    if case .failed = self { return true }
    return false
  }
}

/// Command context is created by the view model, so the call site and the daemon share one
/// trace and one requestId (docs/bots/PROTOCOL.md, "Trace ownership").
public struct CommandContext: Sendable, Equatable {
  public let trace: String
  public let requestId: String?
  public let contextId: String?
  public let resourceHead: String?

  public init(
    trace: String, requestId: String? = nil, contextId: String? = nil, resourceHead: String? = nil
  ) {
    self.trace = trace
    self.requestId = requestId
    self.contextId = contextId
    self.resourceHead = resourceHead
  }

  public static func command(_ prefix: String = "cmd", contextId: String? = nil) -> CommandContext {
    CommandContext(trace: Identifiers.trace(prefix), contextId: contextId)
  }

  public static func send(
    _ requestId: String, contextId: String? = nil, resourceHead: String? = nil
  ) -> CommandContext {
    CommandContext(
      trace: Identifiers.trace("send"), requestId: requestId, contextId: contextId,
      resourceHead: resourceHead)
  }
}

/// Identifiers the wire accepts: 8–64 characters of `[A-Za-z0-9_-]` (PROTOCOL.md, limits).
public enum Identifiers {
  public static func trace(_ prefix: String = "cmd") -> String {
    "\(prefix)_\(UUID().uuidString)"
  }

  public static func request() -> String {
    "r_\(UUID().uuidString)"
  }
}

public protocol CatalogPort: AnyObject {
  /// The bots and the groups in one read: a membership only means something with the
  /// groups beside it (PROTOCOL.md, "Group rules").
  func load() async throws -> BotCatalog
  func create(
    title: String,
    label: String?,
    appearance: BotAppearance
  ) async throws -> BotSummary
  /// Edits a bot: a nil field is left alone; an empty label clears the stored one.
  func update(
    id: String,
    title: String?,
    label: String?,
    appearance: BotAppearance?
  ) async throws -> BotSummary
  func rename(id: String, title: String) async throws -> BotSummary
  func delete(id: String) async throws
  func catalogEvents() -> AsyncStream<BotCatalog>

  func createGroup(title: String) async throws -> BotGroup
  func renameGroup(id: String, title: String) async throws -> BotGroup
  /// The daemon refuses while a bot is still filed under it; the message is what shows.
  func deleteGroup(id: String) async throws
  /// The whole order, every group once: the daemon writes nothing partial.
  func reorderGroups(ids: [String]) async throws -> [BotGroup]
  /// Files a bot; a nil group unfiles it.
  func moveBot(id: String, groupId: String?) async throws -> BotSummary
  /// The third-party providers and their saved state.
  func loadProviders() async throws -> [ProviderSettings]
  /// Saves one provider's key or enable flag.
  func saveProvider(id: String, apiKey: String?, enabled: Bool?) async throws -> ProviderSettings
  /// Probes one provider with a single search.
  func testProvider(id: String) async throws -> ProviderProbe
  /// Usage statistics over the retained window.
  func loadUsage(days: Int) async throws -> UsageReport
  /// The model ids the gateway offers.
  func loadModels() async throws -> [String]
  /// The bot's own agent choice; nil fields are left alone.
  func setAgent(id: String, model: String?, thinkingLevel: String?) async throws -> BotSummary
  /// Runs one parked task again; the task graph reports it as live work.
  func retryTask(bot: String, task: String) async throws
  /// Stops one live task; the transcript keeps what it committed.
  func abortTask(bot: String, task: String) async throws
}

public protocol ConversationPort: AnyObject {
  func open(botId: String, contextId: String?) -> AsyncStream<ConversationEvent>
  /// `botId` is the connection the caller believes it is writing to; the transport
  /// refuses when the socket now belongs to another bot.
  func send(
    _ text: String,
    whenBusy: BusyMode,
    context: CommandContext,
    botId: String
  ) async throws
  func abort(context: CommandContext, botId: String) async throws
  func recover(context: CommandContext, botId: String) async throws
  func resync(context: CommandContext, botId: String) async throws
  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws
  func close()
}

extension ConversationPort {
  public func open(botId: String) -> AsyncStream<ConversationEvent> {
    open(botId: botId, contextId: nil)
  }
}

/// A failure the client itself produced (no connection, a rejected frame, a bad URL).
public struct ClientError: Error, Sendable, CustomStringConvertible {
  public let message: String

  public init(_ message: String) {
    self.message = message
  }

  public var description: String { message }
}

/// One trigger's read-only detail plus the person's only mutation (docs/bots/TRIGGERS.md
/// §8.3). The daemon's bearer authenticates it; a credential never crosses this port.
public struct TriggerDetail: Sendable, Equatable, Identifiable {
  public var summary: TriggerSummary
  /// The Bot's standing instruction, shown read-only.
  public var prompt: String
  /// Where a webhook delivers; nil for a schedule.
  public var endpoint: String?
  /// The delivery credential. Only the app reads it, and only to copy it once.
  public var token: String?

  public init(
    summary: TriggerSummary, prompt: String, endpoint: String? = nil, token: String? = nil
  ) {
    self.summary = summary
    self.prompt = prompt
    self.endpoint = endpoint
    self.token = token
  }

  public var id: String { summary.id }
}

/// One bot that takes part in an exchange, as the app draws it.
public struct PeerExchangeParticipant: Sendable, Equatable, Identifiable {
  public var id: String
  public var title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}

/// What a transcript needs to fold an exchange into one row.
public struct PeerExchangeSummary: Sendable, Equatable, Identifiable {
  public var id: String
  public var participants: [PeerExchangeParticipant]
  /// Question and answer pairs, as the person counts them: "4 条消息来往".
  public var count: Int
  public var status: String
  public var startedAt: String
  /// When the exchange last moved: the transcript keeps the row beside the latest turn.
  public var updatedAt: String

  public init(
    id: String, participants: [PeerExchangeParticipant], count: Int, status: String,
    startedAt: String, updatedAt: String
  ) {
    self.id = id
    self.participants = participants
    self.count = count
    self.status = status
    self.startedAt = startedAt
    self.updatedAt = updatedAt
  }
}

/// One message inside an exchange: what a bot sent, and what it got back.
public struct PeerExchangeMessage: Sendable, Equatable, Identifiable {
  public var id: String
  public var fromBotId: String
  public var toBotId: String
  public var at: String
  public var text: String
  public var answer: String?

  public init(
    id: String, fromBotId: String, toBotId: String, at: String, text: String, answer: String?
  ) {
    self.id = id
    self.fromBotId = fromBotId
    self.toBotId = toBotId
    self.at = at
    self.text = text
    self.answer = answer
  }
}

/// The whole round trip, read once when a person opens the row.
public struct PeerExchangeDetail: Sendable, Equatable, Identifiable {
  public var id: String
  public var participants: [PeerExchangeParticipant]
  public var status: String
  public var startedAt: String
  public var messages: [PeerExchangeMessage]

  public init(
    id: String, participants: [PeerExchangeParticipant], status: String, startedAt: String,
    messages: [PeerExchangeMessage]
  ) {
    self.id = id
    self.participants = participants
    self.status = status
    self.startedAt = startedAt
    self.messages = messages
  }
}

public protocol PeerPort: AnyObject, Sendable {
  func list(botId: String) async throws -> [PeerExchangeSummary]
  func detail(botId: String, exchangeId: String) async throws -> PeerExchangeDetail
}

public protocol TriggerPort: AnyObject, Sendable {
  func list(botId: String) async throws -> [TriggerDetail]
  /// Switching is the only mutation a person may perform.
  func setEnabled(botId: String, triggerId: String, enabled: Bool) async throws -> TriggerDetail
}
