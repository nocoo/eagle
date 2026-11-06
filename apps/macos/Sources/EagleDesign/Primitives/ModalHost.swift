import SwiftUI

/// One modal surface over the window: the workspace behind it dims (the shell blurs it) and
/// stops taking clicks, and the dialog is one card with the shared radius, hairline and
/// shadow. The scrim, Escape and the dialog's own close control all dismiss it.
public struct ModalHost<Content: View>: View {
  private let onDismiss: () -> Void
  private let insets: EdgeInsets
  private let content: Content

  /// `insets` pulls the card away from the window's edges for a panel that keeps clear of
  /// the shell's columns; a centred dialog leaves them at zero.
  public init(
    insets: EdgeInsets = EdgeInsets(),
    onDismiss: @escaping () -> Void,
    @ViewBuilder content: () -> Content
  ) {
    self.insets = insets
    self.onDismiss = onDismiss
    self.content = content()
  }

  public var body: some View {
    ZStack {
      Theme.Palette.modalScrim
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture(perform: onDismiss)
      card
    }
    // Escape closes from anywhere: the focused-field route and the window's cancel shortcut.
    .onExitCommand(perform: onDismiss)
    .background(DialogShortcut(.cancelAction, action: onDismiss))
    .transition(.opacity)
  }

  private var card: some View {
    content
      .background(
        RoundedRectangle(cornerRadius: Theme.Dialog.radius, style: .continuous)
          .fill(Theme.Palette.surface)
      )
      .clipShape(RoundedRectangle(cornerRadius: Theme.Dialog.radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Dialog.radius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .shadow(
        color: Theme.Palette.modalShadow, radius: Theme.Dialog.shadowRadius,
        y: Theme.Dialog.shadowY
      )
      .padding(insets)
      .background(TrafficLights(hidden: true))
  }
}
