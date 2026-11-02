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
  public let directory: String?

  public init(
    id: String, name: String, kind: String, status: HerdrAgentStatus, directory: String? = nil
  ) {
    self.id = id
    self.name = name
    self.kind = kind
    self.status = status
    self.directory = directory
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

  public init() {
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

  init(execute: @escaping @Sendable ([String]) async throws -> Data) {
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
          let members = (agents[workspace.workspaceId] ?? []).map { agent in
            HerdrTeamMember(
              id: agent.paneId,
              name: Self.nonempty(agent.name) ?? "\(agent.agent) · \(agent.paneId)",
              kind: agent.agent,
              status: HerdrAgentStatus(rawValue: agent.agentStatus ?? "") ?? .unknown,
              directory: Self.nonempty(agent.foregroundCwd) ?? Self.nonempty(agent.cwd))
          }
          if !members.isEmpty {
            teams.append(
              HerdrTeam(
                session: session.name, workspaceID: workspace.workspaceId,
                name: Self.nonempty(workspace.label) ?? workspace.workspaceId, members: members))
          }
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
    timeout: Duration = .seconds(3)
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
      let agent: String
      let agentStatus: String?
      let cwd: String?
      let foregroundCwd: String?
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
