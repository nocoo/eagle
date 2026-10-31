import BotsCore
import Foundation

/// The model gateway settings the daemon stores (docs/bots/PROTOCOL.md, "Gateway
/// settings"). The key never comes back: a client only learns whether one is set.
public struct GatewaySettings: Decodable, Sendable, Equatable {
  public var configured: Bool
  public var provider: String
  public var baseUrl: String
  public var model: String
  public var hasApiKey: Bool
  /// A daemon older than the field reports no level; the daemon itself then uses `medium`.
  public var thinkingLevel: String
  /// The built-in tool groups; `core` and `coding` are mandatory.
  public var toolGroups: [String]

  private enum CodingKeys: String, CodingKey {
    case configured, provider, baseUrl, model, hasApiKey, thinkingLevel, toolGroups
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    configured = try container.decode(Bool.self, forKey: .configured)
    provider = try container.decode(String.self, forKey: .provider)
    baseUrl = try container.decode(String.self, forKey: .baseUrl)
    model = try container.decode(String.self, forKey: .model)
    hasApiKey = try container.decode(Bool.self, forKey: .hasApiKey)
    thinkingLevel = try container.decodeIfPresent(String.self, forKey: .thinkingLevel) ?? "medium"
    toolGroups =
      try container.decodeIfPresent([String].self, forKey: .toolGroups)
      ?? ["core", "coding", "herdr", "agents", "trigger"]
  }
}

/// The daemon's probe of a gateway: reachability, auth and how long it took.
public struct GatewayProbe: Decodable, Sendable, Equatable {
  /// What the gateway's own `/api/live` says, when its origin has one.
  public struct Health: Decodable, Sendable, Equatable {
    public var ok: Bool
    public var status: Int?
    public var version: String?
    public var revision: String?
    public var latencyMs: Int
  }
  public var ok: Bool
  public var status: Int?
  public var message: String
  public var latencyMs: Int
  public var models: Int?
  public var health: Health?
}

/// The catalog over HTTP (docs/bots/PROTOCOL.md, "HTTP endpoints"). Every call carries the
/// bearer token; a 401 is an authentication failure, never a retry.
public final class CatalogHTTPClient: CatalogPort, ReplicaPort, Sendable {
  private let baseURL: URL
  private let token: String
  private let session: URLSession

  public init(baseURL: URL, token: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  public func load() async throws -> BotCatalog {
    struct Payload: Decodable {
      let bots: [BotSummary]
      /// Absent when the daemon has no groups; a client that predates them ignores it.
      let groups: [BotGroup]?
    }
    let payload = try await request(
      path: "/v1/bots", method: "GET", body: nil, as: Payload.self)
    return BotCatalog(bots: payload.bots, groups: payload.groups ?? [])
  }

  public func create(
    title: String,
    label: String?,
    appearance: BotAppearance
  ) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    var body: [String: Any] = [
      "title": title,
      "appearance": ["shape": appearance.shape.rawValue, "tint": appearance.tint.rawValue],
    ]
    if let label, !label.isEmpty { body["label"] = label }
    return try await request(path: "/v1/bots", method: "POST", body: body, as: Payload.self).bot
  }

  public func update(
    id: String,
    title: String?,
    label: String?,
    appearance: BotAppearance?
  ) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    var body: [String: Any] = [:]
    if let title { body["title"] = title }
    if let label { body["label"] = label }
    if let appearance {
      body["appearance"] = [
        "shape": appearance.shape.rawValue, "tint": appearance.tint.rawValue,
      ]
    }
    return try await request(
      path: "/v1/bots/\(id)", method: "PATCH", body: body, as: Payload.self
    ).bot
  }

  public func rename(id: String, title: String) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    return try await request(
      path: "/v1/bots/\(id)",
      method: "PATCH",
      body: ["title": title],
      as: Payload.self
    ).bot
  }

  public func delete(id: String) async throws {
    _ = try await raw(path: "/v1/bots/\(id)", method: "DELETE", body: nil)
  }

  public func createGroup(title: String) async throws -> BotGroup {
    struct Payload: Decodable { let group: BotGroup }
    return try await request(
      path: "/v1/groups", method: "POST", body: ["title": title], as: Payload.self
    ).group
  }

  public func renameGroup(id: String, title: String) async throws -> BotGroup {
    struct Payload: Decodable { let group: BotGroup }
    return try await request(
      path: "/v1/groups/\(id)",
      method: "PATCH",
      body: ["title": title],
      as: Payload.self
    ).group
  }

  public func deleteGroup(id: String) async throws {
    _ = try await raw(path: "/v1/groups/\(id)", method: "DELETE", body: nil)
  }

  public func reorderGroups(ids: [String]) async throws -> [BotGroup] {
    struct Payload: Decodable { let groups: [BotGroup] }
    return try await request(
      path: "/v1/groups/order", method: "PUT", body: ["ids": ids], as: Payload.self
    ).groups
  }

  /// `groupId: nil` is sent as `null`, which clears the membership; an omitted field would
  /// leave the bot where it is.
  public func moveBot(id: String, groupId: String?) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    let body: [String: Any] = ["groupId": groupId.map { $0 as Any } ?? NSNull()]
    return try await request(
      path: "/v1/bots/\(id)", method: "PATCH", body: body, as: Payload.self
    ).bot
  }

  /// The third-party providers and whether each has a key.
  public func loadProviders() async throws -> [ProviderSettings] {
    struct Payload: Decodable { let providers: [ProviderSettings] }
    return try await request(path: "/v1/providers", method: "GET", body: nil, as: Payload.self)
      .providers
  }

  /// Saves a provider's key or enable flag; nil fields are left alone.
  public func saveProvider(
    id: String,
    apiKey: String?,
    enabled: Bool?
  ) async throws -> ProviderSettings {
    struct Payload: Decodable { let provider: ProviderSettings }
    var body: [String: Any] = [:]
    if let apiKey { body["apiKey"] = apiKey }
    if let enabled { body["enabled"] = enabled }
    return try await request(
      path: "/v1/providers/\(id)", method: "PUT", body: body, as: Payload.self
    ).provider
  }

  /// Probes one provider with a single search; nothing is saved.
  public func testProvider(id: String) async throws -> ProviderProbe {
    struct Payload: Decodable { let result: ProviderProbe }
    return try await request(
      path: "/v1/providers/\(id)/test", method: "POST", body: nil, as: Payload.self
    ).result
  }

  /// The usage statistics over the daemon's retained days.
  public func loadUsage(days: Int) async throws -> UsageReport {
    struct Payload: Decodable { let usage: UsageReport }
    return try await request(
      path: "/v1/usage",
      method: "GET",
      body: nil,
      query: [URLQueryItem(name: "days", value: String(days))],
      as: Payload.self
    ).usage
  }

  /// The model ids the configured gateway offers, for a per-bot picker.
  public func loadModels() async throws -> [String] {
    struct Payload: Decodable { let models: [String] }
    return try await request(path: "/v1/models", method: "GET", body: nil, as: Payload.self).models
  }

  /// The bot's own model and reasoning level; nil fields are left alone.
  public func setAgent(
    id: String,
    model: String?,
    thinkingLevel: String?
  ) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    var body: [String: Any] = [:]
    if let model { body["model"] = model }
    if let thinkingLevel { body["thinkingLevel"] = thinkingLevel }
    return try await request(
      path: "/v1/bots/\(id)", method: "PATCH", body: body, as: Payload.self
    ).bot
  }

  /// Runs one parked task again; the daemon answers 204 and the task graph follows.
  public func retryTask(bot botId: String, task taskId: String) async throws {
    _ = try await raw(path: "/v1/bots/\(botId)/tasks/\(taskId)/retry", method: "POST", body: nil)
  }

  /// Stops one live task; the transcript keeps everything it committed.
  public func abortTask(bot botId: String, task taskId: String) async throws {
    _ = try await raw(path: "/v1/bots/\(botId)/tasks/\(taskId)/abort", method: "POST", body: nil)
  }

  public func loadGateway() async throws -> GatewaySettings {
    struct Payload: Decodable { let settings: GatewaySettings }
    return try await request(path: "/v1/settings", method: "GET", body: nil, as: Payload.self)
      .settings
  }

  /// Saving applies the gateway to new bots and moves live conversations to the model and level.
  public func saveGateway(
    baseURL: String,
    model: String,
    thinkingLevel: String,
    toolGroups: [String],
    apiKey: String?
  ) async throws -> GatewaySettings {
    struct Payload: Decodable { let settings: GatewaySettings }
    var body: [String: Any] = [
      "baseUrl": baseURL, "model": model, "thinkingLevel": thinkingLevel,
      "toolGroups": toolGroups,
    ]
    if let apiKey, !apiKey.isEmpty { body["apiKey"] = apiKey }
    return try await request(path: "/v1/settings", method: "PUT", body: body, as: Payload.self)
      .settings
  }

  /// Probes the values typed in the form; an omitted key tests the stored one.
  public func testGateway(
    baseURL: String,
    model: String,
    apiKey: String?
  ) async throws -> GatewayProbe {
    struct Payload: Decodable { let result: GatewayProbe }
    var body: [String: Any] = ["baseUrl": baseURL, "model": model]
    if let apiKey, !apiKey.isEmpty { body["apiKey"] = apiKey }
    return try await request(
      path: "/v1/settings/test", method: "POST", body: body, as: Payload.self
    ).result
  }

  /// The daemon pushes catalog changes on the conversation socket; HTTP has no push.
  public func catalogEvents() -> AsyncStream<BotCatalog> {
    AsyncStream { continuation in
      continuation.finish()
    }
  }

  public func loadReplicaBinding(botId: String) async throws -> ReplicaBinding {
    try await request(
      path: "/v1/bots/\(botId)/replica/status", method: "POST", body: [:], as: ReplicaBinding.self)
  }

  public func bindReplica(botId: String, sharedBotId: String) async throws -> ReplicaBinding {
    try await request(
      path: "/v1/bots/\(botId)/replica/bind", method: "POST", body: ["sharedBotId": sharedBotId],
      as: ReplicaBinding.self)
  }

  public func configureSync(botId: String, peerDeviceId: String, direction: ReplicaSyncDirection?)
    async throws
  {
    _ = try await raw(
      path: "/v1/bots/\(botId)/sync/connections/\(peerDeviceId)",
      method: direction == nil ? "DELETE" : "PUT",
      body: direction.map { ["direction": $0.rawValue] })
  }

  public func loadHeads(botId: String, after: Int = 0) async throws -> ReplicaHeadPage {
    try await request(
      path: "/v1/bots/\(botId)/replica/heads", method: "POST",
      body: ["after": after, "limit": 128], as: ReplicaHeadPage.self)
  }

  public func loadHead(botId: String, head: String) async throws -> ReplicaHeadDetail {
    try await request(
      path: "/v1/bots/\(botId)/replica/head", method: "POST", body: ["head": head],
      as: ReplicaHeadDetail.self)
  }

  public func createContext(botId: String, contextId: String, head: String, resourceHead: String?)
    async throws -> ReplicaContext
  {
    var body: [String: Any] = ["contextId": contextId, "head": head]
    if let resourceHead { body["resourceHead"] = resourceHead }
    return try await request(
      path: "/v1/bots/\(botId)/replica/context", method: "POST", body: body, as: ReplicaContext.self
    )
  }

  public func loadContext(botId: String, contextId: String) async throws -> ReplicaContext {
    try await request(
      path: "/v1/bots/\(botId)/replica/context", method: "POST", body: ["contextId": contextId],
      as: ReplicaContext.self)
  }

  public func mergeHeads(
    botId: String, heads: [String], requestId: String, choices: [ReplicaMergeChoice],
    resources: [ReplicaResourceChoice]
  ) async throws -> ReplicaMerge {
    let body: [String: Any] = [
      "heads": heads, "requestId": requestId,
      "choices": try JSONSerialization.jsonObject(with: JSONEncoder().encode(choices)),
      "resources": try JSONSerialization.jsonObject(with: JSONEncoder().encode(resources)),
    ]
    return try await request(
      path: "/v1/bots/\(botId)/replica/merge", method: "POST", body: body, as: ReplicaMerge.self)
  }

  public func previewMerge(botId: String, heads: [String]) async throws -> ReplicaMergePreview {
    try await request(
      path: "/v1/bots/\(botId)/replica/merge", method: "POST",
      body: ["heads": heads, "preview": true], as: ReplicaMergePreview.self)
  }

  private struct ErrorPayload: Decodable {
    struct Body: Decodable {
      let kind: ErrorKind
      let message: String
    }
    let error: Body
  }

  private func request<T: Decodable>(
    path: String,
    method: String,
    body: [String: Any]?,
    query: [URLQueryItem] = [],
    as: T.Type
  ) async throws -> T {
    let data = try await raw(path: path, method: method, body: body, query: query)
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw ClientError("the daemon answered something this client cannot read")
    }
  }

  private func raw(
    path: String,
    method: String,
    body: [String: Any]?,
    query: [URLQueryItem] = []
  ) async throws -> Data {
    var components = URLComponents(
      url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
    if !query.isEmpty { components?.queryItems = query }
    guard let url = components?.url else { throw ClientError("the daemon address is invalid") }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw ClientError("the daemon is not reachable: \(error.localizedDescription)")
    }
    guard let http = response as? HTTPURLResponse else {
      throw ClientError("the daemon answered without an HTTP response")
    }
    guard (200..<300).contains(http.statusCode) else {
      if http.statusCode == 401 {
        throw ClientError("the daemon rejected the token")
      }
      if let payload = try? JSONDecoder().decode(ErrorPayload.self, from: data) {
        throw ClientError(payload.error.message)
      }
      throw ClientError("the daemon answered \(http.statusCode)")
    }
    return data
  }
}
