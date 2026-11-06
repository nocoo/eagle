import SwiftUI

/// An invisible control that carries a dialog's Return or Escape action wherever the keyboard
/// focus is, so a surface with no focused field still answers the keyboard. It paints nothing
/// and takes no room.
public struct DialogShortcut: View {
  private let shortcut: KeyboardShortcut
  private let action: () -> Void

  public init(_ shortcut: KeyboardShortcut, action: @escaping () -> Void) {
    self.shortcut = shortcut
    self.action = action
  }

  public var body: some View {
    Button(action: action) { EmptyView() }
      .keyboardShortcut(shortcut)
      .buttonStyle(.plain)
      .opacity(0)
      .frame(width: 0, height: 0)
      .accessibilityHidden(true)
  }
}
