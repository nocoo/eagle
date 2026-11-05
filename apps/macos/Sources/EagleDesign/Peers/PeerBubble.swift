import SwiftUI

/// One message of an exchange, drawn as the same card the transcript gives an answer: markdown,
/// hairline, hover copy. Only the radius and the width differ, because this column is narrower.
public struct PeerBubble: View {
  private let text: String
  /// The sender's own colour: two bots in one dialog must not look like one voice.
  private let tint: Color

  public init(text: String, tint: Color) {
    self.text = text
    self.tint = tint
  }

  public var body: some View {
    AssistantBubble(
      text: text,
      cornerRadius: Theme.Metric.peerBubbleRadius,
      maxWidth: Theme.Metric.peerBubbleMaxWidth,
      fill: tint.opacity(0.12),
      border: tint.opacity(0.34)
    )
  }
}

/// A run of messages from one bot: its name once, its bubbles, and its face under the last one, so
/// a long turn is signed where it ends instead of floating a portrait beside every paragraph.
public struct PeerMessageGroup: View {
  private let burst: PeerBurst

  public init(burst: PeerBurst) {
    self.burst = burst
  }

  public var body: some View {
    HStack(alignment: .bottom, spacing: Theme.Metric.peerGutter) {
      PeerFace(peer: burst.sender, size: Theme.Metric.peerChipFace)

      VStack(alignment: .leading, spacing: Theme.Metric.peerMessageGap) {
        Text(burst.sender.title)
          .font(Theme.TypeScale.activity)
          .foregroundStyle(burst.sender.labelTint)
          .padding(.leading, Theme.Metric.peerLabelGap)
        ForEach(burst.messages) { message in
          PeerBubble(text: message.text, tint: burst.sender.labelTint)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The pair an open exchange is between. It floats over the dialog's content so the answer to
/// "who is talking" never scrolls away.
public struct PeerPairChip: View {
  private let exchange: PeerExchange

  public init(exchange: PeerExchange) {
    self.exchange = exchange
  }

  public var body: some View {
    HStack(spacing: 8) {
      ForEach(Array(exchange.participants.prefix(2).enumerated()), id: \.element.id) {
        index, peer in
        if index > 0 {
          Image(systemName: "arrow.left.arrow.right")
            .font(Theme.TypeScale.Glyph.action)
            .foregroundStyle(Theme.Palette.textMuted)
        }
        PeerFaceName(
          peer: peer,
          size: Theme.Metric.peerChipFace,
          font: Theme.TypeScale.cardTitle,
          tint: Theme.Palette.textPrimary
        )
      }
    }
    .padding(.leading, 10)
    .padding(.trailing, 14)
    .padding(.vertical, 7)
    .background(Capsule(style: .continuous).fill(Theme.Palette.card))
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .shadow(color: Theme.Palette.peerAvatarShadow, radius: 12, y: 4)
    .accessibilityElement(children: .combine)
  }
}

extension PeerRef {
  /// The bot's own colour, the one its face is filled with, for its name and its burst label.
  var labelTint: Color {
    if let face { return Theme.Palette.botTint(face.tint) }
    return Theme.Palette.avatarTint(tintIndex)
  }
}
