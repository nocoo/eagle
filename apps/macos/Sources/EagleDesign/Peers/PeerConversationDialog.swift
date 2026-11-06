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
        .padding(.horizontal, Theme.Metric.peerDialogInset)
        .frame(maxWidth: Theme.Metric.peerDialogColumnWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
        // Clear of the pair chip: the first turn must not start under it.
        .padding(.top, Theme.Metric.peerDialogInset + Theme.Dialog.peerTranscriptClearance)
        .padding(.bottom, Theme.Metric.peerDialogInset)
      }
      .scrollIndicators(.automatic)

      footer
    }
    .overlay(alignment: .topTrailing) {
      PeerPairChip(exchange: exchange)
        .padding(.trailing, Theme.Metric.peerDialogInset)
        .padding(.top, Theme.Layout.controlInset)
    }
  }

  private var footer: some View {
    HStack {
      Spacer(minLength: 0)
      Button(action: onClose) {
        Text("关闭聊天")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textPrimary)
          .padding(.horizontal, Theme.Layout.groupGap)
          .padding(.vertical, Theme.Layout.rowGap)
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
