import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Device settings", .serialized)
@MainActor
struct DeviceSettingsViewModelTests {
  @Test("startup is shared and local readiness survives cloud offline")
  func startup() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    async let first: Void = model.startIfNeeded()
    async let second: Void = model.startIfNeeded()
    _ = await (first, second)
    #expect(control.starts == 1)
    #expect(model.localReady)
    #expect(model.cloudStatus == "offline")
    #expect(model.directory?.devices.first?.online == nil)
    #expect(model.policy?.mode == .allApprove)
  }

  @Test("observation changes refresh even at the same membership revision")
  func observationRefresh() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.directory = deviceDirectory(observation: "second", online: true)
    await model.refresh()
    #expect(model.directory?.revision == 1)
    #expect(model.directory?.observationRevision == "second")
    #expect(model.directory?.devices.first?.online == true)
  }

  @Test("a temporary stop does not prevent the next App instance from starting automatically")
  func disable() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    await model.setEnabled(false)
    #expect(control.stops == 1)
    #expect(!model.localReady)
    let restored = DeviceSettingsViewModel(control: control, defaults: defaults)
    await restored.startIfNeeded()
    #expect(restored.enabled)
    #expect(control.starts == 2)
    await restored.setEnabled(true)
    #expect(control.starts == 2)
  }

  @Test("background approval is actionable and policy is never optimistic")
  func permissionAndPolicy() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.startError = DevicePortError("background_approval_required")
    await model.startIfNeeded()
    #expect(model.needsBackgroundApproval)
    #expect(!model.localReady)
    model.openSystemSettings()
    #expect(control.openedSettings == 1)
    control.startError = nil
    await model.startIfNeeded()
    control.handler = { method, _ in
      if method == "policy.set" { throw DevicePortError("device_request_failed") }
      return nil
    }
    await model.setPolicy(.paused)
    #expect(model.policy?.mode == .allApprove)
    control.handler = nil
    await model.setPolicy(.paused)
    #expect(model.policy?.mode == .paused)
    #expect(control.calls.contains { $0.0 == "policy.set" && $0.1?["mode"] == .string("paused") })
  }

  @Test("failed status refresh cannot advertise cached local readiness")
  func failedRefresh() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.handler = { method, _ in
      if method == "service.status" { throw DeviceHostError.unavailable }
      return nil
    }
    await model.refresh()
    #expect(!model.localReady)
    #expect(model.cloudStatus == "unknown")
    #expect(model.directoryIsStale)
  }

  @Test("a status timeout mentions pairing only when an original pairing request exists")
  func timeoutContext() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.handler = { method, _ in
      if method == "service.status" { throw DeviceHostError.timeout }
      return nil
    }
    await model.startIfNeeded()
    #expect(model.errorCode == "device_service_timeout")
    #expect(model.errorMessage?.contains("配对") == false)
    #expect(model.pendingRedeemRequestId == nil)
    let id = UUID().uuidString.lowercased()
    defaults.set(
      ["requestId": id, "codeHash": String(repeating: "a", count: 64)],
      forKey: DeviceSettingsViewModel.pendingRedeemKey)
    control.handler = nil
    let pending = DeviceSettingsViewModel(control: control, defaults: defaults)
    await pending.startIfNeeded()
    control.handler = { method, _ in
      if method == "service.status" { throw DeviceHostError.timeout }
      return nil
    }
    await pending.refresh()
    #expect(pending.pendingRedeemRequestId == id)
    #expect(pending.errorMessage?.contains("原请求") == true)
    #expect(
      defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey)?["requestId"] as? String
        == id)
  }

  @Test("the service switch remains usable while a startup status reply is pending")
  func stopDuringStatus() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    var release: CheckedContinuation<Void, Never>?
    control.statusGate = { await withCheckedContinuation { release = $0 } }
    let starting = Task { await model.startIfNeeded() }
    while release == nil { await Task.yield() }
    #expect(model.isStarting && model.isRefreshing)
    #expect(model.canToggleService)
    let stopping = Task { await model.setEnabled(false) }
    while !model.isBusy { await Task.yield() }
    release?.resume()
    await starting.value
    await stopping.value
    #expect(!model.enabled)
    #expect(control.stops == 1)
    #expect(control.starts == 1)
  }

  @Test("pairing uses bounded TTL and never persists a code")
  func pairingTTL() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    await model.createPairing()
    #expect(model.invitation?.code == "memory-only-code")
    #expect(control.calls.last { $0.0 == "pairing.create" }?.1?["ttlSeconds"] == .number(3600))
    let before = control.calls.count
    await model.createPairing(ttlSeconds: 86401)
    #expect(control.calls.count == before)
    #expect(
      !defaults.dictionaryRepresentation().values.contains {
        String(describing: $0).contains("memory-only-code")
      })
    await model.revokePairing()
    #expect(model.invitation == nil)
    #expect(control.calls.last?.0 == "pairing.revoke")
  }

  @Test("redeem persists the original nonsecret ID before send and recovers after restart")
  func redeemRecovery() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var sentID: String?
    control.handler = { method, params in
      if method == "pairing.redeem" {
        sentID = params?["requestId"]?.string
        #expect(
          defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey)?["requestId"]
            as? String == sentID)
        throw DeviceHostError.timeout
      }
      return nil
    }
    await model.redeem(code: String(repeating: "c", count: 43))
    let originalID = try #require(sentID)
    #expect(model.pendingRedeemRequestId == originalID)
    #expect(
      !defaults.dictionaryRepresentation().values.contains {
        String(describing: $0).contains(String(repeating: "c", count: 43))
      })
    control.handler = { method, params in
      if method == "pairing.result" {
        #expect(params?["requestId"]?.string == originalID)
        return .object([
          "requestId": .string(originalID), "groupId": .null, "directory": control.directory,
        ])
      }
      return nil
    }
    let restored = DeviceSettingsViewModel(control: control, defaults: defaults)
    await restored.startIfNeeded()
    #expect(restored.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
    #expect(control.calls.filter { $0.0 == "pairing.redeem" }.count == 1)
  }

  @Test("late UI decisions cannot approve a replacement operation")
  func approvalIdentity() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let expiry = Int64(Date().timeIntervalSince1970 * 1000) + 60000
    let first = try deviceApproval(expiresAt: expiry)
    let second = try deviceApproval(expiresAt: expiry)
    let callback = try #require(control.confirm)
    let firstResult = Task { await callback(first) }
    while model.pendingApproval == nil { await Task.yield() }
    model.respondToApproval(false, requestId: first.id)
    #expect(await firstResult.value == false)
    let secondResult = Task { await callback(second) }
    while model.pendingApproval == nil { await Task.yield() }
    model.respondToApproval(true, requestId: first.id)
    #expect(model.pendingApproval?.id == second.id)
    model.respondToApproval(false, requestId: second.id)
    #expect(await secondResult.value == false)
  }

  @Test("approval times out without a UI response and cancellation denies")
  func approvalTimeout() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let callback = try #require(control.confirm)
    let request = try deviceApproval(expiresAt: Int64(Date().timeIntervalSince1970 * 1000) + 100)
    #expect(await callback(request) == false)
    #expect(model.pendingApproval == nil)
    let next = try deviceApproval(expiresAt: Int64(Date().timeIntervalSince1970 * 1000) + 60000)
    let result = Task { await callback(next) }
    while model.pendingApproval == nil { await Task.yield() }
    result.cancel()
    #expect(await result.value == false)
  }

  @Test("approval requires an explicit current unexpired decision and disable denies")
  func approval() async throws {
    let clock = DeviceSettingsClock()
    let (model, control, defaults) = deviceSettingsFixture(now: { clock.date })
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let request = try deviceApproval(
      expiresAt: Int64(clock.date.timeIntervalSince1970 * 1000) + 60000)
    let callback = try #require(control.confirm)
    let accepted = Task { await callback(request) }
    while model.pendingApproval == nil { await Task.yield() }
    #expect(model.pendingApproval?.operation["command"]?.string == "echo hello")
    model.respondToApproval(true, requestId: request.id)
    #expect(await accepted.value)
    let expired = Task { await callback(request) }
    while model.pendingApproval == nil { await Task.yield() }
    clock.date = clock.date.addingTimeInterval(61)
    model.respondToApproval(true, requestId: request.id)
    #expect(await expired.value == false)
    clock.date = clock.date.addingTimeInterval(-61)
    let stopped = Task { await callback(request) }
    while model.pendingApproval == nil { await Task.yield() }
    await model.setEnabled(false)
    #expect(await stopped.value == false)
    #expect(model.pendingApproval == nil)
  }
}

@MainActor final class DeviceSettingsClock {
  var date = Date(timeIntervalSince1970: 1_800_000_000)
}

@MainActor final class DeviceSettingsControlStub: DeviceControl {
  let domain = "EagleDeviceSettingsTests.\(UUID().uuidString)"
  var starts = 0
  var stops = 0
  var openedSettings = 0
  var stopGate: (() async -> Void)?
  var statusGate: (() async -> Void)?
  var stopError: (any Error)?
  var startError: (any Error)?
  var confirm: (@MainActor @Sendable (DeviceApprovalRequest) async -> Bool)?
  var calls: [(String, DeviceJSON?)] = []
  var directory = deviceDirectory()
  var policy: DeviceJSON = .object(["mode": .string("all-approve"), "version": .number(1)])
  var handler: ((String, DeviceJSON?) throws -> DeviceJSON?)?
  var asyncHandler: ((String, DeviceJSON?) async throws -> DeviceJSON?)?
  func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    starts += 1
    if let startError { throw startError }
    self.confirm = confirm
  }
  func call(_ method: String, params: DeviceJSON?) async throws -> DeviceJSON {
    calls.append((method, params))
    if let result = try await asyncHandler?(method, params) { return result }
    if method == "service.status" { await statusGate?() }
    if let result = try handler?(method, params) { return result }
    switch method {
    case "service.status":
      return .object([
        "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(true),
        "cloudStatus": .string("offline"),
      ])
    case "directory": return directory
    case "policy.get": return policy
    case "policy.set":
      policy = .object(["mode": params?["mode"] ?? .null, "version": .number(2)])
      return policy
    case "pairing.create":
      return .object(["code": .string("memory-only-code"), "expiresAt": .number(1_900_000_000_000)])
    case "pairing.revoke", "member.remove": return .object([:])
    default: throw DevicePortError("result_not_found")
    }
  }
  func stop() async throws {
    stops += 1
    await stopGate?()
    if let stopError { throw stopError }
  }
  func openSystemSettings() { openedSettings += 1 }
}

let deviceSettingsLocalID = "11111111-1111-4111-8111-111111111111"

func deviceDirectory(observation: String = "first", online: Bool? = nil) -> DeviceJSON {
  .object([
    "localDeviceId": .string(deviceSettingsLocalID), "groupId": .null,
    "revision": .number(1), "observationRevision": .string(observation),
    "devices": .array([
      .object([
        "deviceId": .string(deviceSettingsLocalID), "name": .string("This Mac"),
        "platform": .string("darwin"), "arch": .string("arm64"), "groupId": .null,
        "membershipEpoch": .number(0), "credentialVersion": .number(1),
        "online": online.map(DeviceJSON.bool) ?? .null, "lastSeenAt": .null,
        "capabilities": .null, "policy": .null,
      ])
    ]),
  ])
}

@MainActor func deviceSettingsFixture(
  requiresServiceAddress: Bool? = false,
  now: @escaping @MainActor () -> Date = { Date() }
) -> (DeviceSettingsViewModel, DeviceSettingsControlStub, UserDefaults) {
  let control = DeviceSettingsControlStub()
  let defaults = UserDefaults(suiteName: control.domain)!
  return (
    DeviceSettingsViewModel(
      control: control, defaults: defaults,
      requiresServiceAddress: requiresServiceAddress, now: now),
    control, defaults
  )
}

func deviceApproval(expiresAt: Int64) throws -> DeviceApprovalRequest {
  let operation: DeviceJSON = .object([
    "kind": .string("command"), "command": .string("echo hello"),
  ])
  return try DeviceJSON.object([
    "requestId": .string(UUID().uuidString), "operationId": .string(UUID().uuidString),
    "sourceDeviceId": .string(deviceSettingsLocalID), "targetDeviceId": .string(UUID().uuidString),
    "operation": operation, "digest": .string(try DeviceApprovalRequest.digest(operation)),
    "policyVersion": .number(1), "expiresAt": .number(Double(expiresAt)),
  ]).decoded(DeviceApprovalRequest.self)
}

@Suite("Device service address configuration", .serialized)
@MainActor
struct DeviceServiceAddressConfigurationTests {
  @Test("a bundle without a relay never starts the service before a person names one")
  func unconfiguredStaysIdle() async throws {
    let (model, control, defaults) = deviceSettingsFixture(requiresServiceAddress: true)
    defer { defaults.removePersistentDomain(forName: control.domain) }
    #expect(model.needsServiceAddress)
    await model.startIfNeeded()
    #expect(control.starts == 0)
    #expect(!model.localReady)
  }

  @Test("saving an origin is stored and starts the service; a bad value is refused")
  func savingOrigin() async throws {
    let (model, control, defaults) = deviceSettingsFixture(requiresServiceAddress: true)
    defer { defaults.removePersistentDomain(forName: control.domain) }
    model.serviceAddressDraft = "http://devices.example.com"
    await model.saveServiceAddress()
    #expect(model.errorCode == "invalid_service_address")
    #expect(control.starts == 0)
    #expect(DeviceServiceAddress.saved(defaults) == nil)

    model.serviceAddressDraft = "https://Devices.Example.com/"
    await model.saveServiceAddress()
    #expect(model.errorCode == nil)
    #expect(DeviceServiceAddress.saved(defaults) == "https://devices.example.com")
    #expect(!model.needsServiceAddress)
    #expect(control.starts == 1)
  }
}
