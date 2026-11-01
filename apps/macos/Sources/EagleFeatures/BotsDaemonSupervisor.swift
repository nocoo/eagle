import Combine
import CryptoKit
import EagleDevices
import Foundation

/// Owns the local Bots daemon: starts it with the app (unless one is already running),
/// reports its state in Settings, and terminates the process it started when the app quits.
/// It never stops a daemon it did not start, except one a previous run of this app left
/// behind (recognised by the pid it recorded).
private let botsAutoStartKey = "eagle.bots.autoStart"
private let botsDaemonPidKey = "eagle.bots.daemonPid"

@MainActor
public final class BotsDaemonSupervisor: ObservableObject {
  public static let shared = BotsDaemonSupervisor()
  public enum Status: Equatable {
    case stopped
    case starting
    case running(version: String, pid: Int, external: Bool)
    case failed(String)
  }

  @Published public private(set) var status: Status = .stopped
  /// Persisted so the next launch can adopt a daemon an earlier run left after a crash.
  @Published public var autoStart: Bool {
    didSet { defaults.set(autoStart, forKey: botsAutoStartKey) }
  }

  public var rootPath: String { settings.rootPath }
  public var port: String { settings.port }

  private let settings: BotsSettings
  private let daemonDirectory: URL?
  private let nodePath: String?
  private let packaged: Bool
  private let deviceSocketPath: String?
  private let environment: [String: String]
  private let defaults: UserDefaults
  private var child: Process?
  /// A daemon this app started earlier (or adopted from its recorded pid); it is ours to stop.
  private var ownedPid: Int?
  private var starting = false
  private let log = LockedText()

  public init(
    settings: BotsSettings = BotsSettings(), bundle: URL = Bundle.main.bundleURL,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    defaults: UserDefaults = .standard
  ) {
    self.settings = settings
    self.defaults = defaults
    self.environment = environment
    autoStart = defaults.object(forKey: botsAutoStartKey) as? Bool ?? true
    packaged = bundle.pathExtension == "app"
    let executable =
      packaged
      ? bundle.appendingPathComponent("Contents/MacOS/Eagle") : Bundle.main.executableURL
    daemonDirectory = Self.resolveDaemonDirectory(
      explicit: environment["BOTS_DAEMON_DIR"],
      executable: executable
    )
    if packaged {
      let node = bundle.appendingPathComponent("Contents/Resources/DeviceRuntime/node")
      nodePath = FileManager.default.isExecutableFile(atPath: node.path) ? node.path : nil
      deviceSocketPath = (try? DeviceHostConfiguration.load(bundle: bundle))?.socketPath
    } else {
      nodePath = Self.resolveNode(environment: environment)
      deviceSocketPath = environment["BOTS_DEVICE_SOCKET"]
    }
  }

  /// Starts the daemon if nothing answers the health endpoint. Idempotent.
  public func startIfNeeded() async {
    if case .running = status { return }
    if starting { return }
    starting = true
    defer { starting = false }
    guard !packaged || deviceSocketPath != nil else {
      status = .failed("设备运行配置不可用，请重新安装 Eagle。")
      return
    }
    if let health = await probe() {
      guard matchesDevicePort(health) else {
        status = .failed("此端口的 Bots 服务未连接当前设备环境。请停止该服务后重试。")
        return
      }
      adopt(health)
      return
    }
    guard autoStart else {
      status = .stopped
      return
    }
    guard let daemonDirectory else {
      status = .failed(packaged ? "内置 Bots 服务不完整，请重新安装 Eagle。" : "找不到开发环境的 Bots 服务。")
      return
    }
    guard let nodePath else {
      status = .failed(packaged ? "内置运行环境不完整，请重新安装 Eagle。" : "开发环境缺少 Node 24+。")
      return
    }
    status = .starting
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments =
      ["--experimental-strip-types"]
      + (packaged ? [] : ["--env-file-if-exists=.env"]) + [
        "scripts/serve.ts",
        "--root", settings.rootPath,
        "--port", settings.port,
      ]
    let childEnvironment = Self.daemonEnvironment(
      packaged: packaged,
      environment: environment,
      isolatedConfigHome: settings.isIsolated
        ? settings.rootURL.appendingPathComponent("config").path : nil,
      deviceSocketPath: deviceSocketPath
    )
    process.environment = childEnvironment
    process.currentDirectoryURL = daemonDirectory
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { [log] handle in
      let data = handle.availableData
      if !data.isEmpty { log.append(data) }
    }
    process.terminationHandler = { [weak self] finished in
      Task { @MainActor [weak self] in
        self?.terminated(finished)
      }
    }
    do {
      try process.run()
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      status = .failed("Bots daemon 启动失败：\(error.localizedDescription)")
      return
    }
    child = process
    ownedPid = Int(process.processIdentifier)
    defaults.set(ownedPid, forKey: botsDaemonPidKey)
    // Wait for health; a daemon with a busy port exits and the probe never answers.
    for _ in 0..<40 {
      try? await Task.sleep(nanoseconds: 250_000_000)
      if let health = await probe() {
        guard health.pid == Int(process.processIdentifier), matchesDevicePort(health) else { break }
        status = .running(version: health.version, pid: health.pid, external: false)
        return
      }
      if !process.isRunning { break }
    }
    let tail = log.suffix(600)
    await terminateChild()
    status = .failed(
      tail.isEmpty ? "Bots daemon 没有在 10 秒内就绪。" : "Bots daemon 退出：\(tail)"
    )
  }

  /// The Settings buttons: stop is synchronous enough for a click; start goes through the
  /// same path as launch.
  public func stop() async {
    if case .running(_, let pid, let external) = status, external {
      status = .failed("这个 daemon 不是由 App 启动的（pid \(pid)），不自动停止。")
      return
    }
    await terminateChild()
    status = .stopped
  }

  public func restart() async {
    await terminateChild()
    status = .stopped
    await startIfNeeded()
  }

  /// `applicationWillTerminate` has little time: signal, wait briefly, then kill. It reads
  /// the pid the supervisor recorded, so it works without touching the main actor.
  public nonisolated static func terminateRecordedDaemon() {
    let pid = UserDefaults.standard.integer(forKey: botsDaemonPidKey)
    guard pid > 0 else { return }
    kill(pid_t(pid), SIGTERM)
    let deadline = Date().addingTimeInterval(3)
    while kill(pid_t(pid), 0) == 0, Date() < deadline { usleep(50_000) }
    if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGKILL) }
    UserDefaults.standard.removeObject(forKey: botsDaemonPidKey)
  }

  // MARK: - internals

  /// The environment the daemon child gets. A packaged build gets a fixed, minimal one; a
  /// source run inherits the developer's environment and tells the daemon where the
  /// development token lives (`docs/bots/CLI.md` "Development token").
  static func daemonEnvironment(
    packaged: Bool,
    environment: [String: String],
    isolatedConfigHome: String?,
    deviceSocketPath: String?
  ) -> [String: String] {
    var childEnvironment =
      packaged
      ? [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
        "HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(),
      ] : environment
    if let isolatedConfigHome { childEnvironment["XDG_CONFIG_HOME"] = isolatedConfigHome }
    if !packaged {
      childEnvironment["BOTS_DEV_AGENT_TOKEN"] = devTokenPath(home: environment["HOME"])
    }
    // Keep the port configured even when disabled/offline: absence must never expose unguarded tools.
    if let deviceSocketPath { childEnvironment["BOTS_DEVICE_SOCKET"] = deviceSocketPath }
    return childEnvironment
  }

  /// `~/.config/eagle-dev/token`; the file itself may or may not exist.
  static func devTokenPath(home: String?) -> String {
    let root = home.flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
    return URL(fileURLWithPath: root, isDirectory: true)
      .appendingPathComponent(".config/eagle-dev", isDirectory: true)
      .appendingPathComponent("token").path
  }

  private struct Health: Decodable {
    let version: String
    let pid: Int
    let deviceAccess: DeviceAccess?
  }
  private struct DeviceAccess: Decodable {
    let version: Int
    let binding: String
  }
  private func matchesDevicePort(_ health: Health) -> Bool {
    guard let deviceSocketPath else { return !packaged }
    let binding = SHA256.hash(data: Data(deviceSocketPath.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return health.deviceAccess?.version == 1 && health.deviceAccess?.binding == binding
  }

  private func probe() async -> Health? {
    guard let url = URL(string: "http://127.0.0.1:\(settings.port)/v1/health") else {
      return nil
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else {
      return nil
    }
    return try? JSONDecoder().decode(Health.self, from: data)
  }

  private func adopt(_ health: Health) {
    if let recorded = defaults.object(forKey: botsDaemonPidKey) as? Int,
      recorded == health.pid
    {
      // A previous run of this app spawned it (a crash skipped the shutdown).
      ownedPid = health.pid
      status = .running(version: health.version, pid: health.pid, external: false)
      return
    }
    status = .running(version: health.version, pid: health.pid, external: true)
  }

  private func terminated(_ process: Process) {
    guard child === process else { return }
    child = nil
    ownedPid = nil
    defaults.removeObject(forKey: botsDaemonPidKey)
    if case .starting = status { return }
    if case .stopped = status { return }
    status = .stopped
  }

  private func terminateChild() async {
    guard let process = child, process.isRunning else {
      child = nil
      ownedPid = nil
      defaults.removeObject(forKey: botsDaemonPidKey)
      if case .running(_, _, let external) = status, !external {
        status = .stopped
      }
      return
    }
    process.terminate()
    for _ in 0..<40 {
      if !process.isRunning { break }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    if process.isRunning { kill(pid_t(process.processIdentifier), SIGKILL) }
    child = nil
    ownedPid = nil
    defaults.removeObject(forKey: botsDaemonPidKey)
  }

  /// `apps/bots` from the executable's ancestry, so a built `.app` in the repo finds the
  /// daemon without configuration; an explicit environment path wins.
  static func resolveDaemonDirectory(explicit: String?, executable: URL?) -> URL? {
    let fileManager = FileManager.default
    var ancestor = executable?.deletingLastPathComponent()
    while let current = ancestor, current.path != "/" {
      if current.pathExtension == "app" {
        let runtime = current.appendingPathComponent("Contents/Resources/DeviceRuntime/bots")
        return fileManager.fileExists(
          atPath: runtime.appendingPathComponent("scripts/serve.ts").path)
          ? runtime : nil
      }
      ancestor = current.deletingLastPathComponent()
    }
    if let explicit, !explicit.isEmpty {
      let url = URL(fileURLWithPath: explicit, isDirectory: true)
      if fileManager.fileExists(atPath: url.appendingPathComponent("scripts/serve.ts").path) {
        return url
      }
      return nil
    }
    var directory = executable?.deletingLastPathComponent()
    for _ in 0..<8 {
      guard let current = directory else { return nil }
      let candidate = current.appendingPathComponent("apps/bots", isDirectory: true)
      if fileManager.fileExists(atPath: candidate.appendingPathComponent("scripts/serve.ts").path) {
        return candidate
      }
      directory = current.deletingLastPathComponent()
    }
    return nil
  }

  /// A GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`; Homebrew's node is not on it.
  static func resolveNode(environment: [String: String]) -> String? {
    // An explicit path is an instruction, not a hint: a typo must not silently pick
    // another Node that may be the wrong major version.
    if let explicit = environment["BOTS_NODE"] {
      return FileManager.default.isExecutableFile(atPath: explicit) ? explicit : nil
    }
    for candidate in [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ] where FileManager.default.isExecutableFile(atPath: candidate) {
      return candidate
    }
    if let path = environment["PATH"] {
      for directory in path.split(separator: ":") {
        let candidate = "\(directory)/node"
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
      }
    }
    return nil
  }
}

/// A tiny thread-safe tail buffer for the child's output, read on a background queue.
private final class LockedText: @unchecked Sendable {
  private let lock = NSLock()
  private var text = ""

  func append(_ data: Data) {
    guard let piece = String(data: data, encoding: .utf8) else { return }
    lock.lock()
    text += piece
    if text.count > 4_000 { text = String(text.suffix(4_000)) }
    lock.unlock()
  }

  func suffix(_ count: Int) -> String {
    lock.lock()
    defer { lock.unlock() }
    return String(text.suffix(count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
