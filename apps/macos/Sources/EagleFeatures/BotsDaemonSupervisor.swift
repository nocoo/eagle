import BotsTransport
import Combine
import CryptoKit
import Darwin
import EagleDevices
import Foundation
import OSLog

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
  private let publishSync: @MainActor (Int?, String?) async throws -> Void
  private var syncGeneration = UUID()
  private var syncTask: Task<Void, Never>?
  private var lastSyncPublication: String?
  public enum Withdrawal: Equatable { case confirmed, unknown, notOwned }
  public private(set) var withdrawal: Withdrawal = .notOwned
  private let syncLog = Logger(subsystem: "ai.hexly.eagle.bots", category: "sync")
  private var child: Process?
  /// A daemon this app started earlier (or adopted from its recorded pid); it is ours to stop.
  private var ownedPid: Int?
  private var ownedIdentity: ProcessIdentity?
  private var stoppingChild = false
  private struct ProcessIdentity: Equatable {
    let pid: Int
    let seconds: UInt64
    let microseconds: UInt64
    static func read(_ pid: Int) -> ProcessIdentity? {
      var info = proc_bsdinfo()
      guard pid > 0,
        proc_pidinfo(
          Int32(pid), PROC_PIDTBSDINFO, 0, &info,
          Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
        info.pbi_uid == getuid()
      else { return nil }
      return ProcessIdentity(
        pid: pid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }
  }
  private var startupGeneration = UUID()
  private var startTask: Task<Void, Never>?
  private var stopTask: (generation: UUID, task: Task<Void, Never>)?
  private var quitting = false
  private let log = LockedText()

  public init(
    settings: BotsSettings = BotsSettings(), bundle: URL = Bundle.main.bundleURL,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    defaults: UserDefaults = .standard,
    publishSync: @escaping @MainActor (Int?, String?) async throws -> Void = { port, digest in
      try await DeviceSettingsViewModel.shared.publishSyncEndpoints(
        port: port, expectedSelfDigest: digest)
    }
  ) {
    self.settings = settings
    self.defaults = defaults
    self.publishSync = publishSync
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
    guard !quitting, stopTask == nil else { return }
    if case .running = status { return }
    if let startTask {
      await startTask.value
      return
    }
    let generation = UUID()
    startupGeneration = generation
    let task = Task { await start(generation: generation) }
    startTask = task
    await task.value
    if startupGeneration == generation { startTask = nil }
  }

  private func start(generation: UUID) async {
    guard currentStartup(generation) else { return }
    guard !packaged || deviceSocketPath != nil else {
      status = .failed("设备运行配置不可用，请重新安装 Eagle。")
      return
    }
    if let health = await probe() {
      guard currentStartup(generation) else { return }
      guard matchesDevicePort(health) else {
        status = .failed("此端口的 Bots 服务未连接当前设备环境。请停止该服务后重试。")
        return
      }
      adopt(health)
      return
    }
    guard currentStartup(generation) else { return }
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
      ] + (deviceSocketPath == nil ? [] : ["--sync-port", "0"])
    var childEnvironment =
      packaged
      ? [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
        "HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(),
      ] : environment
    if settings.isIsolated {
      childEnvironment["XDG_CONFIG_HOME"] = settings.rootURL.appendingPathComponent("config").path
    }
    // Keep the port configured even when disabled/offline: absence must never expose unguarded tools.
    if let deviceSocketPath { childEnvironment["BOTS_DEVICE_SOCKET"] = deviceSocketPath }
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
    guard currentStartup(generation) else { return }
    do {
      try process.run()
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      status = .failed("Bots daemon 启动失败：\(error.localizedDescription)")
      return
    }
    child = process
    ownedPid = Int(process.processIdentifier)
    ownedIdentity = ProcessIdentity.read(Int(process.processIdentifier))
    defaults.set(ownedPid, forKey: botsDaemonPidKey)
    // Wait for health; a daemon with a busy port exits and the probe never answers.
    for _ in 0..<40 {
      try? await Task.sleep(nanoseconds: 250_000_000)
      guard currentStartup(generation) else { return }
      if let health = await probe() {
        guard currentStartup(generation), child === process else { return }
        guard health.pid == Int(process.processIdentifier), matchesDevicePort(health) else { break }
        status = .running(version: health.version, pid: health.pid, external: false)
        observeSync(health)
        return
      }
      guard currentStartup(generation), child === process else { return }
      if !process.isRunning { break }
    }
    guard currentStartup(generation), child === process else { return }
    let tail = log.suffix(600)
    await terminateChild()
    guard currentStartup(generation) else { return }
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
    let generation = await stopOwned()
    if startupGeneration == generation { status = .stopped }
  }

  public func restart() async {
    let generation = await stopOwned()
    guard startupGeneration == generation else { return }
    quitting = false
    status = .stopped
    await startIfNeeded()
  }

  /// Normal App quit awaits this operation; uncertain cloud withdrawal never blocks exit forever.
  public func prepareForApplicationQuit() async {
    quitting = true
    let generation = await stopOwned()
    if startupGeneration == generation { status = .stopped }
  }

  private func currentStartup(_ generation: UUID) -> Bool {
    !quitting && startupGeneration == generation
  }

  private func stopOwned() async -> UUID {
    if let stopTask {
      await stopTask.task.value
      return stopTask.generation
    }
    let generation = UUID()
    startupGeneration = generation
    let pending = startTask
    pending?.cancel()
    startTask = nil
    let task = Task {
      await terminateChild()
      await pending?.value
    }
    stopTask = (generation, task)
    await task.value
    if stopTask?.generation == generation { stopTask = nil }
    return generation
  }

  /// Synchronous last-resort cleanup, after the awaited applicationShouldTerminate path.
  public func terminateOwnedDaemonFallback() {
    startupGeneration = UUID()
    startTask?.cancel()
    syncGeneration = UUID()
    syncTask?.cancel()
    syncTask = nil
    if let child, child.isRunning {
      kill(child.processIdentifier, SIGKILL)
    } else if let ownedIdentity, ProcessIdentity.read(ownedIdentity.pid) == ownedIdentity {
      kill(pid_t(ownedIdentity.pid), SIGKILL)
    }
  }

  public static func terminateRecordedDaemon() {
    shared.terminateOwnedDaemonFallback()
  }

  // MARK: - internals

  private struct Health: Decodable {
    let version: String
    let pid: Int
    let deviceAccess: DeviceAccess?
    let instance: String?
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
      guard let identity = ProcessIdentity.read(health.pid) else {
        status = .failed("无法确认已记录的 Bots 进程归属。")
        return
      }
      ownedPid = health.pid
      ownedIdentity = identity
      status = .running(version: health.version, pid: health.pid, external: false)
      observeSync(health)
      return
    }
    status = .running(version: health.version, pid: health.pid, external: true)
  }

  private func terminated(_ process: Process) {
    guard child === process else { return }
    child = nil
    if stoppingChild { return }
    syncGeneration = UUID()
    syncTask?.cancel()
    syncTask = nil
    let generation = syncGeneration
    let pid = ownedPid
    status = .stopped
    Task {
      await dispatchWithdrawal(generation: generation)
      guard syncGeneration == generation, ownedPid == pid else { return }
      ownedPid = nil
      ownedIdentity = nil
      defaults.removeObject(forKey: botsDaemonPidKey)
    }
  }

  private struct SyncState: Decodable {
    let version: Int
    let instance: String
    let pid: Int
    let binding: String?
    let ready: Bool
    let actualPort: Int?
    let selfDigest: String?
  }

  private func observeSync(_ health: Health) {
    syncGeneration = UUID()
    syncTask?.cancel()
    lastSyncPublication = nil
    let generation = syncGeneration
    guard deviceSocketPath != nil, ownedPid == health.pid else { return }
    syncTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.syncGeneration == generation else { return }
        await self.refreshSync(health, generation: generation)
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
      }
    }
  }

  private func refreshSync(_ health: Health, generation: UUID) async {
    let state: SyncState?
    do {
      var request = URLRequest(url: settings.baseURL.appendingPathComponent("v1/sync/status"))
      request.timeoutInterval = 1
      let token = try TokenStore(root: settings.rootURL, environment: [:]).read()
      request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
      let (data, response) = try await URLSession.shared.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw DeviceHostError.unavailable
      }
      state = try JSONDecoder().decode(SyncState.self, from: data)
    } catch { state = nil }
    guard generation == syncGeneration, ownedPid == health.pid else { return }
    var port: Int?
    var digest: String?
    if let state, state.version == 1, state.pid == health.pid,
      state.instance == health.instance, state.binding == health.deviceAccess?.binding,
      state.ready, let actualPort = state.actualPort, (1...65535).contains(actualPort),
      let selfDigest = state.selfDigest,
      selfDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    {
      port = actualPort
      digest = selfDigest
    }
    let key = port.map { "\($0):\(digest ?? "")" } ?? "withdraw"
    guard lastSyncPublication != key || port != nil else { return }
    // No await between the generation check and dispatch; Node orders already-dispatched writes.
    do {
      try await publishSync(port, digest)
      guard generation == syncGeneration, ownedPid == health.pid else { return }
      lastSyncPublication = key
    } catch {
      guard generation == syncGeneration else { return }
      lastSyncPublication = nil
      syncLog.error("endpoint publication unconfirmed")
    }
  }

  private func withdrawSync() async {
    syncGeneration = UUID()
    syncTask?.cancel()
    syncTask = nil
    await dispatchWithdrawal(generation: syncGeneration)
  }

  private func dispatchWithdrawal(generation: UUID) async {
    guard generation == syncGeneration else { return }
    guard let pid = ownedPid, deviceSocketPath != nil else {
      if withdrawal != .unknown { withdrawal = .notOwned }
      return
    }
    // A non-cooperative XPC/Node operation can outlive cancellation: never await that task at the deadline.
    let confirmed = await withCheckedContinuation { continuation in
      var settled = false
      var deadline: Task<Void, Never>?
      Task {
        guard generation == syncGeneration, ownedPid == pid else {
          guard !settled else { return }
          settled = true
          deadline?.cancel()
          continuation.resume(returning: false)
          return
        }
        let result: Bool
        do {
          try await publishSync(nil, nil)
          result = true
        } catch { result = false }
        guard !settled else { return }
        settled = true
        deadline?.cancel()
        continuation.resume(returning: result)
      }
      deadline = Task {
        do { try await Task.sleep(for: .seconds(3)) } catch { return }
        guard !settled else { return }
        settled = true
        continuation.resume(returning: false)
      }
    }
    guard generation == syncGeneration, ownedPid == pid else { return }
    withdrawal = confirmed ? .confirmed : .unknown
    if !confirmed { syncLog.error("endpoint withdrawal unconfirmed at shutdown") }
  }

  private func terminateChild() async {
    stoppingChild = true
    defer { stoppingChild = false }
    let identity = ownedIdentity
    await withdrawSync()
    guard let pid = ownedPid else { return }
    if let process = child, process.isRunning {
      process.terminate()
      for _ in 0..<40 {
        if !process.isRunning { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    } else if let identity, identity.pid == pid, ProcessIdentity.read(pid) == identity {
      kill(pid_t(pid), SIGTERM)
      for _ in 0..<30 {
        if ProcessIdentity.read(pid) != identity { break }
        try? await Task.sleep(for: .milliseconds(100))
      }
      if ProcessIdentity.read(pid) == identity { kill(pid_t(pid), SIGKILL) }
    }
    child = nil
    ownedPid = nil
    ownedIdentity = nil
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
