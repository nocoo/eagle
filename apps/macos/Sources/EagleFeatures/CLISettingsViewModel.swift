import BotsCore
import BotsTransport
import Foundation

/// Settings → CLI: the one switch that installs the command line client, and the list of
/// credentials a person can hand to another agent and take away again
/// (docs/bots/CLI.md). The App owns both halves; the daemon only stores hashes.
@MainActor
public final class CLISettingsViewModel: ObservableObject {
  /// Where the installed link points; the released App names it `eagle`, every other build
  /// keeps its own name so the two never collide.
  public let commandName: String
  public let binaryURL: URL?
  public let linkURL: URL
  public let configURL: URL
  public let binDirectory: URL

  @Published public private(set) var clients: [CLIClient] = []
  @Published public private(set) var busy = false
  @Published public private(set) var message: String?
  @Published public private(set) var failure: String?
  /// The one chance to copy a new secret; cleared as soon as the sheet closes.
  @Published public private(set) var issuedToken: String?
  @Published public private(set) var installed = false
  @Published public private(set) var pathReady = false

  private let baseURL: URL
  private let rootURL: URL
  private let port: String
  private let session: URLSession
  private let fileManager: FileManager
  /// A name the daemon accepts (lower case, digits, `-`, `_`): credentials are
  /// identified in logs, so the automatic one is stated in that same alphabet.
  static let automaticClientName = "this-mac"

  public init(
    appVersion: AppVersion = .current(),
    botsSettings: BotsSettings = BotsSettings(),
    session: URLSession = .shared,
    fileManager: FileManager = .default,
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    binaryURL: URL? = CLISettingsViewModel.bundledCommand(
      in: Bundle.main.bundleURL, executable: Bundle.main.executableURL),
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.commandName = appVersion.isRelease ? "eagle" : "eagle-dev"
    self.binaryURL = binaryURL
    self.baseURL = botsSettings.baseURL
    self.rootURL = botsSettings.rootURL
    self.port = botsSettings.port
    self.session = session
    self.fileManager = fileManager
    self.binDirectory = home.appendingPathComponent(".local/bin", isDirectory: true)
    self.linkURL = binDirectory.appendingPathComponent(
      appVersion.isRelease ? "eagle" : "eagle-dev")
    self.configURL =
      home
      .appendingPathComponent(".config/eagle", isDirectory: true)
      .appendingPathComponent(
        "\(appVersion.isRelease ? "eagle" : "eagle-dev").json")
    self.pathReady = Self.path(environment["PATH"]).contains(binDirectory.path)
    self.installed = fileManager.fileExists(atPath: linkURL.path)
  }

  /// The command this App can install: the copy shipped in `Contents/Helpers`, or — for a
  /// source run, where `Bundle.main` is the build directory — the sibling `eagle-cli` that
  /// `swift build` produced. The installed link still gets the App's own name.
  public static func bundledCommand(
    in bundleURL: URL,
    executable: URL? = Bundle.main.executableURL
  ) -> URL? {
    let helpers = bundleURL.appendingPathComponent("Contents/Helpers", isDirectory: true)
    for name in ["eagle", "eagle-dev"] {
      let candidate = helpers.appendingPathComponent(name)
      if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    if let sibling = executable?.deletingLastPathComponent()
      .appendingPathComponent("eagle-cli"),
      FileManager.default.fileExists(atPath: sibling.path)
    {
      return sibling
    }
    return nil
  }

  public var canInstall: Bool { binaryURL != nil }

  public var binaryLabel: String {
    binaryURL.map { "内置 \($0.lastPathComponent)" } ?? "找不到 CLI 可执行文件"
  }

  public var linkLabel: String { linkURL.path }

  public var configLabel: String { configURL.path }

  /// `~/.local/bin` first in a shell, with the one export a person may need to add.
  public var pathHint: String? {
    pathReady ? nil : "把这一行加进 shell 配置：export PATH=\"$HOME/.local/bin:$PATH\""
  }

  public var activeClients: [CLIClient] { clients.filter { !$0.isRevoked } }

  public var revokedClients: [CLIClient] { clients.filter(\.isRevoked) }

  public func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    installed = fileManager.fileExists(atPath: linkURL.path)
    do {
      clients = try await client().list()
    } catch {
      failure = "\(error)"
    }
  }

  /// The switch: link the command, issue this machine's credential once, and write the
  /// config the CLI reads. A missing binary or an unwritable directory stops here with the
  /// exact path instead of asking for permissions the App does not have.
  public func enable() async {
    guard !busy else { return }
    guard let binaryURL else {
      failure = "这一版没有内置 CLI：请在 App 包里安装后才能启用。"
      return
    }
    busy = true
    defer { busy = false }
    do {
      try fileManager.createDirectory(
        at: binDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
      if fileManager.fileExists(atPath: linkURL.path) {
        try fileManager.removeItem(at: linkURL)
      }
      try fileManager.createSymbolicLink(at: linkURL, withDestinationURL: binaryURL)

      // The secret is only ever answered once, so a live credential for this machine is
      // revoked and dropped before a new one is issued; a revoked record is deleted as is.
      for existing in try await client().list() where existing.name == Self.automaticClientName {
        if !existing.isRevoked {
          _ = try await client().revoke(existing.id)
        }
        try await client().delete(existing.id)
      }
      let issued = try await client().issue(
        name: Self.automaticClientName, scopes: ["read", "write"])
      clients = try await client().list()
      try writeConfig(token: issued.1)
      installed = true
      pathReady = pathReady || pathContainsBin
      failure = nil
      message = "已安装 \(commandName)：\(linkURL.path)"
    } catch {
      failure = "\(error)"
    }
  }

  /// Turning the switch off unlinks and revokes this machine's credential; the record stays
  /// so the person can see what was cut off and delete it.
  public func disable() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      if fileManager.fileExists(atPath: linkURL.path) {
        try fileManager.removeItem(at: linkURL)
      }
      try? fileManager.removeItem(at: configURL)
      for record in (try await client().list())
      where record.name == Self.automaticClientName && !record.isRevoked {
        _ = try await client().revoke(record.id)
      }
      clients = try await client().list()
      installed = false
      issuedToken = nil
      failure = nil
      message = "已停用 \(commandName)"
    } catch {
      failure = "\(error)"
    }
  }

  /// The daemon's own rule (docs/bots/PROTOCOL.md "CLI clients and scopes"), checked here so
  /// a name it would refuse is explained before a request is made.
  static func validName(_ name: String) -> Bool {
    name.count <= 32 && name.range(of: "^[a-z0-9][a-z0-9_-]*$", options: .regularExpression) != nil
  }

  /// Issues one more credential for another agent; the secret is answered once.
  public func issue(name: String, scopes: [String]) async {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else {
      failure = "请先命名这个客户端，例如 claude-code"
      return
    }
    guard Self.validName(trimmed) else {
      failure = "名称只能用 1–32 个小写字母、数字、连字符或下划线，例如 claude-code"
      return
    }
    busy = true
    defer { busy = false }
    do {
      let issued = try await client().issue(name: trimmed, scopes: scopes)
      issuedToken = issued.1
      clients = try await client().list()
      failure = nil
    } catch {
      failure = "\(error)"
    }
  }

  public func revoke(_ id: String) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      _ = try await client().revoke(id)
      clients = try await client().list()
      failure = nil
    } catch {
      failure = "\(error)"
    }
  }

  /// Only a revoked record can be deleted; the daemon refuses an active one.
  public func delete(_ id: String) async {
    guard !busy, let target = clients.first(where: { $0.id == id }), target.isRevoked else {
      return
    }
    busy = true
    defer { busy = false }
    do {
      try await client().delete(id)
      clients = try await client().list()
      failure = nil
    } catch {
      failure = "\(error)"
    }
  }

  public func dismissIssuedToken() { issuedToken = nil }

  private var pathContainsBin: Bool {
    Self.path(ProcessInfo.processInfo.environment["PATH"]).contains(binDirectory.path)
  }

  private static func path(_ raw: String?) -> [String] {
    (raw ?? "").split(separator: ":").map(String.init)
  }

  /// 0600, beside nothing else a person has to know about: the CLI reads it, the App writes it.
  private func writeConfig(token: String) throws {
    try fileManager.createDirectory(
      at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let payload: [String: String] = [
      "root": rootURL.path, "port": port, "token": token, "client": Self.automaticClientName,
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    try data.write(to: configURL, options: [.atomic])
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
  }

  private func client() throws -> CLICredentialsClient {
    CLICredentialsClient(
      baseURL: baseURL, token: try TokenStore(root: rootURL).read(), session: session)
  }
}
