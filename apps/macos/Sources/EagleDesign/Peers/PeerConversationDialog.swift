import SwiftUI

/// A peer exchange opened in place: the whole round trip between the open bot and one counterpart,
/// read-only. Nothing here writes, replies or starts work; closing is the only action.
public struct PeerConversationDialog: View {
  private let exchange: PeerExchange
  private let onClose: () -> Void

  public init(exchange: PeerExchange, onClose: @escaping () -> Void) {
    self.exchange = exchange
    self.onClose = onClose
  }

  public var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: Theme.Metric.peerGroupGap) {
          ForEach(exchange.bursts(), id: \.id) { burst in
            if let divider = burst.divider {
              Text(divider)
                .font(Theme.TypeScale.pill)
                .foregroundStyle(Theme.Palette.textMuted)
                .frame(maxWidth: .infinity)
            }
            PeerMessageGroup(burst: burst)
          }
        }
        .frame(maxWidth: Theme.Metric.peerDialogColumnWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
        // Clear of the pair chip: the first turn must not start under it.
        .padding(.top, Theme.Metric.peerDialogInset + 22)
        .padding(.bottom, Theme.Metric.peerDialogInset)
      }
      .scrollIndicators(.automatic)

      footer
    }
    .background(Theme.Palette.canvas)
    .clipShape(RoundedRectangle(cornerRadius: Theme.Metric.peerDialogRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.peerDialogRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .overlay(alignment: .topTrailing) {
      PeerPairChip(exchange: exchange)
        .padding(.trailing, Theme.Metric.peerDialogInset)
        .padding(.top, 14)
    }
    .shadow(color: Theme.Palette.modalShadow, radius: 34, y: 16)
  }

  private var footer: some View {
    HStack {
      Spacer(minLength: 0)
      Button(action: onClose) {
        Text("关闭聊天")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textPrimary)
          .padding(.horizontal, 18)
          .padding(.vertical, 8)
          .background(Capsule(style: .continuous).fill(Theme.Palette.card))
          .overlay(
            Capsule(style: .continuous)
              .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
          )
      }
      .buttonStyle(.plain)
      .keyboardShortcut(.cancelAction)
      Spacer(minLength: 0)
    }
    .frame(height: Theme.Metric.peerDialogFooter)
  }
}
