import Combine
import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Device settings refresh", .serialized)
@MainActor
struct DeviceSettingsRefreshTests {
  @Test("local startup avoids cloud directory reads until the device view opens")
  func localStartupWithoutDirectory() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    await model.startLocal()
    #expect(model.localReady)
    #expect(control.calls.allSatisfy { $0.0 != "directory" })
    let visible = Task { await model.observe() }
    while clock.waits == 0 { await Task.yield() }
    #expect(control.calls.filter { $0.0 == "directory" }.count == 1)
    visible.cancel()
    await visible.value
    while !clock.waiters.isEmpty { await Task.yield() }
    clock.advance()
    #expect(control.calls.filter { $0.0 == "directory" }.count == 1)
  }

  @Test("visible device panels wake shared local observation and closing stops cloud reads")
  func visiblePanelWithLocalObservers() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    let first = Task { await model.observeLocal() }
    while clock.waits == 0 { await Task.yield() }
    let second = Task { await model.observeLocal() }
    while model.observationCount < 2 { await Task.yield() }
    #expect(clock.waits == 1)
    #expect(control.calls.allSatisfy { $0.0 != "directory" })
    let visible = Task { await model.observe() }
    while clock.waits < 2 { await Task.yield() }
    #expect(control.calls.filter { $0.0 == "directory" }.count == 1)
    visible.cancel()
    await visible.value
    clock.advance()
    while clock.waits < 3 { await Task.yield() }
    #expect(control.calls.filter { $0.0 == "directory" }.count == 1)
    first.cancel()
    second.cancel()
    await first.value
    await second.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("a cancelled old observation cannot clear its replacement's wait")
  func oldObservationCannotClearNewWait() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    var model: DeviceSettingsViewModel?
    var first: Task<Void, Never>?
    var replacement: Task<Void, Never>?
    var release: CheckedContinuation<Void, Never>?
    var waits = 0
    model = DeviceSettingsViewModel(
      control: control, defaults: defaults,
      observationWait: {
        waits += 1
        if waits == 1 {
          await withCheckedContinuation { release = $0 }
          first?.cancel()
          await first?.value
          replacement = Task { if let model { await model.observeLocal() } }
          while clock.waits == 0 { await Task.yield() }
          return
        }
        try await clock.wait()
      })
    let current = try #require(model)
    first = Task { await current.observeLocal() }
    while release == nil { await Task.yield() }
    let old = try #require(current.observationRunner)
    release?.resume()
    await old.value
    #expect(current.observationWaiting)
    replacement?.cancel()
    clock.advance()
    await replacement?.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("closing the panel during a health read skips the following directory request")
  func panelClosesDuringHealthRead() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    let local = Task { await model.observeLocal() }
    while clock.waits == 0 { await Task.yield() }
    var release: CheckedContinuation<Void, Never>?
    control.statusGate = { await withCheckedContinuation { release = $0 } }
    let visible = Task { await model.observe() }
    while release == nil { await Task.yield() }
    visible.cancel()
    await visible.value
    control.statusGate = nil
    release?.resume()
    while clock.waits < 2 { await Task.yield() }
    #expect(control.calls.allSatisfy { $0.0 != "directory" })
    local.cancel()
    await local.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("a device view joining local startup reads the directory immediately")
  func viewJoinsLocalStartup() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    var release: CheckedContinuation<Void, Never>?
    control.startGate = { await withCheckedContinuation { release = $0 } }
    let startup = Task { await model.startLocal() }
    while release == nil { await Task.yield() }
    let visible = Task { await model.observe() }
    while model.observationCount == 0 { await Task.yield() }
    release?.resume()
    await startup.value
    while clock.waits == 0 { await Task.yield() }
    #expect(model.localReady)
    #expect(model.directory != nil)
    #expect(control.calls.filter { $0.0 == "directory" }.count == 1)
    visible.cancel()
    await visible.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("local health recovers without a visible device panel or directory poll")
  func backgroundLocalHealth() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    var ready = false
    control.handler = { method, _ in
      if method == "service.status" {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(ready),
          "cloudStatus": .string("offline"), "relayOrigin": .string("https://devices.example"),
        ])
      }
      return nil
    }
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    let background = Task { await model.observeLocal() }
    defer { background.cancel() }
    while clock.waits == 0 { await Task.yield() }
    #expect(!model.localReady)
    ready = true
    clock.advance()
    while clock.waits < 2 { await Task.yield() }
    #expect(model.localReady)
    #expect(control.calls.allSatisfy { $0.0 != "directory" })
    background.cancel()
    await background.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("a panel joining the initial health read gets its directory without a timer tick")
  func panelJoinsHealthRead() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    var release: CheckedContinuation<Void, Never>?
    control.statusGate = { await withCheckedContinuation { release = $0 } }
    let startup = Task { await model.startLocal() }
    while release == nil { await Task.yield() }
    let visible = Task { await model.observe() }
    while model.observationCount == 0 { await Task.yield() }
    control.statusGate = nil
    release?.resume()
    await startup.value
    while clock.waits == 0 { await Task.yield() }
    #expect(model.directory != nil)
    #expect(control.calls.filter { $0.0 == "directory" }.count == 1)
    visible.cancel()
    await visible.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("a panel closed during startup does not fetch the directory")
  func panelClosesDuringStartup() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    var release: CheckedContinuation<Void, Never>?
    control.startGate = { await withCheckedContinuation { release = $0 } }
    let startup = Task { await model.startLocal() }
    while release == nil { await Task.yield() }
    let visible = Task { await model.observe() }
    while model.observationCount == 0 { await Task.yield() }
    visible.cancel()
    await visible.value
    release?.resume()
    await startup.value
    await Task.yield()
    #expect(control.calls.allSatisfy { $0.0 != "directory" })
  }

  @Test("settings, inspector and windows share one cancellable observation lifecycle")
  func sharedObservation() async throws {
    let (_, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    let clock = DeviceObservationClock()
    let model = DeviceSettingsViewModel(
      control: control, defaults: defaults, observationWait: { try await clock.wait() })
    let first = Task { await model.observe() }
    while clock.waits == 0 { await Task.yield() }
    let second = Task { await model.observe() }
    let third = Task { await model.observe() }
    defer {
      first.cancel()
      second.cancel()
      third.cancel()
    }
    try await Task.sleep(for: .milliseconds(20))
    #expect(clock.waits == 1)
    #expect(control.starts == 1)
    #expect(control.calls.filter { $0.0 == "service.status" }.count == 1)
    first.cancel()
    await first.value
    second.cancel()
    await second.value
    control.directory = deviceDirectory(observation: "next-tick", online: true)
    clock.advance()
    while clock.waits < 2 { await Task.yield() }
    #expect(clock.waits == 2)
    #expect(model.directory?.observationRevision == "next-tick")
    #expect(control.calls.filter { $0.0 == "service.status" }.count == 2)
    third.cancel()
    await third.value
    while !clock.waiters.isEmpty { await Task.yield() }
    let again = Task { await model.observe() }
    defer { again.cancel() }
    while clock.waits < 3 { await Task.yield() }
    #expect(control.starts == 1)
    #expect(control.calls.filter { $0.0 == "service.status" }.count == 3)
    again.cancel()
    await again.value
    while !clock.waiters.isEmpty { await Task.yield() }
  }

  @Test("unchanged background reads publish nothing and never disable local controls")
  func unchangedRefresh() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var publications = 0
    let observer = model.objectWillChange.sink { publications += 1 }
    defer { observer.cancel() }
    var release: CheckedContinuation<Void, Never>?
    control.statusGate = { await withCheckedContinuation { release = $0 } }
    let reading = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    #expect(!model.controlsBusy)
    #expect(publications == 0)
    release?.resume()
    await reading.value
    #expect(publications == 0)
    control.statusGate = nil
    control.directory = deviceDirectory(observation: "online", online: true)
    await model.refresh()
    #expect(publications > 0)
    #expect(model.directory?.devices.first?.online == true)
    publications = 0
    control.handler = { method, _ in
      if method == "service.status" { throw DevicePortError("revoked_session") }
      return nil
    }
    await model.refresh()
    #expect(publications > 0)
    #expect(!model.localReady && model.directoryIsStale)
    #expect(model.errorCode == "revoked_session")
  }

  @Test("an offline directory does not flash the helper's cached online status on every read")
  func stableOfflineDirectory() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.handler = { method, _ in
      if method == "service.status" {
        return .object([
          "deviceId": .string(deviceSettingsLocalID), "localReady": .bool(true),
          "cloudStatus": .string("online"), "relayOrigin": .string("https://devices.example"),
        ])
      }
      if method == "directory", case .object(var directory) = control.directory {
        directory["cloudStatus"] = .string("offline")
        return .object(directory)
      }
      return nil
    }
    await model.startIfNeeded()
    #expect(model.cloudStatus == "offline")
    var publications = 0
    let observer = model.objectWillChange.sink { publications += 1 }
    defer { observer.cancel() }
    await model.refresh()
    #expect(model.localReady)
    #expect(model.cloudStatus == "offline")
    #expect(publications == 0)
  }

  @Test("late policy replies cannot overwrite a completed policy write")
  func latePolicy() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let old = control.policy
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { method, _ in
      guard method == "policy.get", release == nil else { return nil }
      await withCheckedContinuation { release = $0 }
      return old
    }
    let reading = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    await model.setPolicy(.paused)
    release?.resume()
    await reading.value
    #expect(model.policy?.mode == .paused)
    #expect(model.policy?.version == 2)
  }

  @Test(
    "front-end input rejection supersedes old reads without changing the pending pairing binding",
    arguments: ["directory", "policy.get"], [false, true])
  func preflightSupersedesRead(method: String, fails: Bool) async throws {
    for rejection in ["invalid_pairing_code", "empty_pairing_code", "invalid_pairing_ttl"] {
      let (model, control, defaults) = deviceSettingsFixture()
      defer { defaults.removePersistentDomain(forName: control.domain) }
      await model.startIfNeeded()
      control.handler = { requested, _ in
        if requested == "pairing.redeem" { throw DeviceHostError.timeout }
        return nil
      }
      await model.redeem(code: String(repeating: "c", count: 43))
      let requestID = try #require(model.pendingRedeemRequestId)
      let binding = try #require(
        defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey)?["codeHash"]
          as? String)
      let old = method == "directory" ? control.directory : control.policy
      var release: CheckedContinuation<Void, Never>?
      control.asyncHandler = { requested, _ in
        guard requested == method else { return nil }
        await withCheckedContinuation { release = $0 }
        if fails { throw DevicePortError("invalid_session") }
        return old
      }
      let reading = Task { await model.refresh() }
      while release == nil { await Task.yield() }
      let before = control.calls.count
      switch rejection {
      case "empty_pairing_code": await model.redeem(code: "  ")
      case "invalid_pairing_ttl": await model.createPairing(ttlSeconds: 86401)
      default: await model.redeem(code: "invalid-code")
      }
      #expect(model.errorCode == rejection)
      #expect(control.calls.count == before)
      release?.resume()
      await reading.value
      #expect(model.errorCode == rejection)
      #expect(model.pendingRedeemRequestId == requestID)
      #expect(
        defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey)?["requestId"]
          as? String
          == requestID)
      #expect(
        defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey)?["codeHash"]
          as? String
          == binding)
      #expect(model.localReady && !model.directoryIsStale)
    }
  }

  @Test("background reads wait for user mutations instead of sampling their intermediate state")
  func readDuringMutation() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { method, _ in
      if method == "policy.set" { await withCheckedContinuation { release = $0 } }
      return nil
    }
    let writing = Task { await model.setPolicy(.paused) }
    while release == nil { await Task.yield() }
    let before = control.calls.count
    await model.refresh()
    #expect(control.calls.count == before)
    #expect(model.localReady)
    release?.resume()
    await writing.value
    #expect(model.policy?.mode == .paused)
  }

  @Test("a late status failure cannot erase an uncertain pairing error or original ID")
  func lateStatusAfterUncertainPairing() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { method, _ in
      guard method == "service.status" else { return nil }
      await withCheckedContinuation { release = $0 }
      throw DevicePortError("revoked_session")
    }
    let reading = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    control.handler = { method, _ in
      if method == "pairing.redeem" { throw DeviceHostError.timeout }
      return nil
    }
    await model.redeem(code: String(repeating: "b", count: 43))
    let original = try #require(model.pendingRedeemRequestId)
    release?.resume()
    await reading.value
    #expect(model.localReady)
    #expect(model.errorCode == "device_service_timeout")
    #expect(model.pendingRedeemRequestId == original)
    #expect(
      defaults.dictionary(forKey: DeviceSettingsViewModel.pendingRedeemKey)?["requestId"] as? String
        == original)
  }

  @Test(
    "late directory and errors cannot overwrite pairing or its original recovery ID",
    arguments: [false, true])
  func latePairingRead(fails: Bool) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let old = control.directory
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { method, _ in
      guard method == "directory", release == nil else { return nil }
      await withCheckedContinuation { release = $0 }
      if fails { throw DeviceHostError.unavailable }
      return old
    }
    let reading = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    control.directory = deviceDirectory(observation: "paired", online: true)
    control.handler = { method, params in
      if method == "pairing.redeem" {
        return .object([
          "requestId": params?["requestId"] ?? .null, "directory": control.directory,
        ])
      }
      return nil
    }
    await model.redeem(code: String(repeating: "a", count: 43))
    release?.resume()
    await reading.value
    #expect(model.directory?.observationRevision == "paired")
    #expect(!model.directoryIsStale)
    #expect(model.errorCode == nil)
    #expect(model.pendingRedeemRequestId == nil)
  }

  @Test("a machine added by pairing starts out asking before anything runs on it")
  func addedDeviceAsks() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    let peer = UUID().uuidString
    let paired = DeviceJSON.object([
      "localDeviceId": .string(deviceSettingsLocalID), "groupId": .string(UUID().uuidString),
      "revision": .number(2), "observationRevision": .string("paired"),
      "relayOrigin": .string("https://devices.example"),
      "devices": .array([
        .object([
          "deviceId": .string(deviceSettingsLocalID), "name": .string("This Mac"),
          "platform": .string("darwin"), "arch": .string("arm64"),
          "groupId": .null, "membershipEpoch": .number(0), "credentialVersion": .number(1),
          "online": .bool(true), "lastSeenAt": .number(1), "capabilities": .null,
          "policy": .object(["mode": .string("all-approve"), "version": .number(1)]),
        ]),
        .object([
          "deviceId": .string(peer), "name": .string("Other Mac"),
          "platform": .string("darwin"), "arch": .string("arm64"),
          "groupId": .null, "membershipEpoch": .number(1), "credentialVersion": .number(1),
          "online": .bool(true), "lastSeenAt": .number(1),
          "capabilities": .array([.string("command"), .string("policy.manage")]),
          "policy": .object(["mode": .string("all-approve"), "version": .number(1)]),
        ]),
      ]),
    ])
    control.handler = { method, params in
      if method == "pairing.redeem" {
        return .object(["requestId": params?["requestId"] ?? .null, "directory": paired])
      }
      return nil
    }
    await model.redeem(code: String(repeating: "a", count: 43))
    // The request is sent after the pairing settles; wait for it rather than sleep.
    for _ in 0..<80
    where !control.calls.contains(where: { method, params in
      method == "policy.set" && params?["deviceId"]?.string == peer
    }) {
      await Task.yield()
    }
    let asked = control.calls.first { method, params in
      method == "policy.set" && params?["deviceId"]?.string == peer
    }
    #expect(asked?.1?["mode"]?.string == "always-ask")
    #expect(control.calls.contains { $0.0 == "policy.set" && $0.1?["deviceId"] == nil } == false)
  }

  @Test(
    "late reads after stop cannot revive readiness, directory or errors",
    arguments: ["service.status", "directory", "policy.get"])
  func lateStop(method: String) async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    await model.startIfNeeded()
    var release: CheckedContinuation<Void, Never>?
    control.asyncHandler = { requested, _ in
      guard requested == method else { return nil }
      await withCheckedContinuation { release = $0 }
      if method == "policy.get" { throw DevicePortError("invalid_session") }
      return nil
    }
    let reading = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    await model.setEnabled(false)
    release?.resume()
    await reading.value
    #expect(!model.enabled && !model.localReady)
    #expect(model.cloudStatus == "unknown")
    #expect(model.directoryIsStale)
    #expect(model.errorCode == nil)
  }
}

@MainActor private final class DeviceObservationClock {
  var waits = 0
  var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]

  func wait() async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      try await withCheckedThrowingContinuation { continuation in
        waits += 1
        waiters[id] = continuation
      }
    } onCancel: {
      Task { @MainActor in
        self.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
      }
    }
  }

  func advance() {
    let pending = waiters.values
    waiters.removeAll()
    for continuation in pending { continuation.resume() }
  }
}
