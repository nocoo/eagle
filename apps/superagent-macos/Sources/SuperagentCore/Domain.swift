import Foundation

public struct ServiceIdentity: Codable, Equatable, Sendable {
  public var service: String
  public var version: String
  public var protocolVersion: Int
  public var pid: Int
  public var instance: String
  public var storeId: String
  public var rootBinding: String
  public init(
    service: String, version: String, protocolVersion: Int, pid: Int, instance: String,
    storeId: String, rootBinding: String
  ) {
    self.service = service
    self.version = version
    self.protocolVersion = protocolVersion
    self.pid = pid
    self.instance = instance
    self.storeId = storeId
    self.rootBinding = rootBinding
  }
}

public struct ServiceHealth: Codable, Equatable, Sendable {
  public var service: String
  public var version: String
  public var protocolVersion: Int
  public var pid: Int
  public var instance: String
  public var storeId: String
  public var rootBinding: String
  public var modelReady: Bool
  public var failure: ServiceFailure?
  public init(
    service: String, version: String, protocolVersion: Int, pid: Int, instance: String,
    storeId: String, rootBinding: String, modelReady: Bool, failure: ServiceFailure? = nil
  ) {
    self.service = service
    self.version = version
    self.protocolVersion = protocolVersion
    self.pid = pid
    self.instance = instance
    self.storeId = storeId
    self.rootBinding = rootBinding
    self.modelReady = modelReady
    self.failure = failure
  }
}

public struct ServiceFailure: Codable, Equatable, Sendable {
  public enum Code: String, Codable, Sendable {
    case storageFailed = "storage_failed"
    case taskParked = "task_parked"
    case modelTimeout = "model_timeout"
    case modelAuthentication = "model_authentication"
    case modelError = "model_error"
  }
  public var code: Code
  public var id: String
  public init(code: Code, id: String) {
    self.code = code
    self.id = id
  }
}

public struct ModelConfiguration: Codable, Equatable, Sendable {
  public var baseUrl: String
  public var model: String
  public var thinkingLevel: String
  public var hasApiKey: Bool
  public init(baseUrl: String, model: String, thinkingLevel: String, hasApiKey: Bool) {
    self.baseUrl = baseUrl
    self.model = model
    self.thinkingLevel = thinkingLevel
    self.hasApiKey = hasApiKey
  }
}

public struct ConfigurationChange: Codable, Equatable, Sendable {
  public var baseUrl: String
  public var model: String
  public var thinkingLevel: String
  public var apiKey: String?
  public init(
    baseUrl: String, model: String, thinkingLevel: String = "medium", apiKey: String? = nil
  ) {
    self.baseUrl = baseUrl
    self.model = model
    self.thinkingLevel = thinkingLevel
    self.apiKey = apiKey
  }
}

public struct ChatMessage: Codable, Equatable, Identifiable, Sendable {
  public enum Role: String, Codable, Sendable { case user, assistant }
  public enum State: String, Codable, Sendable { case complete, streaming, error, aborted }
  public var id: String
  public var role: Role
  public var text: String
  public var state: State
  public var createdAt: Double
  public var requestId: String?
  public init(
    id: String, role: Role, text: String, state: State = .complete, createdAt: Double = 0,
    requestId: String? = nil
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.state = state
    self.createdAt = createdAt
    self.requestId = requestId
  }
}

public struct QueuedInput: Codable, Equatable, Sendable {
  public var id: String
  public var requestId: String
  public var text: String
  public init(id: String, requestId: String, text: String) {
    self.id = id
    self.requestId = requestId
    self.text = text
  }
}

public struct ChatWindow: Codable, Equatable, Sendable {
  public var oldestEntryId: Int?
  public var newestEntryId: Int?
  public var coverage: String
  public var hasOlder: Bool
  public init(
    oldestEntryId: Int? = nil, newestEntryId: Int? = nil, coverage: String = "window",
    hasOlder: Bool = false
  ) {
    self.oldestEntryId = oldestEntryId
    self.newestEntryId = newestEntryId
    self.coverage = coverage
    self.hasOlder = hasOlder
  }

  /// A service from before the additive `hasOlder` field remains readable; absence means
  /// "no certified older page", never a guessed boundary.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    oldestEntryId = try container.decodeIfPresent(Int.self, forKey: .oldestEntryId)
    newestEntryId = try container.decodeIfPresent(Int.self, forKey: .newestEntryId)
    coverage = try container.decode(String.self, forKey: .coverage)
    hasOlder = try container.decodeIfPresent(Bool.self, forKey: .hasOlder) ?? false
  }
}

public struct ChatSnapshot: Codable, Equatable, Sendable {
  public var botId: String
  public var messages: [ChatMessage]
  public var pending: [QueuedInput]
  public var running: Bool
  public var modelReady: Bool
  public var configuration: ModelConfiguration?
  public var window: ChatWindow
  public var failure: ServiceFailure?
  public init(
    messages: [ChatMessage] = [], running: Bool = false, modelReady: Bool = false,
    configuration: ModelConfiguration? = nil, window: ChatWindow? = nil
  ) {
    botId = "superagent"
    self.messages = messages
    pending = []
    self.running = running
    self.modelReady = modelReady
    self.configuration = configuration
    let ids = messages.compactMap { message in
      message.id.hasPrefix("e_") ? Int(message.id.dropFirst(2)) : nil
    }
    self.window = window ?? ChatWindow(oldestEntryId: ids.first, newestEntryId: ids.last)
  }
}

public struct SnapshotFrame: Codable, Equatable, Sendable {
  public var type: String
  public var instance: String
  public var rev: Int
  public var value: ChatSnapshot
  public init(instance: String, rev: Int, value: ChatSnapshot) {
    type = "snapshot"
    self.instance = instance
    self.rev = rev
    self.value = value
  }
}

public struct ChatAdmission: Codable, Equatable, Sendable {
  public enum Status: String, Codable, Sendable { case queued, placed, done, unanswered }
  public var id: String
  public var requestId: String
  public var status: Status
  public var entryId: String?
  public var answerEntryId: String?
  public var answer: String?
  public var reason: String?
  public var terminal: Bool { status == .done || status == .unanswered }
  public init(id: String, requestId: String, status: Status, answer: String? = nil) {
    self.id = id
    self.requestId = requestId
    self.status = status
    self.answer = answer
  }
}

public struct HistoryPage: Codable, Equatable, Sendable {
  public var messages: [ChatMessage]
  public var hasMore: Bool
  public var nextBefore: Int?
  public var coverage: String
  public init(messages: [ChatMessage], hasMore: Bool, nextBefore: Int? = nil, coverage: String) {
    self.messages = messages
    self.hasMore = hasMore
    self.nextBefore = nextBefore
    self.coverage = coverage
  }
}

public struct PendingInput: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var text: String
  public var createdAt: Double
  public init(
    id: String = "r_" + UUID().uuidString.lowercased(), text: String,
    createdAt: Double = Date().timeIntervalSince1970 * 1000
  ) {
    self.id = id
    self.text = text
    self.createdAt = createdAt
  }
}

public enum ServiceCode: String, Codable, Sendable {
  case invalidCommand = "invalid_command"
  case unauthorized, unconfigured, busy
  case limitExceeded = "limit_exceeded"
  case storageFailed = "storage_failed"
  case `internal`
  case shuttingDown = "shutting_down"
  case cancellationUnconfirmed = "cancellation_unconfirmed"
}

public enum SuperagentError: Error, Equatable, Sendable, LocalizedError {
  case credential, identity, unavailable, protocolViolation, timeout, cancelled, storage
  case service(ServiceCode)
  public var errorDescription: String? {
    switch self {
    case .credential: return "Super Bot 凭据不可用或不安全。"
    case .identity: return "Super Bot 服务身份验证失败。"
    case .unavailable: return "无法连接 Super Bot 服务。"
    case .protocolViolation: return "Super Bot 协议响应无效。"
    case .timeout: return "等待超时；已提交的工作不会自动取消。"
    case .cancelled: return "连接已关闭。"
    case .storage: return "Super Bot 本地数据无法安全读写。"
    case .service(let code):
      switch code {
      case .unconfigured: return "请先配置 Super Bot 模型。"
      case .busy: return "Super Bot 正忙，请稍后重试。"
      case .limitExceeded: return "消息或排队数量超过限制。"
      case .unauthorized: return "Super Bot 拒绝此凭据。"
      case .invalidCommand: return "请求格式无效。"
      case .storageFailed: return "Super Bot 存储不可用，请检查服务状态。"
      case .shuttingDown: return "Super Bot 服务正在关闭。"
      case .cancellationUnconfirmed: return "停止尚未确认，请核对后续状态。"
      case .internal: return "Super Bot 服务未能完成请求。"
      }
    }
  }
}

/// SG-002 observation as the native surface reads it: what the Super Bot can see of the
/// workers, never what it may do to them.
public struct ObservationSummary: Equatable, Sendable {
  public enum State: String, Equatable, Sendable {
    case ready
    case refused
    case unreachable
    case reset
    case unconfigured
    case failure = "internal"
  }

  public let state: State
  public let reachable: Bool
  /// Bots whose store the provider could read in the last snapshot.
  public let botsVisible: Int
  /// Bots the provider knows but could not read (missing store, unsupported schema, unreadable).
  public let botsUnknown: Int
  public let lastReadAt: String?
  /// A provider error code, never provider text; nil when nothing failed.
  public let detail: String?
  /// True while nothing has been read yet, so the surface shows unknown rather than zero.
  public let isEmpty: Bool

  public init(
    state: State, reachable: Bool, botsVisible: Int = 0, botsUnknown: Int = 0,
    lastReadAt: String? = nil, detail: String? = nil, isEmpty: Bool = true
  ) {
    self.state = state
    self.reachable = reachable
    self.botsVisible = botsVisible
    self.botsUnknown = botsUnknown
    self.lastReadAt = lastReadAt
    self.detail = detail
    self.isEmpty = isEmpty
  }

  public static let unconfigured = ObservationSummary(state: .unconfigured, reachable: false)

  /// A short, honest line for the surface: no reading is not "zero bots".
  public var headline: String {
    switch state {
    case .unconfigured: return "未连接 worker 观测"
    case .refused: return "观测凭据被拒绝"
    case .unreachable: return "观测源不可达"
    case .reset: return "观测基线已重置"
    case .failure: return "观测失败"
    case .ready: return isEmpty ? "尚未读取" : "已读取"
    }
  }

  public var coverageLine: String {
    guard state == .ready, !isEmpty else { return headline }
    return "可见 \(botsVisible) · 未知 \(botsUnknown)"
  }
}
