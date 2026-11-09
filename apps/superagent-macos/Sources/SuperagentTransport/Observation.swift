import Foundation
import SuperagentCore

/// SG-002 observation values. The provider shape is typed; the payload stays a JSON value
/// so the CLI and the App print exactly what the service answered.
public struct ProviderReport: Decodable, Sendable, Equatable {
  public let reachable: Bool
  public let state: String
  public let lastReadAt: String?
  public let unavailable: Int
  public let detail: String?

  public init(
    reachable: Bool, state: String, lastReadAt: String? = nil, unavailable: Int = 0,
    detail: String? = nil
  ) {
    self.reachable = reachable
    self.state = state
    self.lastReadAt = lastReadAt
    self.unavailable = unavailable
    self.detail = detail
  }

  public var isKnown: Bool { state == "ready" }
}

public enum JSONValue: Decodable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON")
    }
  }

  /// Foundation-shaped, so a CLI can print it and an App can read a field by name.
  public var any: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let value): return value
    case .number(let value): return value
    case .string(let value): return value
    case .array(let values): return values.map(\.any)
    case .object(let values): return values.mapValues(\.any)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let values) = self { return values[key] }
    return nil
  }

  public var array: [JSONValue] {
    if case .array(let values) = self { return values }
    return []
  }

  public var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var int: Int? {
    if case .number(let value) = self { return Int(value) }
    return nil
  }
}

public struct ObservationReply: Decodable, Sendable {
  public let provider: ProviderReport
  public let snapshot: JSONValue?
  public let history: JSONValue?
  public let changes: JSONValue?
}

extension ObservationSummary {
  /// The provider's report plus the snapshot's own coverage facts, and nothing inferred.
  public init(reply: ObservationReply) {
    let bots = reply.snapshot?["bots"]?.array ?? []
    let visible = bots.filter { $0["store"]?["state"]?.string == "available" }.count
    self.init(
      state: ObservationSummary.State(rawValue: reply.provider.state) ?? .failure,
      reachable: reply.provider.reachable,
      botsVisible: visible,
      botsUnknown: bots.count - visible,
      lastReadAt: reply.provider.lastReadAt,
      detail: reply.provider.detail,
      isEmpty: reply.snapshot == nil)
  }
}

/// SG-004: one thing the watcher noticed, as the service reports it.
public struct AttentionItemReply: Decodable, Sendable, Equatable {
  public let id: String
  public let botId: String
  public let kind: String
  public let severity: String
  public let evidence: String
  public let count: Int
  public let firstSeenAt: String
  public let lastSeenAt: String
  public let closedAt: String?
  public let reportedAt: String?
  public let actedAt: String?
}

public struct AttentionReply: Decodable, Sendable, Equatable {
  public let provider: AttentionProvider
  public let items: [AttentionItemReply]

  public struct AttentionProvider: Decodable, Sendable, Equatable {
    public let state: String
    public let lastTickAt: String?
  }
}

public struct AttentionAckReply: Decodable, Sendable, Equatable {
  public let item: AttentionItemReply
}

public struct ManageModeReply: Decodable, Sendable, Equatable {
  public let mode: String
}

/// SG-003: one bounded suggestion and the evidence it quotes.
public struct SuggestionReply: Decodable, Sendable, Equatable {
  public let id: String
  public let botId: String
  public let text: String
  public let evidence: [String]
  public let createdAt: String
  public let closedAt: String?
  public let stale: Bool?
}

public struct SuggestionListReply: Decodable, Sendable, Equatable {
  public let suggestions: [SuggestionReply]
}

public struct DecisionReply: Decodable, Sendable, Equatable {
  public let id: String
  public let suggestionId: String
  public let botId: String
  public let verdict: String
  public let reason: String?
  public let at: String
}

public struct DecisionListReply: Decodable, Sendable, Equatable {
  public let decisions: [DecisionReply]
}

public struct SuggestionAckReply: Decodable, Sendable, Equatable {
  public let suggestion: SuggestionReply
  public let decision: DecisionReply
}

public struct AnalyzeReply: Decodable, Sendable, Equatable {
  public let suggestion: SuggestionReply?
  public let refused: String?
  public let suggestions: [SuggestionReply]?
}
