import Foundation
import SuperagentCore
import SuperagentTransport
import XCTest

final class TransportTests: XCTestCase {
  func testEndpointUsesOnlyItsOwnNamespaceAndRefusesMalformedOverrides() throws {
    let endpoint = try SuperagentEndpoint.resolve(environment: [
      "HOME": "/tmp/home", "SUPERAGENT_ROOT": "/tmp/own", "SUPERAGENT_PORT": "45001",
      "EAGLE_TOKEN": "worker", "BOTS_ROOT": "/tmp/worker",
    ])
    XCTAssertEqual(endpoint.root.path, "/tmp/own")
    XCTAssertEqual(endpoint.port, 45001)
    XCTAssertNil(endpoint.tokenOverride)
    XCTAssertThrowsError(
      try SuperagentEndpoint.resolve(environment: ["SUPERAGENT_PORT": "invalid"]))
    let release = try SuperagentEndpoint.resolve(environment: [:], home: "/tmp/home", release: true)
    XCTAssertEqual(release.port, 43128)
    XCTAssertEqual(release.root.lastPathComponent, "eagle-superagent")
  }

  func testScopedCredentialsRejectUnsafeModesAndNeverFallBackFromInvalidOverride() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let token = String(repeating: "a", count: 64)
    let path = root.appendingPathComponent("token")
    try Data(token.utf8).write(to: path)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    let endpoint = try SuperagentEndpoint(root: root, port: 43127)
    XCTAssertEqual(try SuperagentCredentials.read(endpoint), token)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
    XCTAssertThrowsError(try SuperagentCredentials.read(endpoint))
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    XCTAssertThrowsError(
      try SuperagentCredentials.read(
        SuperagentEndpoint(root: root, port: 43127, tokenOverride: "bad")))
  }

  func testRealServiceConnectionVerifiesIdentityAndRefusesUnconfiguredChat() async throws {
    let fixture = try ServiceFixture()
    defer { fixture.stop() }
    let client = SuperagentClient(endpoint: fixture.endpoint)
    do {
      let health = try await client.health()
      XCTAssertEqual(health.service, "eagle-superagent")
      XCTAssertFalse(health.modelReady)
      let events = try await client.events()
      var iterator = events.makeAsyncIterator()
      let first = try await iterator.next()
      XCTAssertEqual(first?.value.botId, "superagent")
      XCTAssertFalse(first?.value.modelReady ?? true)
      // SG-002: an unconfigured observer answers a value, and the transport maps it.
      let observed = try await client.observation()
      XCTAssertEqual(observed.state, .unconfigured)
      XCTAssertTrue(observed.isEmpty)
      let reply = try await client.observeSnapshot()
      XCTAssertEqual(reply.provider.state, "unconfigured")
      let historyReply = try await client.observeHistory(botId: "b_none")
      XCTAssertEqual(historyReply.provider.state, "unconfigured")
      // Without a baseline the consumer asks for a fresh snapshot instead of guessing.
      let changesReply = try await client.observeChanges(limit: 5)
      XCTAssertEqual(changesReply.provider.state, "reset")
      let page = try await client.history(before: nil, limit: 100)
      XCTAssertTrue(page.messages.isEmpty)
      do {
        _ = try await client.submit(PendingInput(text: "hello"))
        XCTFail("unconfigured send must fail")
      } catch { XCTAssertEqual(error as? SuperagentError, .service(.unconfigured)) }
      let configured = try await client.configure(
        ConfigurationChange(
          baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiKey: "fixture-only-key"))
      XCTAssertTrue(configured.hasApiKey)
      let snapshot = try await client.state()
      XCTAssertTrue(snapshot.value.modelReady)
      try await client.abort()
      await client.close()
    } catch {
      await client.close()
      throw error
    }
  }
}

func temporaryRoot() throws -> URL {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(
    "superagent-swift-" + UUID().uuidString)
  try FileManager.default.createDirectory(
    at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  return root
}

final class ServiceFixture {
  let root: URL
  let endpoint: SuperagentEndpoint
  let process: Process
  init() throws {
    root = try temporaryRoot()
    process = Process()
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", "scripts/serve.ts", "--root", root.path, "--port", "0"]
    process.currentDirectoryURL = repository.appendingPathComponent("apps/superagent")
    // The fixture owns its own provider configuration: an empty endpoint is "unconfigured",
    // so a developer's running daemon cannot change what this test observes.
    process.environment = ProcessInfo.processInfo.environment.merging(
      ["BOTS_OBSERVATION_ENDPOINT": "", "BOTS_OBSERVATION_TOKEN_FILE": ""]
    ) { _, fixture in fixture }
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let timeout = DispatchWorkItem { [process] in if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeout)
    let data = output.fileHandleForReading.availableData
    timeout.cancel()
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let port = value["port"] as? Int
    else {
      process.terminate()
      process.waitUntilExit()
      throw SuperagentError.unavailable
    }
    endpoint = try SuperagentEndpoint(root: root, port: port)
  }
  func stop() {
    if process.isRunning {
      process.terminate()
      process.waitUntilExit()
    }
    try? FileManager.default.removeItem(at: root)
  }
}
