import Foundation

/// Where the CLI finds the daemon and the credential it presents
/// (`docs/bots/CLI.md` "Names, install, discovery"). Resolution order is env → file →
/// defaults; the App's own `<root>/token` is never a fallback, so a CLI credential cannot
/// borrow the App's rights.
public struct CLIConfig: Sendable {
  public let binaryName: String
  public let root: String
  public let port: String
  public let token: String?
  public let clientName: String?
  public let configPath: String

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

  public static func load(
    argv0: String,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    home: String = NSHomeDirectory()
  ) -> CLIConfig {
    let name = binaryName(for: argv0)
    let url = configURL(binaryName: name, home: home)
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
    return CLIConfig(
      binaryName: name,
      root: env("EAGLE_ROOT") ?? value("root") ?? "~/.local/share/eagle-bots",
      port: env("EAGLE_PORT") ?? value("port") ?? "43117",
      token: env("EAGLE_TOKEN") ?? value("token"),
      clientName: value("client"),
      configPath: url.path
    )
  }
}
