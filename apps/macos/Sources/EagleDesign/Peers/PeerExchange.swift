import SwiftUI

/// One bot at the other end of an exchange, as the transcript draws it. The face travels with the
/// name because the same bot appears in the row, the chip and the origin line.
public struct PeerRef: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  /// The bot's own face; nil falls back to a tinted initial.
  public let face: BotFace.Style?

  public init(id: String, title: String, face: BotFace.Style? = nil) {
    self.id = id
    self.title = title
    self.face = face
  }
}

/// Who an answer was given to, and the exchange it belongs to. The id lets the row open that
/// exchange; an origin without one is a label only.
public struct PeerOrigin: Hashable, Sendable {
  public let peer: PeerRef
  public let exchangeId: String?

  public init(peer: PeerRef, exchangeId: String? = nil) {
    self.peer = peer
    self.exchangeId = exchangeId
  }
}

/// One message inside an exchange. Text is what a person reads: the dialog is not a log viewer.
public struct PeerMessage: Identifiable, Hashable, Sendable {
  public let id: String
  public let senderId: String
  public let text: String
  /// When it was sent, when the daemon knows: the dialog divides the round trip by real gaps.
  public let at: Date?

  public init(id: String, senderId: String, text: String, at: Date? = nil) {
    self.id = id
    self.senderId = senderId
    self.text = text
    self.at = at
  }
}

/// A run of consecutive messages from one bot. The dialog signs each run once, at its end.
public struct PeerBurst: Identifiable, Hashable, Sendable {
  public let sender: PeerRef
  public let messages: [PeerMessage]
  /// The moment this run started, when the gap before it was long enough to say so.
  public let divider: String?

  public init(sender: PeerRef, messages: [PeerMessage], divider: String? = nil) {
    self.sender = sender
    self.messages = messages
    self.divider = divider
  }

  public var id: String { messages.first?.id ?? sender.id }
}

/// One exchange between the open bot and one counterpart: the whole round trip, not one send.
/// This is view state only; the daemon owns durability and the client reads it as one record.
public struct PeerExchange: Identifiable, Hashable, Sendable {
  public let id: String
  /// Both sides, in the order the daemon recorded them. Two: an exchange is always a pair.
  public let participants: [PeerRef]
  public let messages: [PeerMessage]
  /// How many messages the daemon counted, when the row does not carry them all: a folded row
  /// keeps only the count, and opening it reads the messages.
  public let count: Int?

  public init(
    id: String,
    participants: [PeerRef],
    messages: [PeerMessage],
    count: Int? = nil
  ) {
    self.id = id
    self.participants = participants
    self.messages = messages
    self.count = count
  }

  /// The collapsed row's first half: a count, never a summary of what was said.
  public var summary: String { "\(count ?? messages.count) 条消息来往：" }

  public func participant(_ id: String) -> PeerRef? {
    participants.first { $0.id == id }
  }

  /// How long a silence has to be before the dialog says when the conversation resumed.
  public static let dividerGap: TimeInterval = 5 * 60

  /// Consecutive messages from the same bot read as one turn. A sender the exchange does not list
  /// keeps its own burst under its raw id, so a missing participant never hides a message. A run
  /// that starts more than `gap` after the previous message carries the moment it started.
  public func bursts(
    gap: TimeInterval = PeerExchange.dividerGap,
    label: (Date) -> String = PeerTimeline.label
  ) -> [PeerBurst] {
    var bursts: [PeerBurst] = []
    var run: [PeerMessage] = []
    var runDivider: String?
    var previous: Date?
    func flush() {
      guard let first = run.first else { return }
      bursts.append(
        PeerBurst(sender: sender(of: first.senderId), messages: run, divider: runDivider)
      )
      run = []
      runDivider = nil
    }
    for message in messages {
      if let current = run.first, current.senderId != message.senderId {
        flush()
      }
      if run.isEmpty, let at = message.at {
        // The first run always says when it began; later ones only after a real silence.
        let silent = previous.map { at.timeIntervalSince($0) >= gap } ?? true
        if silent { runDivider = label(at) }
      }
      run.append(message)
      if let at = message.at { previous = at }
    }
    flush()
    return bursts
  }

  private func sender(of senderId: String) -> PeerRef {
    participant(senderId) ?? PeerRef(id: senderId, title: senderId)
  }
}
