import BotsCore
import Foundation

/// One skill the person ticked, as the daemon stores it (docs/bots/PROTOCOL.md, "Gateway
/// settings"). `path` is the skill's own directory, written with `~` when it lives under the
/// home, so the daemon expands it itself.
public struct SelectedSkill: Codable, Sendable, Equatable {
  public var name: String
  public var version: String
  public var description: String
  public var path: String

  public init(name: String, version: String, description: String, path: String) {
    self.name = name
    self.version = version
    self.description = description
    self.path = path
  }
}

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
  /// The person's standing instruction, the first section of every bot's system prompt.
  public var corePrompt: String
  /// The skills this person ticked for the machine's Bot service.
  public var skills: [SelectedSkill]

  private enum CodingKeys: String, CodingKey {
    case configured, provider, baseUrl, model, hasApiKey, thinkingLevel, toolGroups, corePrompt,
      skills
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
      ?? [
        "persona", "machine", "core", "coding", "memory", "secrets", "herdr", "agents", "trigger",
      ]
    corePrompt = try container.decodeIfPresent(String.self, forKey: .corePrompt) ?? ""
    skills = try container.decodeIfPresent([SelectedSkill].self, forKey: .skills) ?? []
  }
}

/// The machine's own instructions, as the daemon found them: read-only, with the file a person
/// would open. Nil means no candidate file exists, so nothing is rendered into the prompt.
public struct MachinePromptPreview: Decodable, Sendable, Equatable {
  public var path: String
  public var text: String

  public init(path: String, text: String) {
    self.path = path
    self.text = text
  }
}

/// One tool a group contributes: what it is called and what it is for.
public struct ToolDescription: Decodable, Sendable, Equatable, Identifiable {
  public var name: String
  public var description: String

  public var id: String { name }

  public init(name: String, description: String) {
    self.name = name
    self.description = description
  }
}

/// What one tool group gives a bot today, so the settings page shows the surface a switch owns.
public struct ToolGroupCatalog: Decodable, Sendable, Equatable, Identifiable {
  public var group: String
  public var tools: [ToolDescription]

  public var id: String { group }

  public init(group: String, tools: [ToolDescription]) {
    self.group = group
    self.tools = tools
  }
}

/// One read of the daemon's settings: the values that can be edited, plus what the machine
/// contributes to every prompt and never accepts edits for.
public struct BotSettingsSnapshot: Sendable, Equatable {
  public var settings: GatewaySettings
  public var machinePrompt: MachinePromptPreview?
  /// Absent from a daemon that predates the catalogue; nil then, so the page shows no list.
  public var tools: [ToolGroupCatalog]?
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
public final class CatalogHTTPClient: CatalogPort, SecretPort, QuestionPort, Sendable {
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
    appearance: BotCreationAppearance
  ) async throws -> BotSummary {
    struct Payload: Decodable { let bot: BotSummary }
    var face = ["shape": appearance.shape.rawValue]
    if let tint = appearance.tint { face["tint"] = tint.rawValue }
    var body: [String: Any] = ["title": title, "appearance": face]
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

  /// Saves a provider's key, enable flag, or the address and model it overrides: a nil field is
  /// left alone, an empty address or model returns that provider to its catalogue value.
  public func saveProvider(
    id: String,
    apiKey: String?,
    enabled: Bool?,
    baseUrl: String? = nil,
    model: String? = nil
  ) async throws -> ProviderSettings {
    struct Payload: Decodable { let provider: ProviderSettings }
    var body: [String: Any] = [:]
    if let apiKey { body["apiKey"] = apiKey }
    if let enabled { body["enabled"] = enabled }
    if let baseUrl { body["baseUrl"] = baseUrl }
    if let model { body["model"] = model }
    return try await request(
      path: "/v1/providers/\(id)", method: "PUT", body: body, as: Payload.self
    ).provider
  }

  /// Probes one provider: one search, or one minimal decision. Nothing is saved.
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

  /// The model ids the configured gateway offers, and what the daemon knows about each.
  public func loadModels() async throws -> GatewayModels {
    struct Payload: Decodable {
      let models: [String]
      let modelDetails: [ModelDetail]?
      let discoveryError: String?
    }
    let payload = try await request(path: "/v1/models", method: "GET", body: nil, as: Payload.self)
    return GatewayModels(
      ids: payload.models,
      details: payload.modelDetails ?? [],
      discoveryError: payload.discoveryError
    )
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

  public func loadGateway() async throws -> BotSettingsSnapshot {
    struct Payload: Decodable {
      let settings: GatewaySettings
      let machinePrompt: MachinePromptPreview?
      let tools: [ToolGroupCatalog]?
    }
    let payload = try await request(
      path: "/v1/settings", method: "GET", body: nil, as: Payload.self)
    return BotSettingsSnapshot(
      settings: payload.settings, machinePrompt: payload.machinePrompt, tools: payload.tools)
  }

  /// Saving applies the gateway to new bots and moves live conversations to the model and level.
  public func saveGateway(
    baseURL: String,
    model: String,
    thinkingLevel: String,
    toolGroups: [String],
    apiKey: String?
  ) async throws -> BotSettingsSnapshot {
    var body: [String: Any] = [
      "baseUrl": baseURL, "model": model, "thinkingLevel": thinkingLevel,
      "toolGroups": toolGroups,
    ]
    if let apiKey, !apiKey.isEmpty { body["apiKey"] = apiKey }
    return try await saveSettings(body: body)
  }

  /// The tools page: the standing instruction and the group switches, leaving the gateway
  /// fields the model page owns untouched (an absent field keeps its stored value).
  public func saveToolSettings(
    corePrompt: String,
    toolGroups: [String]
  ) async throws -> BotSettingsSnapshot {
    try await saveSettings(body: ["corePrompt": corePrompt, "toolGroups": toolGroups])
  }

  /// The 技能 page's one write: this list replaces what the daemon stored, and an empty list
  /// clears it. Every other setting is left alone, because an absent field keeps its value.
  public func saveSkills(_ skills: [SelectedSkill]) async throws {
    let list = skills.map { skill in
      [
        "name": skill.name, "version": skill.version, "description": skill.description,
        "path": skill.path,
      ]
    }
    _ = try await raw(path: "/v1/settings", method: "PUT", body: ["skills": list])
  }

  private func saveSettings(body: [String: Any]) async throws -> BotSettingsSnapshot {
    struct Payload: Decodable {
      let settings: GatewaySettings
      let machinePrompt: MachinePromptPreview?
      let tools: [ToolGroupCatalog]?
    }
    let payload = try await request(
      path: "/v1/settings", method: "PUT", body: body, as: Payload.self)
    return BotSettingsSnapshot(
      settings: payload.settings, machinePrompt: payload.machinePrompt, tools: payload.tools)
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

  // MARK: - Secrets

  /// Every record's metadata. A store that cannot be read is a refusal, not an empty list, so
  /// the caller never shows "no passwords" when it means "cannot read them".
  public func answerQuestions(
    botId: String, entryId: String, answers: [[String]], skipped: Bool
  ) async throws {
    struct Payload: Decodable { let submission: Submission }
    var body: [String: Any] = ["entryId": entryId]
    if skipped { body["skipped"] = true } else { body["answers"] = answers }
    let result = try await request(
      path: "/v1/bots/\(botId)/answers", method: "POST", body: body, as: Payload.self)
    if result.submission.status == .unanswered { throw ClientError("这个回答没有被接纳") }
  }

  public func secrets() async throws -> [Secret] {
    struct Payload: Decodable { let secrets: [Secret] }
    return try await request(path: "/v1/secrets", method: "GET", body: nil, as: Payload.self)
      .secrets
  }

  /// One value, read on request: the daemon records the read and answers the value alone.
  public func revealSecret(key: String, scope: SecretScope, botId: String?) async throws -> String {
    struct Payload: Decodable {
      struct Body: Decodable {
        let key: String
        let scope: String
        let value: String
      }
      let secret: Body
    }
    var body: [String: Any] = ["key": key, "scope": scope.rawValue]
    if let botId, !botId.isEmpty { body["botId"] = botId }
    let payload = try await request(
      path: "/v1/secrets/reveal",
      method: "POST",
      body: body,
      as: Payload.self
    )
    return payload.secret.value
  }

  /// Removes one record. The daemon answers 204, or 404 for a record that is already gone.
  public func deleteSecret(key: String, scope: SecretScope, botId: String?) async throws {
    var query: [URLQueryItem] = []
    if let botId, !botId.isEmpty { query.append(URLQueryItem(name: "botId", value: botId)) }
    _ = try await raw(
      path: "/v1/secrets/\(scope.rawValue)/\(key)", method: "DELETE", body: nil, query: query)
  }

  /// Answers a secret card. The value travels once: the response carries the submission and
  /// nothing else. `ttlMinutes` is the person's last word, so it is always in the body — the
  /// number they chose, or null for a record that never expires.
  public func answerSecret(
    botId: String,
    entryId: String,
    callIndex: Int,
    key: String,
    value: String,
    scope: SecretScope,
    ttlMinutes: SecretTTL,
    skipped: Bool
  ) async throws {
    struct Payload: Decodable { let submission: Submission }
    var body: [String: Any] = [
      "entryId": entryId,
      "callIndex": callIndex,
      "key": key,
      "value": value,
      "scope": scope.rawValue,
    ]
    switch ttlMinutes {
    case .inherit:
      break
    case .permanent:
      body["ttlMinutes"] = NSNull()
    case .minutes(let minutes):
      body["ttlMinutes"] = minutes
    }
    if skipped { body["skipped"] = true }
    _ = try await request(
      path: "/v1/bots/\(botId)/secrets", method: "POST", body: body, as: Payload.self
    )
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
