import BotsCore
import Foundation

/// The wire codec for protocol v1 (docs/bots/PROTOCOL.md). The daemon owns encoding; this
/// side decodes strictly where the contract is strict and ignores unknown event types
/// while still consuming their revision.
public enum Wire {
  public static let protocolVersion = 1
  public static let clientName = "BotsApp/0.1.0"

  public struct Decoded: Sendable {
    public let event: ConversationEvent?
    public let rev: Int?
    public let type: String
    /// The absolute catalog a `welcome` or `bots` frame carries.
    public let catalog: BotCatalog?

    public init(
      event: ConversationEvent?,
      rev: Int?,
      type: String,
      catalog: BotCatalog? = nil
    ) {
      self.event = event
      self.rev = rev
      self.type = type
      self.catalog = catalog
    }
  }

  public static func decode(_ data: Data) throws -> Decoded {
    let decoder = JSONDecoder()
    let envelope = try decoder.decode(Envelope.self, from: data)
    switch envelope.type {
    case "welcome":
      let frame = try decoder.decode(Welcome.self, from: data)
      guard frame.protocolVersion == protocolVersion else {
        throw ClientError(
          "the daemon speaks protocol \(frame.protocolVersion), not \(protocolVersion)")
      }
      return Decoded(
        event: .connection(.ready), rev: nil, type: "welcome", catalog: frame.catalog)
    case "snapshot":
      let frame = try decoder.decode(SnapshotFrame.self, from: data)
      return Decoded(event: .snapshot(frame.value), rev: frame.rev, type: "snapshot")
    case "append":
      let frame = try decoder.decode(AppendFrame.self, from: data)
      return Decoded(
        event: .append(message: frame.message, replaces: frame.replaces),
        rev: frame.rev,
        type: "append"
      )
    case "delta":
      let frame = try decoder.decode(DeltaFrame.self, from: data)
      return Decoded(
        event: .delta(messageId: frame.messageId, changes: frame.changes),
        rev: frame.rev,
        type: "delta"
      )
    case "status":
      let frame = try decoder.decode(StatusFrame.self, from: data)
      return Decoded(
        event: .status(running: frame.running, inbox: frame.inbox, streaming: frame.streaming),
        rev: frame.rev,
        type: "status"
      )
    case "submission":
      let frame = try decoder.decode(SubmissionFrame.self, from: data)
      return Decoded(
        event: .submission(
          Submission(
            id: frame.submissionId,
            requestId: frame.requestId,
            status: frame.status,
            entryId: frame.entryId,
            answerEntryId: frame.answerEntryId,
            reason: frame.reason
          )
        ),
        rev: frame.rev,
        type: "submission"
      )
    case "history":
      let frame = try decoder.decode(HistoryFrame.self, from: data)
      return Decoded(
        event: .history(page: HistoryPage(messages: frame.messages, hasMore: frame.hasMore)),
        rev: nil,
        type: "history"
      )
    case "tasks":
      let frame = try decoder.decode(TasksFrame.self, from: data)
      return Decoded(event: .tasks(frame.tasks), rev: frame.rev, type: "tasks")
    case "triggers":
      let frame = try decoder.decode(TriggersFrame.self, from: data)
      return Decoded(event: .triggers(frame.triggers), rev: frame.rev, type: "triggers")
    case "pulls":
      let frame = try decoder.decode(PullsFrame.self, from: data)
      return Decoded(event: .pulls(frame.pulls), rev: frame.rev, type: "pulls")
    case "usage":
      let frame = try decoder.decode(UsageFrame.self, from: data)
      return Decoded(event: .usage(frame.usage), rev: frame.rev, type: "usage")
    case "agent":
      let frame = try decoder.decode(AgentFrame.self, from: data)
      return Decoded(event: .agent(frame.agent), rev: frame.rev, type: "agent")
    case "error":
      let frame = try decoder.decode(ErrorFrame.self, from: data)
      // The handshake failure carries `server` instead of a disposition and is sent before
      // a session exists (PROTOCOL.md, client duties 3).
      let disposition =
        frame.disposition ?? (frame.server == nil ? .runtime : .notAdmitted)
      return Decoded(
        event: .error(
          kind: frame.kind,
          disposition: disposition,
          message: frame.message,
          failure: frame.failure,
          requestId: frame.requestId
        ),
        rev: frame.rev,
        type: "error"
      )
    case "bots":
      let frame = try decoder.decode(BotsFrame.self, from: data)
      return Decoded(
        event: .catalog(frame.catalog), rev: nil, type: "bots", catalog: frame.catalog)
    case "pong":
      return Decoded(event: nil, rev: nil, type: "pong")
    default:
      return Decoded(event: nil, rev: envelope.rev, type: envelope.type)
    }
  }

  // MARK: - Commands

  public static func hello() throws -> Data {
    try JSONEncoder().encode(
      Hello(type: "hello", protocolVersion: protocolVersion, client: clientName)
    )
  }

  public static func subscribe(botId: String, contextId: String? = nil, trace: String) throws
    -> Data
  {
    try JSONEncoder().encode(
      Subscribe(type: "subscribe", botId: botId, contextId: contextId, trace: trace))
  }

  public static func send(
    requestId: String,
    text: String,
    whenBusy: BusyMode,
    contextId: String? = nil,
    resourceHead: String? = nil,
    trace: String
  ) throws -> Data {
    try JSONEncoder().encode(
      Send(
        type: "send",
        requestId: requestId,
        text: text,
        whenBusy: whenBusy.rawValue,
        contextId: contextId, resourceHead: resourceHead,
        trace: trace
      )
    )
  }

  public static func abort(trace: String) throws -> Data {
    try JSONEncoder().encode(TracedCommand(type: "abort", trace: trace))
  }

  public static func recover(trace: String) throws -> Data {
    try JSONEncoder().encode(TracedCommand(type: "recover", trace: trace))
  }

  public static func resync(trace: String) throws -> Data {
    try JSONEncoder().encode(TracedCommand(type: "resync", trace: trace))
  }

  public static func history(before: String, limit: Int, trace: String) throws -> Data {
    try JSONEncoder().encode(
      HistoryCommand(type: "history", before: before, limit: limit, trace: trace)
    )
  }

  public static func ping() throws -> Data {
    try JSONEncoder().encode(Ping(type: "ping"))
  }

  // MARK: - Payloads

  struct Envelope: Decodable {
    let type: String
    let rev: Int?
  }

  struct Welcome: Decodable {
    let protocolVersion: Int
    let bots: [BotSummary]
    /// Absent when the daemon has no groups, so an older client keeps working.
    let groups: [BotGroup]?

    var catalog: BotCatalog { BotCatalog(bots: bots, groups: groups ?? []) }
  }

  struct SnapshotFrame: Decodable {
    let rev: Int
    let value: ConversationSnapshot
  }

  struct AppendFrame: Decodable {
    let rev: Int
    let message: Message
    let replaces: String?
  }

  struct DeltaFrame: Decodable {
    let rev: Int
    let messageId: String
    let changes: [DeltaChange]
  }

  struct StatusFrame: Decodable {
    let rev: Int
    let running: Bool
    let streaming: String?
    let inbox: [InboxItem]
  }

  struct SubmissionFrame: Decodable {
    let rev: Int?
    let requestId: String
    let submissionId: String
    let status: SubmissionStatus
    let entryId: String?
    let answerEntryId: String?
    let reason: String?
  }

  struct HistoryFrame: Decodable {
    let messages: [Message]
    let hasMore: Bool
  }

  struct AgentFrame: Decodable {
    let rev: Int
    let agent: AgentView
  }

  struct UsageFrame: Decodable {
    let rev: Int
    let usage: Usage
  }

  struct TasksFrame: Decodable {
    let rev: Int
    let tasks: [TaskSummary]
  }

  struct TriggersFrame: Decodable {
    let rev: Int
    let triggers: [TriggerSummary]
  }

  struct PullsFrame: Decodable {
    let rev: Int
    let pulls: [PullSummary]
  }

  struct ErrorFrame: Decodable {
    let rev: Int?
    let kind: ErrorKind
    let disposition: ErrorDisposition?
    let failure: String?
    let message: String
    let requestId: String?
    let server: ServerVersion?
  }

  struct BotsFrame: Decodable {
    let bots: [BotSummary]
    let groups: [BotGroup]?

    var catalog: BotCatalog { BotCatalog(bots: bots, groups: groups ?? []) }
  }

  struct ServerVersion: Decodable {
    let protocolVersion: Int
  }

  struct Hello: Encodable {
    let type: String
    let protocolVersion: Int
    let client: String
  }

  struct Subscribe: Encodable {
    let type: String
    let botId: String
    let contextId: String?
    let trace: String
  }

  struct Send: Encodable {
    let type: String
    let requestId: String
    let text: String
    let whenBusy: String
    let contextId: String?
    let resourceHead: String?
    let trace: String
  }

  struct TracedCommand: Encodable {
    let type: String
    let trace: String
  }

  struct HistoryCommand: Encodable {
    let type: String
    let before: String
    let limit: Int
    let trace: String
  }

  struct Ping: Encodable {
    let type: String
  }
}
