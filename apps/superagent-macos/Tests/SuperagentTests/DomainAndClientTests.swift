import Foundation
import SuperagentCore
import SuperagentTransport
import XCTest

final class DomainAndErrorTests: XCTestCase {
  func testEveryDomainValueRoundTripsThroughTheSharedCodec() throws {
    let identity = ServiceIdentity(
      service: "eagle-superagent", version: "0.1.0", protocolVersion: 1, pid: 1,
      instance: "11111111-1111-4111-8111-111111111111",
      storeId: "22222222-2222-4222-8222-222222222222",
      rootBinding: String(repeating: "a", count: 64))
    try checkRoundTrip(identity)
    try checkRoundTrip(
      ServiceHealth(
        service: identity.service, version: identity.version, protocolVersion: 1, pid: 1,
        instance: identity.instance, storeId: identity.storeId, rootBinding: identity.rootBinding,
        modelReady: false, failure: ServiceFailure(code: ServiceFailure.Code.modelError, id: "f_1"))
    )
    for code in [
      ServiceFailure.Code.storageFailed, .taskParked, .modelTimeout, .modelAuthentication,
      .modelError,
    ] { try checkRoundTrip(ServiceFailure(code: code, id: "f_2")) }
    try checkRoundTrip(
      ModelConfiguration(baseUrl: "http://x", model: "m", thinkingLevel: "high", hasApiKey: true))
    try checkRoundTrip(ConfigurationChange(baseUrl: "http://x", model: "m"))
    try checkRoundTrip(
      ConfigurationChange(baseUrl: "http://x", model: "m", thinkingLevel: "low", apiKey: "k"))
    for role in [ChatMessage.Role.user, .assistant] {
      for state in [ChatMessage.State.complete, .streaming, .error, .aborted] {
        try checkRoundTrip(
          ChatMessage(
            id: "e_1", role: role, text: "t", state: state, createdAt: 1, requestId: "r_1"))
      }
    }
    try checkRoundTrip(QueuedInput(id: "s_1", requestId: "r_1", text: "queued"))
    try checkRoundTrip(ChatWindow(oldestEntryId: 1, newestEntryId: 2, coverage: "window"))
    try checkRoundTrip(
      ChatSnapshot(
        messages: [ChatMessage(id: "e_1", role: .user, text: "hi")], running: true, modelReady: true
      ))
    try checkRoundTrip(SnapshotFrame(instance: identity.instance, rev: 3, value: ChatSnapshot()))
    for status in [
      ChatAdmission.Status.queued, .placed, .done, .unanswered,
    ] {
      try checkRoundTrip(ChatAdmission(id: "s_1", requestId: "r_1", status: status, answer: "a"))
    }
    try checkRoundTrip(
      HistoryPage(messages: [], hasMore: true, nextBefore: 3, coverage: "partial"))
    try checkRoundTrip(PendingInput(id: "r_1", text: "draft", createdAt: 2))
    let first = PendingInput(text: "one")
    let second = PendingInput(text: "two")
    XCTAssertNotEqual(first.id, second.id)
    XCTAssertGreaterThan(first.createdAt, 0)
    XCTAssertTrue(ChatAdmission(id: "s", requestId: "r", status: .done).terminal)
    XCTAssertFalse(ChatAdmission(id: "s", requestId: "r", status: .queued).terminal)
  }

  func testEveryServiceErrorHasAStableVisibleSentence() {
    let errors: [SuperagentError] = [
      .credential, .identity, .unavailable, .protocolViolation, .timeout, .cancelled, .storage,
      .service(.invalidCommand), .service(.unauthorized), .service(.unconfigured), .service(.busy),
      .service(.limitExceeded), .service(.storageFailed), .service(.internal),
      .service(.shuttingDown), .service(.cancellationUnconfirmed),
    ]
    for error in errors {
      XCTAssertFalse((error.errorDescription ?? "").isEmpty)
    }
    XCTAssertEqual(
      SuperagentError.service(.unconfigured).errorDescription, "请先配置 Super Bot 模型。")
  }

  private func checkRoundTrip<T: Codable & Equatable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    XCTAssertEqual(try JSONDecoder().decode(T.self, from: data), value)
  }
}

final class ClientFailureTests: XCTestCase {
  func testMissingCredentialWrongPortAndForeignRootAreDistinctLocalFailures() async throws {
    let fixture = try ServiceFixture()
    defer { fixture.stop() }
    let missing = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: missing) }
    let missingClient = SuperagentClient(
      endpoint: try SuperagentEndpoint(root: missing, port: fixture.endpoint.port))
    do {
      _ = try await missingClient.events()
      XCTFail("expected refusal")
    } catch { XCTAssertEqual(error as? SuperagentError, .credential) }
    await missingClient.close()

    let closedPort = try SuperagentEndpoint(root: fixture.root, port: 9)
    let closedClient = SuperagentClient(endpoint: closedPort)
    do {
      _ = try await closedClient.health()
      XCTFail("expected refusal")
    } catch { XCTAssertEqual(error as? SuperagentError, .unavailable) }
    await closedClient.close()

    let foreign = SuperagentClient(
      endpoint: try SuperagentEndpoint(
        root: missing, port: fixture.endpoint.port,
        tokenOverride: String(repeating: "c", count: 64)))
    do {
      _ = try await foreign.health()
      XCTFail("expected identity refusal")
    } catch { XCTAssertEqual(error as? SuperagentError, .identity) }
    await foreign.close()
  }

  func testServiceErrorsMapAndRepeatedAdmissionIsIdempotent() async throws {
    let fixture = try ServiceFixture()
    defer { fixture.stop() }
    let client = SuperagentClient(endpoint: fixture.endpoint)
    defer { Task { await client.close() } }
    do {
      _ = try await client.submit(PendingInput(id: "r_missing_01", text: "hello"))
      XCTFail()
    } catch { XCTAssertEqual(error as? SuperagentError, .service(.unconfigured)) }
    _ = try await client.configure(
      ConfigurationChange(baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiKey: "k"))
    let first = try await client.submit(PendingInput(id: "r_repeat_01", text: "once"))
    let again = try await client.submit(PendingInput(id: "r_repeat_01", text: "once"))
    XCTAssertEqual(first.id, again.id)
    do {
      _ = try await client.history(before: 0, limit: 100)
      XCTFail()
    } catch { XCTAssertEqual(error as? SuperagentError, .service(.invalidCommand)) }
    do {
      _ = try await client.history(before: nil, limit: 0)
      XCTFail()
    } catch { XCTAssertEqual(error as? SuperagentError, .service(.invalidCommand)) }
    try await Task.sleep(for: .milliseconds(200))
    try await client.abort()
  }
}

final class ClientLifecycleTests: XCTestCase {
  func testAServiceStopEndsTheStreamAndLaterRequestsFailClosed() async throws {
    let fixture = try ServiceFixture()
    let client = SuperagentClient(endpoint: fixture.endpoint)
    let stream = try await client.events()
    var iterator = stream.makeAsyncIterator()
    _ = try await iterator.next()
    fixture.stop()
    var ended = false
    do {
      while (try await iterator.next()) != nil {}
      ended = true
    } catch { ended = true }
    XCTAssertTrue(ended)
    do {
      _ = try await client.state()
      XCTFail("expected refusal")
    } catch { XCTAssertNotNil(error as? SuperagentError) }
    await client.close()
  }

  func testUnknownSubmissionIsNullInvalidConfigurationIsRefusedAndCloseIsIdempotent() async throws {
    let fixture = try ServiceFixture()
    defer { fixture.stop() }
    let client = SuperagentClient(endpoint: fixture.endpoint)
    let missing = try await client.submission("r_absent_01")
    XCTAssertNil(missing)
    let snapshot = try await client.state()
    XCTAssertEqual(snapshot.value.botId, "superagent")
    do {
      _ = try await client.configure(
        ConfigurationChange(baseUrl: "not a url", model: "m", apiKey: "k"))
      XCTFail("invalid configuration must be refused")
    } catch { XCTAssertEqual(error as? SuperagentError, .service(.invalidCommand)) }
    do {
      _ = try await client.submit(
        PendingInput(id: "r_toolong_1", text: String(repeating: "x", count: 8001)))
      XCTFail("over-limit input must be refused")
    } catch { XCTAssertEqual(error as? SuperagentError, .service(.limitExceeded)) }
    await client.close()
    await client.close()
  }
}
