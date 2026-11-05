import SwiftUI

/// A bot's face and name, at the one size a place asks for. The collapsed row, the pair chip and
/// the origin line all draw a bot the same way, so the same bot looks the same in all three.
public struct PeerFaceName: View {
  private let peer: PeerRef
  private let size: CGFloat
  private let font: Font
  private let tint: Color

  public init(
    peer: PeerRef,
    size: CGFloat = Theme.Metric.peerFace,
    font: Font = Theme.TypeScale.note,
    tint: Color = Theme.Palette.textSecondary
  ) {
    self.peer = peer
    self.size = size
    self.font = font
    self.tint = tint
  }

  public var body: some View {
    HStack(spacing: Theme.Layout.labelGap) {
      PeerFace(peer: peer, size: size)
      Text(peer.title)
        .font(font)
        .foregroundStyle(tint)
        .lineLimit(1)
    }
    .accessibilityElement(children: .combine)
  }
}

/// The bot's own face, or a tinted initial when the exchange did not carry one.
public struct PeerFace: View {
  private let peer: PeerRef
  private let size: CGFloat

  public init(peer: PeerRef, size: CGFloat = Theme.Metric.peerFace) {
    self.peer = peer
    self.size = size
  }

  public var body: some View {
    Group {
      if let face = peer.face {
        BotFace(style: face, size: size)
      } else {
        Avatar(
          initial: String(peer.title.prefix(1)),
          tint: Theme.Palette.avatarTint(peer.tintIndex),
          size: size,
          shape: .blob
        )
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
