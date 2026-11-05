import BotsCore
import Foundation
import Testing

@testable import EagleFeatures

/// The 密码 page's own HTTP stub: a separate protocol class, so these tests never share a
/// handler with the other settings suites.
final class SecretHTTPStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var handler: ((URLRequest) throws -> (Int, Data))?
  }

  private static let storage = Storage()

  static var handler: ((URLRequest) throws -> (Int, Data))? {
    get { storage.handler }
    set { storage.handler = newValue }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
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

@MainActor
func secretSettingsFixture() throws -> (BotsSettings, URLSession) {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("settings-secrets-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let tokenURL = root.appendingPathComponent("token")
  try "test-token-01234567890123456789012".write(to: tokenURL, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
  let settings = BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"])
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [SecretHTTPStub.self]
  let session = URLSession(configuration: configuration)
  return (settings, session)
}

/// The 密码 page: the records the daemon stores, and the three things a person may do with
/// one of them (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5).
@Suite("Settings passwords", .serialized)
@MainActor
struct SecretSettingsTests {
  private let sharedJSON = """
    {"key":"github-pat","scope":"shared","botId":"b_1","purpose":"发布 Eagle 用",
     "createdAt":"2026-11-03T01:10:00.000Z","updatedAt":"2026-11-03T01:10:00.000Z",
     "expiresAt":"2026-11-04T01:10:00.000Z","lastUsedAt":"2026-11-03T01:20:00.000Z",
     "lastUsedBy":"bot"}
    """

  private let botJSON = """
    {"key":"npm-token","scope":"bot","botId":"b_2","purpose":"装依赖",
     "createdAt":"2026-11-03T01:10:00.000Z","updatedAt":"2026-11-03T01:10:00.000Z"}
    """

  private func listHandler() -> (URLRequest) throws -> (Int, Data) {
    { request in
      switch request.url?.path {
      case "/v1/secrets":
        return (200, Data("{\"secrets\":[\(self.sharedJSON),\(self.botJSON)]}".utf8))
      case "/v1/bots":
        return (
          200,
          Data(
            #"{"bots":[{"id":"b_1","title":"研究员","createdAt":"x","updatedAt":"x","model":{"provider":"faux","modelId":"faux-1"},"state":"idle"}]}"#
              .utf8)
        )
      default:
        return (404, Data())
      }
    }
  }

  @Test("the page splits the records into the shared ones and the ones each bot owns")
  func groups() async throws {
    let (settings, session) = try secretSettingsFixture()
    SecretHTTPStub.handler = listHandler()
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadSecrets()
    #expect(model.secrets.count == 2)
    #expect(model.sharedSecrets.map(\.key) == ["github-pat"])
    #expect(model.botSecrets.map(\.key) == ["npm-token"])
    #expect(model.secretLoadError == nil)
    #expect(model.secretOwner(model.secrets[0]) == "研究员", "the row names the bot")
    SecretHTTPStub.handler = nil
  }

  @Test("a store that cannot be read is a page error, not an empty list")
  func loadFailure() async throws {
    let (settings, session) = try secretSettingsFixture()
    SecretHTTPStub.handler = { request in
      #expect(request.url?.path == "/v1/secrets")
      return (
        503,
        Data(#"{"error":{"kind":"storage_failed","message":"密码库无法读取"}}"#.utf8)
      )
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadSecrets()
    #expect(model.secretLoadError == "密码库无法读取")
    #expect(model.secrets.isEmpty)
    #expect(model.sharedSecrets.isEmpty, "the page shows the error, not the empty state")
    SecretHTTPStub.handler = nil
  }

  @Test("a value is only read when a person asks for it, and a second click hides it")
  func reveal() async throws {
    let (settings, session) = try secretSettingsFixture()
    var reveals = 0
    SecretHTTPStub.handler = { request in
      switch request.url?.path {
      case "/v1/secrets":
        return (200, Data("{\"secrets\":[\(self.sharedJSON)]}".utf8))
      case "/v1/secrets/reveal":
        reveals += 1
        return (
          200,
          Data(#"{"secret":{"key":"github-pat","scope":"shared","value":"ghp_example"}}"#.utf8)
        )
      default:
        return (404, Data())
      }
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadSecrets()
    let secret = try #require(model.secrets.first)
    #expect(reveals == 0, "reading the list never reads a value")

    await model.revealSecret(secret)
    #expect(reveals == 1)
    #expect(model.revealedSecrets[secret.id] == "ghp_example")

    await model.revealSecret(secret)
    #expect(reveals == 1, "hiding a value asks the daemon for nothing")
    #expect(model.revealedSecrets[secret.id] == nil)
    SecretHTTPStub.handler = nil
  }

  @Test("deleting a record takes its row with it")
  func delete() async throws {
    let (settings, session) = try secretSettingsFixture()
    var deleted: [String] = []
    SecretHTTPStub.handler = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/secrets"):
        return (200, Data("{\"secrets\":[\(self.sharedJSON)]}".utf8))
      case ("DELETE", "/v1/secrets/shared/github-pat"):
        deleted.append(request.url?.path ?? "")
        return (204, Data())
      default:
        return (404, Data())
      }
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadSecrets()
    let secret = try #require(model.secrets.first)
    await model.deleteSecret(secret)
    #expect(deleted == ["/v1/secrets/shared/github-pat"])
    #expect(model.secrets.isEmpty)
    #expect(model.secretNotice == .success("已删除 github-pat"))
    SecretHTTPStub.handler = nil
  }

  @Test("a refused copy says why and writes nothing")
  func copyFailure() async throws {
    let (settings, session) = try secretSettingsFixture()
    SecretHTTPStub.handler = { request in
      switch request.url?.path {
      case "/v1/secrets":
        return (200, Data("{\"secrets\":[\(self.sharedJSON)]}".utf8))
      case "/v1/secrets/reveal":
        return (403, Data(#"{"error":{"kind":"auth_failed","message":"没有权限"}}"#.utf8))
      default:
        return (404, Data())
      }
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadSecrets()
    let secret = try #require(model.secrets.first)
    await model.copySecret(secret)
    #expect(model.secretNotice == .failure("没有权限"))
    #expect(model.revealedSecrets[secret.id] == nil)
    SecretHTTPStub.handler = nil
  }

  @Test("a permanent record says so, and one with an expiry counts down")
  func validity() async throws {
    let (settings, session) = try secretSettingsFixture()
    SecretHTTPStub.handler = { request in
      guard request.url?.path == "/v1/secrets" else { return (404, Data()) }
      return (200, Data("{\"secrets\":[\(self.sharedJSON),\(self.botJSON)]}".utf8))
    }
    let model = SettingsViewModel(botsSettings: settings, urlSession: session)
    await model.loadSecrets()
    let permanent = try #require(model.botSecrets.first)
    #expect(model.secretValidity(permanent) == "永久")
    #expect(model.secretLastUsed(permanent) == "最近使用：无")
    let expiring = try #require(model.sharedSecrets.first)
    let created = try Date("2026-11-03T01:10:00Z", strategy: .iso8601)
    let expiry = try Date("2026-11-04T01:10:00Z", strategy: .iso8601)
    #expect(model.secretValidity(expiring, now: created) == "剩余 24 小时")
    #expect(model.secretValidity(expiring, now: expiry.addingTimeInterval(-60)) == "剩余 1 分钟")
    #expect(model.secretValidity(expiring, now: expiry) == "已过期")
    #expect(model.secretValidity(expiring, now: expiry.addingTimeInterval(60)) == "已过期")
    #expect(model.secretLastUsed(expiring).contains("Bot"))
    SecretHTTPStub.handler = nil
  }
}
