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
  /// account can read is not a credential. The mode and the bytes come from one open
  /// descriptor, so the file that was checked is the file that is read. Only "there is no
  /// such file" means absent: a path that cannot be inspected fails closed, because an
  /// unreadable directory must never look like a missing credential.
  static func readDevToken(home: String) -> DevToken {
    let url = devTokenURL(home: home)
    // `O_NONBLOCK` keeps a FIFO somebody left at this path from hanging every command;
    // a regular file is unaffected by the flag.
    let descriptor = url.path.withCString { open($0, O_RDONLY | O_NONBLOCK) }
    guard descriptor >= 0 else {
      let code = errno
      if code == ENOENT { return .missing }
      return .unsafe(
        path: url.path, reason: "it cannot be opened (\(String(cString: strerror(code))))")
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var info = stat()
    guard fstat(handle.fileDescriptor, &info) == 0 else {
      return .unsafe(path: url.path, reason: "its state cannot be read")
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else {
      return .unsafe(path: url.path, reason: "it is not a regular file")
    }
    let mode = Int(info.st_mode & 0o777)
    guard mode == 0o600 else {
      return .unsafe(path: url.path, reason: "its mode is \(Self.octal(mode)), not 0600")
    }
    guard let data = try? handle.readToEnd(), let text = String(data: data, encoding: .utf8) else {
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

  private static func octal(_ mode: Int) -> String {
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
    var token: String?
    var unsafeDevToken: UnsafeDevToken?
    if let fromEnvironment = env("EAGLE_TOKEN") {
      // The caller's own instruction for this run: the file is not even opened, so a
      // credential on disk can never shadow an explicit one. The released binary never
      // looks at the development directory at all.
      token = fromEnvironment
    } else {
      switch name == "eagle-dev" ? readDevToken(home: resolvedHome) : .missing {
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
