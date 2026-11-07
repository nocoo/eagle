import Foundation

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
