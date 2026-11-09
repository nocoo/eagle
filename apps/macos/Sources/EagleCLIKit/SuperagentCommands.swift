import Foundation
import SuperagentCore
import SuperagentTransport

/// `eagle-dev superagent ...` — its own namespace, credential and service. It never loads the
/// worker CLI configuration or borrows a worker token.
public struct SuperagentCommands: Sendable {
  private let endpoint: SuperagentEndpoint
  private let printer: Printer
  private let release: Bool
  private let client: SuperagentClient

  public init(endpoint: SuperagentEndpoint, printer: Printer, release: Bool) {
    self.endpoint = endpoint
    self.printer = printer
    self.release = release
    client = SuperagentClient(endpoint: endpoint)
  }

  public static func resolve(
    arguments: [String],
    environment: [String: String] = ProcessInfo.processInfo.environment,
    home: String? = nil
  ) throws -> SuperagentEndpoint {
    try SuperagentEndpoint.resolve(
      environment: environment, home: home,
      release: CLIConfig.binaryName(for: arguments.first ?? "eagle-dev") == "eagle")
  }

  public func run(_ tokens: [String]) async throws {
    guard let first = tokens.first else {
      printer.text(Self.usage)
      return
    }
    switch first {
    case "--help", "help", "-h":
      printer.text(Self.usage)
      return
    case "health":
      try await health(Array(tokens.dropFirst()))
      return
    case "config":
      try await config(Array(tokens.dropFirst()))
      return
    case "chat":
      try await chat(Array(tokens.dropFirst()))
      return
    case "observe":
      try await observe(Array(tokens.dropFirst()))
      return
    case "attention":
      try await attention(Array(tokens.dropFirst()))
      return
    case "manage":
      try await manage(Array(tokens.dropFirst()))
      return
    case "suggest":
      try await suggest(Array(tokens.dropFirst()))
      return
    case "decisions":
      try await decisions(Array(tokens.dropFirst()))
      return
    default:
      throw CLIError.usage("unknown superagent command \(first)\n\n\(Self.usage)")
    }
  }

  public static let usage = """
    eagle-dev superagent health [--json]
    eagle-dev superagent config show [--json]
    eagle-dev superagent config set --stdin [--json]
    eagle-dev superagent chat send --text T [--request-id ID] [--wait] [--timeout 120]
    eagle-dev superagent chat history [--before N] [--limit N] [--json]
    eagle-dev superagent chat watch [--json]
    eagle-dev superagent chat stop [--json]
    eagle-dev superagent observe status [--json]
    eagle-dev superagent observe snapshot [--json]
    eagle-dev superagent observe history --bot ID [--scope ID] [--before e_n] [--limit N] [--json]
    eagle-dev superagent observe changes [--limit N] [--json]
    eagle-dev superagent attention [list] [--limit N] [--json]
    eagle-dev superagent attention ack --item ID [--json]
    eagle-dev superagent manage [--mode off|notify|act] [--json]
    eagle-dev superagent suggest [list] [--bot ID] [--limit N] [--json]
    eagle-dev superagent suggest now [--bot ID] [--json]
    eagle-dev superagent suggest ack --suggestion ID --verdict accepted|rejected|deferred [--reason T]
    eagle-dev superagent decisions [--bot ID] [--limit N] [--json]

    Observation is read-only: it names what each Bot holds, never what it should do.

    The Super Bot service is independent of the Bots daemon. Its credential comes from
    SUPERAGENT_TOKEN or the service root's own private token; there is no worker fallback.
    """

  private func observe(_ tokens: [String]) async throws {
    guard let action = tokens.first else {
      throw CLIError.usage("observe needs status, snapshot, history or changes")
    }
    let rest = Array(tokens.dropFirst())
    switch action {
    case "status", "snapshot":
      let arguments = try Arguments.parse(rest, valueFlags: [], switchFlags: ["json"])
      let reply = try await mapped { try await client.observeSnapshot() }
      if printer.wantsJSON(arguments) {
        printer.json([
          "provider": Self.providerObject(reply.provider),
          "snapshot": reply.snapshot?.any ?? NSNull(),
        ])
        return
      }
      printer.text(Self.providerLine(reply.provider))
      guard let snapshot = reply.snapshot else { return }
      let bots = snapshot["bots"]?.array ?? []
      for bot in bots {
        let store = bot["store"]?["state"]?.string ?? "unknown"
        let entries = bot["coverage"]?["entries"]?.int
        let newest = bot["coverage"]?["newestEntryId"]?.string ?? "-"
        let counted = entries.map { " · \($0) 条" } ?? ""
        printer.text(
          "\(bot["botId"]?.string ?? "?") · \(bot["title"]?.string ?? "") · \(store)\(counted) · \(newest)"
        )
      }
      if snapshot["truncated"]?.any as? Bool == true { printer.text("fleet 列表已截断") }
    case "history":
      let arguments = try Arguments.parse(
        rest, valueFlags: ["bot", "scope", "before", "limit"], switchFlags: ["json"])
      guard let botId = arguments.value("bot"), !botId.isEmpty else {
        throw CLIError.usage("observe history needs --bot ID")
      }
      let limit = arguments.value("limit").flatMap(Int.init) ?? 50
      let before = arguments.value("before")
      guard (1...200).contains(limit), before.map({ $0.hasPrefix("e_") }) ?? true else {
        throw CLIError.usage("--limit is 1..200 and --before is an entry id like e_91")
      }
      let reply = try await mapped {
        try await client.observeHistory(
          botId: botId, scope: arguments.value("scope"), before: before, limit: limit)
      }
      if printer.wantsJSON(arguments) {
        printer.json([
          "provider": Self.providerObject(reply.provider),
          "history": reply.history?.any ?? NSNull(),
        ])
        return
      }
      printer.text(Self.providerLine(reply.provider))
      guard let history = reply.history else { return }
      let coverage = history["coverage"]
      let parts = ["scopes", "page", "content"].compactMap { key in
        coverage?[key]?.string.map { "\(key)=\($0)" }
      }
      printer.text(
        "scope \(history["scope"]?["id"]?.string ?? "?") · 条目 \(history["messages"]?.array.count ?? 0)"
          + " · 上界 \(history["boundary"]?["newestEntryId"]?.string ?? "-") · "
          + parts.joined(separator: " ")
      )
      for scope in history["scopes"]?.array ?? [] {
        printer.text(
          "  \(scope["id"]?.string ?? "?") · \(scope["kind"]?.string ?? "?") · \(scope["entries"]?.int ?? 0) 条"
        )
      }
      if let next = history["next"]?["before"]?.string { printer.text("--before \(next) 读取更早") }
    case "changes":
      let arguments = try Arguments.parse(rest, valueFlags: ["limit"], switchFlags: ["json"])
      let limit = arguments.value("limit").flatMap(Int.init) ?? 100
      guard (1...500).contains(limit) else { throw CLIError.usage("--limit is 1..500") }
      let reply = try await mapped { try await client.observeChanges(limit: limit) }
      if printer.wantsJSON(arguments) {
        printer.json([
          "provider": Self.providerObject(reply.provider),
          "changes": reply.changes?.any ?? NSNull(),
        ])
        return
      }
      printer.text(Self.providerLine(reply.provider))
      for change in reply.changes?["changes"]?.array ?? [] {
        let kind = change["kind"]?.string ?? "?"
        let bot = change["botId"]?.string ?? "-"
        let to = change["to"]?.string
        printer.text("\(kind) · \(bot)" + (to.map { " · 到 \($0)" } ?? ""))
      }
      if reply.changes?["coverage"]?["complete"]?.any as? Bool == false { printer.text("本页已截断") }
    default:
      throw CLIError.usage("unknown observe command \(action)")
    }
  }

  /// SG-004: what the watcher noticed, and the one switch that lets it act.
  private func attention(_ tokens: [String]) async throws {
    let action = tokens.first
    if action != "ack" {
      // `attention`, `attention list` and `attention --json` are the same read.
      let arguments = try Arguments.parse(
        action == "list" ? Array(tokens.dropFirst()) : tokens, valueFlags: ["limit"],
        switchFlags: ["json"]
      )
      let limit = arguments.value("limit").flatMap(Int.init) ?? 50
      guard (1...200).contains(limit) else { throw CLIError.usage("--limit is 1..200") }
      let reply = try await mapped { try await client.attention(limit: limit) }
      if printer.wantsJSON(arguments) {
        printer.json([
          "provider": [
            "state": reply.provider.state,
            "lastTickAt": (reply.provider.lastTickAt as Any?) ?? NSNull(),
          ],
          "items": reply.items.map(Self.itemObject),
        ])
        return
      }
      printer.text(
        "superagent 巡检 \(reply.provider.state) · 上次扫描 \(reply.provider.lastTickAt ?? "-")")
      if reply.items.isEmpty { printer.text("没有需要你处理的事") }
      for item in reply.items {
        printer.text(
          "\(item.id) · \(item.kind) · \(item.botId) · ×\(item.count) · \(item.evidence)"
            + (item.actedAt == nil ? "" : " · 已处理"))
      }
      return
    }
    switch action {
    case "ack":
      let arguments = try Arguments.parse(
        Array(tokens.dropFirst()), valueFlags: ["item"], switchFlags: ["json"])
      guard let itemId = arguments.value("item"), !itemId.isEmpty else {
        throw CLIError.usage("attention ack needs --item ID")
      }
      let reply = try await mapped { try await client.attentionAck(itemId: itemId) }
      if printer.wantsJSON(arguments) {
        printer.json(["item": Self.itemObject(reply.item)])
        return
      }
      printer.text("已确认 \(reply.item.id) · \(reply.item.kind) · \(reply.item.botId)")
    default:
      throw CLIError.usage("unknown attention command \(action)")
    }
  }

  /// SG-004: read or replace the policy mode. `act` is the only mode that writes to a Bot.
  private func manage(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: ["mode"], switchFlags: ["json"])
    if let mode = arguments.value("mode") {
      guard ["off", "notify", "act"].contains(mode) else {
        throw CLIError.usage("--mode is off, notify or act")
      }
    }
    let reply = try await mapped { try await client.manageMode(arguments.value("mode")) }
    if printer.wantsJSON(arguments) {
      printer.json(["mode": reply.mode])
      return
    }
    let meaning =
      switch reply.mode {
      case "off": "只记录，不动手"
      case "act": "会按策略给 Bot 发消息"
      default: "会向哥报告，不动手"
      }
    printer.text("manage \(reply.mode) · \(meaning)")
  }

  /// SG-003: suggestions must quote evidence, and a decision is written once.
  private func suggest(_ tokens: [String]) async throws {
    guard let action = tokens.first, action == "list" || action == "now" || action == "ack" else {
      // `suggest` and `suggest --json` are the list.
      try await suggestList(tokens)
      return
    }
    switch action {
    case "list":
      try await suggestList(Array(tokens.dropFirst()))
    case "now":
      let arguments = try Arguments.parse(
        Array(tokens.dropFirst()), valueFlags: ["bot"], switchFlags: ["json"])
      let reply = try await mapped { try await client.analyze(botId: arguments.value("bot")) }
      if printer.wantsJSON(arguments) {
        printer.json([
          "suggestion": reply.suggestion.map(Self.suggestionObject) ?? NSNull(),
          "refused": (reply.refused as Any?) ?? NSNull(),
          "suggestions": (reply.suggestions ?? []).map(Self.suggestionObject),
        ])
        return
      }
      if let refused = reply.refused {
        let reason =
          switch refused {
          case "cooldown": "这个 Bot 还在冷却期"
          case "no_evidence": "没有可引用的证据"
          case "model": "模型没有回答"
          case "invalid": "模型没有引用证据，已丢弃"
          case "duplicate": "同样的建议已经有了"
          default: "建议数量已到上限"
          }
        printer.text("未生成建议：\(reason)")
        return
      }
      if let suggestion = reply.suggestion {
        Self.printSuggestion(suggestion, printer: printer)
      }
      for suggestion in reply.suggestions ?? [] {
        Self.printSuggestion(suggestion, printer: printer)
      }
      if reply.suggestion == nil, (reply.suggestions ?? []).isEmpty { printer.text("没有新建议") }
    case "ack":
      let arguments = try Arguments.parse(
        Array(tokens.dropFirst()), valueFlags: ["suggestion", "verdict", "reason"],
        switchFlags: ["json"])
      guard let suggestionId = arguments.value("suggestion"), !suggestionId.isEmpty,
        let verdict = arguments.value("verdict"),
        ["accepted", "rejected", "deferred"].contains(verdict)
      else {
        throw CLIError.usage(
          "suggest ack needs --suggestion ID and --verdict accepted|rejected|deferred")
      }
      let reply = try await mapped {
        try await client.suggestionAck(
          suggestionId: suggestionId, verdict: verdict, reason: arguments.value("reason"))
      }
      if printer.wantsJSON(arguments) {
        printer.json([
          "suggestion": Self.suggestionObject(reply.suggestion),
          "decision": Self.decisionObject(reply.decision),
        ])
        return
      }
      printer.text("已记录决定 \(reply.decision.verdict) · \(reply.decision.suggestionId)")
    default:
      throw CLIError.usage("unknown suggest command \(action)")
    }
  }

  private func suggestList(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["bot", "limit"], switchFlags: ["json"])
    let limit = arguments.value("limit").flatMap(Int.init) ?? 50
    guard (1...200).contains(limit) else { throw CLIError.usage("--limit is 1..200") }
    let reply = try await mapped {
      try await client.suggestionList(botId: arguments.value("bot"), limit: limit)
    }
    if printer.wantsJSON(arguments) {
      printer.json(["suggestions": reply.suggestions.map(Self.suggestionObject)])
      return
    }
    if reply.suggestions.isEmpty { printer.text("没有建议") }
    for suggestion in reply.suggestions { Self.printSuggestion(suggestion, printer: printer) }
  }

  private func decisions(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["bot", "limit"], switchFlags: ["json"])
    let limit = arguments.value("limit").flatMap(Int.init) ?? 50
    guard (1...200).contains(limit) else { throw CLIError.usage("--limit is 1..200") }
    let reply = try await mapped {
      try await client.decisionList(botId: arguments.value("bot"), limit: limit)
    }
    if printer.wantsJSON(arguments) {
      printer.json(["decisions": reply.decisions.map(Self.decisionObject)])
      return
    }
    if reply.decisions.isEmpty { printer.text("还没有决定") }
    for decision in reply.decisions {
      printer.text(
        "\(decision.at) · \(decision.verdict) · \(decision.botId) · \(decision.suggestionId)"
          + (decision.reason.map { " · \($0)" } ?? ""))
    }
  }

  private static func itemObject(_ item: AttentionItemReply) -> [String: Any] {
    [
      "id": item.id, "botId": item.botId, "kind": item.kind, "severity": item.severity,
      "evidence": item.evidence, "count": item.count, "firstSeenAt": item.firstSeenAt,
      "lastSeenAt": item.lastSeenAt,
      "closedAt": item.closedAt ?? NSNull(), "reportedAt": item.reportedAt ?? NSNull(),
      "actedAt": item.actedAt ?? NSNull(),
    ]
  }

  private static func suggestionObject(_ suggestion: SuggestionReply) -> [String: Any] {
    [
      "id": suggestion.id, "botId": suggestion.botId, "text": suggestion.text,
      "evidence": suggestion.evidence, "createdAt": suggestion.createdAt,
      "closedAt": suggestion.closedAt ?? NSNull(), "stale": suggestion.stale ?? false,
    ]
  }

  private static func decisionObject(_ decision: DecisionReply) -> [String: Any] {
    [
      "id": decision.id, "suggestionId": decision.suggestionId, "botId": decision.botId,
      "verdict": decision.verdict, "reason": decision.reason ?? NSNull(), "at": decision.at,
    ]
  }

  private static func printSuggestion(_ suggestion: SuggestionReply, printer: Printer) {
    let flags = [
      suggestion.stale == true ? "已过期" : nil,
      suggestion.closedAt == nil ? nil : "已决定",
    ].compactMap { $0 }
    printer.text(
      "\(suggestion.id) · \(suggestion.botId) · \(suggestion.text)"
        + (flags.isEmpty ? "" : " · \(flags.joined(separator: " · "))"))
    printer.text("  证据: \(suggestion.evidence.joined(separator: ", "))")
  }

  private static func providerObject(_ report: ProviderReport) -> [String: Any] {
    [
      "reachable": report.reachable, "state": report.state,
      "lastReadAt": report.lastReadAt ?? NSNull(), "unavailable": report.unavailable,
      "detail": report.detail ?? NSNull(),
    ]
  }

  private static func providerLine(_ report: ProviderReport) -> String {
    let read = report.lastReadAt.map { " · 上次读取 \($0)" } ?? " · 尚未读取"
    let detail = report.detail.map { " · \($0)" } ?? ""
    return "观测 \(report.state)\(detail) · 不可读 \(report.unavailable)\(read)"
  }

  private func health(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let health = try await mapped { try await client.health() }
    let failure: Any = health.failure.map { ["code": $0.code.rawValue, "id": $0.id] } ?? NSNull()
    let body: [String: Any] = [
      "service": health.service, "version": health.version,
      "protocolVersion": health.protocolVersion, "pid": health.pid,
      "instance": health.instance, "modelReady": health.modelReady,
      "failure": failure,
    ]
    if printer.wantsJSON(arguments) {
      printer.json(body)
      return
    }
    printer.text(
      "superagent \(health.version) · pid \(health.pid) · "
        + (health.modelReady ? "模型已配置" : "未配置模型") + " · \(endpoint.address)")
  }

  private func config(_ tokens: [String]) async throws {
    guard let action = tokens.first else { throw CLIError.usage("config needs show or set") }
    let arguments = try Arguments.parse(
      Array(tokens.dropFirst()), valueFlags: [], switchFlags: ["json", "stdin"])
    switch action {
    case "show":
      let snapshot = try await mapped { try await client.state() }
      let configuration = snapshot.value.configuration
      let body: [String: Any] =
        configuration.map {
          [
            "baseUrl": $0.baseUrl, "model": $0.model,
            "thinkingLevel": $0.thinkingLevel, "hasApiKey": $0.hasApiKey,
          ]
        } ?? [:]
      if printer.wantsJSON(arguments) {
        let visible: Any = configuration == nil ? NSNull() : body
        printer.json(["configuration": visible])
      } else if let configuration {
        printer.text(
          "\(configuration.baseUrl) · \(configuration.model) · \(configuration.thinkingLevel) · "
            + (configuration.hasApiKey ? "有密钥" : "无密钥"))
      } else {
        printer.text("Super Bot 尚未配置模型。")
      }
    case "set":
      guard arguments.switches.contains("stdin") else {
        throw CLIError.usage("config set reads JSON on --stdin; no secret flag exists")
      }
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard !data.isEmpty, data.count <= 64 * 1024 else {
        throw CLIError.usage("configuration JSON must be 1..65536 bytes on stdin")
      }
      let change: ConfigurationChange
      do { change = try JSONDecoder().decode(ConfigurationChange.self, from: data) } catch {
        throw CLIError.usage("configuration JSON is invalid")
      }
      let saved = try await mapped { try await client.configure(change) }
      let body: [String: Any] = [
        "baseUrl": saved.baseUrl, "model": saved.model,
        "thinkingLevel": saved.thinkingLevel, "hasApiKey": saved.hasApiKey,
      ]
      if printer.wantsJSON(arguments) {
        printer.json(["configuration": body])
      } else {
        printer.text("已保存 · \(saved.model)")
      }
    default:
      throw CLIError.usage("unknown config action \(action)")
    }
  }

  private func chat(_ tokens: [String]) async throws {
    guard let action = tokens.first else {
      throw CLIError.usage("chat needs send, history, watch or stop")
    }
    let rest = Array(tokens.dropFirst())
    switch action {
    case "send": try await send(rest)
    case "history": try await history(rest)
    case "watch": try await watch(rest)
    case "stop": try await stop(rest)
    default: throw CLIError.usage("unknown chat action \(action)")
    }
  }

  private func send(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["text", "request-id", "timeout"], switchFlags: ["json", "wait"])
    let text = try arguments.required("text")
    let requestId =
      arguments.value("request-id")
      ?? ("r_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())
    guard requestId.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil else {
      throw CLIError.usage("--request-id must match [A-Za-z0-9_-]{8,64}")
    }
    let admission = try await mapped {
      try await client.submit(PendingInput(id: requestId, text: text))
    }
    try print(admission, json: printer.wantsJSON(arguments))
    guard arguments.switches.contains("wait") else { return }
    let seconds = Double(arguments.value("timeout") ?? "120") ?? 120
    guard seconds > 0 else { throw CLIError.usage("--timeout must be positive") }
    let deadline = Date().addingTimeInterval(seconds)
    var record = admission
    while !record.terminal, Date() < deadline {
      try await Task.sleep(for: .milliseconds(200))
      record = try await mapped { try await client.submission(requestId) } ?? record
    }
    guard record.terminal else {
      throw CLIError.refused(kind: "timeout", message: "等待超时；服务端工作不会被取消")
    }
    if let answer = record.answer {
      if printer.wantsJSON(arguments) {
        try print(record, json: true)
      } else {
        printer.text(answer)
      }
    }
    if record.status == .unanswered {
      throw CLIError.refused(kind: record.reason ?? "unanswered", message: "回答未产生")
    }
  }

  private func history(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(
      tokens, valueFlags: ["before", "limit"], switchFlags: ["json"])
    let before = arguments.value("before").flatMap(Int.init)
    let limit = arguments.value("limit").flatMap(Int.init) ?? 100
    guard (1...100).contains(limit), before.map({ $0 > 0 }) ?? true else {
      throw CLIError.usage("--limit is 1..100 and --before is a positive entry number")
    }
    let page = try await mapped { try await client.history(before: before, limit: limit) }
    if printer.wantsJSON(arguments) {
      let encoded = try JSONEncoder().encode(page)
      let object = (try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]) ?? [:]
      printer.json(object)
      return
    }
    for message in page.messages {
      printer.text("\(message.role.rawValue): \(message.text)")
    }
    if page.hasMore, let next = page.nextBefore { printer.text("--before \(next) 读取更早") }
  }

  private func watch(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    let stream = try await mapped { try await client.events() }
    for try await frame in stream {
      if printer.wantsJSON(arguments) {
        let encoded = try JSONEncoder().encode(frame)
        let object = (try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]) ?? [:]
        printer.json(object)
      } else {
        for message in frame.value.messages
        where message.state != .complete || message.role == .assistant {
          printer.text("\(message.role.rawValue): \(message.text)")
        }
      }
    }
  }

  private func stop(_ tokens: [String]) async throws {
    let arguments = try Arguments.parse(tokens, valueFlags: [], switchFlags: ["json"])
    try await mapped { try await client.abort() }
    if printer.wantsJSON(arguments) {
      printer.json(["stopped": true])
    } else {
      printer.text("已停止。")
    }
  }

  private func print(_ admission: ChatAdmission, json: Bool) throws {
    if json {
      let encoded = try JSONEncoder().encode(admission)
      printer.json((try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]) ?? [:])
    } else {
      printer.text("\(admission.requestId) · \(admission.status.rawValue)")
    }
  }

  private func mapped<Value>(_ work: () async throws -> Value) async throws -> Value {
    do { return try await work() } catch let error as SuperagentError {
      switch error {
      case .credential: throw CLIError.auth("Super Bot 凭据不可用；检查 \(endpoint.root.path)")
      case .identity: throw CLIError.auth("Super Bot 服务身份与本地 root 不匹配。")
      case .unavailable: throw CLIError.unreachable("无法连接 Super Bot（\(endpoint.address)）。")
      case .protocolViolation: throw CLIError.refused(kind: "protocol", message: "服务响应无效")
      case .timeout: throw CLIError.refused(kind: "timeout", message: "请求超时")
      case .cancelled: throw CLIError.refused(kind: "cancelled", message: "连接已关闭")
      case .storage: throw CLIError.auth("Super Bot 本地存储不可读。")
      case .service(let code): throw CLIError.refused(kind: code.rawValue, message: code.rawValue)
      }
    }
  }
}
