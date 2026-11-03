import BotsCore
import BotsTransport
import XCTest

/// The secrets routes (docs/bots/PROTOCOL.md, "Secrets"). A value is written once by a card
/// and read back only when a person asks for it.
final class SecretHTTPTests: XCTestCase {
  private var client: CatalogHTTPClient!

  override func setUp() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    client = CatalogHTTPClient(
      baseURL: URL(string: "http://127.0.0.1:9")!,
      token: "test-token-0123456789",
      session: URLSession(configuration: configuration)
    )
  }

  override func tearDown() {
    StubProtocol.handler = nil
  }

  /// URLProtocol hands a request's body as a stream; a test that inspects it reads it.
  private func body(_ request: URLRequest) -> [String: Any]? {
    var data: Data?
    if let raw = request.httpBody {
      data = raw
    } else if let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 1024)
      var collected = Data()
      while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        collected.append(buffer, count: read)
      }
      data = collected
    }
    guard let data else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  private let secretJSON = """
    {"key":"github-pat","scope":"shared","botId":"b_1","purpose":"发布 Eagle 用",
     "createdAt":"2026-11-03T01:10:00.000Z","updatedAt":"2026-11-03T01:10:00.000Z",
     "expiresAt":"2026-11-03T02:10:00.000Z","lastUsedAt":"2026-11-03T01:20:00.000Z",
     "lastUsedBy":"bot"}
    """

  func testTheListCarriesMetadataAndNeverAValue() async throws {
    StubProtocol.handler = { request in
      XCTAssertEqual(request.httpMethod, "GET")
      XCTAssertEqual(request.url?.path, "/v1/secrets")
      return (200, Data("{\"secrets\":[\(self.secretJSON)]}".utf8))
    }
    let listed = try await client.secrets()
    XCTAssertEqual(listed.count, 1)
    XCTAssertEqual(listed.first?.key, "github-pat")
    XCTAssertEqual(listed.first?.scope, .shared)
    XCTAssertEqual(listed.first?.botId, "b_1")
    XCTAssertEqual(listed.first?.purpose, "发布 Eagle 用")
    XCTAssertEqual(listed.first?.expiresAt, "2026-11-03T02:10:00.000Z")
    XCTAssertEqual(listed.first?.lastUsedAt, "2026-11-03T01:20:00.000Z")
    XCTAssertEqual(listed.first?.lastUsedBy, "bot")
    XCTAssertEqual(StubProtocol.lastAuthorization, "Bearer test-token-0123456789")
  }

  func testRevealAsksForOneRecordAndAnswersItsValue() async throws {
    var sent: [String: Any] = [:]
    StubProtocol.handler = { request in
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.url?.path, "/v1/secrets/reveal")
      sent = self.body(request) ?? [:]
      return (
        200,
        Data(#"{"secret":{"key":"github-pat","scope":"shared","value":"ghp_example"}}"#.utf8)
      )
    }
    let value = try await client.revealSecret(
      key: "github-pat", scope: .shared, botId: "b_1")
    XCTAssertEqual(value, "ghp_example")
    XCTAssertEqual(sent["key"] as? String, "github-pat")
    XCTAssertEqual(sent["scope"] as? String, "shared")
    XCTAssertEqual(sent["botId"] as? String, "b_1", "two bots may use one key")
  }

  func testDeleteNamesTheScopeAndTheKeyInThePath() async throws {
    var paths: [String] = []
    StubProtocol.handler = { request in
      paths.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
      return (204, Data())
    }
    try await client.deleteSecret(key: "github-pat", scope: .shared, botId: "b_1")
    try await client.deleteSecret(key: "npm-token", scope: .bot, botId: "b_1")
    XCTAssertEqual(
      paths, ["DELETE /v1/secrets/shared/github-pat", "DELETE /v1/secrets/bot/npm-token"])
  }

  /// The card's answer carries the person's last word about the expiry: the number they
  /// chose, or null for a record that never expires.
  func testTheCardAnswerCarriesTheScopeTheKeyAndTheExpiry() async throws {
    var bodies: [[String: Any]] = []
    StubProtocol.handler = { request in
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.url?.path, "/v1/bots/b_1/secrets")
      bodies.append(self.body(request) ?? [:])
      return (
        200,
        Data(
          #"{"submission":{"id":"s_1","requestId":"r_1","status":"placed","entryId":"e_12"}}"#.utf8)
      )
    }
    try await client.answerSecret(
      botId: "b_1", entryId: "e_12", callIndex: 0, key: "github-pat", value: "ghp_example",
      scope: .shared, ttlMinutes: .minutes(60), skipped: false)
    try await client.answerSecret(
      botId: "b_1", entryId: "e_12", callIndex: 1, key: "github-pat", value: "ghp_example",
      scope: .shared, ttlMinutes: .permanent, skipped: false)
    try await client.answerSecret(
      botId: "b_1", entryId: "e_12", callIndex: 0, key: "github-pat", value: "", scope: .bot,
      ttlMinutes: .inherit, skipped: true)

    XCTAssertEqual(bodies[0]["entryId"] as? String, "e_12")
    XCTAssertEqual(bodies[0]["callIndex"] as? Int, 0)
    XCTAssertEqual(bodies[1]["callIndex"] as? Int, 1, "the second card is its own question")
    XCTAssertEqual(bodies[0]["key"] as? String, "github-pat")
    XCTAssertEqual(bodies[0]["value"] as? String, "ghp_example")
    XCTAssertEqual(bodies[0]["scope"] as? String, "shared")
    XCTAssertEqual(bodies[0]["ttlMinutes"] as? Int, 60)
    XCTAssertNil(bodies[0]["skipped"])

    XCTAssertTrue(bodies[1]["ttlMinutes"] is NSNull, "permanent is an explicit null")
    XCTAssertNil(bodies[1]["skipped"])

    XCTAssertNil(bodies[2]["ttlMinutes"], "the card's own rule is left alone")
    XCTAssertEqual(bodies[2]["skipped"] as? Bool, true)
    XCTAssertEqual(bodies[2]["scope"] as? String, "bot")
  }

  /// A store that cannot be read is a refusal: the page must say so instead of showing an
  /// empty list that reads as "there are no passwords".
  func testAStorageFailureIsReportedAndNotAnEmptyList() async {
    StubProtocol.handler = { _ in
      (
        503,
        Data(
          #"{"error":{"kind":"storage_failed","message":"密码库无法读取"}}"#.utf8)
      )
    }
    do {
      _ = try await client.secrets()
      XCTFail("expected a refusal")
    } catch {
      XCTAssertEqual((error as? ClientError)?.message, "密码库无法读取")
    }
  }
}
