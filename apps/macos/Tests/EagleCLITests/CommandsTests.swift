import Darwin
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

  private func requestBody() -> Data? {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      result.append(buffer, count: count)
    }
    return result
  }

  override func startLoading() {
    let path = request.url?.path ?? ""
    Self.calls.append(
      Call(
        method: request.httpMethod ?? "GET", path: path,
        bearer: request.value(forHTTPHeaderField: "authorization"),
        body: requestBody().map { String(decoding: $0, as: UTF8.self) }))
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

  @Test("skills are read as the selection a Bot is told about")
  func skills() async {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/bots": (200, Self.catalog),
      "/v1/settings": (
        200,
        #"{"settings":{"skills":[{"name":"weather-lookup","version":"1.4.0","description":"d","path":"~/.agents/skills/weather-lookup"}]}}"#
      ),
    ]
    let listed = await run(["skills", "list"])
    #expect(listed.code == 0)
    #expect(listed.out.joined().contains("weather-lookup · 1.4.0"))

    let withoutStdin = await run(["skills", "set"])
    #expect(withoutStdin.code == 2, "the selection is read from stdin, never an argument")
  }

  @Test("peers are read, and an unknown exchange is a refusal")
  func peers() async {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/bots": (200, Self.catalog),
      "/v1/bots/b_1/exchanges": (200, #"{"exchanges":[]}"#),
      "/v1/bots/b_1/exchanges/x_000000000000": (
        404, #"{"error":{"kind":"unknown_bot","message":"no such exchange"}}"#
      ),
    ]
    let listed = await run(["peers", "list", "b_1"])
    #expect(listed.code == 0)
    #expect(listed.out.joined().contains("no exchanges"))
    let missing = await run(["peers", "show", "b_1", "x_000000000000"])
    #expect(missing.code == 1)
    #expect(missing.err.joined().contains("no such exchange"))
  }

  @Test("a hand-fired webhook presents the trigger's own token, never the CLI's")
  func fireTrigger() async {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/bots": (200, Self.catalog),
      "/v1/triggers": (
        200,
        #"{"triggers":[{"id":"t_abcd2ef3gh","kind":"webhook","name":"hook","enabled":true,"token":"trig_secret"}]}"#
      ),
      "/v1/triggers/b_1/t_abcd2ef3gh": (202, #"{"delivery":{"id":"d_1"}}"#),
    ]
    let fired = await run(["triggers", "fire", "b_1", "hook", "--body", "hello"])
    #expect(fired.code == 0)
    let delivery = StubTransport.calls.first { $0.method == "POST" }
    #expect(
      delivery?.bearer == "Bearer trig_secret",
      "the ingress answers to the trigger, not the CLI")
    #expect(delivery?.body?.contains("hello") == true)

    StubTransport.calls = []
    let disabled = await run(["triggers", "disable", "b_1", "hook", "--json"])
    #expect(disabled.code == 0)
    let patch = StubTransport.calls.first { $0.method == "PATCH" }
    #expect(patch?.path == "/v1/triggers/b_1/t_abcd2ef3gh")
    #expect(patch?.body?.contains("false") == true)

    let unknown = await run(["triggers", "fire", "b_1", "nope", "--body", "hello"])
    #expect(unknown.code == 1)
    #expect(unknown.err.joined().contains("no trigger matches"))
  }

  @Test("only creation may omit the appearance tint")
  func creationTint() async throws {
    StubTransport.calls = []
    StubTransport.answers = ["/v1/bots": (201, #"{"bot":{"id":"b_new","title":"Fixture"}}"#)]
    let created = await run(["bots", "create", "--title", "Fixture", "--shape", "star", "--json"])
    #expect(created.code == 0)
    let body = try #require(StubTransport.calls.first?.body)
    let json = try #require(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
    #expect(json["appearance"] as? [String: String] == ["shape": "star"])
    let tintOnly = await run(["bots", "create", "--title", "Fixture", "--tint", "red"])
    #expect(tintOnly.code != 0)
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let update = await run(["bots", "update", "b_1", "--shape", "star"])
    #expect(update.code != 0)
    #expect(!StubTransport.calls.contains { $0.method == "PATCH" })
  }

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

  @Test("card answers use their own HTTP admission, never an unrelated socket submission")
  func answerAdmission() async {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/bots": (200, #"{"bots":[{"id":"b_1","title":"helper"}]}"#),
      "/v1/bots/b_1/answers": (
        400, #"{"error":{"kind":"invalid_command","message":"ambiguous answer"}}"#
      ),
    ]
    let refused = await run(["chat", "answer", "helper", "--entry", "e_12", "--choose", "Yes"])
    #expect(refused.code != 0)
    #expect(refused.out.allSatisfy { !$0.contains("answered") })
    #expect(
      StubTransport.calls.contains { $0.method == "POST" && $0.path == "/v1/bots/b_1/answers" })
    StubTransport.answers["/v1/bots/b_1/answers"] = (
      200,
      #"{"submission":{"id":"s_1","requestId":"answer_1","status":"placed","entryId":"e_20"}}"#
    )
    let accepted = await run([
      "chat", "answer", "helper", "--entry", "e_12", "--choose", "Yes", "--json",
    ])
    #expect(accepted.code == 0)
    #expect(accepted.out.contains { $0.contains("answer_1") })
    let printed = accepted.out.compactMap {
      try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
    }
    #expect(printed.last?["submissionId"] as? String == "s_1")
    #expect(printed.last?["type"] as? String == "submission")
    #expect(printed.last?["entryId"] as? String == "e_20", "a placed answer keeps its entry")
  }

  @Test("a secret card can be skipped through its own admission")
  func skipSecretCard() async {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/bots": (200, #"{"bots":[{"id":"b_1","title":"helper"}]}"#),
      "/v1/bots/b_1/secrets": (
        200, #"{"submission":{"id":"s_1","requestId":"secret_1","status":"placed"}}"#
      ),
    ]
    let result = await run([
      "chat", "secret", "helper", "--entry", "e_12", "--key", "fixture", "--skip", "--json",
    ])
    #expect(result.code == 0)
    let body = StubTransport.calls.last?.body?.data(using: .utf8)
    let object = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    #expect(object?["entryId"] as? String == "e_12")
    #expect(object?["key"] as? String == "fixture")
    #expect(object?["skipped"] as? Bool == true)
    #expect(object?["value"] == nil)
    #expect(result.out.contains { $0.contains("secret_1") })
  }

  @Test("secret card arguments refuse ambiguous modes and invalid indices")
  func invalidSecretArguments() async {
    StubTransport.calls = []
    let ambiguous = await run([
      "chat", "secret", "helper", "--entry", "e_12", "--key", "fixture", "--skip", "--stdin",
    ])
    let invalidIndex = await run([
      "chat", "secret", "helper", "--entry", "e_12", "--key", "fixture", "--skip", "--call-index",
      "-1",
    ])
    #expect(ambiguous.code == 2)
    #expect(invalidIndex.code == 2)
    #expect(StubTransport.calls.isEmpty)
  }

  @Test("secret stdin preserves bytes and refuses invalid or oversized values")
  func secretInputValidation() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eagle-cli-secret-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("input")
    func read(_ data: Data) throws -> String {
      try data.write(to: file)
      let handle = try FileHandle(forReadingFrom: file)
      defer { try? handle.close() }
      return try Commands.readSecretInput(handle)
    }
    #expect(try read(Data("fixture value\n".utf8)) == "fixture value\n")
    #expect(try read(Data(repeating: 65, count: 8192)).utf8.count == 8192)
    #expect((try? read(Data(repeating: 65, count: 8193))) == nil, "oversized input is refused")
    #expect(throws: CLIError.self) { try read(Data([0x61, 0x00, 0x62])) }
    #expect(throws: CLIError.self) { try read(Data([0xff])) }
  }

  @Test("secret stdin refuses an interactive terminal")
  func secretInputTerminal() throws {
    var master: Int32 = -1
    var slave: Int32 = -1
    guard openpty(&master, &slave, nil, nil, nil) == 0 else {
      throw CLIError.usage("cannot create a test terminal")
    }
    defer { close(master) }
    let handle = FileHandle(fileDescriptor: slave, closeOnDealloc: true)
    defer { try? handle.close() }
    #expect(throws: CLIError.self) { try Commands.readSecretInput(handle) }
  }

  @Test("question-indexed answers support repeated labels")
  func groupedCardAnswer() async {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/bots": (200, #"{"bots":[{"id":"b_1","title":"helper"}]}"#),
      "/v1/bots/b_1/answers": (
        200, #"{"submission":{"id":"s_1","requestId":"answer_1","status":"queued"}}"#
      ),
    ]
    let result = await run([
      "chat", "answer", "helper", "--entry", "e_12", "--answers", #"[["Yes"],["No"]]"#,
    ])
    #expect(result.code == 0)
    let body = StubTransport.calls.last?.body?.data(using: .utf8)
    let object = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    #expect(object?["answers"] as? [[String]] == [["Yes"], ["No"]])
    #expect(object?["chosen"] == nil)
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

  @Test("invalid wait deadlines are rejected before contacting the daemon")
  func invalidTimeout() async {
    StubTransport.calls = []
    for value in ["0", "-1", "nan", "inf", "invalid"] {
      let result = await run(["chat", "send", "b_1", "--text", "hi", "--wait", "--timeout", value])
      #expect(result.code == 2)
      #expect(result.err.first?.contains("--timeout") == true)
    }
    #expect(StubTransport.calls.isEmpty)
  }

  @Test("a conversation is read from the frame's value, where the snapshot keeps it")
  func snapshotValue() {
    let frame: JSONObject = [
      "type": "snapshot", "rev": 4,
      "value": [
        "botId": "b_1", "messages": [["id": "e_1"]], "truncatedBefore": "e_0",
      ],
    ]
    let conversation = SocketSession.snapshotValue(frame)
    #expect(
      (conversation["messages"] as? [JSONObject])?.count == 1,
      "watch finds the page where the daemon put it")
    #expect(
      conversation["truncatedBefore"] as? String == "e_0",
      "history finds the oldest page boundary the snapshot named")
    #expect(
      SocketSession.snapshotValue(["messages": []])["messages"] != nil,
      "a frame without a value is read as it arrives")
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

  @Test("only the development copy explains the development token")
  func skillMentionsTheDevelopmentToken() {
    let development = Skill.document(binaryName: "eagle-dev", clientName: nil)
    #expect(development.contains("~/.config/eagle-dev/token"))
    #expect(development.contains("0600"))
    #expect(development.contains("EAGLE_TOKEN"))
    #expect(development.contains("npm --prefix apps/bots run eval"))
    #expect(development.contains(".agents/skills/eagle-cli-eval/SKILL.md"))

    let release = Skill.document(binaryName: "eagle", clientName: nil)
    #expect(release.contains("eagle-dev") == false)
    #expect(release.contains("development token") == false)
    #expect(release.contains("~/.config/eagle-dev") == false)
    #expect(release.contains("npm --prefix apps/bots run eval") == false)
  }

  private func developmentHome(_ token: String, mode: Int = 0o600) throws -> URL {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-cli-\(UUID().uuidString)", isDirectory: true)
    let directory = home.appendingPathComponent(".config/eagle-dev", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("token")
    try Data(token.utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
    return home
  }

  /// The whole binary's path: argv, environment and the exit code.
  private func runEntry(
    _ arguments: [String], environment: [String: String]
  ) async -> (code: Int32, out: [String], err: [String]) {
    let box = OutputBox()
    let code = await CLIEntry.run(
      arguments: arguments,
      environment: environment,
      printer: { _ in
        Printer(json: false) { line, isError in box.append(line, isError: isError) }
      },
      session: session()
    )
    return (code, box.out, box.err)
  }

  @Test("an unsafe development token file stops the commands that need a credential")
  func unsafeDevelopmentToken() async throws {
    StubTransport.calls = []
    StubTransport.answers = [
      "/v1/health": (200, #"{"version":"1.0","bots":0,"pid":1}"#),
      "/v1/bots": (200, Self.catalog),
    ]
    let home = try developmentHome(String(repeating: "d", count: 48), mode: 0o644)
    defer { try? FileManager.default.removeItem(at: home) }
    let path = home.appendingPathComponent(".config/eagle-dev/token").path

    let health = await runEntry(["/x/eagle-dev", "health"], environment: ["HOME": home.path])
    #expect(health.code == 0, "a command without a credential still works")
    #expect(health.out.first?.contains("1.0") == true)

    let version = await runEntry(["/x/eagle-dev", "--version"], environment: ["HOME": home.path])
    #expect(version.code == 0, "--version is the diagnostic for a broken setup")
    let help = await runEntry(["/x/eagle-dev", "--help"], environment: ["HOME": home.path])
    #expect(help.code == 0)
    let skill = await runEntry(["/x/eagle-dev", "--skill"], environment: ["HOME": home.path])
    #expect(skill.code == 0)

    let listed = await runEntry(
      ["/x/eagle-dev", "bots", "list"], environment: ["HOME": home.path])
    #expect(listed.code == 3)
    #expect(listed.err.first?.contains("not usable") == true)
    #expect(listed.err.first?.contains(path) == true)
    #expect(
      StubTransport.calls.allSatisfy { $0.path == "/v1/health" },
      "no credentialed request is attempted")
  }

  @Test("EAGLE_TOKEN wins over an unsafe development token file")
  func environmentBeatsTheUnsafeFile() async throws {
    StubTransport.calls = []
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let home = try developmentHome(String(repeating: "d", count: 48), mode: 0o644)
    defer { try? FileManager.default.removeItem(at: home) }
    let config = CLIConfig.load(
      argv0: "/x/eagle-dev", environment: ["EAGLE_TOKEN": "c_env"], home: home.path)
    #expect(config.unsafeDevToken == nil, "the file is not even read")

    let result = await runEntry(
      ["/x/eagle-dev", "bots", "list"],
      environment: ["HOME": home.path, "EAGLE_TOKEN": "c_env"])
    #expect(result.code == 0)
    #expect(StubTransport.calls.first?.bearer == "Bearer c_env")
  }

  @Test("HOME decides which development token the CLI presents")
  func homeDrivesTheCredential() async throws {
    StubTransport.calls = []
    StubTransport.answers = ["/v1/bots": (200, Self.catalog)]
    let token = String(repeating: "d", count: 48)
    let home = try developmentHome(token)
    defer { try? FileManager.default.removeItem(at: home) }
    let box = OutputBox()
    let code = await CLIEntry.run(
      arguments: ["/x/eagle-dev", "bots", "list"],
      environment: ["HOME": home.path],
      printer: { _ in
        Printer(json: false) { line, isError in box.append(line, isError: isError) }
      },
      session: session()
    )
    #expect(code == 0)
    #expect(StubTransport.calls.first?.bearer == "Bearer \(token)")
  }
}

@Suite("CLI questions")
struct QuestionLinesTests {
  @Test("an ask_user call prints its options and the command that answers it")
  func cardLines() {
    let message: [String: Any] = [
      "id": "e_11",
      "role": "assistant",
      "blocks": [
        [
          "type": "toolCall", "callId": "c_2", "name": "ask_user",
          "args": [
            "questions": [
              [
                "prompt": "要不要继续？", "kind": "single",
                "options": [["label": "继续"], ["label": "停止"]],
              ]
            ]
          ],
        ]
      ],
    ]
    let lines = Commands.questionLines(message)
    #expect(lines.first == "[question e_11] (单选) 要不要继续？: 继续 | 停止")
    #expect(lines.last?.contains("--entry e_11 --choose") == true)
  }

  @Test("secret cards display their key and index without a value")
  func secretLines() {
    let message: [String: Any] = [
      "id": "e_12", "role": "assistant",
      "blocks": [
        [
          "type": "toolCall", "name": "secret_request", "args": ["key": "first", "purpose": "One"],
        ],
        [
          "type": "toolCall", "name": "secret_request",
          "args": ["key": "second", "purpose": "Two"],
        ],
      ],
    ]
    let lines = Commands.questionLines(message)
    #expect(lines.contains { $0.contains("first") && $0.contains("--call-index 0") })
    #expect(lines.contains { $0.contains("second") && $0.contains("--call-index 1") })
  }

  @Test("a hidden answer is not chat: only the fact that the card was answered")
  func hiddenAnswer() {
    let message: [String: Any] = [
      "id": "e_16", "role": "user", "hidden": true, "answersTo": "e_11", "blocks": [],
    ]
    #expect(Commands.messageLine(message) == "[answered e_11]")
  }
}
