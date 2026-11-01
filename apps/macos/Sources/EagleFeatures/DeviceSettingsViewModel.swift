import Combine
import CryptoKit
import EagleDevices
import Foundation

public struct DevicePolicyState: Codable, Equatable, Sendable {
  public enum Mode: String, Codable, CaseIterable, Sendable {
    case allApprove = "all-approve"
    case alwaysAsk = "always-ask"
    case paused

    public var title: String {
      switch self {
      case .allApprove: "始终允许"
      case .alwaysAsk: "每次询问"
      case .paused: "暂停执行"
      }
    }
  }
  public let mode: Mode
  public let version: Int
}

public struct DeviceDirectoryEntry: Codable, Equatable, Identifiable, Sendable {
  public let deviceId: String
  public let name: String
  public let platform: String
  public let arch: String
  public let groupId: String?
  public let online: Bool?
  public let lastSeenAt: Int64?
  public let capabilities: [String]?
  public let policy: DevicePolicyState?
  public var id: String { deviceId }
  public var connectionLabel: String {
    switch online {
    case true: "在线"
    case false: "离线"
    default: "连接未知"
    }
  }
}

public struct DeviceDirectoryState: Codable, Equatable, Sendable {
  public let localDeviceId: String
  public let groupId: String?
  public let revision: Int
  public let observationRevision: String
  public let devices: [DeviceDirectoryEntry]
}

public struct DevicePairingInvitation: Codable, Equatable, Sendable {
  public let code: String
  public let expiresAt: Int64
}

private struct DeviceServiceState: Decodable {
  let deviceId: String?
  let localReady: Bool
  let cloudStatus: String
  let error: String?
}

/// One App-wide control surface. Pairing codes stay in memory; only their hash binds a saved request ID.
@MainActor public final class DeviceSettingsViewModel: ObservableObject {
  public static let shared = DeviceSettingsViewModel()
  public static let disabledKey = "eagle.devices.disabled"
  public static let pendingRedeemKey = "eagle.devices.pendingRedeemRequestId"

  @Published public private(set) var enabled: Bool
  @Published public private(set) var localReady = false
  @Published public private(set) var cloudStatus = "unknown"
  @Published public private(set) var directory: DeviceDirectoryState?
  @Published public private(set) var directoryIsStale = true
  @Published public private(set) var policy: DevicePolicyState?
  @Published private var confirmedPolicies: [String: DevicePolicyState] = [:]
  @Published public private(set) var invitation: DevicePairingInvitation?
  @Published public private(set) var pendingRedeemRequestId: String?
  @Published public private(set) var pendingApproval: DeviceApprovalRequest?
  @Published public private(set) var errorCode: String?
  /// The relay the person runs. A published App ships none, so this is the only source.
  @Published public var serviceAddressDraft: String = ""
  @Published public private(set) var savedServiceAddress: String = ""
  @Published public private(set) var isStarting = false
  @Published public private(set) var isBusy = false

  private let control: any DeviceControl
  private let defaults: UserDefaults
  private let requiresServiceAddress: Bool
  private let now: @MainActor () -> Date
  private let observationWait: @MainActor () async throws -> Void
  private var started = false
  private var stopping = false
  private var stateGeneration: UInt64 = 0
  private var refreshGeneration: UInt64?
  private var pendingRedeemCodeHash: String?
  private var localDeviceId: String?
  private var startTask: Task<Void, Never>?
  private var approvalContinuation: CheckedContinuation<Bool, Never>?
  private var approvalExpiry: Task<Void, Never>?
  private var observers: [UUID: CheckedContinuation<Void, Never>] = [:]
  private var observationTask: Task<Void, Never>?

  public init(
    control: any DeviceControl = DeviceSystemControl(), defaults: UserDefaults = .standard,
    /// `nil` derives it from the bundle; tests state it instead.
    requiresServiceAddress: Bool? = nil,
    now: @escaping @MainActor () -> Date = { Date() },
    observationWait: @escaping @MainActor () async throws -> Void = {
      try await Task.sleep(for: .seconds(5))
    }
  ) {
    self.control = control
    self.defaults = defaults
    // A bundle that names no relay (every published build) needs the person's choice first.
    self.requiresServiceAddress =
      requiresServiceAddress
      ?? (try? DeviceHostConfiguration.load(bundle: Bundle.main.bundleURL)).map(\.baseUrl.isEmpty)
      ?? false
    self.now = now
    self.observationWait = observationWait
    enabled = true
    defaults.removeObject(forKey: Self.disabledKey)
    savedServiceAddress = DeviceServiceAddress.saved(defaults) ?? ""
    serviceAddressDraft = savedServiceAddress
    let record = defaults.dictionary(forKey: Self.pendingRedeemKey)
    // Older candidate records contain an ID only: they can be queried, never blindly retried.
    let savedID = record?["requestId"] as? String ?? defaults.string(forKey: Self.pendingRedeemKey)
    pendingRedeemRequestId = savedID.flatMap { UUID(uuidString: $0)?.uuidString.lowercased() }
    if let hash = record?["codeHash"] as? String,
      hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    {
      pendingRedeemCodeHash = hash
    }
  }

  public var needsBackgroundApproval: Bool { errorCode == "background_approval_required" }
  /// True when nothing may be contacted yet: no relay is baked in and none was chosen.
  public var needsServiceAddress: Bool { requiresServiceAddress && savedServiceAddress.isEmpty }
  public var isRefreshing: Bool { refreshGeneration != nil }
  public var controlsBusy: Bool { isStarting || isBusy }
  public var canToggleService: Bool { !isBusy && (enabled || !controlsBusy) }
  public var canRetryService: Bool {
    enabled && !localReady && !controlsBusy && !needsBackgroundApproval
  }
  public var errorMessage: String? {
    guard let errorCode else { return nil }
    switch errorCode {
    case "invalid_service_address":
      return "请填写服务地址：https 的裸域名，本机调试可用 http://127.0.0.1:端口。"
    case "background_approval_required":
      return "请在系统设置中允许 Eagle 在后台运行，然后重试。"
    case "group_conflict": return "两台设备已属于不同设备群。请先退出原群，再配对。"
    case "pairing_unavailable", "pairing_not_found": return "配对码已过期、已作废或不存在。"
    case "pairing_consumed": return "这个配对码已被另一台设备使用。"
    case "pairing_result_expired": return "配对结果已超过保留期限，请刷新设备目录。"
    case "result_not_found": return "还没有查到原请求的结果。可继续查询，或重新输入原配对码以原请求重试。"
    case "rate_limited": return "请求过于频繁，请稍后再试。"
    case "invalid_pairing_ttl": return "配对码有效期必须在 1 秒至 24 小时之间。"
    case "empty_pairing_code": return "请输入另一台设备的配对码。"
    case "invalid_pairing_code": return "配对码格式不正确，请完整复制另一台设备生成的配对码。"
    case "self_pairing": return "不能用本机配对码与本机配对，请输入另一台设备的配对码。"
    case "request_conflict": return "此请求已绑定另一个配对码，请输入原配对码或查询原请求。"
    case "pairing_binding_unavailable": return "原请求缺少配对码校验信息，只能继续查询原结果。"
    case "invalid_session", "revoked_session", "unknown_device": return "设备身份会话已失效，请重新连接设备服务。"
    case "target_policy_unavailable": return "暂时无法修改这台设备的权限，请确认设备在线并已更新 Eagle。"
    case "target_offline": return "这台设备当前离线，请等待它重新连接后再修改权限。"
    case "target_management_unsupported": return "请先更新这台设备上的 Eagle，再修改它的权限。"
    case "policy_result_unknown_refresh_target", "policy_request_already_sent_refresh_target":
      return "权限修改结果尚未确认，请刷新查看这台设备的实际权限。"
    case "policy_management_busy": return "这台设备正在处理其他请求，请稍后再试。"
    case "device_service_timeout":
      return pendingRedeemRequestId == nil
        ? "设备服务未能及时就绪，请重试。"
        : "设备服务响应超时。配对结果尚不确定，请保留并查询原请求。"
    default: return "设备服务暂时不可用，请重试。"
    }
  }

  /// Stores the origin and restarts the service so the helper picks it up.
  public func saveServiceAddress() async {
    guard let origin = DeviceServiceAddress.normalize(serviceAddressDraft) else {
      errorCode = "invalid_service_address"
      return
    }
    DeviceServiceAddress.save(origin, defaults: defaults)
    savedServiceAddress = origin
    serviceAddressDraft = origin
    errorCode = nil
    guard started else {
      await startIfNeeded()
      return
    }
    do {
      try await control.stop()
    } catch {
      started = false
      record(error)
      return
    }
    started = false
    localReady = false
    cloudStatus = "unknown"
    directoryIsStale = true
    await start(retrying: false)
  }

  public func startIfNeeded() async {
    await start(retrying: false)
  }

  private func start(retrying: Bool) async {
    guard enabled, !stopping, !isBusy, !needsServiceAddress else { return }
    if let startTask {
      await startTask.value
      return
    }
    guard !started else { return }
    isStarting = true
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        let confirm: @MainActor @Sendable (DeviceApprovalRequest) async -> Bool = {
          [weak self] request in
          guard let self else { return false }
          return await self.confirm(request)
        }
        if retrying {
          try await control.retryStart(confirm: confirm)
        } else {
          try await control.start(confirm: confirm)
        }
        started = true
        if enabled {
          let deadline = ContinuousClock.now.advanced(by: .seconds(5))
          await readState(includeDirectory: false)
          // Observe cold local initialization promptly; cloud reads never define local readiness.
          while enabled && !stopping && !localReady && errorCode == nil
            && ContinuousClock.now < deadline
          {
            try await Task.sleep(for: .milliseconds(100))
            await readState(includeDirectory: false)
          }
          if enabled && !stopping && !localReady && errorCode == nil {
            throw DeviceHostError.timeout
          }
        }
      } catch { record(error) }
      isStarting = false
    }
    startTask = task
    await task.value
    startTask = nil
    // Cloud enrichment is outside the startup task: disabling never waits for a cloud read.
    if enabled && !stopping && localReady {
      let generation = stateGeneration
      await readDirectory()
      if acceptsRead(generation), pendingRedeemRequestId != nil { await recoverPairing() }
    }
  }

  public func setEnabled(_ value: Bool) async {
    guard !isBusy else { return }
    stateGeneration &+= 1
    if value {
      enabled = true
      defaults.set(false, forKey: Self.disabledKey)
      await startIfNeeded()
      return
    }
    isBusy = true
    stopping = true
    denyPendingApproval()
    defer {
      isBusy = false
      stopping = false
    }
    if let startTask { await startTask.value }
    do {
      try await control.stop()
      enabled = false
      defaults.set(true, forKey: Self.disabledKey)
      invitation = nil
      started = false
      localReady = false
      cloudStatus = "unknown"
      directoryIsStale = true
      errorCode = nil
    } catch {
      // A failed unregister is not a disabled service. Reconnect and retry remain available.
      started = false
      localReady = false
      cloudStatus = "unknown"
      directoryIsStale = true
      record(error)
    }
  }

  public func openSystemSettings() { control.openSystemSettings() }

  /// Settings, inspectors and windows share one reader until the last view disappears.
  public func observe() async {
    let id = UUID()
    await withTaskCancellationHandler {
      guard !Task.isCancelled else { return }
      await withCheckedContinuation { continuation in
        observers[id] = continuation
        guard observationTask == nil else { return }
        observationTask = Task { @MainActor [weak self] in
          while !Task.isCancelled {
            guard let self else { return }
            if started { await refresh() } else { await startIfNeeded() }
            guard !Task.isCancelled else { return }
            do { try await observationWait() } catch { return }
          }
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.endObservation(id) }
    }
  }

  private func endObservation(_ id: UUID) {
    let continuation = observers.removeValue(forKey: id)
    if observers.isEmpty {
      observationTask?.cancel()
      observationTask = nil
    }
    continuation?.resume()
  }

  public func refresh() async {
    guard !isBusy else { return }
    await readState()
  }

  private func readState(includeDirectory: Bool = true) async {
    let generation = stateGeneration
    guard enabled, started, !stopping, refreshGeneration != generation else { return }
    refreshGeneration = generation
    defer { if refreshGeneration == generation { refreshGeneration = nil } }
    var observedStatus: DeviceServiceState?
    do {
      let status = try await control.call("service.status", params: nil).decoded(
        DeviceServiceState.self)
      guard acceptsRead(generation) else { return }
      observedStatus = status
      guard status.localReady else {
        applyStatus(status)
        publish(\.errorCode, status.error.map { DevicePortError($0).code })
        denyPendingApproval()
        publish(\.directoryIsStale, true)
        return
      }
      publish(\.localReady, true)
      localDeviceId = status.deviceId
      let currentPolicy = try await control.call("policy.get", params: nil).decoded(
        DevicePolicyState.self)
      guard acceptsRead(generation) else { return }
      publish(\.policy, currentPolicy)
      if isStarting { isStarting = false }
      if !includeDirectory {
        applyStatus(status)
        publish(\.errorCode, nil)
        return
      }
      let current = try await control.call("directory", params: nil)
      guard acceptsRead(generation) else { return }
      applyStatus(status, cloudStatus: current["cloudStatus"]?.string)
      try applyDirectory(current)
      publish(\.errorCode, nil)
    } catch {
      guard acceptsRead(generation) else { return }
      if let observedStatus {
        applyStatus(observedStatus)
      } else {
        started = false
        publish(\.localReady, false)
        publish(\.cloudStatus, "unknown")
        denyPendingApproval()
      }
      publish(\.directoryIsStale, true)
      record(error)
    }
  }

  private func readDirectory() async {
    let generation = stateGeneration
    guard enabled, started, !stopping, !isBusy, refreshGeneration != generation else { return }
    refreshGeneration = generation
    defer { if refreshGeneration == generation { refreshGeneration = nil } }
    do {
      let current = try await control.call("directory", params: nil)
      guard acceptsRead(generation) else { return }
      if let cloud = current["cloudStatus"]?.string { publish(\.cloudStatus, cloud) }
      try applyDirectory(current)
      publish(\.errorCode, nil)
    } catch {
      guard acceptsRead(generation) else { return }
      publish(\.directoryIsStale, true)
      record(error)
    }
  }

  /// Retry an unreachable helper, or only its Node child when the helper is authenticated.
  public func retryService() async {
    guard enabled, !stopping, !controlsBusy else { return }
    if !started {
      await start(retrying: true)
      return
    }
    stateGeneration &+= 1
    isBusy = true
    denyPendingApproval()
    defer { isBusy = false }
    do {
      _ = try await control.call("service.retry", params: nil)
      localReady = false
      cloudStatus = "unknown"
      directoryIsStale = true
      errorCode = nil
      let clock = ContinuousClock()
      let deadline = clock.now.advanced(by: .seconds(5))
      while enabled && !stopping && clock.now < deadline {
        await readState()
        if localReady || errorCode != nil { return }
        try await Task.sleep(for: .milliseconds(100))
      }
      if enabled && !stopping { throw DeviceHostError.timeout }
    } catch { record(error) }
  }

  public func policy(for device: DeviceDirectoryEntry) -> DevicePolicyState? {
    if device.deviceId == localDeviceId { return policy }
    guard let confirmed = confirmedPolicies[device.deviceId] else { return device.policy }
    if let observed = device.policy, observed.version >= confirmed.version { return observed }
    return confirmed
  }

  public func canEditPolicy(for device: DeviceDirectoryEntry) -> Bool {
    guard enabled, localReady, !controlsBusy, policy(for: device) != nil else { return false }
    if device.deviceId == localDeviceId { return true }
    return !directoryIsStale && device.online == true
      && device.capabilities?.contains("policy.manage") == true
  }

  public func setPolicy(_ mode: DevicePolicyState.Mode, deviceId: String? = nil) async {
    let remote = deviceId.flatMap { $0 == localDeviceId ? nil : $0 }
    if let remote {
      guard let device = directory?.devices.first(where: { $0.deviceId == remote }),
        canEditPolicy(for: device)
      else {
        rejectPreflight("target_policy_unavailable")
        return
      }
    }
    await perform {
      var params: [String: DeviceJSON] = ["mode": .string(mode.rawValue)]
      if let remote {
        params["deviceId"] = .string(remote)
        params["requestId"] = .string(UUID().uuidString.lowercased())
      }
      let result = try await self.control.call(
        "policy.set", params: .object(params))
      let policy = try result.decoded(DevicePolicyState.self)
      if let remote {
        self.confirmedPolicies[remote] = policy
      } else {
        self.policy = policy
      }
      self.denyPendingApproval()
      await self.readState()
    }
  }

  public func createPairing(ttlSeconds: Int = 3600) async {
    guard (1...86400).contains(ttlSeconds) else {
      rejectPreflight("invalid_pairing_ttl")
      return
    }
    await perform {
      self.invitation = try await self.control.call(
        "pairing.create", params: .object(["ttlSeconds": .number(Double(ttlSeconds))])
      ).decoded(DevicePairingInvitation.self)
    }
  }

  public func revokePairing() async {
    guard let invitation else { return }
    await perform {
      _ = try await self.control.call(
        "pairing.revoke", params: .object(["code": .string(invitation.code)]))
      self.invitation = nil
    }
  }

  public func redeem(code: String) async {
    let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !code.isEmpty else {
      rejectPreflight("empty_pairing_code")
      return
    }
    guard code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
      rejectPreflight("invalid_pairing_code")
      return
    }
    await perform {
      let hash = SHA256.hash(data: Data(code.utf8)).map { String(format: "%02x", $0) }.joined()
      if let requestId = self.pendingRedeemRequestId {
        if let original = self.pendingRedeemCodeHash, original != hash {
          throw DevicePortError("request_conflict")
        }
        do {
          let result = try await self.control.call(
            "pairing.result", params: .object(["requestId": .string(requestId)]))
          try self.acceptPairingResult(result, requestId: requestId)
          await self.readState()
        } catch let error as DevicePortError where error.code == "result_not_found" {
          guard self.pendingRedeemCodeHash == hash else {
            throw DevicePortError("pairing_binding_unavailable")
          }
          // Explicit re-entry of the same code can recover a pre-send loss. The ID never changes.
          try await self.sendRedemption(requestId: requestId, code: code, firstAttempt: false)
        }
      } else {
        let requestId = UUID().uuidString.lowercased()
        self.defaults.set(
          ["requestId": requestId, "codeHash": hash], forKey: Self.pendingRedeemKey)
        guard self.defaults.synchronize() else {
          self.defaults.removeObject(forKey: Self.pendingRedeemKey)
          throw DeviceHostError.failed
        }
        self.pendingRedeemRequestId = requestId
        self.pendingRedeemCodeHash = hash
        try await self.sendRedemption(requestId: requestId, code: code, firstAttempt: true)
      }
    }
  }

  private func sendRedemption(requestId: String, code: String, firstAttempt: Bool) async throws {
    do {
      let result = try await control.call(
        "pairing.redeem", params: .object(["requestId": .string(requestId), "code": .string(code)]))
      try acceptPairingResult(result, requestId: requestId)
      await readState()
    } catch {
      if !firstAttempt, let port = error as? DevicePortError,
        ["pairing_unavailable", "pairing_consumed", "pairing_result_expired"].contains(port.code)
      {
        let current = try await control.call("directory", params: nil)
        // The Agent's offline local fallback cannot confirm current Registry membership.
        guard current["cloudStatus"]?.string != "offline" else { throw DeviceHostError.unavailable }
        try applyDirectory(current)
        clearPendingRedemption()
      }
      // Self-pairing can never have committed. Network/rate/session uncertainty keeps the ID.
      if let port = error as? DevicePortError,
        port.code == "self_pairing"
          || (firstAttempt
            && [
              "group_conflict", "pairing_unavailable", "pairing_consumed", "pairing_result_expired",
              "request_conflict", "rate_limited", "invalid_request", "invalid_session",
              "revoked_session", "unknown_device",
            ].contains(port.code))
      {
        clearPendingRedemption()
      }
      throw error
    }
  }

  public func recoverPairing() async {
    guard let requestId = pendingRedeemRequestId else { return }
    await perform {
      let result = try await self.control.call(
        "pairing.result", params: .object(["requestId": .string(requestId)]))
      try self.acceptPairingResult(result, requestId: requestId)
      await self.readState()
    }
  }

  public func removeMember(_ deviceId: String) async {
    await perform {
      _ = try await self.control.call(
        "member.remove", params: .object(["deviceId": .string(deviceId)]))
      await self.readState()
    }
  }

  private func perform(_ action: @MainActor () async throws -> Void) async {
    guard enabled, started, localReady else {
      rejectPreflight("device_service_unavailable")
      return
    }
    guard !isBusy else { return }
    // A user action supersedes every read begun before it, including delayed failures.
    stateGeneration &+= 1
    isBusy = true
    errorCode = nil
    defer { isBusy = false }
    do { try await action() } catch { record(error) }
  }

  private func applyDirectory(_ value: DeviceJSON) throws {
    let current = try value.decoded(DeviceDirectoryState.self)
    if directory?.groupId != current.groupId || directory?.localDeviceId != current.localDeviceId
      || directory?.revision != current.revision
      || directory?.observationRevision != current.observationRevision
    {
      directory = current
    }
    publish(\.directoryIsStale, false)
    if value["cloudStatus"]?.string == "offline" { publish(\.cloudStatus, "offline") }
  }

  private func acceptsRead(_ generation: UInt64) -> Bool {
    generation == stateGeneration && enabled && started && !stopping && !Task.isCancelled
  }

  private func rejectPreflight(_ code: String) {
    // Rejected input is still a newer user result than an already pending read.
    stateGeneration &+= 1
    publish(\.errorCode, code)
  }

  private func applyStatus(_ status: DeviceServiceState, cloudStatus: String? = nil) {
    publish(\.localReady, status.localReady)
    localDeviceId = status.deviceId
    publish(\.cloudStatus, cloudStatus ?? status.cloudStatus)
  }

  private func publish<Value: Equatable>(
    _ keyPath: ReferenceWritableKeyPath<DeviceSettingsViewModel, Value>, _ value: Value
  ) {
    if self[keyPath: keyPath] != value { self[keyPath: keyPath] = value }
  }

  private func acceptPairingResult(_ value: DeviceJSON, requestId: String) throws {
    guard value["requestId"]?.string == requestId, let current = value["directory"] else {
      throw DeviceHostError.invalidResponse
    }
    let known = Set(directory?.devices.map(\.deviceId) ?? [])
    try applyDirectory(current)
    clearPendingRedemption()
    let joined =
      directory?.devices.filter { $0.deviceId != localDeviceId && !known.contains($0.deviceId) }
      ?? []
    for device in joined { Task { await self.askBeforeRunning(on: device) } }
  }

  /// A machine that was just added starts out asking: nothing runs on it silently until the
  /// person chooses otherwise. A target that cannot take the change stays as it is; the pairing
  /// itself already succeeded, and the row shows the policy it reports.
  private func askBeforeRunning(on device: DeviceDirectoryEntry) async {
    guard device.online == true, device.capabilities?.contains("policy.manage") == true,
      device.policy?.mode != .alwaysAsk
    else { return }
    _ = try? await control.call(
      "policy.set",
      params: .object([
        "mode": .string(DevicePolicyState.Mode.alwaysAsk.rawValue),
        "deviceId": .string(device.deviceId),
        "requestId": .string(UUID().uuidString.lowercased()),
      ]))
    await readState()
  }

  private func clearPendingRedemption() {
    defaults.removeObject(forKey: Self.pendingRedeemKey)
    pendingRedeemRequestId = nil
    pendingRedeemCodeHash = nil
  }

  private func record(_ error: any Error) {
    let code =
      (error as? DevicePortError)?.code ?? (error as? DeviceHostError)?.rawValue
      ?? "device_request_failed"
    publish(\.errorCode, code)
  }

  private func confirm(_ request: DeviceApprovalRequest) async -> Bool {
    guard enabled, started, !stopping, !Task.isCancelled, localReady, pendingApproval == nil,
      let localDeviceId,
      (try? request.validate(sourceDeviceId: localDeviceId, now: milliseconds)) != nil
    else { return false }
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        pendingApproval = request
        approvalContinuation = continuation
        let delay = max(0, request.expiresAt - milliseconds)
        approvalExpiry = Task { @MainActor [weak self] in
          do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
          self?.respondToApproval(false, requestId: request.id)
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.respondToApproval(false, requestId: request.id)
      }
    }
  }

  /// Global dismiss can only deny. Every acceptance must carry the ID the person reviewed.
  public func denyPendingApproval() {
    guard let requestId = pendingApproval?.id else { return }
    respondToApproval(false, requestId: requestId)
  }

  public func respondToApproval(_ allow: Bool, requestId: String) {
    guard let continuation = approvalContinuation, let request = pendingApproval,
      request.id == requestId
    else { return }
    let accepted =
      allow && enabled && started && !stopping && localReady && request.expiresAt > milliseconds
    approvalExpiry?.cancel()
    approvalExpiry = nil
    approvalContinuation = nil
    pendingApproval = nil
    continuation.resume(returning: accepted)
  }

  private var milliseconds: Int64 { Int64(now().timeIntervalSince1970 * 1000) }
}
