import BotsCore
import BotsTransport
import XCTest

/// A URLProtocol stub: the catalog client's status, error and decoding paths without a
/// daemon.
final class StubProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (Int, Data))?
  static var lastAuthorization: String?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lastAuthorization = request.value(forHTTPHeaderField: "Authorization")
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: ClientError("no handler"))
      return
    }
    do {
      let (status, data) = try handler(request)
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
      )!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

/// URLProtocol hands a request's body as a stream; a test that inspects it reads it.
private func bodyData(_ request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return nil }
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

final class CatalogHTTPClientTests: XCTestCase {
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

  private func bot(_ id: String, _ title: String) -> String {
    """
    {"id":"\(id)","title":"\(title)","createdAt":"x","updatedAt":"x",
     "model":{"provider":"faux","modelId":"faux-1"},"state":"idle"}
    """
  }

  func testLoadCreateRenameAndDeleteSpeakTheDocumentedShape() async throws {
    StubProtocol.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/bots"):
        return (200, Data("{\"bots\":[\(self.bot("b_1", "一"))]}".utf8))
      case ("POST", "/v1/bots"):
        return (201, Data("{\"bot\":\(self.bot("b_2", "二"))}".utf8))
      case ("PATCH", "/v1/bots/b_1"):
        return (200, Data("{\"bot\":\(self.bot("b_1", "改"))}".utf8))
      case ("DELETE", "/v1/bots/b_1"):
        return (204, Data())
      default:
        return (404, Data())
      }
    }
    let loaded = try await client.load()
    XCTAssertEqual(loaded.bots.map(\.id), ["b_1"])
    let created = try await client.create(title: "二", label: nil, appearance: .init())
    XCTAssertEqual(created.id, "b_2")
    let renamed = try await client.rename(id: "b_1", title: "改")
    XCTAssertEqual(renamed.title, "改")
    try await client.delete(id: "b_1")
    XCTAssertEqual(StubProtocol.lastAuthorization, "Bearer test-token-0123456789")
  }

  func testCreateOmitsDefaultTintAndSendsManualOverride() async throws {
    var faces: [[String: String]] = []
    StubProtocol.handler = { request in
      let data = try XCTUnwrap(bodyData(request))
      let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      faces.append(try XCTUnwrap(body["appearance"] as? [String: String]))
      return (201, Data("{\"bot\":\(self.bot("b_1", "fixture"))}".utf8))
    }
    _ = try await client.create(title: "Default", label: nil, appearance: .init())
    _ = try await client.create(
      title: "Manual", label: nil, appearance: .init(shape: .star, tint: .pink))
    XCTAssertEqual(faces[0], ["shape": "blob"])
    XCTAssertEqual(faces[1], ["shape": "star", "tint": "pink"])
  }

  func testUpdateSendsOnlyTheSpecifiedBotFields() async throws {
    var bodies: [[String: Any]] = []
    StubProtocol.handler = { request in
      XCTAssertEqual(request.httpMethod, "PATCH")
      XCTAssertEqual(request.url?.path, "/v1/bots/b_1")
      let data = try XCTUnwrap(bodyData(request))
      bodies.append(try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]))
      return (200, Data("{\"bot\":\(self.bot("b_1", "fixture"))}".utf8))
    }
    let changed = try await client.update(
      id: "b_1", title: nil, label: "", appearance: BotAppearance(shape: .star, tint: .pink))
    XCTAssertEqual(changed.id, "b_1")
    XCTAssertNil(bodies[0]["title"])
    XCTAssertEqual(bodies[0]["label"] as? String, "")
    let appearance = try XCTUnwrap(bodies[0]["appearance"] as? [String: String])
    XCTAssertEqual(appearance, ["shape": "star", "tint": "pink"])
    _ = try await client.update(id: "b_1", title: "renamed", label: nil, appearance: nil)
    XCTAssertEqual(bodies[1]["title"] as? String, "renamed")
    XCTAssertNil(bodies[1]["label"])
    XCTAssertNil(bodies[1]["appearance"])
  }

  func testGatewaySettingsDecodeTestAndSave() async throws {
    var savedBody: [String: Any] = [:]
    var savedProviderBody: [String: Any] = [:]
    StubProtocol.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/settings"):
        return (
          200,
          Data(
            #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://x/v1","model":"m","hasApiKey":true}}"#
              .utf8)
        )
      case ("PUT", "/v1/settings"):
        if let body = bodyData(request),
          let parsed = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
          savedBody = parsed
        }
        return (
          200,
          Data(
            #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://x/v1","model":"m2","hasApiKey":true}}"#
              .utf8)
        )
      case ("POST", "/v1/settings/test"):
        if let body = bodyData(request),
          let parsed = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
          savedProviderBody = parsed
        }
        return (
          200,
          Data(
            #"{"result":{"ok":true,"status":200,"message":"连接成功","latencyMs":3,"models":2}}"#.utf8)
        )
      default:
        return (404, Data())
      }
    }
    let loaded = try await client.loadGateway()
    XCTAssertEqual(loaded.settings.model, "m")
    XCTAssertTrue(loaded.settings.hasApiKey)
    // A daemon that predates the level or the groups reports none; the client assumes defaults.
    XCTAssertEqual(loaded.settings.thinkingLevel, "medium")
    XCTAssertEqual(
      loaded.settings.toolGroups,
      [
        "persona", "machine", "core", "core-ui", "coding", "memory", "secrets", "herdr", "agents",
        "trigger",
      ])
    // An omitted key must not be sent, so the daemon keeps the stored one.
    let saved = try await client.saveGateway(
      baseURL: "http://x/v1", model: "m2", thinkingLevel: "xhigh", toolGroups: ["core", "coding"],
      apiKey: nil)
    XCTAssertEqual(saved.settings.model, "m2")
    XCTAssertNil(savedBody["apiKey"])
    XCTAssertEqual(savedBody["model"] as? String, "m2")
    XCTAssertEqual(savedBody["thinkingLevel"] as? String, "xhigh")
    XCTAssertEqual(savedBody["toolGroups"] as? [String], ["core", "coding"])
    _ = try await client.saveToolSettings(corePrompt: "fixture", toolGroups: ["core", "secrets"])
    XCTAssertEqual(savedBody["corePrompt"] as? String, "fixture")
    XCTAssertEqual(savedBody["toolGroups"] as? [String], ["core", "secrets"])
    XCTAssertNil(savedBody["model"])
    let probe = try await client.testGateway(baseURL: "http://x/v1", model: "m", apiKey: "k")
    XCTAssertTrue(probe.ok)
    XCTAssertEqual(probe.models, 2)
    XCTAssertEqual(savedProviderBody["apiKey"] as? String, "k")
  }

  func testSkillsDecodeFromSettingsAndSaveOnTheirOwn() async throws {
    var savedBody: [String: Any] = [:]
    StubProtocol.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/settings"):
        return (
          200,
          Data(
            #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://x/v1","model":"m","hasApiKey":true,"skills":[{"name":"alpha","version":"1.0.0","description":"Runs alpha.","path":"~/.agents/skills/alpha"}]}}"#
              .utf8)
        )
      case ("PUT", "/v1/settings"):
        if let body = bodyData(request),
          let parsed = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
          savedBody = parsed
        }
        return (
          200,
          Data(
            #"{"settings":{"configured":true,"provider":"magpie","baseUrl":"http://x/v1","model":"m","hasApiKey":true,"skills":[]}}"#
              .utf8)
        )
      default:
        return (404, Data())
      }
    }
    let loaded = try await client.loadGateway()
    XCTAssertEqual(
      loaded.settings.skills,
      [
        SelectedSkill(
          name: "alpha", version: "1.0.0", description: "Runs alpha.",
          path: "~/.agents/skills/alpha")
      ])
    try await client.saveSkills([])
    XCTAssertEqual(savedBody["skills"] as? [[String: String]], [])
    XCTAssertNil(savedBody["model"], "a skills push leaves every other setting alone")
    try await client.saveSkills([
      SelectedSkill(
        name: "beta", version: "", description: "Runs beta.", path: "/skills/beta")
    ])
    let sent = try XCTUnwrap(savedBody["skills"] as? [[String: String]])
    XCTAssertEqual(
      sent, [["name": "beta", "version": "", "description": "Runs beta.", "path": "/skills/beta"]])
  }

  func testUsageRequestsTheChosenRetentionWindow() async throws {
    StubProtocol.handler = { request in
      XCTAssertEqual(request.url?.path, "/v1/usage")
      XCTAssertEqual(request.url?.query, "days=7")
      return (
        200,
        Data(
          #"{"usage":{"retentionDays":90,"today":{"totalTokens":2,"costUsd":0},"week":{"totalTokens":2,"costUsd":0},"month":{"totalTokens":2,"costUsd":0},"days":[],"bots":[]}}"#
            .utf8)
      )
    }
    let usage = try await client.loadUsage(days: 7)
    XCTAssertEqual(usage.today.totalTokens, 2)
  }

  func testARejectedTokenIsASetupError() async {
    StubProtocol.handler = { _ in (401, Data()) }
    await expectThrows(
      { try await self.client.load() },
      handler: { error in
        XCTAssertEqual((error as? ClientError)?.message, "the daemon rejected the token")
      })
  }

  func testSelectedBotConfigurationAndTaskActionsUseTheCorrectEndpoints() async throws {
    var requests: [(String, String)] = []
    var updates: [[String: Any]] = []
    StubProtocol.handler = { request in
      let method = request.httpMethod ?? ""
      let path = request.url?.path ?? ""
      requests.append((method, path))
      switch (method, path) {
      case ("GET", "/v1/models"):
        return (
          200,
          Data(
            #"""
            {"models":["m1","m2"],"modelDetails":[{"id":"m1","contextWindow":272000,
            "maxTokens":128000,"reasoning":true,"thinkingLevels":["off","low","medium","high"]}],
            "discoveryError":"the gateway could not be asked for its models"}
            """#.utf8)
        )
      case ("PATCH", "/v1/bots/b_1"):
        let data = try XCTUnwrap(bodyData(request))
        updates.append(try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]))
        return (200, Data("{\"bot\":\(self.bot("b_1", "configured"))}".utf8))
      case ("POST", "/v1/bots/b_1/tasks/t_1/retry"),
        ("POST", "/v1/bots/b_1/tasks/t_2/abort"):
        XCTAssertNil(bodyData(request))
        return (204, Data())
      default:
        XCTFail("unexpected request \(method) \(path)")
        return (404, Data())
      }
    }
    let models = try await client.loadModels()
    XCTAssertEqual(models.ids, ["m1", "m2"])
    XCTAssertEqual(models.details.first?.id, "m1")
    XCTAssertEqual(models.details.first?.thinkingLevels, ["off", "low", "medium", "high"])
    XCTAssertEqual(models.discoveryError, "the gateway could not be asked for its models")
    let configured = try await client.setAgent(id: "b_1", model: "m2", thinkingLevel: "high")
    XCTAssertEqual(configured.title, "configured")
    _ = try await client.setAgent(id: "b_1", model: nil, thinkingLevel: nil)
    try await client.retryTask(bot: "b_1", task: "t_1")
    try await client.abortTask(bot: "b_1", task: "t_2")
    XCTAssertEqual(updates.first?["model"] as? String, "m2")
    XCTAssertEqual(updates.first?["thinkingLevel"] as? String, "high")
    XCTAssertTrue(updates.last?.isEmpty == true)
    XCTAssertEqual(requests.map { $0.0 }, ["GET", "PATCH", "PATCH", "POST", "POST"])
    XCTAssertEqual(StubProtocol.lastAuthorization, "Bearer test-token-0123456789")
  }

  func testAnErrorBodyAndAnUnknownStatusAreReported() async {
    StubProtocol.handler = { _ in
      (409, Data("{\"error\":{\"kind\":\"internal\",\"message\":\"the bot is quarantined\"}}".utf8))
    }
    await expectThrows(
      { try await self.client.load() },
      handler: { error in
        XCTAssertEqual((error as? ClientError)?.message, "the bot is quarantined")
      })

    StubProtocol.handler = { _ in (500, Data("boom".utf8)) }
    await expectThrows(
      { try await self.client.load() },
      handler: { error in
        XCTAssertEqual((error as? ClientError)?.message, "the daemon answered 500")
      })
  }

  func testAReadableButWrongBodyIsReportedAndAnUnreachableDaemonToo() async {
    StubProtocol.handler = { _ in (200, Data("{}".utf8)) }
    await expectThrows(
      { try await self.client.load() },
      handler: { error in
        XCTAssertTrue(
          (error as? ClientError)?.message.contains("cannot read") == true
        )
      })

    StubProtocol.handler = { _ in throw ClientError("connection refused") }
    await expectThrows({ try await self.client.load() }, handler: { _ in })
  }

  func testProvidersLoadSaveAndProbe() async throws {
    var savedBody: [String: Any] = [:]
    var probed = false
    let provider = """
      {"id":"deepseek-search","title":"DeepSeek 搜索","service":"search","kind":"deepseek-search",
       "baseUrl":"https://api.deepseek.com","model":"",
       "docsUrl":"https://api-docs.deepseek.com/guides/search/",
       "keyLabel":"DeepSeek API Key","keyRequired":true,"hasApiKey":true,"enabled":true,
       "defaults":{"baseUrl":"https://api.deepseek.com","model":""}}
      """
    StubProtocol.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/providers"):
        return (200, Data("{\"providers\":[\(provider)]}".utf8))
      case ("PUT", "/v1/providers/deepseek-search"):
        if let data = bodyData(request) {
          savedBody = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        }
        return (200, Data("{\"provider\":\(provider)}".utf8))
      case ("POST", "/v1/providers/deepseek-search/test"):
        probed = true
        return (
          200,
          Data(
            "{\"result\":{\"ok\":true,\"message\":\"ok\",\"latencyMs\":4,\"results\":1}}"
              .utf8)
        )
      default:
        return (404, Data())
      }
    }
    let listed = try await client.loadProviders()
    XCTAssertEqual(listed.first?.id, "deepseek-search")
    XCTAssertEqual(listed.first?.hasApiKey, true)
    XCTAssertEqual(listed.first?.keyLabel, "DeepSeek API Key")

    let saved = try await client.saveProvider(
      id: "deepseek-search", apiKey: "sk-new", enabled: false)
    XCTAssertEqual(saved.title, "DeepSeek 搜索")
    XCTAssertEqual(savedBody["apiKey"] as? String, "sk-new")
    XCTAssertEqual(savedBody["enabled"] as? Bool, false)

    let probe = try await client.testProvider(id: "deepseek-search")
    XCTAssertTrue(probed)
    XCTAssertTrue(probe.ok)
    XCTAssertEqual(probe.results, 1)
  }

  /// A decision provider carries its own address, model and key rule, and an override travels
  /// with the save (docs/bots/PROTOCOL.md, "Providers").
  func testDecisionProviderLoadsAndSavesItsAddressAndModel() async throws {
    var savedBody: [String: Any] = [:]
    let provider = """
      {"id":"falcon","title":"Falcon","service":"decision","kind":"systemone",
       "baseUrl":"http://127.0.0.1:19999","model":"jev-preview",
       "docsUrl":"https://github.com/nocoo/falcon/blob/main/docs/03-protocol.md",
       "keyLabel":"Falcon Source Key","keyRequired":true,"hasApiKey":true,"enabled":true,
       "defaults":{"baseUrl":"http://127.0.0.1:19823","model":"jev-latest"}}
      """
    StubProtocol.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/providers"):
        return (200, Data("{\"providers\":[\(provider)]}".utf8))
      case ("PUT", "/v1/providers/falcon"):
        if let data = bodyData(request) {
          savedBody = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        }
        return (200, Data("{\"provider\":\(provider)}".utf8))
      case ("POST", "/v1/providers/falcon/test"):
        return (
          200,
          Data(
            "{\"result\":{\"ok\":true,\"message\":\"连接成功 · jev-1.14.0 · test 0.62\",\"latencyMs\":9,\"model\":\"jev-preview\",\"resolvedModel\":\"jev-1.14.0\"}}"
              .utf8)
        )
      default:
        return (404, Data())
      }
    }
    let listed = try await client.loadProviders()
    XCTAssertEqual(listed.first?.service, "decision")
    XCTAssertTrue(listed.first?.isDecision == true)
    XCTAssertEqual(listed.first?.model, "jev-preview")
    XCTAssertEqual(listed.first?.keyRequired, true)
    XCTAssertEqual(listed.first?.defaults.baseUrl, "http://127.0.0.1:19823")
    XCTAssertEqual(listed.first?.defaults.model, "jev-latest")

    _ = try await client.saveProvider(
      id: "falcon", apiKey: "falcon_key", enabled: nil,
      baseUrl: "http://127.0.0.1:19999", model: "jev-preview")
    XCTAssertEqual(savedBody["baseUrl"] as? String, "http://127.0.0.1:19999")
    XCTAssertEqual(savedBody["model"] as? String, "jev-preview")
    XCTAssertEqual(savedBody["apiKey"] as? String, "falcon_key")
    XCTAssertNil(savedBody["enabled"])

    let probe = try await client.testProvider(id: "falcon")
    XCTAssertEqual(probe.resolvedModel, "jev-1.14.0")
    XCTAssertEqual(probe.model, "jev-preview")
  }
}

private func expectThrows(
  _ expression: () async throws -> Any,
  handler: (Error) -> Void
) async {
  do {
    _ = try await expression()
    XCTFail("expected an error")
  } catch {
    handler(error)
  }
}
