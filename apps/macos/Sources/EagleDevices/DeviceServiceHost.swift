import Foundation

/// Lives in the independent login helper, which owns the private Node pipes and file-vault identity.
@MainActor
public final class DeviceServiceHost {
  public private(set) var localReady = false
  public private(set) var cloudStatus = "offline"
  public private(set) var failure: String?
  public let identity: DeviceIdentity
  public let configuration: DeviceHostConfiguration
  public let stateDirectory: URL
  public var socketPath: String { stateDirectory.appendingPathComponent("access.sock").path }
  public var approver: (@MainActor @Sendable (DeviceApprovalRequest) async -> Bool)?
  private var approverOwner: UUID?
  public func attachApprover(
    owner: UUID, action: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) {
    approverOwner = owner
    approver = action
  }
  public func detachApprover(owner: UUID) {
    if approverOwner == owner {
      approver = nil
      approverOwner = nil
    }
  }

  private let node: URL
  private let entry: URL
  private var child: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var buffer = Data()
  private var generation = UUID()
  private var pending: [String: CheckedContinuation<DeviceJSON, any Error>] = [:]
  private var timeouts: [String: Task<Void, Never>] = [:]
  private var approvalId: String?
  private var approvalTimeout: Task<Void, Never>?
  private var remoteOrigin: String
  private var remoteGeneration = UUID()
  private var configuringRemote = false
  private var stopping: Task<Void, Never>?
  private var retrying: Task<Void, any Error>?
  var statusReader: @MainActor (String) async throws -> DeviceJSON = { path in
    try await DeviceLocalPort(path: path).call("status")
  }

  public init(
    identity: DeviceIdentity, configuration: DeviceHostConfiguration,
    node: URL, entry: URL, stateDirectory: URL? = nil
  ) {
    self.identity = identity
    self.configuration = configuration
    self.remoteOrigin = configuration.serviceOrigin
    self.node = node
    self.entry = entry
    self.stateDirectory = stateDirectory ?? configuration.stateDirectory
  }

  public func start() throws {
    guard stopping == nil else { throw DeviceHostError.unavailable }
    if child?.isRunning == true { return }
    try configuration.validate()
    guard FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.fileExists(atPath: entry.path)
    else { throw DeviceHostError.unavailable }
    localReady = false
    cloudStatus = "offline"
    failure = nil
    buffer.removeAll(keepingCapacity: false)
    let current = UUID()
    generation = current
    remoteGeneration = UUID()
    let process = Process()
    let incoming = Pipe()
    let outgoing = Pipe()
    process.executableURL = node
    process.arguments = [entry.path]
    process.environment = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(),
      "TMPDIR": NSTemporaryDirectory(),
    ]
    process.standardInput = incoming
    process.standardOutput = outgoing
    // Raw child stderr is not a user log. Failures arrive as stable protocol codes.
    process.standardError = FileHandle.nullDevice
    outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      DispatchQueue.main.async { [weak self] in
        guard self?.generation == current else { return }
        self?.consume(data)
      }
    }
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { [weak self] in
        guard self?.generation == current else { return }
        self?.disconnected()
      }
    }
    do { try process.run() } catch {
      outgoing.fileHandleForReading.readabilityHandler = nil
      throw DeviceHostError.unavailable
    }
    child = process
    input = incoming.fileHandleForWriting
    output = outgoing.fileHandleForReading
    var config: [String: DeviceJSON] = [
      "type": .string("configure"), "version": .number(1),
      "baseUrl": .string(remoteOrigin),
      "deviceId": .string(identity.deviceId), "publicKey": .string(identity.publicKey),
      "name": .string(Host.current().localizedName ?? "Mac"), "platform": .string("darwin"),
      "arch": .string(Self.arch), "stateDirectory": .string(stateDirectory.path),
      "socketPath": .string(socketPath),
    ]
    if let boot = DeviceHostConfiguration.bootSessionID() {
      config["bootSessionId"] = .string(boot)
    }
    try send(.object(config))
  }
  private static var arch: String {
    #if arch(arm64)
      "arm64"
    #else
      "x64"
    #endif
  }

  public func stop() async {
    remoteGeneration = UUID()
    if let stopping {
      await stopping.value
      return
    }
    guard let process = child else {
      disconnected()
      return
    }
    generation = UUID()
    try? input?.close()
    input = nil
    disconnected()
    let task = Task { @MainActor in
      for _ in 0..<50 {
        if !process.isRunning { break }
        try? await Task.sleep(for: .milliseconds(100))
      }
      if process.isRunning { process.terminate() }
      // Keep ownership until exit; no replacement may race an old journal/socket owner.
      while process.isRunning { try? await Task.sleep(for: .milliseconds(50)) }
    }
    stopping = task
    await task.value
    if child === process { child = nil }
    stopping = nil
  }
  private func retry() async throws {
    if let retrying { return try await retrying.value }
    let task = Task { @MainActor in
      await self.stop()
      try self.start()
    }
    retrying = task
    defer { retrying = nil }
    try await task.value
  }
  private func disconnected() {
    localReady = false
    cloudStatus = "offline"
    output?.readabilityHandler = nil
    try? output?.close()
    output = nil
    approvalTimeout?.cancel()
    approvalId = nil
    for item in pending.values { item.resume(throwing: DeviceHostError.unavailable) }
    pending.removeAll()
    for item in timeouts.values { item.cancel() }
    timeouts.removeAll()
  }

  public func call(_ method: String, params: DeviceJSON? = nil) async throws -> DeviceJSON {
    if method == "service.ping" {
      // Authenticated helper contact must not depend on a busy Node socket or the network.
      return .object(["version": .number(1)])
    }
    if method == "service.status" {
      let observedGeneration = remoteGeneration
      var status: [String: DeviceJSON] = [
        "deviceId": .string(identity.deviceId), "localReady": .bool(localReady),
        "cloudStatus": .string(cloudStatus),
      ]
      if let failure { status["error"] = .string(failure) }
      if localReady, let raw = try? await statusReader(socketPath),
        case .object(let value) = raw
      {
        if !configuringRemote && observedGeneration == remoteGeneration {
          if value["cloudStatus"]?.string == "unconfigured" {
            remoteOrigin = ""
          } else if let origin = value["relayOrigin"]?.string,
            DeviceServiceAddress.normalize(origin) == origin
          {
            remoteOrigin = origin
          }
        }
        status.merge(value) { _, new in new }
      }
      return .object(status)
    }
    if method == "service.retry" {
      try await retry()
      return .object(["starting": .bool(true)])
    }
    guard localReady else { throw DeviceHostError.unavailable }
    if ["status", "directory"].contains(method) {
      return try await DeviceLocalPort(path: socketPath).call(method)
    }
    guard
      [
        "pairing.create", "pairing.prepare", "pairing.revoke", "pairing.redeem", "pairing.result",
        "member.remove",
        "policy.get", "policy.set", "remote.configure",
      ].contains(method)
    else { throw DeviceHostError.forbidden }
    guard pending.count < 32 else { throw DeviceHostError.unavailable }
    var requestedOrigin: String?
    var managedParams = params
    if method == "remote.configure" {
      guard !configuringRemote, let value = params?["baseUrl"]?.string else {
        throw DevicePortError("remote_configuration_busy")
      }
      let origin: String
      if value.isEmpty {
        origin = ""
      } else if let normalized = DeviceServiceAddress.normalize(value) {
        origin = normalized
      } else {
        throw DevicePortError("invalid_service_address")
      }
      configuringRemote = true
      remoteGeneration = UUID()
      requestedOrigin = origin
      remoteOrigin = origin
      managedParams = .object(["baseUrl": .string(origin)])
    }
    defer {
      if requestedOrigin != nil {
        remoteGeneration = UUID()
        configuringRemote = false
      }
    }
    let id = UUID().uuidString.lowercased()
    var message: [String: DeviceJSON] = [
      "type": .string("manage"), "requestId": .string(id), "method": .string(method),
    ]
    if let managedParams { message["params"] = managedParams }
    let result: DeviceJSON = try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      timeouts[id] = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(20)) } catch { return }
        self?.finish(id, error: DeviceHostError.timeout)
      }
      do { try send(.object(message)) } catch { finish(id, error: error) }
    }
    if let requestedOrigin {
      guard result["baseUrl"]?.string == requestedOrigin else {
        throw DeviceHostError.invalidResponse
      }
      remoteOrigin = requestedOrigin
    }
    return result
  }
  private func finish(_ id: String, result: DeviceJSON? = nil, error: (any Error)? = nil) {
    timeouts.removeValue(forKey: id)?.cancel()
    guard let continuation = pending.removeValue(forKey: id) else { return }
    if let error {
      continuation.resume(throwing: error)
    } else if let result {
      continuation.resume(returning: result)
    } else {
      continuation.resume(throwing: DeviceHostError.invalidResponse)
    }
  }
  private func send(_ value: DeviceJSON) throws {
    guard let input else { throw DeviceHostError.unavailable }
    var data = try JSONEncoder().encode(value)
    guard data.count <= 524288 else { throw DeviceHostError.invalidConfiguration }
    data.append(10)
    try input.write(contentsOf: data)
  }
  private func consume(_ data: Data) {
    guard !data.isEmpty else {
      disconnected()
      return
    }
    buffer.append(data)
    guard buffer.count <= 1_048_576 else {
      rejectProtocol()
      return
    }
    while let end = buffer.firstIndex(of: 10) {
      let frame = buffer.prefix(upTo: end)
      guard frame.count <= 524288,
        let value = try? JSONDecoder().decode(DeviceJSON.self, from: frame)
      else {
        rejectProtocol()
        return
      }
      buffer.removeSubrange(...end)
      receive(value)
    }
  }
  private func rejectProtocol() {
    failure = "invalid_device_response"
    try? input?.close()
    disconnected()
  }
  private func receive(_ value: DeviceJSON) {
    switch value["type"]?.string {
    case "ready":
      guard value["deviceId"]?.string == identity.deviceId,
        value["socketPath"]?.string == socketPath
      else {
        rejectProtocol()
        return
      }
      localReady = true
    case "cloud":
      guard let status = value["status"]?.string,
        ["online", "offline", "unconfigured"].contains(status)
      else {
        rejectProtocol()
        return
      }
      cloudStatus = status
    case "failed":
      failure = DevicePortError(value["error"]?.string ?? "device_service_failed").code
      localReady = false
    case "managed":
      guard let id = value["requestId"]?.string else { return }
      if let error = value["error"]?.string {
        finish(id, error: DevicePortError(error))
      } else {
        finish(id, result: value["result"])
      }
    case "sign":
      guard let id = value["requestId"]?.string, UUID(uuidString: id) != nil,
        let payload = value["payload"]?.string
      else {
        rejectProtocol()
        return
      }
      do {
        let signature = try identity.signRegistration(
          payload, serviceOrigin: remoteOrigin, now: Self.now)
        try send(
          .object([
            "type": .string("signature"), "requestId": .string(id), "signature": .string(signature),
          ]))
      } catch {
        try? send(
          .object([
            "type": .string("signature"), "requestId": .string(id),
            "error": .string("invalid_registration_payload"),
          ]))
      }
    case "approve":
      guard let request = try? value.decoded(DeviceApprovalRequest.self) else {
        rejectProtocol()
        return
      }
      confirm(request)
    default: rejectProtocol()
    }
  }
  private func confirm(_ request: DeviceApprovalRequest) {
    do { try request.validate(sourceDeviceId: identity.deviceId, now: Self.now) } catch {
      replyApproval(request.id, error: "invalid_approval_request")
      return
    }
    guard approvalId == nil, let approver else {
      replyApproval(request.id, error: "confirmation_unavailable")
      return
    }
    approvalId = request.id
    let current = generation
    approvalTimeout = Task { [weak self] in
      do {
        try await Task.sleep(for: .milliseconds(min(request.expiresAt - Self.now, 55000)))
      } catch { return }
      guard let self, generation == current, approvalId == request.id else { return }
      approvalId = nil
      replyApproval(request.id, error: "confirmation_expired")
    }
    Task { [weak self] in
      let confirmed = await approver(request)
      guard let self, generation == current, approvalId == request.id else { return }
      approvalTimeout?.cancel()
      approvalId = nil
      guard confirmed else {
        replyApproval(request.id, error: "confirmation_denied")
        return
      }
      do { replyApproval(request.id, approval: try identity.approve(request, now: Self.now)) } catch
      { replyApproval(request.id, error: "invalid_approval_request") }
    }
  }
  private func replyApproval(_ id: String, approval: DeviceApproval? = nil, error: String? = nil) {
    var message: [String: DeviceJSON] = ["type": .string("approval"), "requestId": .string(id)]
    if let approval { message["approval"] = try? DeviceJSON.encoded(approval) }
    if let error { message["error"] = .string(error) }
    try? send(.object(message))
  }
  private static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
