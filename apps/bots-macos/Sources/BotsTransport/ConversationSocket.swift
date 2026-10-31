import BotsCore
import Foundation

/// The resync state machine (PROTOCOL I2): one resync per gap, a ten-second deadline that
/// either sends a second resync or reconnects, and a snapshot that always wins — it opens
/// the barrier and resets the count, and a deadline that fires afterwards must not close
/// the barrier again.
public struct ResyncState: Sendable {
  public enum Action: Equatable, Sendable {
    case none
    case resend
    case reconnect
  }

  public private(set) var pending = false
  public private(set) var attempts = 0

  public init() {}

  /// Starts waiting; false when a wait is already in place (the frame that noticed the gap
  /// does not get a second request).
  public mutating func begin() -> Bool {
    guard !pending else { return false }
    pending = true
    return true
  }

  /// A snapshot repairs the stream: the barrier opens and the count resets.
  public mutating func snapshotArrived() {
    pending = false
    attempts = 0
  }

  /// The deadline fired. When a snapshot already opened the barrier this is a no-op.
  public mutating func deadlineFired() -> Action {
    guard pending else { return .none }
    attempts += 1
    if attempts >= 2 {
      pending = false
      return .reconnect
    }
    return .resend
  }
}

/// One bot's WebSocket (docs/bots/PROTOCOL.md, "Transport" and "Handshake"). It owns the
/// frame codec's use, the revision baseline, the gap rule, liveness and the close codes;
/// everything it observes becomes a `ConversationEvent`.
public final class ConversationSocket: NSObject {
  public let botId: String
  public let contextId: String?
  public let events: AsyncStream<ConversationEvent>

  private let url: URL
  private let token: String
  private let continuation: AsyncStream<ConversationEvent>.Continuation
  private let lock = NSLock()
  private let configuration: URLSessionConfiguration
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var pingTask: Task<Void, Never>?
  private var writeQueue: [Data] = []
  private var writing = false
  private var closed = false
  private var handshakeDone = false
  private var attempt = 0
  /// Whether this socket ever completed a handshake: a first connection that never did
  /// means the daemon is not running, which is a prompt, not something to retry blindly.
  private var everReady = false
  /// One per connection; the heartbeat task ends when its connection does.
  private var generation = 0
  private var gap = RevisionGap()
  private var resync = ResyncState()
  private var resyncDeadline: Task<Void, Never>?

  public init(
    baseURL: URL,
    token: String,
    botId: String,
    contextId: String? = nil,
    configuration: URLSessionConfiguration = .default
  ) {
    self.botId = botId
    self.contextId = contextId
    self.token = token
    self.url = baseURL.appendingPathComponent("/v1/socket")
    self.configuration = configuration
    var captured: AsyncStream<ConversationEvent>.Continuation!
    self.events = AsyncStream { continuation in
      captured = continuation
    }
    self.continuation = captured
    super.init()
  }

  /// Opens the socket, says hello, and subscribes. Safe to call once.
  public func start() {
    lock.lock()
    guard session == nil, !closed else {
      lock.unlock()
      return
    }
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    lock.unlock()
    emit(.connection(.connecting))
    openTask(in: session)
  }

  /// True between the welcome and the close.
  public var isReady: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !closed && handshakeDone
  }

  public func close() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    resyncDeadline?.cancel()
    resyncDeadline = nil
    pingTask?.cancel()
    pingTask = nil
    receiveTask?.cancel()
    receiveTask = nil
    let task = self.task
    self.task = nil
    lock.unlock()
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    continuation.yield(.connection(.stopped))
    continuation.finish()
  }

  // MARK: - Commands

  public func send(
    text: String, requestId: String, whenBusy: BusyMode, resourceHead: String? = nil, trace: String
  ) throws {
    enqueue(
      try Wire.send(
        requestId: requestId, text: text, whenBusy: whenBusy, contextId: contextId,
        resourceHead: resourceHead, trace: trace))
  }

  public func abort(trace: String) throws {
    enqueue(try Wire.abort(trace: trace))
  }

  public func recover(trace: String) throws {
    enqueue(try Wire.recover(trace: trace))
  }

  public func resync(trace: String) throws {
    enqueue(try Wire.resync(trace: trace))
  }

  public func loadHistory(before: String, limit: Int, trace: String) throws {
    enqueue(try Wire.history(before: before, limit: limit, trace: trace))
  }

  // MARK: - Connection

  private func openTask(in session: URLSession) {
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let task = session.webSocketTask(with: request)
    lock.lock()
    self.task = task
    generation += 1
    handshakeDone = false
    self.gap = RevisionGap()
    lock.unlock()
    task.resume()
    receiveLoop(task)
    enqueue(try? Wire.hello())
    startPing(in: session)
  }

  private func startPing(in session: URLSession) {
    lock.lock()
    pingTask?.cancel()
    let generation = self.generation
    lock.unlock()
    pingTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 15_000_000_000)
        guard let self else { return }
        self.lock.lock()
        // The welcome resets `attempt`, but not the connection: the heartbeat follows the
        // generation it was started for.
        let stillCurrent = !self.closed && self.generation == generation
        let ready = self.handshakeDone
        self.lock.unlock()
        if !stillCurrent { return }
        if ready { self.enqueue(try? Wire.ping()) }
      }
      _ = session
    }
  }

  private func receiveLoop(_ task: URLSessionWebSocketTask) {
    receiveTask?.cancel()
    receiveTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        do {
          let message = try await task.receive()
          guard case .string(let text) = message else {
            self.disconnect(reason: "the daemon sent a binary frame", code: 1008)
            return
          }
          self.handle(text)
        } catch {
          self.disconnect(reason: "the connection ended", code: 1006)
          return
        }
      }
    }
  }

  private func handle(_ text: String) {
    guard let data = text.data(using: .utf8) else { return }
    let decoded: Wire.Decoded
    do {
      decoded = try Wire.decode(data)
    } catch {
      disconnect(reason: "the daemon sent a frame this client cannot read", code: 1008)
      return
    }
    if decoded.type == "welcome" {
      lock.lock()
      handshakeDone = true
      everReady = true
      attempt = 0
      gap.reset(to: nil)
      lock.unlock()
      if let catalog = decoded.catalog {
        continuation.yield(.catalog(catalog))
      }
      continuation.yield(.connection(.ready))
      enqueue(
        try? Wire.subscribe(botId: botId, contextId: contextId, trace: Identifiers.trace("sub")))
      return
    }
    if let rev = decoded.rev {
      var accept = false
      var gapped = false
      lock.lock()
      if case .snapshot? = decoded.event {
        self.gap.reset(to: rev)
        self.resync.snapshotArrived()
        resyncDeadline?.cancel()
        resyncDeadline = nil
        accept = true
      } else if self.resync.pending {
        // Waiting for the snapshot that repairs a gap: nothing else is applied.
        accept = false
      } else if self.gap.isStale(rev) {
        accept = false
      } else if self.gap.accept(rev) {
        accept = true
      } else {
        gapped = true
        accept = false
      }
      lock.unlock()
      if gapped {
        requestResync()
        return
      }
      guard accept else { return }
    }
    if let catalog = decoded.catalog, decoded.type == "bots" {
      continuation.yield(.catalog(catalog))
    }
    if let event = decoded.event {
      continuation.yield(event)
    }
  }

  /// One resync per gap; a second failure without a snapshot reconnects (PROTOCOL I2).
  /// One resync per gap; only the ten-second deadline advances the retry count, so a stream
  /// that keeps sending gapped frames cannot exhaust the attempts.
  private func requestResync() {
    lock.lock()
    if closed || !resync.begin() {
      lock.unlock()
      return
    }
    lock.unlock()
    enqueue(try? Wire.resync(trace: Identifiers.trace("resync")))
    armResyncDeadline()
  }

  /// After the deadline: one more resync, then a reconnect; never a third silent wait.
  /// A snapshot that arrived in the meantime has already opened the barrier, so this task
  /// neither counts it nor closes the barrier again.
  private func armResyncDeadline() {
    resyncDeadline?.cancel()
    resyncDeadline = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      guard let self, !Task.isCancelled else { return }
      self.lock.lock()
      guard !self.closed else {
        self.lock.unlock()
        return
      }
      let action = self.resync.deadlineFired()
      let stillWaiting = self.resync.pending && !self.closed
      self.lock.unlock()
      switch action {
      case .none:
        return
      case .reconnect:
        self.disconnect(reason: "the stream kept losing revisions", code: 1011)
      case .resend:
        self.enqueue(try? Wire.resync(trace: Identifiers.trace("resync")))
        // A snapshot that arrived meanwhile has opened the barrier: do not re-arm.
        if stillWaiting { self.armResyncDeadline() }
      }
    }
  }

  private func disconnect(reason: String, code: Int) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    let previous = task
    task = nil
    handshakeDone = false
    resync.snapshotArrived()
    resyncDeadline?.cancel()
    resyncDeadline = nil
    lock.unlock()
    previous?.cancel(with: .abnormalClosure, reason: nil)
    switch Self.behaviour(code: code, everReady: everReady) {
    case .stop(let message):
      fail(message)
    case .retry:
      scheduleReconnect()
    }
  }

  /// A first connection that never reached `welcome` means nothing is listening: ask the
  /// person to start the daemon instead of reconnecting every few seconds. A connection
  /// that dropped after a session keeps the contract's retry.
  public static func behaviour(code: Int, everReady: Bool) -> CloseBehaviour {
    if code == 1006 && !everReady { return .stop(daemonDownMessage) }
    return closeBehaviour(code)
  }

  public static let daemonDownMessage = "Bots daemon 未启动。到「设置 → Bots」启动后重试。"

  /// Close codes are the contract's reconnection policy (PROTOCOL.md, "Close codes").
  public enum CloseBehaviour: Equatable, Sendable {
    case stop(String)
    case retry
  }

  public static func closeBehaviour(_ code: Int) -> CloseBehaviour {
    switch code {
    case 1008: return .stop("the daemon refused the protocol exchange")
    case 4001: return .stop("the daemon rejected the token")
    case 4004: return .stop("this bot no longer exists")
    case 4009: return .stop("the daemon speaks another protocol version")
    // A quarantined bot is retried: it leaves quarantine when its close finishes, and
    // `recover` can only travel over a live socket.
    case 4090: return .retry
    case 1000: return .stop("the connection was closed")
    default: return .retry
    }
  }

  private func closeBehaviour(_ code: Int) -> CloseBehaviour {
    ConversationSocket.closeBehaviour(code)
  }

  private func scheduleReconnect() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    attempt += 1
    let current = attempt
    let session = self.session
    lock.unlock()
    continuation.yield(.connection(.reconnecting(attempt: current)))
    guard let session else { return }
    let delay = min(5.0, 0.4 * pow(2.0, Double(current - 1)))
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard let self else { return }
      self.lock.lock()
      let reconnect = !self.closed && self.attempt == current
      self.lock.unlock()
      if reconnect { self.openTask(in: session) }
    }
  }

  private func fail(_ reason: String) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    resyncDeadline?.cancel()
    pingTask?.cancel()
    pingTask = nil
    receiveTask?.cancel()
    receiveTask = nil
    let task = self.task
    self.task = nil
    lock.unlock()
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    continuation.yield(.connection(.failed(reason: reason)))
    continuation.finish()
  }

  private func emit(_ event: ConversationEvent) {
    continuation.yield(event)
  }

  // MARK: - Writes

  private func enqueue(_ data: Data?) {
    guard let data else { return }
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    writeQueue.append(data)
    let shouldStart = !writing
    writing = true
    lock.unlock()
    if shouldStart { Task { await drain() } }
  }

  private func drain() async {
    while true {
      lock.lock()
      if writeQueue.isEmpty {
        writing = false
        lock.unlock()
        return
      }
      let next = writeQueue.removeFirst()
      let task = self.task
      lock.unlock()
      guard let task else { continue }
      do {
        try await task.send(.string(String(decoding: next, as: UTF8.self)))
      } catch {
        // Release the writer *and* drop the queue it belonged to: those frames were for a
        // connection that is gone, and the next one must start with `hello`.
        lock.lock()
        writing = false
        writeQueue.removeAll()
        lock.unlock()
        disconnect(reason: "the write failed", code: 1006)
        return
      }
    }
  }
}

extension ConversationSocket: URLSessionWebSocketDelegate {
  public func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    disconnect(reason: "the daemon closed the connection", code: closeCode.rawValue)
  }

  public func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    lock.lock()
    let current = !closed && handshakeDone == false
    lock.unlock()
    if current { emit(.connection(.connecting)) }
  }
}

/// The `ConversationPort` implementation the view models use: one socket per selected bot.
public final class BotsConnection: ConversationPort {
  private let baseURL: URL
  private let token: String
  private var socket: ConversationSocket?

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  public func open(botId: String, contextId: String? = nil) -> AsyncStream<ConversationEvent> {
    socket?.close()
    let created = ConversationSocket(
      baseURL: baseURL, token: token, botId: botId, contextId: contextId)
    socket = created
    created.start()
    return created.events
  }

  public func send(
    _ text: String,
    whenBusy: BusyMode,
    context: CommandContext,
    botId: String
  ) async throws {
    guard let requestId = context.requestId else {
      throw ClientError("the send has no request id")
    }
    let socket = try require(botId, contextId: context.contextId)
    try socket.send(
      text: text,
      requestId: requestId,
      whenBusy: whenBusy,
      resourceHead: context.resourceHead,
      trace: context.trace
    )
  }

  public func abort(context: CommandContext, botId: String) async throws {
    try require(botId, contextId: context.contextId).abort(trace: context.trace)
  }

  public func recover(context: CommandContext, botId: String) async throws {
    try require(botId, contextId: context.contextId).recover(trace: context.trace)
  }

  public func resync(context: CommandContext, botId: String) async throws {
    try require(botId, contextId: context.contextId).resync(trace: context.trace)
  }

  public func loadHistory(before messageId: String, context: CommandContext, botId: String)
    async throws
  {
    try require(botId, contextId: context.contextId).loadHistory(
      before: messageId, limit: 50, trace: context.trace)
  }

  public func close() {
    socket?.close()
    socket = nil
  }

  private func require(_ botId: String, contextId: String?) throws -> ConversationSocket {
    guard let socket else { throw ClientError("there is no connection") }
    guard socket.botId == botId && socket.contextId == contextId else {
      throw ClientError("the connection now belongs to another bot")
    }
    // Between the close and the new handshake the socket cannot carry a command; a
    // dropped frame would look like a successful request to the view model.
    guard socket.isReady else { throw ClientError("the connection is not ready yet") }
    return socket
  }

}
