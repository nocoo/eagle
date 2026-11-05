import SwiftUI

public struct CardActionButton: View {
  public enum Style { case filled, text }
  private let title: String
  private let enabled: Bool
  private let style: Style
  private let action: () -> Void

  public init(
    _ title: String, enabled: Bool = true, style: Style = .filled, action: @escaping () -> Void
  ) {
    self.title = title
    self.enabled = enabled
    self.style = style
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(Theme.TypeScale.noteEmphasis)
        .foregroundStyle(style == .filled ? Theme.Palette.onColor : Theme.Palette.textSecondary)
        .padding(.horizontal, style == .filled ? Theme.Card.actionInset : Theme.Layout.sectionGap)
        .frame(height: Theme.Form.actionHeight)
        .background {
          if style == .filled {
            RoundedRectangle(cornerRadius: Theme.Form.actionRadius, style: .continuous)
              .fill(enabled ? Theme.Palette.accentStrong : Theme.Palette.disabledAction)
          }
        }
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
  }
}
