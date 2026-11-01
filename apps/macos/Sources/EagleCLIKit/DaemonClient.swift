import Foundation

/// A refusal the person or the calling agent can act on. The exit code is part of the
/// contract (`docs/bots/CLI.md` "Exit codes").
public enum CLIError: Error {
  /// The command line is wrong; nothing was sent.
  case usage(String)
  /// The daemon refused the request.
  case refused(kind: String, message: String)
  /// No credential, a refused credential, or a missing scope.
  case auth(String)
  /// The daemon is unreachable: switch off, App not running, or a wrong port.
  case unreachable(String)

  public var exitCode: Int32 {
    switch self {
    case .usage: 2
    case .refused: 1
    case .auth: 3
    case .unreachable: 4
    }
  }

  public var message: String {
    switch self {
    case .usage(let text), .auth(let text), .unreachable(let text): text
    case .refused(let kind, let message): "\(kind): \(message)"
    }
  }
}

/// One JSON object off the wire; no models, because the CLI only forwards what it read.
public typealias JSONObject = [String: Any]

/// HTTP and the socket in one place, both carrying the same bearer.
public struct DaemonClient: Sendable {
  private let config: CLIConfig
  private let session: URLSession

  public init(config: CLIConfig, session: URLSession = .shared) {
    self.config = config
    self.session = session
  }

  /// `GET` or a mutation; a `204` answers an empty object. Only `health` may travel
  /// without a credential, and it says so.
  public func request(
    _ method: String,
    _ path: String,
    body: JSONObject? = nil,
    requiresAuth: Bool = true
  ) async throws -> JSONObject {
    if requiresAuth, (config.token ?? "").isEmpty {
      throw CLIError.auth(
        "no CLI credential: turn on the App's Settings → CLI switch, or set EAGLE_TOKEN (looked in \(config.configPath))"
      )
    }
    var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.timeoutInterval = 15
    if let token = config.token, !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw CLIError.unreachable(
        "cannot reach the daemon at \(config.baseURL.absoluteString): \(error.localizedDescription)"
      )
    }
    guard let http = response as? HTTPURLResponse else {
      throw CLIError.unreachable("the daemon did not answer HTTP")
    }
    if http.statusCode == 204 { return [:] }
    let object = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject ?? [:]
    guard (200..<300).contains(http.statusCode) else {
      throw Self.failure(status: http.statusCode, object: object)
    }
    return object
  }

  private static func failure(status: Int, object: JSONObject) -> CLIError {
    let error = object["error"] as? JSONObject
    let kind = error?["kind"] as? String ?? "http_\(status)"
    let message = error?["message"] as? String ?? "the daemon refused the request"
    if status == 401 { return .auth(message) }
    if kind == "auth_scope" { return .auth(message) }
    return .refused(kind: kind, message: message)
  }

  /// Opens the one socket this process uses and completes the handshake.
  public func connect(clientName: String) async throws -> SocketSession {
    guard let token = config.token, !token.isEmpty else {
      throw CLIError.auth(
        "no CLI credential: run the App's Settings → CLI switch, or set EAGLE_TOKEN (looked in \(config.configPath))"
      )
    }
    var request = URLRequest(url: config.socketURL)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let task = session.webSocketTask(with: request)
    task.resume()
    let socket = SocketSession(task: task, clientName: clientName)
    do {
      try await socket.handshake()
    } catch {
      socket.close()
      throw error
    }
    return socket
  }
}

/// One conversation connection: `hello`, `subscribe`, then the frames the daemon sends.
/// Not an actor: the CLI reads one frame at a time from one task, which is the whole
/// contract, so the unchecked conformance only states that no two readers share it.
public final class SocketSession: @unchecked Sendable {
  private let task: URLSessionWebSocketTask
  private let clientName: String

  init(task: URLSessionWebSocketTask, clientName: String) {
    self.task = task
    self.clientName = clientName
  }

  func handshake() async throws {
    try await write(["type": "hello", "protocolVersion": 1, "client": clientName])
    let frame = try await read()
    switch frame["type"] as? String {
    case "welcome":
      return
    case "error":
      let kind = frame["kind"] as? String ?? "handshake"
      throw kind == "version_mismatch"
        ? CLIError.refused(kind: kind, message: "this CLI speaks protocol v1")
        : CLIError.refused(kind: kind, message: frame["message"] as? String ?? "handshake refused")
    default:
      throw CLIError.refused(kind: "handshake", message: "the daemon did not welcome the client")
    }
  }

  public func subscribe(botId: String) async throws -> JSONObject {
    try await write(["type": "subscribe", "botId": botId, "trace": Self.trace()])
    while true {
      let frame = try await read()
      if frame["type"] as? String == "snapshot" { return frame }
      if frame["type"] as? String == "error" { throw Self.error(from: frame) }
    }
  }

  public func send(text: String, requestId: String, whenBusy: String = "followUp") async throws {
    try await write([
      "type": "send", "requestId": requestId, "text": text, "whenBusy": whenBusy,
      "trace": Self.trace(),
    ])
  }

  public func abort() async throws {
    try await write(["type": "abort", "trace": Self.trace()])
  }

  public func history(before: String?, limit: Int) async throws -> JSONObject {
    var command: JSONObject = ["type": "history", "limit": limit, "trace": Self.trace()]
    if let before { command["before"] = before }
    try await write(command)
    while true {
      let frame = try await read()
      if frame["type"] as? String == "history" { return frame }
      if frame["type"] as? String == "error" { throw Self.error(from: frame) }
    }
  }

  public func read() async throws -> JSONObject {
    let message: URLSessionWebSocketTask.Message
    do {
      message = try await task.receive()
    } catch {
      throw CLIError.unreachable("the daemon closed the connection: \(error.localizedDescription)")
    }
    let data: Data
    switch message {
    case .string(let text): data = Data(text.utf8)
    case .data(let raw): data = raw
    @unknown default: throw CLIError.refused(kind: "transport", message: "unsupported frame")
    }
    guard let frame = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject else {
      throw CLIError.refused(
        kind: "transport", message: "the daemon sent a frame the CLI cannot read")
    }
    if frame["type"] as? String == "error" { throw Self.error(from: frame) }
    return frame
  }

  public nonisolated func close() {
    task.cancel(with: .goingAway, reason: nil)
  }

  private func write(_ frame: JSONObject) async throws {
    let data = try JSONSerialization.data(withJSONObject: frame)
    do {
      try await task.send(.string(String(decoding: data, as: UTF8.self)))
    } catch {
      throw CLIError.unreachable("the daemon is not answering: \(error.localizedDescription)")
    }
  }

  private static func error(from frame: JSONObject) -> CLIError {
    let kind = frame["kind"] as? String ?? "invalid_command"
    let message = frame["message"] as? String ?? "the daemon refused the command"
    if kind == "auth_scope" || kind == "auth_failed" { return .auth(message) }
    return .refused(kind: kind, message: message)
  }

  private static func trace() -> String {
    "tr_cli_" + UUID().uuidString.prefix(8).lowercased()
  }
}
