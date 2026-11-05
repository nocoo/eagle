import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Device policy settings", .serialized)
@MainActor
struct DeviceSettingsPolicyTests {
  @Test("remote policy changes bind their target and do not change this computer's policy")
  func remotePolicy() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.directory = managedDeviceDirectory()
    await model.startIfNeeded()
    let remote = try #require(model.directory?.devices.last)
    control.handler = { method, _ in
      if method == "policy.set" {
        return .object(["mode": .string("paused"), "version": .number(2)])
      }
      return nil
    }
    await model.setPolicy(.paused, deviceId: remote.deviceId)
    let request = try #require(control.calls.first { $0.0 == "policy.set" }?.1)
    #expect(request["deviceId"]?.string == remote.deviceId)
    #expect(request["requestId"]?.string.flatMap(UUID.init(uuidString:)) != nil)
    #expect(request["relayOrigin"]?.string == "https://devices.example")
    #expect(model.policy?.mode == .allApprove)
    // The older cloud observation must not replace the acknowledged target version.
    #expect(model.policy(for: remote)?.mode == .paused)
    #expect(model.policy(for: remote)?.version == 2)
  }

  @Test("an uncertain remote change asks for a refresh without changing or resending policy")
  func uncertainRemotePolicy() async throws {
    let (model, control, defaults) = deviceSettingsFixture()
    defer { defaults.removePersistentDomain(forName: control.domain) }
    control.directory = managedDeviceDirectory()
    await model.startIfNeeded()
    let remote = try #require(model.directory?.devices.last)
    control.handler = { method, _ in
      if method == "policy.set" {
        throw DevicePortError("policy_result_unknown_refresh_target")
      }
      return nil
    }
    await model.setPolicy(.paused, deviceId: remote.deviceId)
    #expect(model.errorMessage == "权限修改结果尚未确认，请刷新查看这台设备的实际权限。")
    #expect(model.policy(for: remote)?.mode == .allApprove)
    #expect(model.policy?.mode == .allApprove)
    #expect(control.calls.filter { $0.0 == "policy.set" }.count == 1)
  }
}

func managedDeviceDirectory() -> DeviceJSON {
  guard case .object(var directory) = deviceDirectory(online: true),
    case .array(let devices) = directory["devices"], case .object(var local) = devices.first
  else { return .null }
  let policy: DeviceJSON = .object(["mode": .string("all-approve"), "version": .number(1)])
  local["groupId"] = .string("test-group")
  local["policy"] = policy
  local["capabilities"] = .array([.string("command"), .string("policy.manage")])
  var remote = local
  remote["deviceId"] = .string("22222222-2222-4222-8222-222222222222")
  remote["name"] = .string("MacBook")
  directory["groupId"] = .string("test-group")
  directory["devices"] = .array([.object(local), .object(remote)])
  return .object(directory)
}
