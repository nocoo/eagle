import Foundation

public protocol SuperagentChatPort: Sendable {
  func events() async throws -> AsyncThrowingStream<SnapshotFrame, Error>
  func state() async throws -> SnapshotFrame
  func configure(_ value: ConfigurationChange) async throws -> ModelConfiguration
  func submit(_ input: PendingInput) async throws -> ChatAdmission
  func submission(_ requestId: String) async throws -> ChatAdmission?
  func history(before: Int?, limit: Int) async throws -> HistoryPage
  func abort() async throws
  func close() async
}

public protocol SuperagentServicePort: SuperagentChatPort {
  func health() async throws -> ServiceHealth
}

public protocol PendingInputStore: Sendable {
  func save(_ input: PendingInput) async throws
  func list() async throws -> [PendingInput]
  func remove(_ id: String) async throws
}

public struct ChatState: Equatable, Sendable {
  public private(set) var snapshot = ChatSnapshot()
  public private(set) var instance: String?
  public private(set) var revision = -1
  public private(set) var older: [ChatMessage] = []
  public private(set) var nextBefore: Int?
  public private(set) var hasMore = false
  public init() {}
  public var messages: [ChatMessage] {
    var seen = Set<String>()
    return (older + snapshot.messages).filter { seen.insert($0.id).inserted }
  }
  @discardableResult public mutating func accept(_ frame: SnapshotFrame) throws -> Bool {
    guard frame.type == "snapshot", frame.rev >= 0, UUID(uuidString: frame.instance) != nil,
      frame.value.botId == "superagent", frame.value.window.coverage == "window",
      frame.value.messages.count <= 100,
      Set(frame.value.messages.map(\.id)).count == frame.value.messages.count
    else { throw SuperagentError.protocolViolation }
    if instance == frame.instance, frame.rev <= revision { return false }
    if instance != frame.instance
      || snapshot.window.oldestEntryId != frame.value.window.oldestEntryId
    {
      older = []
      nextBefore = frame.value.window.oldestEntryId
      hasMore = nextBefore != nil && frame.value.window.hasOlder
    }
    instance = frame.instance
    revision = frame.rev
    snapshot = frame.value
    return true
  }
  public mutating func prepend(_ page: HistoryPage, expectedBefore: Int) throws {
    guard nextBefore == expectedBefore else { return }
    guard ["complete", "partial"].contains(page.coverage), page.messages.count <= 100,
      !page.hasMore || page.nextBefore.map({ $0 > 0 && $0 < expectedBefore }) == true,
      page.hasMore || page.nextBefore == nil,
      page.messages.allSatisfy({ message in
        guard message.id.hasPrefix("e_"), let id = Int(message.id.dropFirst(2)) else {
          return false
        }
        return id > 0 && id < expectedBefore
      })
    else { throw SuperagentError.protocolViolation }
    let known = Set(older.map(\.id))
    older = page.messages.filter { !known.contains($0.id) } + older
    nextBefore = page.nextBefore
    hasMore = page.hasMore
  }
  public mutating func reconnect() {
    older = []
    nextBefore = nil
    hasMore = false
    instance = nil
    revision = -1
  }
}

/// SG-002 observation: a read-only port. It has no send, steer, abort or configure method
/// on purpose — the Super Bot observes workers and never commands them.
public protocol SuperagentObservationPort: Sendable {
  func observation() async throws -> ObservationSummary
}
