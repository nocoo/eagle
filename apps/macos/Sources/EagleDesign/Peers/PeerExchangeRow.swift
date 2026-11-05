import SwiftUI

/// The collapsed form of a peer exchange: one centred line inside the transcript. It says how many
/// messages passed and between which bots, never what they said, and opens the exchange on click.
public struct PeerExchangeRow: View {
  private let exchange: PeerExchange
  private let onOpen: () -> Void
  @State private var hovering = false

  public init(exchange: PeerExchange, onOpen: @escaping () -> Void) {
    self.exchange = exchange
    self.onOpen = onOpen
  }

  public var body: some View {
    Button(action: onOpen) {
      HStack(spacing: Theme.Layout.labelGap) {
        Spacer(minLength: 0)
        Text(exchange.summary)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
        ForEach(Array(exchange.participants.prefix(2).enumerated()), id: \.element.id) {
          index, peer in
          if index > 0 {
            Text("和")
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
          }
          PeerFaceName(peer: peer)
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, Theme.Primitive.peerExchangeVerticalInset)
      .padding(.horizontal, Theme.Layout.sectionGap)
      .background(Capsule().fill(hovering ? Theme.Palette.hover : Theme.Palette.clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(Theme.Motion.hover, value: hovering)
    .accessibilityLabel("\(exchange.summary)打开对话")
    .accessibilityAddTraits(.isButton)
  }
}

/// Who a message came from, under the message itself: the one place a person learns that an answer
/// was not written by the bot they are looking at. It reads on the same centred line as every other
/// exchange row, and opens that exchange when the entry knows which one it was.
public struct PeerOriginRow: View {
  private let origin: PeerOrigin
  private let onOpen: (String) -> Void
  @State private var hovering = false

  public init(origin: PeerOrigin, onOpen: @escaping (String) -> Void = { _ in }) {
    self.origin = origin
    self.onOpen = onOpen
  }

  public var body: some View {
    Button {
      if let id = origin.exchangeId { onOpen(id) }
    } label: {
      HStack(spacing: Theme.Layout.labelGap) {
        Spacer(minLength: 0)
        Text("消息来自")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
        PeerFaceName(
          peer: origin.peer, font: Theme.TypeScale.note, tint: Theme.Palette.textSecondary)
        Spacer(minLength: 0)
      }
      .padding(.vertical, Theme.Layout.captionGap)
      .padding(.horizontal, Theme.Layout.sectionGap)
      .background(Capsule().fill(hovering ? Theme.Palette.hover : Theme.Palette.clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(origin.exchangeId == nil)
    .onHover { hovering = origin.exchangeId == nil ? false : $0 }
    .animation(Theme.Motion.hover, value: hovering)
    .accessibilityLabel("消息来自 \(origin.peer.title)")
  }
}
