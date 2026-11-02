import Foundation
import Testing

@testable import EagleFeatures

@Suite("Local Herdr teams")
struct LocalHerdrClientTests {
  @Test("running local sessions keep separate teams and include agents from every tab")
  func readsLocalTeams() async throws {
    let commands = HerdrReadCommands()
    let client = LocalHerdrClient { arguments in
      await commands.append(arguments)
      return Data(
        (arguments == ["session", "list", "--json"]
          ? herdrSessionFixture : herdrSnapshotFixture).utf8)
    }
    let snapshot = try await client.read()
    #expect(snapshot.sessionCount == 2)
    try #require(snapshot.teams.count == 4)
    #expect(Set(snapshot.teams.map(\.id)).count == 4)
    #expect(snapshot.teams.map(\.session) == ["default", "default", "focus", "focus"])
    #expect(snapshot.teams[1].name == "Shells")
    #expect(snapshot.teams[1].members.isEmpty)
    let team = snapshot.teams[0]
    #expect(team.name == "Eagle")
    #expect(team.members.map(\.name) == ["service", "codex · w1:p2", "review"])
    #expect(team.members.map(\.status) == [.working, .unknown, .done])
    #expect(team.members[0].kind == "codex")
    #expect(team.members.allSatisfy { $0.model == nil })
    #expect(
      await commands.values == [
        ["session", "list", "--json"],
        ["--session", "default", "api", "snapshot"],
        ["--session", "focus", "api", "snapshot"],
      ])
  }

  @Test("no running sessions is distinct from an installed session with no agents")
  func emptySessions() async throws {
    let client = LocalHerdrClient { _ in Data(#"{"sessions":[]}"#.utf8) }
    #expect(try await client.read() == HerdrTeamsSnapshot(teams: [], sessionCount: 0))

    let running = LocalHerdrClient { arguments in
      Data(
        (arguments == ["session", "list", "--json"]
          ? #"{"sessions":[{"name":"default","running":true}]}"#
          : #"{"result":{"type":"session_snapshot","snapshot":{"workspaces":[],"agents":[]}}}"#)
          .utf8)
    }
    #expect(try await running.read() == HerdrTeamsSnapshot(teams: [], sessionCount: 1))
  }

  @Test("optional model metadata never changes the Herdr lifecycle state")
  func metadataPreservesStatus() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(
      fixture.header + fixture.turn + fixture.window
        + #"{"type":"event_msg","payload":{"type":"task_complete"}}"# + "\n")
    let client = LocalHerdrClient(metadata: CodexSessionMetadataReader(root: fixture.root)) {
      arguments in
      Data(
        (arguments == ["session", "list", "--json"]
          ? herdrSessionFixture
          : herdrSnapshotFixture.replacingOccurrences(of: "working", with: "blocked")).utf8)
    }
    let member = try #require(try await client.read().teams.first?.members.first)
    #expect(member.status == .blocked)
    #expect(member.detail == "codex · gpt-6-astra · max · 257.4K")
    #expect(member.configurationHelp.contains("推理强度：max"))
    #expect(member.configurationHelp.contains("tokens"))
  }

  @Test(
    "unsupported or malformed session references keep the roster usable without guessed settings",
    arguments: [
      "false", #"{"agent":"claude","kind":"id","value":"11111111-1111-4111-8111-111111111111"}"#,
      #"{"agent":"codex","kind":"path","value":"/unexpected/log"}"#,
      #"{"agent":"codex","kind":"id","value":"../../outside"}"#,
    ])
  func unsupportedMetadata(reference: String) async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(fixture.header + fixture.turn + fixture.window)
    let original = #"{"agent":"codex","kind":"id","value":"11111111-1111-4111-8111-111111111111"}"#
    let client = LocalHerdrClient(metadata: CodexSessionMetadataReader(root: fixture.root)) {
      arguments in
      Data(
        (arguments == ["session", "list", "--json"]
          ? herdrSessionFixture
          : herdrSnapshotFixture.replacingOccurrences(of: original, with: reference)).utf8)
    }
    let member = try #require(try await client.read().teams.first?.members.first)
    #expect(member.status == .working)
    #expect(member.model == nil)
    #expect(member.detail == "codex · 模型未记录")
  }

  @Test(
    "invalid snapshots fail instead of becoming an empty team list",
    arguments: [
      "not json", #"{"error":{"code":"not_running"}}"#,
      herdrSnapshotFixture.replacingOccurrences(of: "session_snapshot", with: "agent_list"),
      herdrSnapshotFixture.replacingOccurrences(of: "w1:p2", with: "w1:p1"),
      herdrSnapshotFixture.replacingOccurrences(
        of: #""workspace_id":"w2""#, with: #""workspace_id":"w1""#),
    ])
  func invalidSnapshots(raw: String) async throws {
    let client = LocalHerdrClient { arguments in
      Data((arguments == ["session", "list", "--json"] ? herdrSessionFixture : raw).utf8)
    }
    await #expect(throws: HerdrReadError.invalidResponse) { try await client.read() }
  }

  @Test("inherited selectors and secrets are not sent to the local reader")
  func environment() {
    let home = URL(fileURLWithPath: "/Users/test")
    let result = LocalHerdrClient.commandEnvironment(
      home: home,
      environment: [
        "PATH": "/usr/bin", "HERDR_SOCKET_PATH": "/remote.sock", "HERDR_SESSION": "other",
        "HERDR_CONFIG_PATH": "/Users/test/.config/herdr/config.toml", "API_KEY": "test-secret",
      ])
    #expect(result["PATH"] == "/usr/bin")
    #expect(result["HOME"] == home.path)
    #expect(result["HERDR_CONFIG_PATH"] == "/Users/test/.config/herdr/config.toml")
    #expect(result["HERDR_SOCKET_PATH"] == nil)
    #expect(result["HERDR_SESSION"] == nil)
    #expect(result["API_KEY"] == nil)
    #expect(HerdrAgentStatus.done.title == "已响应")
    #expect(HerdrAgentStatus.unknown.title == "未知")
  }

  @Test("GUI launch finds the user installation without a login-shell PATH")
  func executableDiscovery() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: home) }
    let binary = home.appendingPathComponent(".local/bin/herdr")
    try FileManager.default.createDirectory(
      at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
    #expect(
      LocalHerdrClient.executable(home: home, environment: ["PATH": "/usr/bin:/bin"]) == binary)
  }

  @Test("read arguments are passed literally without invoking a shell")
  func literalArguments() async throws {
    let text = "a session; $(false) `false`"
    let output = try await LocalHerdrClient.run(
      executable: URL(fileURLWithPath: "/bin/echo"), arguments: [text], environment: [:])
    #expect(String(decoding: output, as: UTF8.self) == text + "\n")
    await #expect(throws: HerdrReadError.unavailable) {
      try await LocalHerdrClient.run(
        executable: URL(fileURLWithPath: "/usr/bin/false"), arguments: [], environment: [:])
    }
  }

  @Test("a hung read times out and excessive output is bounded")
  func boundedRead() async throws {
    await #expect(throws: HerdrReadError.timeout) {
      try await LocalHerdrClient.run(
        executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["60"], environment: [:],
        timeout: .milliseconds(100))
    }
    await #expect(throws: HerdrReadError.invalidResponse) {
      try await LocalHerdrClient.run(
        executable: URL(fileURLWithPath: "/usr/bin/yes"), arguments: [], environment: [:])
    }
  }

  @Test("cancelling a reader terminates its command")
  func cancelledRead() async throws {
    let reading = Task {
      try await LocalHerdrClient.run(
        executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["60"], environment: [:])
    }
    try await Task.sleep(for: .milliseconds(50))
    reading.cancel()
    await #expect(throws: CancellationError.self) { try await reading.value }
  }
}

private actor HerdrReadCommands {
  var values: [[String]] = []
  func append(_ arguments: [String]) { values.append(arguments) }
}

let herdrSessionFixture = """
  {"sessions":[
    {"name":"default","running":true},
    {"name":"stopped","running":false},
    {"name":"focus","running":true}
  ]}
  """

let herdrSnapshotFixture = """
  {"id":"cli:snapshot","result":{"type":"session_snapshot","snapshot":{
    "workspaces":[
      {"workspace_id":"w1","label":"Eagle","agent_status":"done","tab_count":2},
      {"workspace_id":"w2","label":"Shells","agent_status":"unknown"}
    ],
    "agents":[
      {"workspace_id":"w1","pane_id":"w1:p1","tab_id":"w1:t1","name":"service",
       "agent_session":{"agent":"codex","kind":"id","value":"11111111-1111-4111-8111-111111111111"},
       "agent":"codex","agent_status":"working","cwd":"/work/base","foreground_cwd":"/work/current"},
      {"workspace_id":"w1","pane_id":"w1:p2","tab_id":"w1:t2","agent":"codex",
       "agent_status":"future-state","cwd":"/work/base"},
      {"workspace_id":"w1","pane_id":"w1:p3","tab_id":"w1:t2","name":"review",
       "agent":"codex","agent_status":"done"}
    ]
  }}}
  """
