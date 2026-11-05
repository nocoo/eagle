import BotsCore
import EagleDesign
import Foundation
import Testing

@testable import EagleFeatures

/// The 消耗最多 card draws each bot as the catalog does, and a bot that no longer exists only
/// shows up as its share of one 其他 row.
@Suite("Settings usage bots", .serialized)
@MainActor
struct SettingsUsageBotsTests {
  @Test("each spending bot draws its own face, and the deleted ones add up to 其他")
  func botFaces() async throws {
    let model = try await usageModel(
      bots:
        #"[{"id":"b_1","title":"研究员","createdAt":"2026-10-25T02:11:03.412Z","updatedAt":"2026-10-25T02:11:03.412Z","model":{"provider":"magpie","modelId":"m"},"state":"idle","appearance":{"shape":"star","tint":"violet"}}]"#,
      usageBots:
        #"[{"botId":"b_1","title":"研究员","totalTokens":2000,"calls":2,"costUsd":0.2},{"botId":"b_gone","title":"已删","totalTokens":1000,"calls":3,"costUsd":0.1},{"botId":"b_gone2","title":"也删","totalTokens":500,"costUsd":0.05}]"#
    )
    let rows = model.usageBotRows
    #expect(rows.map(\.title) == ["研究员", "其他"])
    let first = try #require(rows.first)
    #expect(first.face == BotFace.Style(shape: .star, tint: .violet), "the row draws the bot")
    #expect(!first.aggregate)
    let other = try #require(rows.last)
    #expect(other.face == nil)
    #expect(other.aggregate, "one row carries what the deleted bots spent")
    #expect(other.value == "1.5k · 3 次 · $0.15")
    #expect(other.detail == "2 个已删除的 Bot")
  }

  @Test("a catalog that never answered lists the report as it came, deleting nothing")
  func catalogUnread() async throws {
    let model = try await usageModel(
      bots: nil,
      usageBots:
        #"[{"botId":"b_1","title":"研究员","totalTokens":2000,"costUsd":0.2},{"botId":"b_gone","title":"已删","totalTokens":1000,"costUsd":0.1}]"#
    )
    let rows = model.usageBotRows
    #expect(rows.map(\.title) == ["研究员", "已删"], "an unanswered catalog proves nothing")
    #expect(rows.allSatisfy { $0.face == nil && !$0.aggregate })
  }

  private func usageModel(bots: String?, usageBots: String) async throws -> SettingsViewModel {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-usage-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let token = root.appendingPathComponent("token")
    try "usage-token-012345678901234567890123".write(
      to: token, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)
    UsageBotsStub.bots = bots
    UsageBotsStub.usageBots = usageBots
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [UsageBotsStub.self]
    let model = SettingsViewModel(
      botsSettings: BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"]),
      urlSession: URLSession(configuration: configuration))
    await model.loadUsage()
    return model
  }
}

/// Answers the catalog and the usage read, so this suite owns its stub while the settings suites
/// run in parallel.
final class UsageBotsStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var bots: String?
    var usageBots = "[]"
  }

  private static let storage = Storage()

  static var bots: String? {
    get { storage.bots }
    set { storage.bots = newValue }
  }

  static var usageBots: String {
    get { storage.usageBots }
    set { storage.usageBots = newValue }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var status = 404
    var body = "{}"
    switch request.url?.path {
    case "/v1/bots":
      if let bots = Self.bots {
        status = 200
        body = #"{"bots":\#(bots)}"#
      }
    case "/v1/usage":
      status = 200
      body = #"""
        {"usage":{"retentionDays":90,"today":{"totalTokens":0,"costUsd":0},"week":{"totalTokens":0,"costUsd":0},"month":{"totalTokens":0,"costUsd":0},"days":[],"bots":\#(Self.usageBots)}}
        """#
    default:
      break
    }
    let data = Data(body.utf8)
    let response = HTTPURLResponse(
      url: request.url ?? URL(string: "http://127.0.0.1")!, statusCode: status,
      httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
