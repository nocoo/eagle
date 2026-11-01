import Foundation

/// The external device port's JSON value; no Eagle/Bots protocol dependency.
public indirect enum DeviceJSON: Codable, Equatable, Sendable {
  case object([String: DeviceJSON])
  case array([DeviceJSON])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let x = try? value.decode(Bool.self) {
      self = .bool(x)
    } else if let x = try? value.decode(String.self) {
      self = .string(x)
    } else if let x = try? value.decode(Double.self) {
      self = .number(x)
    } else if let x = try? value.decode([String: DeviceJSON].self) {
      self = .object(x)
    } else {
      self = .array(try value.decode([DeviceJSON].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .null: try value.encodeNil()
    case .bool(let x): try value.encode(x)
    case .number(let x): try value.encode(x)
    case .string(let x): try value.encode(x)
    case .array(let x): try value.encode(x)
    case .object(let x): try value.encode(x)
    }
  }

  public subscript(_ key: String) -> DeviceJSON? {
    guard case .object(let values) = self else { return nil }
    return values[key]
  }
  public var string: String? {
    if case .string(let x) = self { return x }
    return nil
  }
  public var number: Double? {
    if case .number(let x) = self { return x }
    return nil
  }

  public func decoded<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
  }

  public static func encoded<T: Encodable>(_ value: T) throws -> DeviceJSON {
    try JSONDecoder().decode(Self.self, from: JSONEncoder().encode(value))
  }

  /// Matches the wire's recursively key-sorted JSON.stringify bytes.
  public func canonical() throws -> String {
    switch self {
    case .null: return "null"
    case .bool(let x): return x ? "true" : "false"
    case .string(let x): return Self.quote(x)
    case .number(let x): return try Self.numberText(x)
    case .array(let x): return "[" + (try x.map { try $0.canonical() }).joined(separator: ",") + "]"
    case .object(let x):
      let keys = x.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
      return "{"
        + (try keys.map { key in
          Self.quote(key) + ":" + (try (x[key] ?? .null).canonical())
        }).joined(separator: ",") + "}"
    }
  }

  private static func quote(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 34: result += "\\\""
      case 92: result += "\\\\"
      case 8: result += "\\b"
      case 9: result += "\\t"
      case 10: result += "\\n"
      case 12: result += "\\f"
      case 13: result += "\\r"
      case 0..<32: result += String(format: "\\u%04x", scalar.value)
      default: result.unicodeScalars.append(scalar)
      }
    }
    return result + "\""
  }

  private static func numberText(_ value: Double) throws -> String {
    guard value.isFinite else { throw DeviceIdentityError.invalidPayload }
    if value == 0 { return "0" }
    let raw = String(value).lowercased()
    let parts = raw.split(separator: "e")
    var mantissa = String(parts[0])
    if mantissa.hasSuffix(".0") { mantissa.removeLast(2) }
    guard parts.count == 2, let exponent = Int(parts[1]) else { return mantissa }
    if exponent >= -6 && exponent < 21 {
      let negative = mantissa.hasPrefix("-")
      let unsigned = negative ? String(mantissa.dropFirst()) : mantissa
      let whole = unsigned.split(separator: ".")[0].count
      let digits = unsigned.replacingOccurrences(of: ".", with: "")
      let point = whole + exponent
      let expanded: String
      if point <= 0 {
        expanded = "0." + String(repeating: "0", count: -point) + digits
      } else if point >= digits.count {
        expanded = digits + String(repeating: "0", count: point - digits.count)
      } else {
        let index = digits.index(digits.startIndex, offsetBy: point)
        expanded = String(digits[..<index]) + "." + digits[index...]
      }
      return (negative ? "-" : "") + expanded
    }
    return mantissa + "e" + (exponent >= 0 ? "+" : "") + String(exponent)
  }
}
