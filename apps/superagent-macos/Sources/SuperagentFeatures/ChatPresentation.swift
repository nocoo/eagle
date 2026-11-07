import Foundation
import SuperagentCore

/// One transcript row as the native view needs it, without SwiftUI or worker types.
public struct ChatRow: Equatable, Identifiable, Sendable {
  public enum Kind: Equatable, Sendable { case user, assistant, streaming, aborted, failed, queued }
  public var id: String
  public var kind: Kind
  public var text: String
  public var requestId: String?
  public init(id: String, kind: Kind, text: String, requestId: String? = nil) {
    self.id = id
    self.kind = kind
    self.text = text
    self.requestId = requestId
  }
}

public enum ChatPresentation {
  /// Committed turns keep their wire outcome; accepted-but-unplaced inputs appear after
  /// them as queued rows, because the transcript alone would make them vanish.
  public static func rows(_ state: ChatState) -> [ChatRow] {
    var rows = state.messages.map { message -> ChatRow in
      switch (message.role, message.state) {
      case (.user, _):
        return ChatRow(
          id: message.id, kind: .user, text: message.text, requestId: message.requestId)
      case (.assistant, .streaming):
        return ChatRow(id: message.id, kind: .streaming, text: message.text)
      case (.assistant, .aborted):
        return ChatRow(id: message.id, kind: .aborted, text: message.text)
      case (.assistant, .error):
        return ChatRow(id: message.id, kind: .failed, text: message.text)
      case (.assistant, .complete):
        return ChatRow(id: message.id, kind: .assistant, text: message.text)
      }
    }
    rows += state.snapshot.pending.map {
      ChatRow(id: "q_\($0.id)", kind: .queued, text: $0.text, requestId: $0.requestId)
    }
    return rows
  }

  public static func queuedRequests(_ state: ChatState) -> [String: String] {
    Dictionary(
      uniqueKeysWithValues: state.snapshot.pending.map { ("q_\($0.id)", $0.requestId) })
  }
}
