import CryptoKit
import Foundation

/// The relay origin this Mac talks to. A published App ships none: the person names the service
/// they run. Apps and helpers with the same signed profile share that choice.
public enum DeviceServiceAddress {
  public static let defaultsKey = "eagle.deviceServiceAddress"

  /// An origin only: no credentials, path, query or fragment. Plain HTTP is loopback-only.
  public static func normalize(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
      let components = URLComponents(string: trimmed),
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      ["", "/"].contains(components.path),
      let host = components.host?.lowercased(),
      !host.isEmpty
    else { return nil }
    switch components.scheme?.lowercased() {
    case "https": return components.url?.originString
    case "http":
      return ["127.0.0.1", "localhost", "::1"].contains(host) ? components.url?.originString : nil
    default: return nil
    }
  }

  public static func saved(_ defaults: UserDefaults) -> String? {
    defaults.string(forKey: defaultsKey).flatMap(normalize)
  }

  public static func saved(profile: String) -> String? {
    profileDefaults(profile).flatMap(saved)
  }

  @discardableResult
  public static func save(_ value: String, profile: String) -> String? {
    profileDefaults(profile).flatMap { save(value, defaults: $0) }
  }

  private static func profileDefaults(_ profile: String) -> UserDefaults? {
    guard !profile.isEmpty, profile.utf8.count <= 80 else { return nil }
    let digest = SHA256.hash(data: Data(profile.utf8)).map { String(format: "%02x", $0) }.joined()
    return UserDefaults(suiteName: "ai.hexly.eagle.devices.address." + digest)
  }

  /// Stores the normalized origin, or clears the choice when the value is not usable.
  @discardableResult
  public static func save(_ value: String, defaults: UserDefaults) -> String? {
    guard let origin = normalize(value) else {
      defaults.removeObject(forKey: defaultsKey)
      return nil
    }
    defaults.set(origin, forKey: defaultsKey)
    return origin
  }
}

extension URL {
  fileprivate var originString: String? {
    guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false),
      let host = host()
    else { return nil }
    components.scheme = components.scheme?.lowercased()
    components.host = host.contains(":") ? "[\(host.lowercased())]" : host.lowercased()
    if (components.scheme == "https" && components.port == 443)
      || (components.scheme == "http" && components.port == 80)
    {
      components.port = nil
    }
    components.path = ""
    return components.string
  }
}
