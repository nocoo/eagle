import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Device settings recovery", .serialized)
@MainActor
struct DeviceSettingsRecoveryTests {
  @Test("cold local initialization becomes ready without waiting for a directory observation tick")
  func coldStartup() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    var probes = 0
    control.handler = { method, _ in
      guard method == "service.status" else { return nil }
      probes += 1
      if probes == 1 {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(false),
          "cloudStatus": .string("offline"),
        ])
      }
      return nil
    }
    await model.startIfNeeded()
    #expect(model.localReady)
    #expect(model.policy?.mode == .allApprove)
    #expect(probes == 2)
    #expect(control.starts == 1)
  }

  @Test("local readiness and controls are available before a slow cloud directory responds")
  func localReadyBeforeDirectory() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { method, _ in
      if method == "directory" { await withCheckedContinuation { release = $0 } }
      return nil
    }
    let starting = Task { await model.startIfNeeded() }
    while release == nil { await Task.yield() }
    #expect(model.localReady)
    #expect(model.policy?.mode == .allApprove)
    #expect(!model.controlsBusy)
    release?.resume()
    await starting.value
  }

  @Test(
    "disabling after local startup does not wait for a slow cloud directory",
    arguments: [false, true])
  func stopDoesNotWaitForCloudDirectory(pendingPairing: Bool) async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    if pendingPairing {
      defaults.set(
        [
          "requestId": UUID().uuidString.lowercased(),
          "codeHash": String(repeating: "a", count: 64),
          "relayOrigin": "https://devices.example",
        ], forKey: DeviceSettingsViewModel.pendingRedeemKey)
    }
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { method, _ in
      if method == "directory" { await withCheckedContinuation { release = $0 } }
      return nil
    }
    let starting = Task { await model.startIfNeeded() }
    while release == nil { await Task.yield() }
    let stopping = Task { await model.setEnabled(false) }
    try await Task.sleep(for: .milliseconds(30))
    #expect(control.stops == 1)
    release?.resume()
    await starting.value
    await stopping.value
    #expect(!model.enabled)
    #expect(!model.localReady)
    #expect(model.errorCode == nil)
    #expect((model.pendingRedeemRequestId != nil) == pendingPairing)
  }

  @Test("failed helper startup can be retried without toggling the service preference")
  func retryHelperStartup() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.startError = DeviceHostError.unavailable
    await model.startIfNeeded()
    #expect(model.canRetryService)
    control.startError = nil
    await model.retryService()
    #expect(model.localReady)
    #expect(model.enabled)
    #expect(!defaults.bool(forKey: DeviceSettingsViewModel.disabledKey))
    #expect(control.starts == 2)
    #expect(control.stops == 0)
  }

  @Test("failed unregister preserves enabled preference and permits reconnect and retry")
  func failedStop() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.stopError = DeviceHostError.failed
    await model.setEnabled(false)
    #expect(model.enabled)
    #expect(!defaults.bool(forKey: DeviceSettingsViewModel.disabledKey))
    await model.startIfNeeded()
    #expect(control.starts == 2)
    #expect(model.localReady)
    control.stopError = nil
    await model.setEnabled(false)
    #expect(!model.enabled)
    #expect(defaults.bool(forKey: DeviceSettingsViewModel.disabledKey))
  }

  @Test("stop in flight cannot register again after a failed status reset")
  func delayedStopBlocksStartup() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.handler = { method, _ in
      if method == "service.status" { throw DeviceHostError.unavailable }
      return nil
    }
    await model.refresh()
    control.handler = nil
    var release: CheckedContinuation<Void, Never>?
    control.stopGate = { await withCheckedContinuation { release = $0 } }
    let stopping = Task { await model.setEnabled(false) }
    while release == nil { await Task.yield() }
    await model.startIfNeeded()
    #expect(control.starts == 1)
    release?.resume()
    await stopping.value
    #expect(!model.enabled)
  }

  @Test(
    "dead retry code converges only after a current cloud directory",
    arguments: ["pairing_unavailable", "pairing_consumed", "pairing_result_expired"])
  func deadPairingRetry(code error: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: code)
    var confirmed = false
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" { throw DevicePortError(error) }
      if method == "directory" {
        confirmed = true
        return control.directory
      }
      return nil
    }
    await model.redeem(code: code)
    #expect(confirmed)
    #expect(model.errorCode == error)
    #expect(model.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
  }

  @Test("reachable helper surfaces the stable Node failure instead of silently staying unready")
  func nodeFailureStatus() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.handler = { method, _ in
      if method == "service.status" {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(false),
          "cloudStatus": .string("offline"), "error": .string("device_initialization_failed"),
        ])
      }
      return nil
    }
    await model.startIfNeeded()
    #expect(!model.localReady)
    #expect(model.errorCode == "device_initialization_failed")
  }

  @Test("explicit Node retry waits for observed readiness without registering again")
  func retryNode() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    var ready = false
    var retried = false
    control.handler = { method, _ in
      if method == "service.status", !ready {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(false),
          "cloudStatus": .string("offline"),
          "error": retried ? .null : .string("device_initialization_failed"),
        ])
      }
      if method == "service.retry" {
        retried = true
        return .object(["starting": .bool(true)])
      }
      return nil
    }
    await model.startIfNeeded()
    #expect(model.canRetryService)
    let retry = Task { await model.retryService() }
    while !retried { await Task.yield() }
    #expect(!model.localReady)
    ready = true
    await retry.value
    #expect(model.localReady)
    #expect(model.errorCode == nil)
    #expect(control.starts == 1)
    #expect(control.calls.filter { $0.0 == "service.retry" }.count == 1)
  }

  @Test(
    "dead retry retains original ID without a cloud directory",
    arguments: ["offline", "unconfigured", "transport"])
  func deadRetryNeedsDirectory(failure: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: code)
    let original = model.pendingRedeemRequestId
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" { throw DevicePortError("pairing_unavailable") }
      if method == "directory" {
        if failure == "transport" { throw DeviceHostError.timeout }
        guard case .object(var value) = control.directory else { return nil }
        value["cloudStatus"] = .string(failure)
        return .object(value)
      }
      return nil
    }
    await model.redeem(code: code)
    #expect(model.pendingRedeemRequestId == original)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) != nil)
  }

  @Test(
    "rate and session retry uncertainty retain the original binding",
    arguments: ["rate_limited", "invalid_session", "revoked_session", "remote_not_configured"])
  func retryUncertain(error: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: code)
    let original = try #require(model.pendingRedeemRequestId)
    let saved = try #require(defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey))
    let hash = try #require(saved["codeHash"] as? String)
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" { throw DevicePortError(error) }
      return nil
    }
    await model.redeem(code: code)
    #expect(model.pendingRedeemRequestId == original)
    let retained = try #require(
      defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey))
    #expect(retained["requestId"] as? String == original)
    #expect(retained["codeHash"] as? String == hash)
    #expect(model.errorCode == error)
  }

  @Test("a build without a device helper says so instead of looking unconnected")
  func sourceRunExplainsTheMissingHelper() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.startError = DeviceHostError.invalidConfiguration
    await model.startIfNeeded()
    #expect(model.errorCode == "invalid_configuration")
    #expect(model.errorMessage?.contains("安装") == true)
    #expect(model.errorMessage?.contains("源码") == true)
  }

  @Test("startup applies the saved relay before allowing remote pairing")
  func reconcileSavedRelay() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set("https://b.example", forKey: DeviceServiceAddress.defaultsKey)
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, requiresServiceAddress: true)
    await model.startIfNeeded()
    let configure = try #require(control.calls.first { $0.0 == "remote.configure" }?.1)
    #expect(configure["baseUrl"]?.string == "https://b.example")
    #expect(model.localReady)
    #expect(model.canUseRemote)
    control.handler = { method, params in
      if method == "pairing.redeem" {
        #expect(params?["relayOrigin"]?.string == "https://b.example")
        return .object([
          "requestId": .string(try #require(params?["requestId"]?.string)),
          "directory": control.directory,
        ])
      }
      return nil
    }
    await model.redeem(code: String(repeating: "c", count: 43))
    #expect(model.pendingRedeemRequestId == nil)
  }

  @Test("a failed saved-relay reconciliation leaves local tools ready and remote pairing blocked")
  func failedRelayReconciliation() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    defaults.set("https://b.example", forKey: DeviceServiceAddress.defaultsKey)
    control.handler = { method, _ in
      if method == "remote.configure" { throw DeviceHostError.unavailable }
      return nil
    }
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, requiresServiceAddress: true)
    await model.startIfNeeded()
    #expect(model.localReady)
    #expect(!model.canUseRemote)
    await model.redeem(code: String(repeating: "c", count: 43))
    #expect(control.calls.allSatisfy { $0.0 != "pairing.prepare" && $0.0 != "pairing.redeem" })
  }

  @Test("an invalid pending pairing is never replaced or sent")
  func invalidPairingBinding() async throws {
    for value: Any in [
      UUID().uuidString.lowercased(),
      ["requestId": UUID().uuidString.lowercased(), "codeHash": String(repeating: "a", count: 64)],
      [
        "requestId": UUID().uuidString.lowercased(), "codeHash": String(repeating: "a", count: 64),
        "relayOrigin": "https://example.com/path",
      ],
    ] {
      let (_, control, defaults) = deviceSettingsFixture()
      defer { defaults.removePersistentDomain(forName: control.domain) }
      defaults.set(value, forKey: DeviceSettingsViewModel.pendingRedeemKey)
      let restored = DeviceSettingsViewModel(control: control, defaults: defaults)
      await restored.startIfNeeded()
      await restored.redeem(code: String(repeating: "b", count: 43))
      #expect(restored.errorCode == "pairing_binding_unavailable")
      #expect(control.calls.allSatisfy { $0.0 != "pairing.redeem" && $0.0 != "pairing.result" })
      #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) != nil)
    }
  }

  @Test("an uncertain pairing stays bound to its relay across restart and switch")
  func pendingPairingKeepsOrigin() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    var origin = "https://devices.example"
    control.handler = { method, params in
      if method == "service.status" {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(true),
          "cloudStatus": .string("online"), "relayOrigin": .string(origin),
        ])
      }
      if method == "directory", case .object(var directory) = control.directory {
        directory["relayOrigin"] = .string(origin)
        return .object(directory)
      }
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      if method == "pairing.result", case .object(var directory) = control.directory {
        directory["relayOrigin"] = .string(origin)
        return .object([
          "requestId": params?["requestId"] ?? .null, "directory": .object(directory),
        ])
      }
      return nil
    }
    await model.startIfNeeded()
    await model.redeem(code: String(repeating: "a", count: 43))
    let original = try #require(model.pendingRedeemRequestId)
    let saved = try #require(defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey))
    #expect(saved["relayOrigin"] as? String == "https://devices.example")
    origin = "https://other.example"
    await model.refresh()
    let before = control.calls.filter { $0.0 == "pairing.result" }.count
    await model.recoverPairing()
    #expect(model.pendingRedeemRequestId == original)
    #expect(control.calls.filter { $0.0 == "pairing.result" }.count == before)
    let restored = DeviceSettingsViewModel(control: control, defaults: defaults)
    await restored.startIfNeeded()
    #expect(restored.pendingRedeemRequestId == original)
    #expect(control.calls.filter { $0.0 == "pairing.result" }.count == before)
    origin = "https://devices.example"
    await restored.refresh()
    await restored.recoverPairing()
    #expect(restored.pendingRedeemRequestId == nil)
    #expect(control.calls.filter { $0.0 == "pairing.result" }.count == before + 1)
  }

  @Test("an unconfigured first attempt cannot strand a pairing request")
  func unconfiguredFirstAttempt() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let firstCode = String(repeating: "a", count: 43)
    let nextCode = String(repeating: "b", count: 43)
    control.handler = { method, params in
      guard method == "pairing.redeem" else { return nil }
      if params?["code"]?.string == firstCode { throw DevicePortError("remote_not_configured") }
      return .object([
        "requestId": params?["requestId"] ?? .null, "directory": control.directory,
      ])
    }
    await model.redeem(code: firstCode)
    #expect(model.errorCode == "remote_not_configured")
    #expect(model.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
    model.serviceAddressDraft = "https://devices.example.com"
    await model.saveServiceAddress()
    await model.redeem(code: nextCode)
    #expect(model.errorCode == nil)
    #expect(model.pendingRedeemRequestId == nil)
    #expect(control.calls.filter { $0.0 == "pairing.redeem" }.count == 2)
  }

  @Test("self_pairing is a definitive rejection and does not strand a pending request")
  func selfPairing() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DevicePortError("self_pairing") }
      return nil
    }
    await model.redeem(code: String(repeating: "a", count: 43))
    #expect(model.errorCode == "self_pairing")
    #expect(model.errorMessage?.contains("本机") == true)
    #expect(model.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
  }

  @Test("self_pairing remains definitive after an uncertain first transmission")
  func selfPairingAfterLoss() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var lost = true
    control.handler = { method, _ in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" {
        if lost {
          lost = false
          throw DeviceHostError.timeout
        }
        throw DevicePortError("self_pairing")
      }
      return nil
    }
    let code = String(repeating: "a", count: 43)
    await model.redeem(code: code)
    #expect(model.pendingRedeemRequestId != nil)
    await model.redeem(code: code)
    #expect(model.errorCode == "self_pairing")
    #expect(model.pendingRedeemRequestId == nil)
  }

  @Test("pre-send loss retries the same ID only with the original code after result_not_found")
  func retryOriginalBinding() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let code = String(repeating: "a", count: 43)
    var originalID: String?
    control.handler = { method, params in
      if method == "pairing.redeem" {
        originalID = params?["requestId"]?.string
        throw DeviceHostError.timeout
      }
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      return nil
    }
    await model.redeem(code: code)
    let requestId = try #require(originalID)
    let saved = try #require(defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey))
    #expect(saved["requestId"] as? String == requestId)
    #expect((saved["codeHash"] as? String)?.count == 64)
    #expect(!String(describing: saved).contains(code))
    let restored = DeviceSettingsViewModel(control: control, defaults: defaults)
    await restored.startIfNeeded()
    #expect(restored.errorCode == "result_not_found")
    let sent = control.calls.filter { $0.0 == "pairing.redeem" }.count
    await restored.redeem(code: String(repeating: "b", count: 43))
    #expect(restored.errorCode == "request_conflict")
    #expect(control.calls.filter { $0.0 == "pairing.redeem" }.count == sent)
    #expect(restored.pendingRedeemRequestId == requestId)
    control.handler = { method, params in
      if method == "pairing.result" { throw DevicePortError("result_not_found") }
      if method == "pairing.redeem" {
        #expect(params?["requestId"]?.string == requestId)
        #expect(params?["code"]?.string == code)
        return .object(["requestId": .string(requestId), "directory": control.directory])
      }
      return nil
    }
    await restored.redeem(code: code)
    #expect(control.calls.filter { $0.0 == "pairing.redeem" }.count == sent + 1)
    #expect(restored.pendingRedeemRequestId == nil)
    #expect(defaults.object(forKey: DeviceSettingsViewModel.pendingRedeemKey) == nil)
  }
}
