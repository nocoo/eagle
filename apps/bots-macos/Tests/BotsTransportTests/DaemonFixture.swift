import BotsCore
import BotsTransport
import Foundation

/// A child process whose stdout a test can poll for a start line.
final class Child {
  let process: Process
  private let pipe = Pipe()
  private let lock = NSLock()
  private var buffer = Data()

  init(
    executable: String,
    arguments: [String],
    currentDirectory: URL,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) throws {
    process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = currentDirectory
    process.environment = environment
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      guard let self, !chunk.isEmpty else { return }
      self.lock.lock()
      self.buffer.append(chunk)
      self.lock.unlock()
    }
    try process.run()
  }

  var output: String {
    lock.lock()
    defer { lock.unlock() }
    return String(decoding: buffer, as: UTF8.self)
  }

  /// Waits for one JSON start line carrying `marker` and returns its `port`.
  func waitForPort(marker: String, timeout: TimeInterval = 30) async throws -> Int {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      for line in output.split(separator: "\n") where line.contains("\"\(marker)\"") {
        if let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let port = object["port"] as? Int
        {
          return port
        }
      }
      if !process.isRunning {
        throw ClientError("the child exited before \(marker): \(output)")
      }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw ClientError("\(marker) did not appear within \(Int(timeout)) s: \(output)")
  }

  func terminate() {
    process.terminate()
    pipe.fileHandleForReading.readabilityHandler = nil
  }
}

/// Spawns the real daemon and a stub model endpoint for the client's integration tests.
/// The daemon is the production one (`scripts/serve.ts`) with its real adapter and sqlite
/// storage; only the model network is replaced, exactly like the daemon's own tests.
final class BotsDaemonFixture {
  let root: URL
  let token: String
  let baseURL: URL
  private let daemon: Child
  private let model: Child

  private init(root: URL, token: String, port: Int, daemon: Child, model: Child) {
    self.root = root
    self.token = token
    self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
    self.daemon = daemon
    self.model = model
  }

  static var appsBots: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("bots", isDirectory: true)
  }

  static func start() async throws -> BotsDaemonFixture {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-client-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let model = try Child(
      executable: "/usr/bin/env",
      arguments: [
        "node", "--experimental-strip-types",
        appsBots.appendingPathComponent("scripts/stub-model.ts").path,
      ],
      currentDirectory: appsBots
    )
    let modelPort = try await model.waitForPort(marker: "stub.ready")

    var environment = ProcessInfo.processInfo.environment
    environment["BOTS_BASE_URL"] = "http://127.0.0.1:\(modelPort)/v1"
    environment["BOTS_API_KEY"] = "stub-model-key-0123456789"
    environment["BOTS_MODEL"] = "auto/stub"
    environment["BOTS_MODEL_PROVIDER"] = "stub"

    let daemon = try Child(
      executable: "/usr/bin/env",
      arguments: [
        "node", "--experimental-strip-types",
        appsBots.appendingPathComponent("scripts/serve.ts").path,
        "--root", directory.path,
        "--port", "0",
      ],
      currentDirectory: appsBots,
      environment: environment
    )
    do {
      let port = try await daemon.waitForPort(marker: "daemon.start")
      let token = try String(
        contentsOf: directory.appendingPathComponent("token"),
        encoding: .utf8
      ).trimmingCharacters(in: .whitespacesAndNewlines)
      return BotsDaemonFixture(
        root: directory,
        token: token,
        port: port,
        daemon: daemon,
        model: model
      )
    } catch {
      daemon.terminate()
      model.terminate()
      throw error
    }
  }

  func stop() {
    daemon.terminate()
    model.terminate()
    try? FileManager.default.removeItem(at: root)
  }
}

/// Collects socket events so a test can wait for a predicate instead of sleeping.
actor EventCollector {
  private var events: [ConversationEvent] = []

  func append(_ event: ConversationEvent) {
    events.append(event)
  }

  /// Sixty seconds, not fifteen: these tests start a real Node daemon, and the first socket of a
  /// cold CI runner has taken longer than fifteen to say `ready` while the rest of the package
  /// compiles and runs beside it. The bound still fails a daemon that never answers.
  func waitFor(
    _ predicate: @Sendable (ConversationEvent) -> Bool,
    timeout: TimeInterval = 60
  ) async throws -> ConversationEvent {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let hit = events.first(where: predicate) { return hit }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    let summary = events.map { String(describing: $0) }.joined(separator: "\n")
    throw ClientError("timed out waiting for an event; saw:\n\(summary)")
  }

  func all() -> [ConversationEvent] { events }
}
