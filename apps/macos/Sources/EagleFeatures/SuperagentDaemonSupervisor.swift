import Combine
import Foundation
import SuperagentCore
import SuperagentTransport

/// Owns the independent Superagent process. It never touches the worker daemon: its own root,
/// its own credential, its own readiness and only the child it launched.
@MainActor
public final class SuperagentDaemonSupervisor: ObservableObject {
  public static let shared = SuperagentDaemonSupervisor()
  public enum Status: Equatable {
    case stopped
    case starting
    case running(instance: String, pid: Int, external: Bool)
    case failed(String)
  }

  @Published public private(set) var status: Status = .stopped
  public let endpoint: SuperagentEndpoint?
  public let endpointError: String?
  private let release: Bool
  private let environment: [String: String]
  /// The worker service this Super Bot may observe: its own build's daemon, never the other's.
  private let bots: BotsSettings
  private let bundledNode: String?
  private var child: Process?
  private var starting: Task<Void, Never>?
  /// Quit during a start must not leave a freshly spawned child behind.
  private var stopping = false
  private static let stopBudget: Duration = .seconds(8)

  public init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    bundle: URL = Bundle.main.bundleURL,
    release: Bool? = nil,
    bots: BotsSettings = BotsSettings()
  ) {
    self.environment = environment
    self.bots = bots
    let packaged = bundle.pathExtension == "app"
    self.release = release ?? packaged
    if packaged {
      let node = bundle.appendingPathComponent("Contents/Resources/DeviceRuntime/node")
      bundledNode = FileManager.default.isExecutableFile(atPath: node.path) ? node.path : nil
    } else {
      bundledNode = nil
    }
    do {
      endpoint = try SuperagentEndpoint.resolve(
        environment: environment, home: environment["HOME"],
        release: release ?? packaged)
      endpointError = nil
    } catch {
      endpoint = nil
      endpointError = "Super Bot 服务地址配置无效。"
    }
  }

  public func startIfNeeded() async {
    if stopping { return }
    if case .running = status, child?.isRunning != false {
      return
    }
    if case .running = status {
      status = .failed("Super Bot 进程已退出。")
    }
    if let starting { return await starting.value }
    let work = Task { await self.start() }
    starting = work
    await work.value
    starting = nil
  }

  private func start() async {
    guard let endpoint else {
      status = .failed(endpointError ?? "Super Bot 服务地址配置无效。")
      return
    }
    status = .starting
    if let health = await probe(endpoint) {
      adopt(health)
      return
    }
    guard !release || bundledNode != nil else {
      status = .failed("内置 Super Bot 运行环境不完整，请重新安装 Eagle。")
      return
    }
    guard let directory = Self.daemonDirectory(environment: environment) else {
      status = .failed("找不到 Super Bot 服务目录。")
      return
    }
    let node = bundledNode ?? environment["PATH"].map { _ in "/usr/bin/env" } ?? "/usr/bin/env"
    let process = Process()
    if bundledNode != nil {
      process.executableURL = URL(fileURLWithPath: node)
      process.arguments = [
        "scripts/serve.ts", "--root", endpoint.root.path, "--port", String(endpoint.port),
      ]
    } else {
      process.executableURL = URL(fileURLWithPath: node)
      process.arguments = [
        "node", "scripts/serve.ts", "--root", endpoint.root.path, "--port", String(endpoint.port),
      ]
    }
    process.currentDirectoryURL = directory
    process.environment = Self.childEnvironment(environment, release: release, bots: bots)
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    output.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
    do { try process.run() } catch {
      status = .failed("Super Bot 服务启动失败。")
      return
    }
    child = process
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      try? await Task.sleep(for: .milliseconds(150))
      guard process.isRunning else { break }
      if stopping {
        await terminateOwned()
        status = .stopped
        return
      }
      if let health = await probe(endpoint), health.pid == Int(process.processIdentifier) {
        status = .running(instance: health.instance, pid: health.pid, external: false)
        return
      }
    }
    await terminateOwned()
    status = .failed("Super Bot 服务没有在 10 秒内就绪。")
  }

  /// The App's own child only: an externally started service is never signalled.
  public func stopOwned() async {
    stopping = true
    if let starting { await starting.value }
    defer { stopping = false }
    guard let child, child.isRunning else {
      if case .running(_, let pid, false) = status {
        status = .failed("Super Bot 进程已退出（pid \(pid)）。")
      }
      return
    }
    await terminateOwned()
    status = .stopped
  }

  public func restart() async {
    await stopOwned()
    status = .stopped
    await startIfNeeded()
  }

  public static func terminateRecordedIfOwned() {
    // Ownership lives in the running App: no persisted PID alone may authorize a signal.
  }

  private func terminateOwned() async {
    guard let process = child else { return }
    child = nil
    if process.isRunning { process.terminate() }
    let deadline = Date().addingTimeInterval(8)
    while process.isRunning, Date() < deadline {
      try? await Task.sleep(for: .milliseconds(100))
    }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    process.waitUntilExit()
  }

  private func probe(_ endpoint: SuperagentEndpoint) async -> ServiceHealth? {
    let service = SuperagentClient(endpoint: endpoint)
    guard let health = try? await service.health() else { return nil }
    guard health.service == "eagle-superagent", health.protocolVersion == 1 else { return nil }
    return health
  }

  private func adopt(_ health: ServiceHealth) {
    if let child, child.processIdentifier == pid_t(health.pid) {
      status = .running(instance: health.instance, pid: health.pid, external: false)
    } else {
      status = .running(instance: health.instance, pid: health.pid, external: true)
    }
  }

  public static func daemonDirectory(
    environment: [String: String], bundle: URL = Bundle.main.bundleURL
  ) -> URL? {
    if let explicit = environment["SUPERAGENT_DAEMON_DIR"], !explicit.isEmpty {
      let url = URL(fileURLWithPath: explicit, isDirectory: true)
      return FileManager.default.fileExists(
        atPath: url.appendingPathComponent("scripts/serve.ts").path) ? url : nil
    }
    // A shipped App carries its own copy beside the bundled Node and Bots; it never reads a
    // checkout under the installer's home directory.
    if bundle.pathExtension == "app" {
      let runtime = bundle.appendingPathComponent(
        "Contents/Resources/DeviceRuntime/superagent", isDirectory: true)
      return FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent("scripts/serve.ts").path) ? runtime : nil
    }
    var ancestor = bundle.deletingLastPathComponent()
    for _ in 0..<10 {
      let candidate = ancestor.appendingPathComponent("apps/superagent", isDirectory: true)
      if FileManager.default.fileExists(
        atPath: candidate.appendingPathComponent("scripts/serve.ts").path)
      {
        return candidate
      }
      ancestor = ancestor.deletingLastPathComponent()
    }
    return nil
  }

  nonisolated static func childEnvironment(
    _ environment: [String: String], release: Bool, bots: BotsSettings
  ) -> [String: String] {
    var child =
      release
      ? [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(),
      ] : environment
    child.removeValue(forKey: "BOTS_DEV_AGENT_TOKEN")
    child.removeValue(forKey: "BOTS_DEVICE_SOCKET")
    // Observation reads the daemon this build owns. Without this the service would fall back
    // to the released App's port and credential, so a source run would observe — and report on
    // — the daily Bots it must not touch.
    child["BOTS_OBSERVATION_ENDPOINT"] = "http://127.0.0.1:\(bots.port)"
    child["BOTS_OBSERVATION_TOKEN_FILE"] =
      bots.rootURL.appendingPathComponent("observation/token").path
    return child
  }
}
