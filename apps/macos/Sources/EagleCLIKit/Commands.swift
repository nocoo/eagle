import Foundation

/// One parsed command line: positionals plus the flags the command declared.
public struct Arguments: Sendable {
  public var positionals: [String] = []
  public var values: [String: String] = [:]
  public var switches: Set<String> = []

  /// Parses with the command's own vocabulary, so a typo is a usage error instead of being
  /// silently ignored (`docs/bots/CLI.md`, exit code 2).
  public static func parse(
    _ tokens: [String],
    valueFlags: Set<String>,
    switchFlags: Set<String>
  ) throws -> Arguments {
    var arguments = Arguments()
    var index = 0
    while index < tokens.count {
      let token = tokens[index]
      if token == "--" {
        arguments.positionals.append(contentsOf: tokens[(index + 1)...])
        break
      }
      guard token.hasPrefix("--") else {
        arguments.positionals.append(token)
        index += 1
        continue
      }
      let body = String(token.dropFirst(2))
      let parts = body.split(separator: "=", maxSplits: 1).map(String.init)
      let name = parts[0]
      if switchFlags.contains(name) {
        guard parts.count == 1 else { throw CLIError.usage("--\(name) takes no value") }
        arguments.switches.insert(name)
        index += 1
        continue
      }
      guard valueFlags.contains(name) else { throw CLIError.usage("unknown option --\(name)") }
      if parts.count == 2 {
        arguments.values[name] = parts[1]
        index += 1
        continue
      }
      guard index + 1 < tokens.count else {
        throw CLIError.usage("--\(name) needs a value")
      }
      arguments.values[name] = tokens[index + 1]
      index += 2
    }
    return arguments
  }

  public func value(_ name: String) -> String? { values[name] }

  public func required(_ name: String) throws -> String {
    guard let value = values[name], !value.isEmpty else {
      throw CLIError.usage("--\(name) is required")
    }
    return value
  }

  public func positional(_ index: Int, _ label: String) throws -> String {
    guard index < positionals.count else { throw CLIError.usage("\(label) is required") }
    return positionals[index]
  }
}

/// The command surface. Every method reads or mutates through the daemon only.
public struct Commands: Sendable {
  private let config: CLIConfig
  private let printer: Printer
  private let session: URLSession

  public init(config: CLIConfig, printer: Printer, session: URLSession = .shared) {
    self.config = config
    self.printer = printer
    self.session = session
  }

  private var client: DaemonClient { DaemonClient(config: config, session: session) }

  /// `eagle --skill`: the agent-facing document, with this binary's own name substituted.
  public var skill: String {
    Skill.document(binaryName: config.binaryName, clientName: config.clientName)
  }

  public func run(_ tokens: [String]) async throws {
    guard let first = tokens.first else {
      printer.text(usage)
      return
    }
    switch first {
    case "--skill", "skill":
      printer.text(skill)
      return
    case "--help", "help", "-h":
      printer.text(usage)
      return
    case "--version", "version":
      try await version()
      return
    case "health":
      try await health(tokens: Array(tokens.dropFirst()))
      return
    case "whoami":
      try await whoami(tokens: Array(tokens.dropFirst()))
      return
    case "bots":
      try await bots(tokens: Array(tokens.dropFirst()))
      return
    case "groups":
      try await groups(tokens: Array(tokens.dropFirst()))
      return
    case "chat":
      try await chat(tokens: Array(tokens.dropFirst()))
      return
    case "usage":
      try await usage(tokens: Array(tokens.dropFirst()))
      return
    default:
      throw CLIError.usage("unknown command \(first)\n\n\(usage)")
    }
  }

  public var usage: String {
    """
    \(config.binaryName) — talk to the local Eagle Bots daemon

    USAGE
      \(config.binaryName) --skill                 the agent-facing document
      \(config.binaryName) health                  daemon version and bot count
      \(config.binaryName) whoami                  the credential and its scopes
      \(config.binaryName) bots list|show|create|update|move|delete
      \(config.binaryName) groups list|create|rename|order|delete
      \(config.binaryName) chat send|watch|history|abort <bot>
      \(config.binaryName) usage [--days N]

    Every command takes --json. Destructive commands need --yes.
    Config: \(config.configPath)
    """
  }

  // MARK: - Read-only

  private func version() async throws {
    // The local version prints even when the daemon is down: that is the diagnostic case.
    let daemon = (try? await client.request("GET", "v1/health", requiresAuth: false))
      .flatMap { $0["version"] as? String }
    let tail = daemon.map { "daemon \($0)" } ?? "daemon unreachable"
    printer.text(
      "\(config.binaryName) \(EagleCLIKit.version) · \(tail) · \(config.baseURL.absoluteString)"
    )
  }

  private func health(tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let body = try await client.request("GET", "v1/health", requiresAuth: false)
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    let version = body["version"] as? String ?? "unknown"
    let bots = body["bots"] as? Int ?? 0
    let pid = body["pid"] as? Int ?? 0
    printer.text("daemon \(version) · pid \(pid) · \(bots) bots · \(config.baseURL.absoluteString)")
  }

  private func whoami(tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let body = try await client.request("GET", "v1/clients/me")
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    guard let client = body["client"] as? JSONObject else {
      printer.text("this credential is the App's own token: full access")
      return
    }
    let name = client["name"] as? String ?? "?"
    let scopes = (client["scopes"] as? [String] ?? []).joined(separator: ", ")
    printer.text("\(name) · \(scopes)")
  }

  private func usage(tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: ["days"], switchFlags: ["json"])
    let days = arguments.value("days").flatMap(Int.init) ?? 30
    let body = try await client.request("GET", "v1/usage?days=\(days)")
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    guard let report = body["usage"] as? JSONObject else {
      printer.text("no usage recorded")
      return
    }
    for (label, key) in [("今日", "today"), ("近 7 天", "week"), ("近 30 天", "month")] {
      guard let totals = report[key] as? JSONObject else { continue }
      let tokensTotal = (totals["totalTokens"] as? NSNumber)?.intValue ?? 0
      let calls = (totals["calls"] as? NSNumber)?.intValue ?? 0
      printer.text("\(label)  \(tokensTotal) tokens · \(calls) calls")
    }
  }

  // MARK: - Bots

  private func bots(tokens: [String]) async throws {
    guard let sub = tokens.first else {
      throw CLIError.usage("bots list|show|create|update|move|delete")
    }
    let rest = Array(tokens.dropFirst())
    switch sub {
    case "list":
      let arguments = try Arguments.parse(rest, valueFlags: ["group"], switchFlags: ["json"])
      let body = try await client.request("GET", "v1/bots")
      let summaries = body["bots"] as? [JSONObject] ?? []
      let filtered: [JSONObject]
      if let group = arguments.value("group") {
        filtered =
          group == "-"
          ? summaries.filter { $0["groupId"] == nil || $0["groupId"] is NSNull }
          : summaries.filter { $0["groupId"] as? String == group }
      } else {
        filtered = summaries
      }
      if printer.wantsJSON(arguments) {
        printer.json(["bots": filtered])
        return
      }
      for row in filtered { printer.text(Self.botLine(row)) }
      if filtered.isEmpty { printer.text("no bots") }
    case "show":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json"])
      let name = try arguments.positional(0, "<bot>")
      let bot = try await resolve(name)
      if printer.wantsJSON(arguments) {
        printer.json(["bot": bot])
        return
      }
      printer.text(Self.botLine(bot))
    case "create":
      try await createBot(rest)
    case "update":
      try await updateBot(rest)
    case "move":
      try await moveBot(rest)
    case "delete":
      try await deleteBot(rest)
    default:
      throw CLIError.usage("unknown bots command \(sub)")
    }
  }

  private func createBot(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens,
      valueFlags: ["title", "label", "shape", "tint", "group"],
      switchFlags: ["json"])
    var body: JSONObject = ["title": try arguments.required("title")]
    if let label = arguments.value("label") { body["label"] = label }
    if let group = arguments.value("group") { body["groupId"] = group }
    if let appearance = try appearance(arguments) { body["appearance"] = appearance }
    let answer = try await client.request("POST", "v1/bots", body: body)
    guard let bot = answer["bot"] as? JSONObject else {
      throw CLIError.refused(kind: "invalid_response", message: "the daemon created no bot")
    }
    if printer.wantsJSON(arguments) {
      printer.json(["bot": bot])
      return
    }
    printer.text(Self.botLine(bot))
  }

  private func updateBot(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens,
      valueFlags: ["title", "label", "shape", "tint", "group", "model", "thinking"],
      switchFlags: ["json"])
    let name = try arguments.positional(0, "<bot>")
    let bot = try await resolve(name)
    var patch: JSONObject = [:]
    if let title = arguments.value("title") { patch["title"] = title }
    if let label = arguments.value("label") { patch["label"] = label }
    if let model = arguments.value("model") { patch["model"] = model }
    if let thinking = arguments.value("thinking") { patch["thinkingLevel"] = thinking }
    if let group = arguments.value("group") {
      patch["groupId"] = group == "-" ? NSNull() : group
    }
    if let appearance = try appearance(arguments) { patch["appearance"] = appearance }
    guard !patch.isEmpty else { throw CLIError.usage("nothing to update") }
    let id = bot["id"] as? String ?? name
    let answer = try await client.request("PATCH", "v1/bots/\(id)", body: patch)
    if printer.wantsJSON(arguments) {
      printer.json(answer)
      return
    }
    printer.text(Self.botLine(answer["bot"] as? JSONObject ?? bot))
  }

  private func moveBot(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: ["group"], switchFlags: ["json"])
    let name = try arguments.positional(0, "<bot>")
    let group = try arguments.required("group")
    let bot = try await resolve(name)
    let id = bot["id"] as? String ?? name
    let patch: JSONObject = ["groupId": group == "-" ? NSNull() : group]
    let answer = try await client.request("PATCH", "v1/bots/\(id)", body: patch)
    if printer.wantsJSON(arguments) {
      printer.json(answer)
      return
    }
    printer.text(Self.botLine(answer["bot"] as? JSONObject ?? bot))
  }

  private func deleteBot(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json", "yes"])
    let name = try arguments.positional(0, "<bot>")
    try requireYes(arguments)
    let bot = try await resolve(name)
    let id = bot["id"] as? String ?? name
    _ = try await client.request("DELETE", "v1/bots/\(id)")
    if printer.wantsJSON(arguments) {
      printer.json(["deleted": id])
      return
    }
    printer.text("deleted \(bot["title"] as? String ?? id)")
  }

  private func appearance(_ arguments: Arguments) throws -> JSONObject? {
    let shape = arguments.value("shape")
    let tint = arguments.value("tint")
    guard shape != nil || tint != nil else { return nil }
    guard let shape, let tint else { throw CLIError.usage("--shape and --tint go together") }
    return ["shape": shape, "tint": tint]
  }

  // MARK: - Groups

  private func groups(tokens: [String]) async throws {
    guard let sub = tokens.first else {
      throw CLIError.usage("groups list|create|rename|order|delete")
    }
    let rest = Array(tokens.dropFirst())
    switch sub {
    case "list":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json"])
      let body = try await client.request("GET", "v1/bots")
      let groups = body["groups"] as? [JSONObject] ?? []
      let bots = body["bots"] as? [JSONObject] ?? []
      if printer.wantsJSON(arguments) {
        printer.json(["groups": groups])
        return
      }
      for group in groups {
        let id = group["id"] as? String ?? "?"
        let title = group["title"] as? String ?? "?"
        let count = bots.filter { $0["groupId"] as? String == id }.count
        printer.text("\(id)  \(title)  (\(count) bots)")
      }
      if groups.isEmpty { printer.text("no groups") }
    case "create":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json"])
      let title = try arguments.positional(0, "<title>")
      let answer = try await client.request("POST", "v1/groups", body: ["title": title])
      printer.output(arguments, json: answer) { group in
        "\(group["id"] as? String ?? "?")  \(group["title"] as? String ?? "?")"
      }
    case "rename":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json"])
      let id = try arguments.positional(0, "<group id>")
      let title = try arguments.positional(1, "<title>")
      let answer = try await client.request("PATCH", "v1/groups/\(id)", body: ["title": title])
      printer.output(arguments, json: answer) { group in
        "\(group["id"] as? String ?? "?")  \(group["title"] as? String ?? "?")"
      }
    case "order":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json"])
      let ids = try arguments.positional(0, "<id,id,…>")
        .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
      let answer = try await client.request("PUT", "v1/groups/order", body: ["ids": ids])
      if printer.wantsJSON(arguments) {
        printer.json(answer)
        return
      }
      let groups = answer["groups"] as? [JSONObject] ?? []
      printer.text(groups.compactMap { $0["title"] as? String }.joined(separator: " → "))
    case "delete":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json", "yes"])
      let id = try arguments.positional(0, "<group id>")
      try requireYes(arguments)
      _ = try await client.request("DELETE", "v1/groups/\(id)")
      if printer.wantsJSON(arguments) {
        printer.json(["deleted": id])
        return
      }
      printer.text("deleted \(id)")
    default:
      throw CLIError.usage("unknown groups command \(sub)")
    }
  }

  private func requireYes(_ arguments: Arguments) throws {
    guard arguments.switches.contains("yes") else {
      throw CLIError.usage("this deletes data: add --yes")
    }
  }

  // MARK: - Chat

  private func chat(tokens: [String]) async throws {
    guard let sub = tokens.first else {
      throw CLIError.usage("chat send|watch|history|abort <bot>")
    }
    let rest = Array(tokens.dropFirst())
    switch sub {
    case "send":
      try await send(rest)
    case "watch":
      try await watch(rest)
    case "history":
      try await history(rest)
    case "abort":
      try await abort(rest)
    default:
      throw CLIError.usage("unknown chat command \(sub)")
    }
  }

  private func send(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["text", "timeout", "when-busy"], switchFlags: ["json", "wait"])
    let name = try arguments.positional(0, "<bot>")
    let text = try arguments.required("text")
    let timeout = arguments.value("timeout").flatMap(Double.init) ?? 300
    let whenBusy = arguments.value("when-busy") ?? "followUp"
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name

    let socket = try await client.connect(clientName: "eagle-cli/\(EagleCLIKit.version)")
    defer { socket.close() }
    _ = try await socket.subscribe(botId: botId)
    let requestId = "r_cli_" + UUID().uuidString.prefix(8).lowercased()
    try await socket.send(text: text, requestId: requestId, whenBusy: whenBusy)
    guard arguments.switches.contains("wait") else {
      if printer.wantsJSON(arguments) {
        printer.json(["sent": requestId])
        return
      }
      printer.text("sent \(requestId)")
      return
    }

    var answers: [String: String] = [:]
    var lastAnswer: String?
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let frame = try await socket.read()
      let type = frame["type"] as? String ?? ""
      if type == "append", let message = frame["message"] as? JSONObject,
        let id = message["id"] as? String
      {
        let text = Self.text(of: message)
        if message["role"] as? String == "assistant", !text.isEmpty {
          answers[id] = text
          lastAnswer = text
        }
        if printer.wantsJSON(arguments) { printer.json(frame) }
      } else if type == "submission", frame["requestId"] as? String == requestId {
        let status = frame["status"] as? String ?? ""
        if status == "unanswered" {
          throw CLIError.refused(kind: "unanswered", message: "the daemon withdrew the input")
        }
        if status == "done" {
          let entryId = frame["answerEntryId"] as? String
          let answer = entryId.flatMap { answers[$0] } ?? lastAnswer ?? ""
          if printer.wantsJSON(arguments) {
            printer.json(frame)
          } else {
            printer.text(answer.isEmpty ? "(no answer)" : answer)
          }
          return
        }
      } else if printer.wantsJSON(arguments) {
        printer.json(frame)
      }
    }
    throw CLIError.refused(kind: "timeout", message: "no settled answer within \(Int(timeout))s")
  }

  private func watch(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let name = try arguments.positional(0, "<bot>")
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name
    let socket = try await client.connect(clientName: "eagle-cli/\(EagleCLIKit.version)")
    defer { socket.close() }
    let frame = try await socket.subscribe(botId: botId)
    let snapshot = SocketSession.snapshotValue(frame)
    if printer.wantsJSON(arguments) {
      printer.json(frame)
    } else {
      for message in snapshot["messages"] as? [JSONObject] ?? [] {
        printer.text(Self.messageLine(message))
      }
    }
    while true {
      let frame = try await socket.read()
      if printer.wantsJSON(arguments) {
        printer.json(frame)
      } else if frame["type"] as? String == "append", let message = frame["message"] as? JSONObject
      {
        printer.text(Self.messageLine(message))
      }
    }
  }

  private func history(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["limit", "before"], switchFlags: ["json"])
    let name = try arguments.positional(0, "<bot>")
    let limit = arguments.value("limit").flatMap(Int.init) ?? 100
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name
    let socket = try await client.connect(clientName: "eagle-cli/\(EagleCLIKit.version)")
    defer { socket.close() }
    let snapshot = SocketSession.snapshotValue(try await socket.subscribe(botId: botId))
    // `truncatedBefore` only says older messages exist; the cursor is the oldest message
    // this client holds (`docs/bots/PROTOCOL.md` "Subscription"), because a page is
    // contiguous with what the caller already has. Paging from the truncation marker asks
    // for what predates the transcript's first entry and answers with nothing.
    let held = (snapshot["messages"] as? [JSONObject])?.first?["id"] as? String
    let more = snapshot["truncatedBefore"] != nil
    guard let before = arguments.value("before") ?? (more ? held : nil) else {
      if printer.wantsJSON(arguments) {
        printer.json(["messages": [], "hasMore": false])
      } else {
        printer.text("no older messages")
      }
      return
    }
    let frame = try await socket.history(before: before, limit: limit)
    if printer.wantsJSON(arguments) {
      printer.json(frame)
      return
    }
    for message in frame["messages"] as? [JSONObject] ?? [] {
      printer.text(Self.messageLine(message))
    }
  }

  private func abort(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let name = try arguments.positional(0, "<bot>")
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name
    let socket = try await client.connect(clientName: "eagle-cli/\(EagleCLIKit.version)")
    defer { socket.close() }
    _ = try await socket.subscribe(botId: botId)
    try await socket.abort()
    if printer.wantsJSON(arguments) {
      printer.json(["aborted": botId])
      return
    }
    printer.text("aborted \(bot["title"] as? String ?? botId)")
  }

  // MARK: - Resolution and formatting

  /// A bot may be named by its id or by an exact title; ids come from the daemon, never
  /// from guessing.
  private func resolve(_ name: String) async throws -> JSONObject {
    let body = try await client.request("GET", "v1/bots")
    let summaries = body["bots"] as? [JSONObject] ?? []
    if let byId = summaries.first(where: { $0["id"] as? String == name }) { return byId }
    let byTitle = summaries.filter { $0["title"] as? String == name }
    if byTitle.count == 1 { return byTitle[0] }
    if byTitle.count > 1 {
      throw CLIError.usage("several bots are titled \(name): use an id from `bots list`")
    }
    throw CLIError.refused(kind: "unknown_bot", message: "no bot matches \(name)")
  }

  static func botLine(_ bot: JSONObject) -> String {
    let id = bot["id"] as? String ?? "?"
    let title = bot["title"] as? String ?? "?"
    let label = bot["label"] as? String
    let state = bot["state"] as? String ?? "?"
    let face = bot["appearance"] as? JSONObject
    let shape = face?["shape"] as? String
    let tint = face?["tint"] as? String
    let group = bot["groupId"] as? String
    var parts = ["\(id)  \(title)"]
    if let note = (bot["note"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !note.isEmpty
    {
      parts.append("「\(note)」")
    }
    if let label { parts.append("label=\(label)") }
    if let group { parts.append("group=\(group)") }
    if let shape, let tint { parts.append("\(shape)/\(tint)") }
    parts.append(state)
    return parts.joined(separator: "  ")
  }

  static func messageLine(_ message: JSONObject) -> String {
    let role = message["role"] as? String ?? "?"
    let origin = message["origin"] as? JSONObject
    let author = origin?["label"] as? String
    let who = author.map { "\(role):\($0)" } ?? role
    let text = text(of: message)
    return "[\(who)] \(text.replacingOccurrences(of: "\n", with: " "))"
  }

  static func text(of message: JSONObject) -> String {
    let blocks = message["blocks"] as? [JSONObject] ?? []
    return blocks.compactMap { block -> String? in
      guard block["type"] as? String == "text" else { return nil }
      return block["text"] as? String
    }.joined(separator: "\n")
  }
}
