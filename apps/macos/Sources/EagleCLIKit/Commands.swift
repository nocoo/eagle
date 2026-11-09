import CryptoKit
import Darwin
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
    case "triggers":
      try await triggers(Array(tokens.dropFirst()))
      return
    case "skills":
      try await skills(Array(tokens.dropFirst()))
      return
    case "peers":
      try await peers(Array(tokens.dropFirst()))
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
      \(config.binaryName) chat send [--file PATH]|watch|history|answer|secret|abort <bot>
      \(config.binaryName) triggers list|enable|disable|fire <bot> [name]
      \(config.binaryName) skills list|set --stdin
      \(config.binaryName) peers list|show <bot> [exchange]
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
    if let appearance = try appearance(arguments, creating: true) {
      body["appearance"] = appearance
    }
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
    if let appearance = try appearance(arguments, creating: false) {
      patch["appearance"] = appearance
    }
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

  private func appearance(_ arguments: Arguments, creating: Bool) throws -> JSONObject? {
    let shape = arguments.value("shape")
    let tint = arguments.value("tint")
    guard shape != nil || tint != nil else { return nil }
    guard let shape, creating || tint != nil else {
      throw CLIError.usage("--tint requires --shape; updates also require --tint")
    }
    var result: JSONObject = ["shape": shape]
    if let tint { result["tint"] = tint }
    return result
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
      throw CLIError.usage("chat send|watch|history|answer|secret|abort <bot>")
    }
    let rest = Array(tokens.dropFirst())
    switch sub {
    case "send":
      try await send(rest)
    case "watch":
      try await watch(rest)
    case "history":
      try await history(rest)
    case "answer":
      try await answer(rest)
    case "secret":
      try await secret(rest)
    case "abort":
      try await abort(rest)
    default:
      throw CLIError.usage("unknown chat command \(sub)")
    }
  }

  private func send(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["text", "timeout", "when-busy", "file"],
      switchFlags: ["json", "wait"])
    let name = try arguments.positional(0, "<bot>")
    let text = try arguments.required("text")
    let timeout: Double
    if let raw = arguments.value("timeout") {
      guard let seconds = Double(raw), seconds.isFinite, seconds > 0,
        seconds <= Double(Int64.max) / 1_000_000_000
      else { throw CLIError.usage("--timeout must be a positive number of seconds") }
      timeout = seconds
    } else {
      timeout = 300
    }
    let whenBusy = arguments.value("when-busy") ?? "followUp"
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name

    let fileIds = try await uploadFile(arguments.value("file"), botId: botId, printer: printer)

    let socket = try await client.connect(clientName: "eagle-cli/\(EagleCLIKit.version)")
    defer { socket.close() }
    _ = try await socket.subscribe(botId: botId)
    let requestId = "r_cli_" + UUID().uuidString.prefix(8).lowercased()
    try await socket.send(
      text: text, requestId: requestId, whenBusy: whenBusy, fileIds: fileIds)
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
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(timeout))
    let timer = Task {
      try? await clock.sleep(until: deadline)
      if !Task.isCancelled { socket.close() }
    }
    defer { timer.cancel() }
    let timedOut = CLIError.refused(
      kind: "timeout",
      message: "no settled answer within \(timeout)s; the bot may still be running")
    while true {
      let frame: JSONObject
      do {
        frame = try await socket.read()
      } catch {
        if clock.now >= deadline { throw timedOut }
        throw error
      }
      if clock.now >= deadline { throw timedOut }
      let type = frame["type"] as? String ?? ""
      if type == "append", let message = frame["message"] as? JSONObject,
        let id = message["id"] as? String
      {
        let text = Self.text(of: message)
        if message["role"] as? String == "assistant", !text.isEmpty {
          answers[id] = text
          lastAnswer = text
        }
        if printer.wantsJSON(arguments) {
          printer.json(frame)
        } else {
          // A card is part of the answer: an agent reading this output must see it.
          for line in Self.questionLines(message) { printer.text(line) }
        }
      } else if type == "submission", frame["requestId"] as? String == requestId {
        if printer.wantsJSON(arguments) { printer.json(frame) }
        let status = frame["status"] as? String ?? ""
        if status == "unanswered" {
          let reason = frame["reason"] as? String ?? "unknown"
          throw CLIError.refused(
            kind: "unanswered", message: "the input was not answered: \(reason)")
        }
        if status == "done" {
          let entryId = frame["answerEntryId"] as? String
          let answer = entryId.flatMap { answers[$0] } ?? lastAnswer ?? ""
          if !printer.wantsJSON(arguments) { printer.text(answer.isEmpty ? "(no answer)" : answer) }
          return
        }
      } else if printer.wantsJSON(arguments) {
        printer.json(frame)
      }
    }
  }

  /// Answers an ask_user card by naming the labels the person chose. The cards themselves are
  /// printed by `watch` and `send --wait`, so an agent reads the options and answers in one go.
  private func answer(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["entry", "choose", "answers"], switchFlags: ["json", "skip"])
    let name = try arguments.positional(0, "<bot>")
    let entry = try arguments.required("entry")
    let skipped = arguments.switches.contains("skip")
    let chosen = (arguments.value("choose") ?? "")
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    var grouped: [[String]]?
    if let raw = arguments.value("answers") {
      guard let data = raw.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String]],
        !parsed.isEmpty, parsed.allSatisfy({ !$0.isEmpty })
      else {
        throw CLIError.usage("--answers takes a JSON array of choice arrays, one per question")
      }
      grouped = parsed
    }
    let modes = (skipped ? 1 : 0) + (!chosen.isEmpty ? 1 : 0) + (grouped != nil ? 1 : 0)
    guard modes == 1 else {
      throw CLIError.usage("pass exactly one of --choose label[,label], --answers JSON, or --skip")
    }
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name
    var body: JSONObject = ["entryId": entry]
    if skipped {
      body["skipped"] = true
    } else if let grouped {
      body["answers"] = grouped
    } else {
      body["chosen"] = chosen
    }
    let payload = try await client.request("POST", "v1/bots/\(botId)/answers", body: body)
    try printAdmission(payload, arguments: arguments, entry: entry, skipped: skipped)
  }

  private func secret(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["entry", "key", "call-index"], switchFlags: ["json", "stdin", "skip"])
    let name = try arguments.positional(0, "<bot>")
    let entry = try arguments.required("entry")
    let key = try arguments.required("key")
    let skipped = arguments.switches.contains("skip")
    guard skipped != arguments.switches.contains("stdin") else {
      throw CLIError.usage("pass exactly one of --stdin or --skip")
    }
    let index: Int
    if let raw = arguments.value("call-index") {
      guard let parsed = Int(raw), parsed >= 0 else {
        throw CLIError.usage("--call-index must be a non-negative integer")
      }
      index = parsed
    } else {
      index = 0
    }
    var body: JSONObject = ["entryId": entry, "key": key, "callIndex": index]
    if skipped {
      body["skipped"] = true
    } else {
      body["value"] = try Self.readSecretInput(.standardInput)
    }
    let bot = try await resolve(name)
    let botId = bot["id"] as? String ?? name
    let payload = try await client.request("POST", "v1/bots/\(botId)/secrets", body: body)
    try printAdmission(payload, arguments: arguments, entry: entry, skipped: skipped)
  }

  static func readSecretInput(_ input: FileHandle) throws -> String {
    guard isatty(input.fileDescriptor) == 0 else {
      throw CLIError.usage("--stdin requires redirected input; it does not read from a terminal")
    }
    var data = Data()
    while data.count <= 8192 {
      let chunk = try input.read(upToCount: min(4096, 8193 - data.count))
      guard let chunk, !chunk.isEmpty else { break }
      data.append(chunk)
    }
    guard data.count <= 8192, !data.contains(0), let text = String(data: data, encoding: .utf8)
    else { throw CLIError.usage("secret input must be UTF-8, without NUL, and at most 8 KiB") }
    return text
  }

  private func printAdmission(
    _ payload: JSONObject, arguments: Arguments, entry: String, skipped: Bool
  ) throws {
    guard let record = payload["submission"] as? JSONObject,
      let status = record["status"] as? String
    else {
      throw CLIError.refused(
        kind: "invalid_response", message: "the daemon did not acknowledge the answer")
    }
    if status == "unanswered" {
      throw CLIError.refused(
        kind: "unanswered", message: "the answer was not admitted: \(record["reason"] ?? "?")")
    }
    if printer.wantsJSON(arguments) {
      // The CLI's own JSON shape is the wire submission, not the HTTP domain object: a caller
      // reading `submissionId` keeps working.
      var frame: JSONObject = ["type": "submission"]
      for key in ["requestId", "entryId", "status", "answerEntryId", "reason", "detail"] {
        if let value = record[key] { frame[key] = value }
      }
      frame["submissionId"] = record["id"]
      printer.json(frame)
    } else {
      printer.text(skipped ? "skipped \(entry)" : "answered \(entry)")
    }
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
        if let line = Self.messageLine(message) { printer.text(line) }
        for line in Self.questionLines(message) { printer.text(line) }
      }
    }
    while true {
      let frame = try await socket.read()
      if printer.wantsJSON(arguments) {
        printer.json(frame)
      } else if frame["type"] as? String == "append", let message = frame["message"] as? JSONObject
      {
        if let line = Self.messageLine(message) { printer.text(line) }
        for line in Self.questionLines(message) { printer.text(line) }
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
    // A provisional id is not a cursor: the daemon only accepts committed entries.
    let held = (snapshot["messages"] as? [JSONObject] ?? [])
      .compactMap { $0["id"] as? String }
      .first { $0.hasPrefix("e_") }
    let more = snapshot["truncatedBefore"] != nil
    if more, held == nil, arguments.value("before") == nil {
      throw CLIError.refused(
        kind: "not_ready",
        message: "the page holds only an unfinished answer; nothing older is reachable yet")
    }
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
      if let line = Self.messageLine(message) { printer.text(line) }
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

  /// The skills a Bot is told about. The App owns the folders and the scan; a caller that
  /// already knows the entries (an agent, a script) installs them here in one write.
  private func skills(_ tokens: [String]) async throws {
    guard let sub = tokens.first else {
      throw CLIError.usage("skills list|set --stdin")
    }
    let arguments = try Arguments.parse(
      Array(tokens.dropFirst()), valueFlags: [], switchFlags: ["json", "stdin"])
    switch sub {
    case "list":
      let body = try await client.request("GET", "v1/settings")
      let settings = body["settings"] as? JSONObject ?? [:]
      let skills = settings["skills"] as? [JSONObject] ?? []
      if printer.wantsJSON(arguments) {
        printer.json(["skills": skills])
        return
      }
      if skills.isEmpty {
        printer.text("no skills selected")
        return
      }
      for skill in skills {
        let name = skill["name"] as? String ?? "?"
        let version = skill["version"] as? String
        printer.text(name + (version.map { " · \($0)" } ?? ""))
      }
    case "set":
      guard arguments.switches.contains("stdin") else {
        throw CLIError.usage("skills set reads a JSON array on --stdin")
      }
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard !data.isEmpty, data.count <= 256 * 1024 else {
        throw CLIError.usage("skills JSON must be 1..262144 bytes on stdin")
      }
      guard let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [JSONObject],
        parsed.count <= 64
      else { throw CLIError.usage("skills JSON must be an array of at most 64 entries") }
      let body = try await client.request("PUT", "v1/settings", body: ["skills": parsed])
      if printer.wantsJSON(arguments) {
        let settings = body["settings"] as? JSONObject
        printer.json(["skills": settings?["skills"] ?? parsed])
        return
      }
      printer.text("已保存 \(parsed.count) 个技能")
    default:
      throw CLIError.usage("unknown skills command \(sub)")
    }
  }

  /// Read-only: what two Bots said to each other, by entry, never a way to start one.
  private func peers(_ tokens: [String]) async throws {
    guard let sub = tokens.first else {
      throw CLIError.usage("peers list|show <bot> [exchange]")
    }
    let arguments = try Arguments.parse(
      Array(tokens.dropFirst()), valueFlags: [], switchFlags: ["json"])
    let bot = try await resolve(arguments.positional(0, "<bot>"))
    let botId = bot["id"] as? String ?? ""
    switch sub {
    case "list":
      let body = try await client.request("GET", "v1/bots/\(botId)/exchanges")
      let exchanges = body["exchanges"] as? [JSONObject] ?? []
      if printer.wantsJSON(arguments) {
        printer.json(body)
        return
      }
      if exchanges.isEmpty {
        printer.text("no exchanges")
        return
      }
      for exchange in exchanges {
        let id = exchange["id"] as? String ?? "?"
        let peer = exchange["peerTitle"] as? String ?? exchange["peerId"] as? String ?? "?"
        let state = exchange["state"] as? String ?? "?"
        printer.text("\(id) · \(peer) · \(state)")
      }
    case "show":
      let exchangeId = try arguments.positional(1, "an exchange id")
      let body = try await client.request("GET", "v1/bots/\(botId)/exchanges/\(exchangeId)")
      if printer.wantsJSON(arguments) {
        printer.json(body)
        return
      }
      let exchange = body["exchange"] as? JSONObject ?? [:]
      printer.text(
        "\(exchange["id"] as? String ?? "?") · \(exchange["state"] as? String ?? "?")")
    default:
      throw CLIError.usage("unknown peers command \(sub)")
    }
  }

  /// Triggers are created by a Bot's own tools; a person turns them on, off and fires a
  /// webhook one by hand. Creation is deliberately absent: a trigger is a Bot's decision.
  private func triggers(_ tokens: [String]) async throws {
    guard let sub = tokens.first else {
      throw CLIError.usage("triggers list|enable|disable|fire <bot> [name]")
    }
    let rest = Array(tokens.dropFirst())
    switch sub {
    case "list": try await triggerList(rest)
    case "enable": try await triggerSet(rest, enabled: true)
    case "disable": try await triggerSet(rest, enabled: false)
    case "fire": try await triggerFire(rest)
    default: throw CLIError.usage("unknown triggers command \(sub)")
    }
  }

  /// Declares the file, uploads its bytes and returns the complete id the send may carry.
  /// The daemon owns the size, hash and step-up checks; this only names what is on disk.
  private func uploadFile(_ path: String?, botId: String, printer: Printer) async throws -> [String]
  {
    guard let path, !path.isEmpty else { return [] }
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    let bytes: Data
    do {
      bytes = try Data(contentsOf: url)
    } catch {
      throw CLIError.usage("--file cannot be read: \(url.path)")
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
      !isDirectory.boolValue
    else { throw CLIError.usage("--file is not a regular file: \(url.path)") }
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    let uploadId = "u_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let manifest: JSONObject = [
      "name": url.lastPathComponent, "size": bytes.count, "sha256": digest,
    ]
    _ = try await client.request(
      "PUT", "v1/bots/\(botId)/files/\(uploadId)/manifest", body: manifest)
    let uploaded = try await client.upload(
      "v1/bots/\(botId)/files/\(uploadId)/content", bytes: bytes)
    guard let file = uploaded["file"] as? JSONObject, let id = file["id"] as? String else {
      throw CLIError.refused(kind: "protocol", message: "the upload answered no file")
    }
    return [id]
  }

  private func triggerList(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let bot = try await resolve(arguments.positional(0, "a bot"))
    let botId = bot["id"] as? String ?? ""
    let body = try await client.request("GET", "v1/triggers?botId=\(botId)")
    let triggers = body["triggers"] as? [JSONObject] ?? []
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    if triggers.isEmpty {
      printer.text("no triggers")
      return
    }
    for trigger in triggers {
      let enabled = trigger["enabled"] as? Bool == true ? "on" : "off"
      let kind = trigger["kind"] as? String ?? "?"
      let name = trigger["name"] as? String ?? "?"
      let id = trigger["id"] as? String ?? "?"
      let last = trigger["lastRunAt"] as? String
      printer.text("\(name) · \(kind) · \(enabled) · \(id)" + (last.map { " · \($0)" } ?? ""))
    }
  }

  /// One trigger of this bot, by id or exact name: a fire must never hit a guessed row.
  private func trigger(
    _ name: String, of botId: String
  ) async throws -> JSONObject {
    let body = try await client.request("GET", "v1/triggers?botId=\(botId)")
    let triggers = body["triggers"] as? [JSONObject] ?? []
    if let byId = triggers.first(where: { $0["id"] as? String == name }) { return byId }
    let byName = triggers.filter { $0["name"] as? String == name }
    if byName.count == 1 { return byName[0] }
    if byName.count > 1 {
      throw CLIError.usage("several triggers are named \(name): use an id from `triggers list`")
    }
    throw CLIError.refused(kind: "unknown_trigger", message: "no trigger matches \(name)")
  }

  private func triggerSet(_ tokens: [String], enabled: Bool) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let bot = try await resolve(arguments.positional(0, "a bot"))
    let botId = bot["id"] as? String ?? ""
    let trigger = try await trigger(arguments.positional(1, "a trigger"), of: botId)
    let triggerId = trigger["id"] as? String ?? ""
    let body = try await client.request(
      "PATCH", "v1/triggers/\(botId)/\(triggerId)", body: ["enabled": enabled])
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    printer.text("\(enabled ? "已启用" : "已停用") · \(trigger["name"] as? String ?? triggerId)")
  }

  private func triggerFire(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["body"], switchFlags: ["json", "stdin"])
    let bot = try await resolve(arguments.positional(0, "a bot"))
    let botId = bot["id"] as? String ?? ""
    let trigger = try await trigger(arguments.positional(1, "a trigger"), of: botId)
    guard trigger["kind"] as? String == "webhook" else {
      throw CLIError.usage("only a webhook trigger can be fired by hand")
    }
    guard let triggerId = trigger["id"] as? String, let token = trigger["token"] as? String else {
      throw CLIError.refused(kind: "unknown_trigger", message: "this trigger has no webhook")
    }
    let text: String
    if arguments.switches.contains("stdin") {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      text = String(decoding: data, as: UTF8.self)
    } else {
      text = arguments.value("body") ?? ""
    }
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.utf8.count <= 64 * 1024
    else { throw CLIError.usage("--body or --stdin must carry 1..65536 bytes of text") }
    let body = try await client.request(
      "POST", "v1/triggers/\(botId)/\(triggerId)", body: ["text": text], token: token)
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    printer.text("已投递 · \(trigger["name"] as? String ?? triggerId)")
  }

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

  /// A hidden message is the person's answer to a card: the card already showed it, so the
  /// transcript skips the text and keeps only the fact that it was answered.
  static func messageLine(_ message: JSONObject) -> String? {
    if message["hidden"] as? Bool == true {
      let entry = message["answersTo"] as? String
      return entry.map { "[answered \($0)]" }
    }
    let role = message["role"] as? String ?? "?"
    let origin = message["origin"] as? JSONObject
    let author = origin?["label"] as? String
    let who = author.map { "\(role):\($0)" } ?? role
    let text = text(of: message)
    return "[\(who)] \(text.replacingOccurrences(of: "\n", with: " "))"
  }

  /// An ask_user card, one line per question, then the exact command that answers it: the
  /// CLI prints the options rather than making the caller decode the tool call.
  static func questionLines(_ message: JSONObject) -> [String] {
    let entry = message["id"] as? String ?? "?"
    if message["hidden"] as? Bool == true { return [] }
    var lines: [String] = []
    var secretIndex = 0
    for block in message["blocks"] as? [JSONObject] ?? [] {
      guard block["type"] as? String == "toolCall" else { continue }
      let name = block["name"] as? String
      if name == "secret_request" {
        let index = secretIndex
        secretIndex += 1
        guard let args = block["args"] as? JSONObject, let key = args["key"] as? String else {
          continue
        }
        let purpose = args["purpose"] as? String ?? ""
        lines.append("[secret \(entry)] \(purpose)")
        lines.append(
          "answer: chat secret <bot> --entry \(entry) --key \(key) --call-index \(index) --stdin (or --skip)"
        )
        continue
      }
      guard name == "ask_user", let args = block["args"] as? JSONObject,
        let questions = args["questions"] as? [JSONObject]
      else { continue }
      let start = lines.count
      for question in questions {
        let prompt = question["prompt"] as? String ?? ""
        let kind = question["kind"] as? String == "multi" ? "多选" : "单选"
        let labels = (question["options"] as? [JSONObject] ?? [])
          .compactMap { $0["label"] as? String }
          .joined(separator: " | ")
        lines.append("[question \(entry)] (\(kind)) \(prompt): \(labels)")
      }
      if lines.count > start {
        lines.append("answer: --entry \(entry) --choose <label>[,<label>] (or --skip)")
      }
    }
    return lines
  }

  static func text(of message: JSONObject) -> String {
    let blocks = message["blocks"] as? [JSONObject] ?? []
    return blocks.compactMap { block -> String? in
      guard block["type"] as? String == "text" else { return nil }
      return block["text"] as? String
    }.joined(separator: "\n")
  }
}
