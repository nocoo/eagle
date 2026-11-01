import Foundation
import Testing

@testable import EagleCLIKit

/// A recorded request and the canned answer the stub returns for it.
final class StubTransport: URLProtocol, @unchecked Sendable {
  struct Call: Sendable {
    let method: String
    let path: String
    let bearer: String?
    let body: String?
  }

  nonisolated(unsafe) static var calls: [Call] = []
  nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]
  nonisolated(unsafe) static var failure: URLError?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    let path = request.url?.path ?? ""
    Self.calls.append(
      Call(
        method: request.httpMethod ?? "GET", path: path,
        bearer: request.value(forHTTPHeaderField: "authorization"),
        body: request.httpBody.map { String(decoding: $0, as: UTF8.self) }))
    if let failure = Self.failure {
      client?.urlProtocol(self, didFailWithError: failure)
      return
    }
    let (status, body) =
      Self.answers[path] ?? Self.answers[path + "?"] ?? (
        404, #"{"error":{"kind":"unknown_path","message":"no stub"}}"#
      )
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["content-type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}

@Suite("CLI commands", .serialized)
struct CommandsTests {
  private func session() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubTransport.self]
    return URLSession(configuration: configuration)
  }

  private func config(token: String? = "c_1.secret") -> CLIConfig {
    CLIConfig.load(
      argv0: "/x/eagle-dev",
      environment: [
        "EAGLE_TOKEN": token ?? "", "EAGLE_PORT": "44000",
      ],
      home: "/nonexistent-home")
  }

  private func run(
    _ tokens: [String],
    token: String? = "c_1.secret",
    configuration: CLIConfig? = nil
  ) async -> (code: Int32, out: [String], err: [String]) {
    let box = OutputBox()
    let config = configuration ?? self.config(token: token)
    let clock = Printer(json: tokens.contains("--json")) { line, isError in
      box.append(line, isError: isError)
    }
    let code = await withCheckedContinuation { continuation in
      Task {
        do {
          try await Commands(config: config, printer: clock, session: session()).run(tokens)
          continuation.resume(returning: Int32(0))
        } catch let error as CLIError {
          clock.error(error.message)
          continuation.resume(returning: error.exitCode)
        } catch {
          clock.error("\(error)")
          continuation.resume(returning: 1)
        }
      }
    }
    return (code, box.out, box.err)
  }

  private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var outLines: [String] = []
    private var errLines: [String] = []
    var out: [String] { lock.withLock { outLines } }
    var err: [String] { lock.withLock { errLines } }
    func append(_ line: String, isError: Bool) {
      lock.withLock { if isError { errLines.append(line) } else { outLines.append(line) } }
    }
  }

  private static let catalog = #"""
    {"bots":[
      {"id":"b_1","title":"研究员","label":"研究","state":"idle","groupId":"g_1",
       "note":"在核对依赖报告",
       "appearance":{"shape":"blob","tint":"green"}},
      {"id":"b_2","title":"工作秘书","state":"idle"}
    ],"groups":[{"id":"g_1","title":"工作"}]}
    """#

  @Test("bots list prints one line per bot and --json prints the daemon's own object")
  func listBots() async {
    StubTransport.calls = []
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let text = await run(["bots", "list"])
    #expect(text.code == 0)
    #expect(text.out.count == 2)
    #expect(text.out[0].contains("b_1"))
    #expect(text.out[0].contains("研究"))
    #expect(text.out[0].contains("blob/green"))
    #expect(text.out[0].contains("「在核对依赖报告」"), "the bot's own note is on the row")
    #expect(StubTransport.calls.first?.bearer == "Bearer c_1.secret")

    let json = await run(["bots", "list", "--json"])
    #expect(json.code == 0)
    #expect(json.out.count == 1)
    #expect(json.out[0].contains("\"b_1\""))
    #expect(json.out[0].hasPrefix("{\"bots\":"))
  }

  @Test("a bot is named by id or by its unique title, and an unknown one is refused")
  func resolve() async {
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let byTitle = await run(["bots", "show", "工作秘书"])
    #expect(byTitle.code == 0)
    #expect(byTitle.out.first?.contains("b_2") == true)

    let missing = await run(["bots", "show", "不存在"])
    #expect(missing.code == 1)
    #expect(missing.err.first?.contains("unknown_bot") == true)
  }

  @Test("delete sends nothing without --yes and answers code 2")
  func deleteNeedsYes() async {
    StubTransport.calls = []
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let refused = await run(["bots", "delete", "b_1"])
    #expect(refused.code == 2)
    #expect(StubTransport.calls.allSatisfy { $0.method == "GET" }, "no mutation was attempted")

    StubTransport.answers["/v1/bots/b_1"] = (204, "")
    let deleted = await run(["bots", "delete", "b_1", "--yes"])
    #expect(deleted.code == 0)
    #expect(StubTransport.calls.last?.method == "DELETE")
  }

  @Test("groups create prints the new group and order prints the new sequence")
  func groups() async {
    StubTransport.answers = [
      "/v1/groups": (201, #"{"group":{"id":"g_2","title":"研究"}}"#),
      "/v1/groups/order": (
        200, #"{"groups":[{"id":"g_2","title":"研究"},{"id":"g_1","title":"工作"}]}"#
      ),
    ]
    let created = await run(["groups", "create", "研究"])
    #expect(created.code == 0)
    #expect(created.out.first == "g_2  研究")

    let ordered = await run(["groups", "order", "g_2,g_1"])
    #expect(ordered.code == 0)
    #expect(ordered.out.first == "研究 → 工作")
  }

  @Test("a refused credential is exit 3 and an unreachable daemon is exit 4")
  func failures() async {
    StubTransport.failure = nil
    StubTransport.answers = [
      "/v1/bots": (401, #"{"error":{"kind":"auth_failed","message":"a bearer token is required"}}"#)
    ]
    let refused = await run(["bots", "list"])
    #expect(refused.code == 3)
    #expect(refused.err.first?.contains("a bearer token is required") == true)

    StubTransport.answers = [
      "/v1/bots": (
        403, #"{"error":{"kind":"auth_scope","message":"this credential cannot write"}}"#
      )
    ]
    let scope = await run(["bots", "list"])
    #expect(scope.code == 3, "a missing scope is an auth answer, not a generic refusal")

    StubTransport.failure = URLError(.cannotConnectToHost)
    let down = await run(["bots", "list"])
    #expect(down.code == 4)
    #expect(down.err.first?.contains("cannot reach the daemon") == true)
    StubTransport.failure = nil
  }

  @Test("a missing credential fails before any request and never borrows the App's token")
  func noToken() async {
    StubTransport.calls = []
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let result = await run(["bots", "list"], token: nil)
    #expect(result.code == 3)
    #expect(StubTransport.calls.isEmpty, "no unauthenticated request is attempted")
    #expect(result.err.first?.contains("Settings → CLI") == true)
  }

  @Test("the skill document names this binary and its two support answers")
  func skill() async {
    let result = await run(["--skill"])
    #expect(result.code == 0)
    let document = result.out.joined(separator: "\n")
    #expect(document.contains("name: eagle-dev"))
    #expect(document.contains("eagle-dev chat send"))
    #expect(document.contains("Settings → CLI"))
    #expect(document.contains("description:"))
  }
}
