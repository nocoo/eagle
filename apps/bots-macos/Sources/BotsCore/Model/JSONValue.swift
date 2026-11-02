import Foundation

/// A JSON value as a tool call's arguments carry it: the daemon sends an open object, the
/// client displays it, and nothing here guesses a schema (docs/bots/PROTOCOL.md,
/// "ContentBlock"). Kept in the domain so a fixture decodes to the same value the row shows.
public enum JSONValue: Codable, Sendable, Equatable, Hashable {
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
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "not a JSON value"
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value):
      // An integral number stays integral on the wire, so a fixture round trip is exact.
      if value.rounded() == value, abs(value) < 1e15 {
        try container.encode(Int(value))
      } else {
        try container.encode(value)
      }
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }

  /// One line for a tool row's subtitle: `{"path":"."}` becomes `path="." · …` only when
  /// the caller asks for the whole value; the compact form is the value itself.
  public var compact: String { render(pretty: false) }

  public var pretty: String { render(pretty: true) }

  private func render(pretty: Bool, indent: Int = 0) -> String {
    switch self {
    case .null: return "null"
    case .bool(let value): return value ? "true" : "false"
    case .number(let value):
      return value.rounded() == value && abs(value) < 1e15
        ? String(Int(value)) : String(value)
    case .string(let value): return Self.quote(value)
    case .array(let value):
      if value.isEmpty { return "[]" }
      if !pretty { return "[\(value.map { $0.render(pretty: false) }.joined(separator: ","))]" }
      let pad = String(repeating: " ", count: indent + 2)
      let lines = value.map { "\(pad)\($0.render(pretty: true, indent: indent + 2))" }
      return "[\n\(lines.joined(separator: ",\n"))\n\(String(repeating: " ", count: indent))]"
    case .object(let value):
      if value.isEmpty { return "{}" }
      let keys = value.keys.sorted()
      if !pretty {
        return
          "{\(keys.map { "\(Self.quote($0)):\(value[$0]?.render(pretty: false) ?? "null")" }.joined(separator: ","))}"
      }
      let pad = String(repeating: " ", count: indent + 2)
      let lines = keys.map { key in
        "\(pad)\(Self.quote(key)): \(value[key]?.render(pretty: true, indent: indent + 2) ?? "null")"
      }
      return "{\n\(lines.joined(separator: ",\n"))\n\(String(repeating: " ", count: indent))}"
    }
  }

  private static func quote(_ value: String) -> String {
    var escaped = ""
    for character in value.unicodeScalars {
      switch character {
      case "\"": escaped += "\\\""
      case "\\": escaped += "\\\\"
      case "\n": escaped += "\\n"
      case "\r": escaped += "\\r"
      case "\t": escaped += "\\t"
      default:
        if character.value < 0x20 {
          escaped += String(format: "\\u%04x", character.value)
        } else {
          escaped.unicodeScalars.append(character)
        }
      }
    }
    return "\"\(escaped)\""
  }
}
