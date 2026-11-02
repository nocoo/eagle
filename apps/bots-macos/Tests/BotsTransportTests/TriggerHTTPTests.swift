import BotsCore
import BotsTransport
import XCTest

/// The trigger detail and switch over HTTP: the paths, the bearer, the body and the refusal.
final class TriggerHTTPTests: XCTestCase {
  private var session: URLSession!

  override func setUp() {
    super.setUp()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    session = URLSession(configuration: configuration)
  }

  override func tearDown() {
    StubProtocol.handler = nil
    session = nil
    super.tearDown()
  }

  private func client() -> TriggerHTTPClient {
    TriggerHTTPClient(
      baseURL: URL(string: "http://127.0.0.1:43117")!, token: "secret", session: session)
  }

  func testListAsksForOneBotAndCarriesTheBearer() async throws {
    var seen: URLRequest?
    StubProtocol.handler = { request in
      seen = request
      let body = """
        {"triggers":[{"id":"t_9f2a1c3d04","kind":"schedule","name":"morning triage",
          "enabled":true,"prompt":"triage the queue",
          "schedule":{"cron":"0 9 * * *","timezone":"Asia/Shanghai",
                      "nextDueAt":"2026-10-29T01:00:00.000Z"},
          "counters":{"fired":2,"dropped":0,"refused":0}},
         {"id":"t_7b1e55aa10","kind":"webhook","name":"deploy notify","enabled":false,
          "prompt":"handle the deploy","endpoint":"/v1/triggers/b_1/t_7b1e55aa10",
          "token":"tok_abc",
          "counters":{"fired":0,"dropped":0,"refused":0}}]}
        """
      return (200, Data(body.utf8))
    }
    let details = try await client().list(botId: "b_1")
    XCTAssertEqual(details.count, 2)
    XCTAssertEqual(details[0].prompt, "triage the queue")
    XCTAssertEqual(details[0].summary.schedule?.nextDueAt, "2026-10-29T01:00:00.000Z")
    XCTAssertEqual(details[0].summary.kind, .schedule)
    XCTAssertEqual(details[1].endpoint, "/v1/triggers/b_1/t_7b1e55aa10")
    XCTAssertEqual(details[1].token, "tok_abc", "the app reads the credential to copy it")
    XCTAssertNil(details[1].endpoint.flatMap { $0.contains("token") ? $0 : nil })
    XCTAssertEqual(seen?.url?.query, "botId=b_1")
    XCTAssertEqual(seen?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
  }

  func testTheSwitchSendsOnlyEnabled() async throws {
    var seen: URLRequest?
    var body: Data?
    StubProtocol.handler = { request in
      seen = request
      body =
        request.httpBody
        ?? request.httpBodyStream.map { stream in
          stream.open()
          defer { stream.close() }
          var data = Data()
          var buffer = [UInt8](repeating: 0, count: 1024)
          while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
          }
          return data
        }
      let payload = """
        {"trigger":{"id":"t_9f2a1c3d04","kind":"schedule","name":"morning triage",
          "enabled":false,"prompt":"triage","counters":{"fired":0,"dropped":0,"refused":0}}}
        """
      return (200, Data(payload.utf8))
    }
    let detail = try await client().setEnabled(
      botId: "b_1", triggerId: "t_9f2a1c3d04", enabled: false)
    XCTAssertEqual(detail.summary.enabled, false)
    XCTAssertEqual(seen?.httpMethod, "PATCH")
    XCTAssertEqual(seen?.url?.path, "/v1/triggers/b_1/t_9f2a1c3d04")
    XCTAssertEqual(
      body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Bool] },
      ["enabled": false],
      "a person may change enabled and nothing else"
    )
  }

  func testRefusalsFailClosed() async {
    StubProtocol.handler = { _ in (401, Data("{}".utf8)) }
    do {
      _ = try await client().list(botId: "b_1")
      XCTFail("a 401 must not be treated as an empty list")
    } catch let error as TriggerHTTPError {
      XCTAssertEqual(error, .unauthorized)
    } catch {
      XCTFail("unexpected error \(error)")
    }
    StubProtocol.handler = { _ in (404, Data("{}".utf8)) }
    do {
      _ = try await client().setEnabled(
        botId: "b_1", triggerId: "t_aaaaaaaaaa", enabled: true)
      XCTFail("a missing trigger is not a success")
    } catch let error as TriggerHTTPError {
      XCTAssertEqual(error, .refused(status: 404))
    } catch {
      XCTFail("unexpected error \(error)")
    }
  }
}
