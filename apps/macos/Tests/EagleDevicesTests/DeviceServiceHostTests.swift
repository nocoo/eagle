import Foundation
import Testing

@testable import EagleDevices

private final class HostVault: DeviceIdentityVault, @unchecked Sendable {
  var data: Data?
  func read(account: String) throws -> Data? { data }
  func insert(_ value: Data, account: String) throws -> Bool {
    data = value
    return true
  }
}

@Suite("Private device host") @MainActor
struct DeviceServiceHostTests {
  private func host(delayedExit: Bool = false) throws -> DeviceServiceHost {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(
      "../../../../"
    ).standardizedFileURL
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", "-p", "process.execPath"]
    let output = Pipe()
    process.standardOutput = output
    try process.run()
    let path = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    process.waitUntilExit()
    let directory = URL(fileURLWithPath: "/tmp/eagle-host-" + UUID().uuidString.prefix(12))
    var entry = root.appendingPathComponent("packages/agent/dist/agent/device-service.js")
    if delayedExit {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      let script = """
        import {appendFileSync} from 'node:fs';
        import {runDeviceService} from '\(entry.absoluteString)';
        appendFileSync(new URL('starts',import.meta.url), String(process.pid)+'\\n');
        process.stdin.once('end',()=>setTimeout(()=>{},500));
        await runDeviceService();
        """
      entry = directory.appendingPathComponent("delayed-exit.mjs")
      try Data(script.utf8).write(to: entry)
    }
    let configuration = try JSONDecoder().decode(
      DeviceHostConfiguration.self,
      from: Data(
        #"{"version":1,"profile":"isolated-test","baseUrl":"http://127.0.0.1:1","machServiceName":"ai.hexly.eagle.devices.test","launchAgentPlist":"ai.hexly.eagle.devices.test.plist"}"#
          .utf8))
    return DeviceServiceHost(
      identity: try .loadOrCreate(profile: "test", vault: HostVault()),
      configuration: configuration,
      node: URL(fileURLWithPath: path),
      entry: entry,
      stateDirectory: directory)
  }
  private func ready(_ host: DeviceServiceHost) async throws {
    try host.start()
    for _ in 0..<200 {
      if host.localReady { return }
      if host.failure != nil { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw DevicePortError(host.failure ?? "host_not_ready")
  }
  private func clean(_ host: DeviceServiceHost) async throws {
    await host.stop()
    try FileManager.default.removeItem(at: host.stateDirectory)
  }

  @Test("authenticated helper handshake is independent of Node and cloud readiness")
  func helperHandshake() async throws {
    let host = try host()
    let current = try DeviceCodeIdentity.currentRequirement()
    let listener = NSXPCListener.anonymous()
    let server = DeviceXPCServer(host: host, requiredPeer: current)
    listener.delegate = server
    listener.resume()
    let client = DeviceXPCClient(
      connection: NSXPCConnection(listenerEndpoint: listener.endpoint), requiredPeer: current,
      confirm: { _ in false })
    defer {
      client.invalidate()
      withExtendedLifetime(server) { listener.invalidate() }
    }
    // The first round trip also builds the connection, so a one-second budget measures the
    // connection setup as much as the handshake; a slow CI runner then reports a timeout
    // for a helper that is answering. Warm the connection once, then hold the answer to the
    // budget the test is about.
    _ = try await client.call("service.ping", timeoutSeconds: 30)
    let reply = try await client.call("service.ping", timeoutSeconds: 1)
    #expect(reply["version"] == .number(1))
    #expect(!host.localReady)
    #expect(host.cloudStatus == "offline")
  }

  @Test("helper configures offline tools automatically and keeps management off the Bot socket")
  func offline() async throws {
    let host = try host()
    try await ready(host)
    do {
      #expect(host.cloudStatus == "offline")
      let port = DeviceLocalPort(path: host.socketPath)
      let status = try await port.call("status")
      #expect(status["localReady"] == .bool(true))
      // A device nobody decided about asks before it acts...
      #expect(status["policy"]?["mode"]?.string == "always-ask")
      // ...and this case is about the tool path once the person has allowed it.
      _ = try await host.call("policy.set", params: .object(["mode": .string("all-approve")]))
      let output = host.stateDirectory.appendingPathComponent("proof.txt")
      let operation: DeviceJSON = .object([
        "kind": .string("file.write"), "path": .string(output.path), "content": .string("真实本机"),
      ])
      let request: DeviceJSON = .object([
        "requestId": .string(UUID().uuidString.lowercased()),
        "operationId": .string(UUID().uuidString.lowercased()),
        "targetDeviceId": .string(host.identity.deviceId), "action": .string("run"),
        "operation": operation, "digest": .string(try DeviceApprovalRequest.digest(operation)),
      ])
      let initial = try await port.call("execute", params: request)
      #expect(["running", "completed"].contains(initial["status"]?.string ?? ""))
      for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: output.path) { break }
        try await Task.sleep(for: .milliseconds(10))
      }
      #expect(try String(contentsOf: output, encoding: .utf8) == "真实本机")
      await #expect(throws: DevicePortError.self) {
        try await port.call("policy.set", params: .object(["mode": .string("paused")]))
      }
      let policy = try await host.call("policy.set", params: .object(["mode": .string("paused")]))
      #expect(policy["mode"]?.string == "paused")
      #expect(try await port.call("status")["policy"]?["mode"]?.string == "paused")
    } catch {
      try await clean(host)
      throw error
    }
    try await clean(host)
  }

  @Test("only an attached App confirmation signs a complete typed service approval")
  func confirmation() async throws {
    let host = try host()
    try await ready(host)
    do {
      let policy = try await host.call(
        "policy.set", params: .object(["mode": .string("always-ask")]))
      let operation: DeviceJSON = .object([
        "kind": .string("command"), "command": .string("printf approved"),
      ])
      let request: DeviceJSON = .object([
        "requestId": .string(UUID().uuidString.lowercased()),
        "operationId": .string(UUID().uuidString.lowercased()),
        "targetDeviceId": .string(host.identity.deviceId), "action": .string("run"),
        "operation": operation, "digest": .string(try DeviceApprovalRequest.digest(operation)),
      ])
      let params: DeviceJSON = .object([
        "request": request, "policyVersion": policy["version"] ?? .null,
        "expiresAt": .number(Double(Int64(Date().timeIntervalSince1970 * 1000) + 30000)),
      ])
      let port = DeviceLocalPort(path: host.socketPath)
      await #expect(throws: DevicePortError.self) {
        try await port.call("approval.request", params: params)
      }
      var seen: DeviceApprovalRequest?
      host.approver = { request in
        seen = request
        return true
      }
      var approved: DeviceJSON?
      do { approved = try await port.call("approval.request", params: params) } catch {}
      #expect(seen?.operation == operation)
      #expect(approved?["approval"]?["signature"]?.string != nil)
      host.approver = { _ in false }
      await #expect(throws: DevicePortError.self) {
        try await port.call("approval.request", params: params)
      }
    } catch {
      try await clean(host)
      throw error
    }
    try await clean(host)
  }

  @Test("real XPC rejects a same-UID process with the wrong code identity before management")
  func codeIdentity() async throws {
    let host = try host()
    try await ready(host)
    let current = try DeviceCodeIdentity.currentRequirement()
    let listener = NSXPCListener.anonymous()
    let server = DeviceXPCServer(
      host: host, requiredPeer: "identifier \"ai.hexly.eagle.invalid-test\"")
    listener.delegate = server
    listener.resume()
    let client = DeviceXPCClient(
      connection: NSXPCConnection(listenerEndpoint: listener.endpoint), requiredPeer: current,
      confirm: { _ in false })
    await #expect(throws: DevicePortError.self) {
      try await client.call("policy.set", params: .object(["mode": .string("paused")]))
    }
    #expect(try await host.call("policy.get")["mode"]?.string == "always-ask")
    client.invalidate()
    withExtendedLifetime(server) { listener.invalidate() }
    let trustedListener = NSXPCListener.anonymous()
    let trustedServer = DeviceXPCServer(host: host, requiredPeer: current)
    trustedListener.delegate = trustedServer
    trustedListener.resume()
    let trustedClient = DeviceXPCClient(
      connection: NSXPCConnection(listenerEndpoint: trustedListener.endpoint),
      requiredPeer: current, confirm: { _ in false })
    let policy = try await trustedClient.call(
      "policy.set", params: .object(["mode": .string("paused")]))
    #expect(policy["mode"]?.string == "paused")
    trustedClient.invalidate()
    withExtendedLifetime(trustedServer) { trustedListener.invalidate() }
    try await clean(host)
  }

  @Test("concurrent retries retain exactly one live helper-owned service")
  func concurrentRetry() async throws {
    let host = try host(delayedExit: true)
    let starts = host.stateDirectory.appendingPathComponent("starts")
    // Also clean a child leaked by the pre-fix implementation, using only this fixture's PIDs.
    defer {
      if let content = try? String(contentsOf: starts, encoding: .utf8) {
        for line in content.split(separator: "\n") {
          if let pid = Int32(line) { kill(pid, SIGTERM) }
        }
      }
      try? FileManager.default.removeItem(at: host.stateDirectory)
    }
    try await ready(host)
    do {
      async let first = host.call("service.retry")
      async let second = host.call("service.retry")
      _ = try await (first, second)
      for _ in 0..<200 {
        if host.localReady || host.failure != nil { break }
        try await Task.sleep(for: .milliseconds(10))
      }
      #expect(host.localReady)
      #expect(host.failure == nil)
      #expect(try String(contentsOf: starts, encoding: .utf8).split(separator: "\n").count == 2)
      #expect(try await host.call("service.status")["localReady"] == .bool(true))
      #expect(try await host.call("policy.get")["mode"]?.string == "always-ask")
    } catch {
      await host.stop()
      throw error
    }
    await host.stop()
  }

  @Test("configuration origin matches WHATWG before exact registration signing")
  func normalizedOrigin() throws {
    let config = try JSONDecoder().decode(
      DeviceHostConfiguration.self,
      from: Data(
        #"{"version":1,"profile":"test","baseUrl":"https://EXAMPLE.com:443/","machServiceName":"ai.hexly.eagle.devices","launchAgentPlist":"ai.hexly.eagle.devices.plist"}"#
          .utf8))
    let identity = try DeviceIdentity.loadOrCreate(profile: "test", vault: HostVault())
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let payload = [
      "eagle-device-register-v1", "https://example.com", identity.deviceId, identity.publicKey,
      UUID().uuidString.lowercased(), Data(repeating: 5, count: 32).base64URL, String(now + 30000),
    ].joined(separator: "\n")
    #expect(throws: Never.self) { try config.validate() }
    #expect(config.serviceOrigin == "https://example.com")
    #expect(throws: Never.self) {
      try identity.signRegistration(payload, serviceOrigin: config.serviceOrigin, now: now)
    }
  }

  @Test(
    "the real kernel supplies a stable UUID and build configuration rejects secret-bearing URLs")
  func configuration() throws {
    let first = try #require(DeviceHostConfiguration.bootSessionID())
    #expect(UUID(uuidString: first) != nil)
    #expect(DeviceHostConfiguration.bootSessionID() == first)
    let config = try JSONDecoder().decode(
      DeviceHostConfiguration.self,
      from: Data(
        #"{"version":1,"profile":"test","baseUrl":"https://user:secret@example.com/?token=private","machServiceName":"ai.hexly.eagle.devices.test","launchAgentPlist":"ai.hexly.eagle.devices.test.plist"}"#
          .utf8))
    #expect(throws: DeviceHostError.self) { try config.validate() }
  }
}
