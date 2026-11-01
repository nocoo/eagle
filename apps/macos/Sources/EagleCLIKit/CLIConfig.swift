import Foundation

/// Where the CLI finds the daemon and the credential it presents
/// (`docs/bots/CLI.md` "Names, install, discovery"). Resolution order is env → file →
/// defaults; the App's own `<root>/token` is never a fallback, so a CLI credential cannot
/// borrow the App's rights.
public struct CLIConfig: Sendable {
  /// A development token file that exists but cannot be used (`docs/bots/CLI.md`
  /// "Development token"). It is a local refusal, never a fallback.
  public struct UnsafeDevToken: Sendable, Equatable {
    public let path: String
    public let reason: String
  }

  public let binaryName: String
  public let root: String
  public let port: String
  public let token: String?
  public let clientName: String?
  public let configPath: String
  public let unsafeDevToken: UnsafeDevToken?

  public var baseURL: URL {
    URL(string: "http://127.0.0.1:\(Int(port) ?? 43117)")!
  }

  public var socketURL: URL {
    URL(string: "ws://127.0.0.1:\(Int(port) ?? 43117)/v1/socket")!
  }

  /// `eagle` is the released App's binary; anything else is a development copy
  /// (`eagle-dev`, or a `swift run EagleCLI` shell), which keeps its own file and credential.
  public static func binaryName(for argv0: String) -> String {
    let name = (argv0 as NSString).lastPathComponent
    return name == "eagle" ? "eagle" : "eagle-dev"
  }

  public static func configURL(binaryName: String, home: String) -> URL {
    URL(fileURLWithPath: home, isDirectory: true)
      .appendingPathComponent(".config/eagle", isDirectory: true)
      .appendingPathComponent("\(binaryName).json")
  }

  /// The development credential's own file, kept apart from the released App's.
  public static func devTokenURL(home: String) -> URL {
    URL(fileURLWithPath: home, isDirectory: true)
      .appendingPathComponent(".config/eagle-dev", isDirectory: true)
      .appendingPathComponent("token", isDirectory: false)
  }

  /// What the development token file holds.
  enum DevToken: Equatable {
    case missing
    case usable(String)
    case unsafe(path: String, reason: String)
  }

  /// The file must be mode 0600 and carry at least 32 characters: a credential another
  /// account can read is not a credential.
  static func readDevToken(home: String) -> DevToken {
    let url = devTokenURL(home: home)
    let manager = FileManager.default
    guard manager.fileExists(atPath: url.path) else { return .missing }
    let attributes = try? manager.attributesOfItem(atPath: url.path)
    guard let mode = (attributes?[.posixPermissions] as? NSNumber)?.intValue else {
      return .unsafe(
        path: url.path, reason: "its permissions could not be read, and they must be 0600")
    }
    guard mode == 0o600 else {
      return .unsafe(path: url.path, reason: "its mode is \(modeText(mode)), not 0600")
    }
    guard let data = manager.contents(atPath: url.path),
      let text = String(data: data, encoding: .utf8)
    else {
      return .unsafe(path: url.path, reason: "it is not readable UTF-8 text")
    }
    let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard token.count >= 32 else {
      return .unsafe(
        path: url.path,
        reason: "it holds \(token.count) characters, and at least 32 are required")
    }
    return .usable(token)
  }

  private static func modeText(_ mode: Int) -> String {
    "0" + String(mode, radix: 8)
  }

  public static func load(
    argv0: String,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    home: String? = nil
  ) -> CLIConfig {
    let name = binaryName(for: argv0)
    // `NSHomeDirectory()` ignores `HOME`, so an isolated run has to be told where home is.
    let homeFromEnvironment = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 }
    let resolvedHome = home ?? homeFromEnvironment ?? NSHomeDirectory()
    let url = configURL(binaryName: name, home: resolvedHome)
    let file = (try? Data(contentsOf: url)).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
    func value(_ key: String) -> String? {
      let raw = (file?[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
      return (raw?.isEmpty ?? true) ? nil : raw
    }
    func env(_ key: String) -> String? {
      let raw = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines)
      return (raw?.isEmpty ?? true) ? nil : raw
    }
    // The released binary never looks at the development directory.
    let devToken = name == "eagle-dev" ? readDevToken(home: resolvedHome) : .missing
    var token: String?
    var unsafeDevToken: UnsafeDevToken?
    if let fromEnvironment = env("EAGLE_TOKEN") {
      token = fromEnvironment
    } else {
      switch devToken {
      case .missing:
        token = value("token")
      case .usable(let developmentToken):
        token = developmentToken
      case .unsafe(let path, let reason):
        token = nil
        unsafeDevToken = UnsafeDevToken(path: path, reason: reason)
      }
    }
    return CLIConfig(
      binaryName: name,
      root: env("EAGLE_ROOT") ?? value("root") ?? "~/.local/share/eagle-bots",
      port: env("EAGLE_PORT") ?? value("port") ?? "43117",
      token: token,
      clientName: value("client"),
      configPath: url.path,
      unsafeDevToken: unsafeDevToken
    )
  }
}
