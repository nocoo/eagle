import Foundation

public enum HerdrAgentStatus: String, Sendable {
  case working, blocked, idle, done, unknown

  public var title: String {
    switch self {
    case .working: return "运行中"
    case .blocked: return "待确认"
    case .idle: return "空闲"
    case .done: return "已响应"
    case .unknown: return "未知"
    }
  }
}

public struct HerdrTeamMember: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let kind: String
  public let status: HerdrAgentStatus
  public let model: String?
  public let reasoningEffort: String?
  public let contextWindow: Int?

  public init(
    id: String, name: String, kind: String, status: HerdrAgentStatus,
    model: String? = nil, reasoningEffort: String? = nil, contextWindow: Int? = nil
  ) {
    self.id = id
    self.name = name
    self.kind = kind
    self.status = status
    self.model = model
    self.reasoningEffort = reasoningEffort
    self.contextWindow = contextWindow
  }

  public var detail: String {
    [
      kind, model ?? "模型未记录", reasoningEffort,
      contextWindow.map { UsageFormat.tokens($0).uppercased() },
    ]
    .compactMap { $0 }.joined(separator: " · ")
  }

  public var configurationHelp: String {
    "模型：\(model ?? "未记录")\n推理强度：\(reasoningEffort ?? "未记录")\n上下文窗口："
      + (contextWindow.map { "\($0.formatted()) tokens" } ?? "未记录")
  }
}

public struct HerdrTeam: Identifiable, Equatable, Sendable {
  public var id: String { "\(session):\(workspaceID)" }
  public let session: String
  public let workspaceID: String
  public let name: String
  public let members: [HerdrTeamMember]

  public init(session: String, workspaceID: String, name: String, members: [HerdrTeamMember]) {
    self.session = session
    self.workspaceID = workspaceID
    self.name = name
    self.members = members
  }
}

public struct HerdrTeamsSnapshot: Equatable, Sendable {
  public let teams: [HerdrTeam]
  public let sessionCount: Int

  public init(teams: [HerdrTeam], sessionCount: Int) {
    self.teams = teams
    self.sessionCount = sessionCount
  }
}

public struct LocalHerdrClient: Sendable {
  private let execute: @Sendable ([String]) async throws -> Data
  private let metadata: CodexSessionMetadataReader?

  public init() {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let codex =
      ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
      ?? home.appendingPathComponent(".codex")
    self.metadata = CodexSessionMetadataReader(root: codex.appendingPathComponent("sessions"))
    self.execute = { arguments in
      let environment = ProcessInfo.processInfo.environment
      let home = FileManager.default.homeDirectoryForCurrentUser
      guard let executable = Self.executable(home: home, environment: environment) else {
        throw HerdrReadError.notInstalled
      }
      return try await Self.run(
        executable: executable, arguments: arguments,
        environment: Self.commandEnvironment(home: home, environment: environment))
    }
  }

  init(
    metadata: CodexSessionMetadataReader? = nil,
    execute: @escaping @Sendable ([String]) async throws -> Data
  ) {
    self.metadata = metadata
    self.execute = execute
  }

  public func read() async throws -> HerdrTeamsSnapshot {
    do {
      let decoder = JSONDecoder()
      decoder.keyDecodingStrategy = .convertFromSnakeCase
      let sessions = try decoder.decode(
        Sessions.self, from: await execute(["session", "list", "--json"])
      )
      .sessions.filter(\.running)
      guard Set(sessions.map(\.name)).count == sessions.count,
        sessions.allSatisfy({ !$0.name.isEmpty })
      else { throw HerdrReadError.invalidResponse }
      var teams: [HerdrTeam] = []
      for session in sessions {
        try Task.checkCancellation()
        let reply = try decoder.decode(
          Reply.self, from: await execute(["--session", session.name, "api", "snapshot"]))
        guard reply.result.type == "session_snapshot" else { throw HerdrReadError.invalidResponse }
        let snapshot = reply.result.snapshot
        let workspaceIDs = Set(snapshot.workspaces.map(\.workspaceId))
        guard workspaceIDs.count == snapshot.workspaces.count,
          Set(snapshot.agents.map(\.paneId)).count == snapshot.agents.count,
          snapshot.agents.allSatisfy({ workspaceIDs.contains($0.workspaceId) })
        else { throw HerdrReadError.invalidResponse }
        let agents = Dictionary(grouping: snapshot.agents, by: \.workspaceId)
        for workspace in snapshot.workspaces {
          var members: [HerdrTeamMember] = []
          for agent in agents[workspace.workspaceId] ?? [] {
            var info = HerdrAgentMetadata()
            if agent.agent == "codex", agent.agentSession?.agent == agent.agent,
              agent.agentSession?.kind == "id", let id = agent.agentSession?.value
            {
              info = await metadata?.read(sessionID: id) ?? HerdrAgentMetadata()
            }
            try Task.checkCancellation()
            let kind = agent.agent.flatMap(Self.nonempty) ?? "未知"
            members.append(
              HerdrTeamMember(
                id: agent.paneId,
                name: Self.nonempty(agent.name) ?? "\(kind) · \(agent.paneId)",
                kind: kind,
                status: HerdrAgentStatus(rawValue: agent.agentStatus ?? "") ?? .unknown,
                model: info.model, reasoningEffort: info.reasoningEffort,
                contextWindow: info.contextWindow))
          }
          teams.append(
            HerdrTeam(
              session: session.name, workspaceID: workspace.workspaceId,
              name: Self.nonempty(workspace.label) ?? workspace.workspaceId, members: members))
        }
      }
      return HerdrTeamsSnapshot(teams: teams, sessionCount: sessions.count)
    } catch is DecodingError {
      throw HerdrReadError.invalidResponse
    }
  }

  private static func nonempty(_ value: String?) -> String? {
    value.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
  }

  static func executable(home: URL, environment: [String: String]) -> URL? {
    let paths =
      [home.appendingPathComponent(".local/bin").path]
      + (environment["PATH"] ?? "").split(separator: ":").map(String.init)
      + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    return paths.filter { $0.hasPrefix("/") }
      .map { URL(fileURLWithPath: $0).appendingPathComponent("herdr") }
      .first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  static func commandEnvironment(home: URL, environment: [String: String]) -> [String: String] {
    // Inherited pane/socket selectors must not retarget an explicit local session.
    var result = environment.filter {
      ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "HERDR_CONFIG_PATH"].contains(
        $0.key)
    }
    result["HOME"] = home.path
    result["TMPDIR"] = NSTemporaryDirectory()
    return result
  }

  static func run(
    executable: URL, arguments: [String], environment: [String: String],
    timeout: Duration = .seconds(10)
  ) async throws -> Data {
    try Task.checkCancellation()
    let process = Process()
    let output = Pipe()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { throw HerdrReadError.unavailable }
    try? output.fileHandleForWriting.close()
    let reader = Task.detached(priority: .utility) {
      defer { try? output.fileHandleForReading.close() }
      var data = Data()
      while let chunk = try output.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= 2 * 1024 * 1024 else {
          if process.isRunning { kill(process.processIdentifier, SIGKILL) }
          throw HerdrReadError.invalidResponse
        }
      }
      return data
    }
    do {
      let deadline = ContinuousClock.now.advanced(by: timeout)
      while process.isRunning {
        try Task.checkCancellation()
        guard ContinuousClock.now < deadline else { throw HerdrReadError.timeout }
        try await Task.sleep(for: .milliseconds(25))
      }
      let data = try await reader.value
      try Task.checkCancellation()
      guard process.terminationStatus == 0 else { throw HerdrReadError.unavailable }
      return data
    } catch {
      // Only this short-lived read command is owned here, never the Herdr server.
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      _ = try? await reader.value
      throw error
    }
  }

  private struct Sessions: Decodable {
    let sessions: [Session]
    struct Session: Decodable {
      let name: String
      let running: Bool
    }
  }
  private struct Reply: Decodable {
    let result: Result
    struct Result: Decodable {
      let type: String
      let snapshot: Snapshot
    }
  }
  private struct Snapshot: Decodable {
    let workspaces: [Workspace]
    let agents: [Agent]
    struct Workspace: Decodable {
      let workspaceId: String
      let label: String?
    }
    struct Agent: Decodable {
      let workspaceId: String
      let paneId: String
      let name: String?
      let agent: String?
      let agentStatus: String?
      let agentSession: AgentSession?
    }
    struct AgentSession: Decodable {
      let agent: String?
      let kind: String?
      let value: String?

      enum CodingKeys: String, CodingKey { case agent, kind, value }

      init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        agent = try? container?.decode(String.self, forKey: .agent)
        kind = try? container?.decode(String.self, forKey: .kind)
        value = try? container?.decode(String.self, forKey: .value)
      }
    }
  }
}

public enum HerdrReadError: Error, Equatable, Sendable {
  case notInstalled, unavailable, invalidResponse, timeout

  public var message: String {
    switch self {
    case .notInstalled: return "未找到 Herdr，请先在本机安装 Herdr。"
    case .unavailable: return "暂时无法连接本机 Herdr，请确认它正在运行。"
    case .invalidResponse: return "无法识别 Herdr 返回的信息，请检查 Herdr 版本。"
    case .timeout: return "读取 Herdr 超时，稍后会自动重试。"
    }
  }
}
