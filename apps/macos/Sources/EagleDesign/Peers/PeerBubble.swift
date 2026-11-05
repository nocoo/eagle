import SwiftUI

/// Peer prose keeps the same neutral reading surface as an assistant answer.
public struct PeerBubble: View {
  private let text: String
  public init(text: String) {
    self.text = text
  }

  public var body: some View {
    AssistantBubble(
      text: text,
      cornerRadius: Theme.Metric.peerBubbleRadius,
      maxWidth: Theme.Metric.peerBubbleMaxWidth
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
          .foregroundStyle(burst.sender.colors.onSoft)
          .lineLimit(1)
          .padding(.horizontal, Theme.Layout.rowGap)
          .padding(.vertical, Theme.Layout.microGap)
          .background(burst.sender.colors.soft, in: Capsule())
          .padding(.leading, Theme.Metric.peerLabelGap)
        ForEach(burst.messages) { message in
          PeerBubble(text: message.text)
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
    HStack(spacing: Theme.Layout.rowGap) {
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
    .padding(.leading, Theme.Layout.controlGap)
    .padding(.trailing, Theme.Layout.controlInset)
    .padding(.vertical, Theme.Primitive.peerChipVerticalInset)
    .background(Capsule(style: .continuous).fill(Theme.Palette.card))
    .overlay(
      Capsule(style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .shadow(
      color: Theme.Palette.peerAvatarShadow, radius: Theme.Primitive.peerChipShadowRadius,
      y: Theme.Primitive.peerChipShadowY
    )
    .accessibilityElement(children: .combine)
  }
}

extension PeerRef {
  var colors: Theme.Palette.IdentityColors {
    if let face { return Theme.Palette.family(face.tint) }
    return Theme.Palette.neutralColors
  }
}
