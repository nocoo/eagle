import Foundation
import SuperagentCore

private final class RedirectRefuser: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private struct Command: Encodable, Sendable {
  var type: String
  var id: String?
  var nonce: String?
  var proof: String?
  var configuration: ConfigurationChange?
  var requestId: String?
  var text: String?
  var before: Int?
  var limit: Int?
}
private struct Header: Decodable {
  var type: String
  var id: String?
  var code: String?
}
private struct Challenge: Decodable {
  var type: String
  var identity: ServiceIdentity
  var serverNonce: String
  var proof: String
}
private struct Reply<Value: Decodable>: Decodable { var value: Value }
private struct Stopped: Decodable, Sendable { var stopped: Bool }

public actor SuperagentClient: SuperagentServicePort {
  public let endpoint: SuperagentEndpoint
  private let session: URLSession
  private var socket: URLSessionWebSocketTask?
  private var opening: Task<Void, Error>?
  private var reader: Task<Void, Never>?
  private var writer: Task<Void, Error>?
  private var connected = false
  private var generation = 0
  private var identity: ServiceIdentity?
  private var latest: SnapshotFrame?
  private struct Pending {
    var continuation: CheckedContinuation<Data, Error>
    var timer: Task<Void, Never>
  }
  private var pending: [String: Pending] = [:]
  private var streams: [UUID: AsyncThrowingStream<SnapshotFrame, Error>.Continuation] = [:]

  public init(endpoint: SuperagentEndpoint) {
    self.endpoint = endpoint
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 10
    session = URLSession(
      configuration: configuration, delegate: RedirectRefuser(), delegateQueue: nil)
  }

  deinit { session.invalidateAndCancel() }

  public func health() async throws -> ServiceHealth {
    let token = try SuperagentCredentials.read(endpoint)
    let nonce = IdentityProof.nonce()
    var request = URLRequest(url: endpoint.healthURL)
    request.timeoutInterval = 2
    request.setValue(nonce, forHTTPHeaderField: "X-Eagle-Challenge")
    do {
      let (data, response) = try await session.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 16_384 else {
        throw SuperagentError.unavailable
      }
      struct Proof: Decodable { var proof: String }
      let proof = try JSONDecoder().decode(Proof.self, from: data).proof
      let health = try JSONDecoder().decode(ServiceHealth.self, from: data)
      let binding = try IdentityProof.rootBinding(endpoint.root)
      guard health.service == "eagle-superagent", health.protocolVersion == 1,
        health.rootBinding == binding,
        proof
          == IdentityProof.health(
            token: token, clientNonce: nonce, endpoint: endpoint.address,
            rootBinding: binding, instance: health.instance)
      else { throw SuperagentError.identity }
      return health
    } catch let error as SuperagentError { throw error } catch { throw SuperagentError.unavailable }
  }

  public func events() async throws -> AsyncThrowingStream<SnapshotFrame, Error> {
    try await ensureConnected()
    let id = UUID()
    return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      streams[id] = continuation
      if let latest { continuation.yield(latest) }
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeStream(id) }
      }
    }
  }

  public func state() async throws -> SnapshotFrame {
    try await request(Command(type: "state"), as: SnapshotFrame.self)
  }
  public func configure(_ value: ConfigurationChange) async throws -> ModelConfiguration {
    try await request(Command(type: "configure", configuration: value), as: ModelConfiguration.self)
  }
  public func submit(_ input: PendingInput) async throws -> ChatAdmission {
    try await request(
      Command(type: "send", requestId: input.id, text: input.text), as: ChatAdmission.self)
  }
  public func submission(_ requestId: String) async throws -> ChatAdmission? {
    try await request(Command(type: "submission", requestId: requestId), as: ChatAdmission?.self)
  }
  public func history(before: Int?, limit: Int) async throws -> HistoryPage {
    try await request(Command(type: "history", before: before, limit: limit), as: HistoryPage.self)
  }
  public func abort() async throws {
    let result = try await request(Command(type: "abort"), as: Stopped.self)
    guard result.stopped else { throw SuperagentError.service(.cancellationUnconfirmed) }
  }
  public func close() async {
    generation += 1
    opening?.cancel()
    opening = nil
    disconnect(SuperagentError.cancelled)
  }

  private func ensureConnected() async throws {
    if connected { return }
    if let opening { return try await opening.value }
    generation += 1
    let current = generation
    let work = Task { try await connect(current) }
    opening = work
    do {
      try await work.value
      if generation == current { opening = nil }
    } catch {
      if generation == current {
        opening = nil
        disconnect(error)
      }
      throw error as? SuperagentError ?? .unavailable
    }
  }

  private func connect(_ current: Int) async throws {
    let token = try SuperagentCredentials.read(endpoint)
    let candidate = session.webSocketTask(with: endpoint.socketURL)
    candidate.maximumMessageSize = 256 * 1024
    socket = candidate
    candidate.resume()
    let watchdog = Task {
      do { try await Task.sleep(for: .seconds(5)) } catch { return }
      candidate.cancel(with: .goingAway, reason: nil)
    }
    defer { watchdog.cancel() }
    let nonce = IdentityProof.nonce()
    try await send(Command(type: "hello", nonce: nonce), on: candidate)
    let challenge = try JSONDecoder().decode(Challenge.self, from: await receive(candidate))
    let value = challenge.identity
    guard current == generation, challenge.type == "challenge",
      value.service == "eagle-superagent", value.protocolVersion == 1,
      UUID(uuidString: value.instance) != nil, UUID(uuidString: value.storeId) != nil,
      value.rootBinding == (try IdentityProof.rootBinding(endpoint.root)),
      IdentityProof.validHex(challenge.serverNonce, length: 32),
      challenge.proof
        == IdentityProof.server(
          token: token, clientNonce: nonce,
          serverNonce: challenge.serverNonce, endpoint: endpoint.address,
          rootBinding: value.rootBinding, instance: value.instance)
    else { throw SuperagentError.identity }
    try await send(
      Command(
        type: "authenticate",
        proof: IdentityProof.client(
          token: token,
          clientNonce: nonce, serverNonce: challenge.serverNonce, instance: value.instance)),
      on: candidate)
    let ready = try JSONDecoder().decode(Header.self, from: await receive(candidate))
    guard current == generation, ready.type == "ready" else { throw SuperagentError.credential }
    identity = value
    connected = true
    reader = Task { await readLoop(candidate, generation: current) }
  }

  private func readLoop(_ candidate: URLSessionWebSocketTask, generation current: Int) async {
    do {
      while !Task.isCancelled, generation == current {
        let data = try await receive(candidate)
        guard generation == current else { return }
        let header = try JSONDecoder().decode(Header.self, from: data)
        switch header.type {
        case "snapshot":
          let frame = try JSONDecoder().decode(SnapshotFrame.self, from: data)
          guard frame.instance == identity?.instance, frame.value.botId == "superagent",
            frame.rev >= 0
          else {
            throw SuperagentError.protocolViolation
          }
          if let latest, frame.rev <= latest.rev { continue }
          latest = frame
          for continuation in streams.values { continuation.yield(frame) }
        case "result", "error":
          guard let id = header.id, let item = pending.removeValue(forKey: id) else { continue }
          item.timer.cancel()
          if header.type == "error" {
            item.continuation.resume(
              throwing: SuperagentError.service(
                ServiceCode(rawValue: header.code ?? "") ?? .internal))
          } else {
            item.continuation.resume(returning: data)
          }
        default: throw SuperagentError.protocolViolation
        }
      }
    } catch {
      if generation == current { disconnect(error as? SuperagentError ?? .unavailable) }
    }
  }

  private func request<Value: Decodable & Sendable>(_ input: Command, as type: Value.Type)
    async throws -> Value
  {
    try await ensureConnected()
    guard let socket, connected, pending.count < 32 else { throw SuperagentError.unavailable }
    let current = generation
    var input = input
    let id = "cmd_" + IdentityProof.nonce()
    input.id = id
    let encoded = try JSONEncoder().encode(input)
    guard encoded.count <= 256 * 1024 else { throw SuperagentError.service(.limitExceeded) }
    let response: Data = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let timer = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(10)) } catch { return }
          await self?.expire(id)
        }
        pending[id] = Pending(continuation: continuation, timer: timer)
        let previous = writer
        let next = Task {
          do {
            try await previous?.value
            guard current == generation, connected else { throw SuperagentError.cancelled }
            try await socket.send(.string(String(decoding: encoded, as: UTF8.self)))
          } catch {
            fail(id, error: error as? SuperagentError ?? .unavailable)
            throw error
          }
        }
        writer = next
      }
    } onCancel: {
      Task { await self.cancel(id) }
    }
    do { return try JSONDecoder().decode(Reply<Value>.self, from: response).value } catch {
      throw SuperagentError.protocolViolation
    }
  }

  private func send(_ value: Command, on socket: URLSessionWebSocketTask) async throws {
    let data = try JSONEncoder().encode(value)
    try await socket.send(.string(String(decoding: data, as: UTF8.self)))
  }
  private func receive(_ socket: URLSessionWebSocketTask) async throws -> Data {
    let message = try await socket.receive()
    guard case .string(let text) = message, text.utf8.count <= 256 * 1024 else {
      throw SuperagentError.protocolViolation
    }
    return Data(text.utf8)
  }
  private func removeStream(_ id: UUID) { streams.removeValue(forKey: id) }
  private func expire(_ id: String) { fail(id, error: .timeout) }
  private func cancel(_ id: String) { fail(id, error: .cancelled) }
  private func fail(_ id: String, error: SuperagentError) {
    guard let item = pending.removeValue(forKey: id) else { return }
    item.timer.cancel()
    item.continuation.resume(throwing: error)
  }
  private func disconnect(_ error: Error) {
    connected = false
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    reader?.cancel()
    reader = nil
    writer?.cancel()
    writer = nil
    identity = nil
    latest = nil
    let waiting = pending
    pending.removeAll()
    for item in waiting.values {
      item.timer.cancel()
      item.continuation.resume(throwing: error)
    }
    let observers = streams
    streams.removeAll()
    for item in observers.values { item.finish(throwing: error) }
  }
}
