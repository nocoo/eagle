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
  private let vault: any DeviceIdentityVault
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
  private var stopping: Task<Void, Never>?
  private var retrying: Task<Void, any Error>?

  public init(
    identity: DeviceIdentity, configuration: DeviceHostConfiguration,
    node: URL, entry: URL, stateDirectory: URL? = nil,
    vault: any DeviceIdentityVault = DeviceFileVault()
  ) {
    self.identity = identity
    self.configuration = configuration
    self.node = node
    self.vault = vault
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
      "baseUrl": .string(configuration.serviceOrigin),
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
      var status: [String: DeviceJSON] = [
        "deviceId": .string(identity.deviceId), "localReady": .bool(localReady),
        "cloudStatus": .string(cloudStatus),
      ]
      if let failure { status["error"] = .string(failure) }
      if localReady, let raw = try? await DeviceLocalPort(path: socketPath).call("status"),
        case .object(let value) = raw
      {
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
        "pairing.create", "pairing.revoke", "pairing.redeem", "pairing.result", "member.remove",
        "policy.get", "policy.set",
        "sync.share", "sync.incoming", "sync.endpoints.publish",
      ].contains(method)
    else { throw DeviceHostError.forbidden }
    guard pending.count < 32 else { throw DeviceHostError.unavailable }
    let id = UUID().uuidString.lowercased()
    var message: [String: DeviceJSON] = [
      "type": .string("manage"), "requestId": .string(id), "method": .string(method),
    ]
    if let params { message["params"] = params }
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      timeouts[id] = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(20)) } catch { return }
        self?.finish(id, error: DeviceHostError.timeout)
      }
      do { try send(.object(message)) } catch { finish(id, error: error) }
    }
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
      guard let status = value["status"]?.string, ["online", "offline"].contains(status) else {
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
          payload, serviceOrigin: configuration.serviceOrigin, now: Self.now)
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
    case "sync_key_descriptor":
      guard case .object(let envelope) = value,
        Set(envelope.keys) == Set(["type", "requestId", "request"]),
        let id = value["requestId"]?.string, UUID(uuidString: id) != nil,
        case .object(let request) = value["request"],
        Set(request.keys) == Set(["version", "registryOrigin", "identity"])
      else {
        rejectProtocol()
        return
      }
      do {
        let raw = DeviceJSON.object(request)
        guard raw["version"] == .number(1),
          raw["registryOrigin"] == .string(configuration.serviceOrigin),
          case .object(let peer) = raw["identity"],
          Set(peer.keys)
            == Set(["deviceId", "publicKey", "groupId", "membershipEpoch", "credentialVersion"]),
          raw["identity"]?["deviceId"] == .string(identity.deviceId),
          raw["identity"]?["publicKey"] == .string(identity.publicKey),
          raw["identity"]?["groupId"] == .null
            || raw["identity"]?["groupId"]?.string.flatMap({
              UUID(uuidString: $0)?.uuidString.lowercased()
            }) == raw["identity"]?["groupId"]?.string,
          let epoch = raw["identity"]?["membershipEpoch"]?.number,
          epoch >= 0, epoch <= 9_007_199_254_740_991, epoch.rounded() == epoch,
          let credential = raw["identity"]?["credentialVersion"]?.number,
          credential >= 1, credential <= 9_007_199_254_740_991,
          credential.rounded() == credential
        else { throw DeviceIdentityError.invalidPayload }
        let key = try DeviceWrappingKey.loadOrCreate(
          profile: configuration.profile, serviceOrigin: configuration.serviceOrigin,
          identity: identity, vault: vault)
        let descriptor = try identity.wrappingDescriptor(
          key: key, serviceOrigin: configuration.serviceOrigin, credentialVersion: Int64(credential)
        )
        try send(
          .object([
            "type": .string("sync_key_descriptor_result"),
            "requestId": .string(id), "result": descriptor,
          ]))
      } catch {
        try? send(
          .object([
            "type": .string("sync_key_descriptor_result"),
            "requestId": .string(id), "error": .string("invalid_sync_key_descriptor"),
          ]))
      }
    case "sync_key_seal", "sync_key_envelope", "sync_key_open":
      guard case .object(let envelope) = value,
        Set(envelope.keys) == Set(["type", "requestId", "request"]),
        let kind = value["type"]?.string, let id = value["requestId"]?.string,
        UUID(uuidString: id) != nil, let request = value["request"]
      else {
        rejectProtocol()
        return
      }
      do {
        let key: DeviceWrappingKey
        if kind == "sync_key_seal" {
          key = try DeviceWrappingKey.loadOrCreate(
            profile: configuration.profile, serviceOrigin: configuration.serviceOrigin,
            identity: identity, vault: vault)
        } else {
          key = try DeviceWrappingKey.loadExisting(
            profile: configuration.profile, serviceOrigin: configuration.serviceOrigin,
            identity: identity, vault: vault)
        }
        let keys = DevicePageKeys(
          identity: identity, wrapping: key, origin: configuration.serviceOrigin)
        let result: DeviceJSON
        switch kind {
        case "sync_key_seal": result = try keys.seal(request)
        case "sync_key_envelope": result = try keys.issue(request)
        default: result = try keys.open(request)
        }
        try send(
          .object(["type": .string(kind + "_result"), "requestId": .string(id), "result": result]))
      } catch {
        try? send(
          .object([
            "type": .string(kind + "_result"), "requestId": .string(id),
            "error": .string("invalid_sync_key_request"),
          ]))
      }
    case "sync_proof":
      guard case .object(let fields) = value,
        Set(fields.keys) == Set(["type", "requestId", "request"]),
        let id = value["requestId"]?.string, UUID(uuidString: id) != nil,
        let raw = value["request"]
      else {
        rejectProtocol()
        return
      }
      do {
        let signature = try identity.signSyncProof(
          SyncProofRequest(raw), serviceOrigin: configuration.serviceOrigin, now: Self.now)
        try send(
          .object([
            "type": .string("sync_signature"), "requestId": .string(id),
            "signature": .string(signature),
          ]))
      } catch {
        try? send(
          .object([
            "type": .string("sync_signature"), "requestId": .string(id),
            "error": .string("invalid_sync_proof"),
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
