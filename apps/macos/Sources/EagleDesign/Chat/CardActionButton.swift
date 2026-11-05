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

  var fillColor: Color { enabled ? Theme.Palette.accentFill : Theme.Palette.disabledAction }
  var textColor: Color { style == .filled ? Theme.Palette.onColor : Theme.Palette.textSecondary }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(Theme.TypeScale.noteEmphasis)
        .foregroundStyle(textColor)
        .padding(.horizontal, style == .filled ? Theme.Card.actionInset : Theme.Layout.sectionGap)
        .frame(height: Theme.Form.actionHeight)
        .background {
          if style == .filled {
            RoundedRectangle(cornerRadius: Theme.Form.actionRadius, style: .continuous)
              .fill(fillColor)
          }
        }
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
  }
}
