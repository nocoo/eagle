import Foundation

@main struct EncryptedObjectFixture {
  @MainActor static func main() async {
    do {
      var lines = FileHandle.standardInput.bytes.lines.makeAsyncIterator()
      guard let first = try await lines.next() else { return }
      let config = try JSONDecoder().decode(DeviceJSON.self, from: Data(first.utf8))
      guard let root = config["root"]?.string, let origin = config["origin"]?.string,
        let node = config["node"]?.string, let entry = config["entry"]?.string
      else { throw DeviceHostError.invalidConfiguration }
      let directory = URL(fileURLWithPath: root, isDirectory: true)
      let vault = DeviceFileVault(directory: directory.appendingPathComponent("vault"))
      let profile = "encrypted-object-fixture"
      let identity = try DeviceIdentity.loadOrCreate(profile: profile, vault: vault)
      let configurationData = try JSONSerialization.data(withJSONObject: [
        "version": 1, "profile": profile, "baseUrl": origin,
        "machServiceName": "ai.hexly.eagle.devices.fixture",
        "launchAgentPlist": "ai.hexly.eagle.devices.fixture.plist",
      ])
      let configuration = try JSONDecoder().decode(
        DeviceHostConfiguration.self, from: configurationData)
      let host = DeviceServiceHost(
        identity: identity, configuration: configuration,
        node: URL(fileURLWithPath: node), entry: URL(fileURLWithPath: entry),
        stateDirectory: directory.appendingPathComponent("state"), vault: vault)
      try host.start()
      let waitCloud = config["waitCloud"]?.bool ?? true
      for _ in 0..<480 {
        if host.localReady && (!waitCloud || host.cloudStatus == "online") { break }
        try await Task.sleep(for: .milliseconds(25))
      }
      guard host.localReady && (!waitCloud || host.cloudStatus == "online") else {
        await host.stop()
        throw DevicePortError(host.failure ?? "fixture_registration_timeout")
      }
      // Each startup explicitly supplies tool approval when the current mode is not all-approve.
      let policy = try await host.call("policy.get")
      if policy["mode"]?.string != "all-approve" {
        _ = try await host.call("policy.set", params: .object(["mode": .string("all-approve")]))
      }
      emit(
        .object([
          "type": .string("ready"), "deviceId": .string(identity.deviceId),
          "publicKey": .string(identity.publicKey), "socketPath": .string(host.socketPath),
        ]))
      while let line = try await lines.next() {
        let input = try JSONDecoder().decode(DeviceJSON.self, from: Data(line.utf8))
        guard let method = input["method"]?.string, let id = input["requestId"]?.string else {
          throw DeviceHostError.invalidConfiguration
        }
        do {
          let result = try await host.call(method, params: input["params"])
          emit(.object(["type": .string("managed"), "requestId": .string(id), "result": result]))
        } catch {
          emit(
            .object([
              "type": .string("managed"), "requestId": .string(id),
              "error": .string(String(describing: error)),
            ]))
        }
      }
      await host.stop()
    } catch {
      FileHandle.standardError.write(Data("fixture_failed: \(error)\n".utf8))
      exit(1)
    }
  }
  static func emit(_ value: DeviceJSON) {
    if var data = try? JSONEncoder().encode(value) {
      data.append(10)
      FileHandle.standardOutput.write(data)
    }
  }
}
