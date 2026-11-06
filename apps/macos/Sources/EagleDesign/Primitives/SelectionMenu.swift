import SwiftUI

public struct SelectionMenu<Content: View>: View {
  public enum Style: CaseIterable, Hashable, Sendable {
    case surface, standard, provider, compact, action, inline, policy

    var textFont: Font {
      switch self {
      case .provider, .policy: Theme.TypeScale.note
      case .compact: Theme.TypeScale.compactEmphasis
      case .inline: Theme.TypeScale.pill
      default: Theme.TypeScale.noteEmphasis
      }
    }

    var glyphFont: Font {
      switch self {
      case .provider, .policy, .action: textFont
      case .inline: Theme.TypeScale.Glyph.microChevron
      default: Theme.TypeScale.Glyph.chevron
      }
    }

    var glyphColor: Color {
      switch self {
      case .provider, .policy, .action: Theme.Palette.textPrimary
      case .inline: Theme.Palette.textMuted
      default: Theme.Palette.textSecondary
      }
    }

    var gap: CGFloat {
      self == .inline ? Theme.Form.inlineChoiceGap : Theme.Form.controlGap
    }

    var inset: CGFloat {
      switch self {
      case .policy: 0
      case .inline: Theme.Layout.labelGap
      case .provider, .compact: Theme.Form.compactControlInset
      default: Theme.Form.controlInset
      }
    }

    var height: CGFloat? {
      switch self {
      case .policy: nil
      case .inline: Theme.Metric.panelTaskRowHeight
      case .compact: Theme.Form.compactSelectorHeight
      case .action: Theme.Form.actionHeight
      default: Theme.Form.selectorHeight
      }
    }
  }

  private let title: String
  private let style: Style
  private let content: Content
  @State private var hovering = false

  public init(_ title: String, style: Style, @ViewBuilder content: () -> Content) {
    self.title = title
    self.style = style
    self.content = content()
  }

  public var body: some View {
    styledMenu
      .menuIndicator(.hidden)
      .fixedSize()
      .onHover { if style == .surface { hovering = $0 } }
  }

  @ViewBuilder private var styledMenu: some View {
    if style == .policy {
      menu.menuStyle(.borderlessButton)
    } else {
      menu.menuStyle(.button).buttonStyle(.plain)
    }
  }

  private var menu: some View {
    Menu {
      content
    } label: {
      label
    }
  }

  /// The inline shell fills the row it sits in, so its title, the gap and the trailing
  /// chevron are one target. The other shells keep their own painted shape as the target.
  @ViewBuilder private var label: some View {
    let shell = HStack(spacing: style.gap) {
      titleText
      Image(systemName: "chevron.down")
        .font(style.glyphFont)
        .foregroundStyle(style.glyphColor)
    }
    .font(style.textFont)
    .foregroundStyle(Theme.Palette.textPrimary)
    .padding(.horizontal, style.inset)
    .frame(height: style.height)
    .background { surface }
    if style == .inline {
      shell.contentShape(Rectangle())
    } else {
      shell
    }
  }

  @ViewBuilder private var titleText: some View {
    if style == .inline { Text(title).lineLimit(1) } else { Text(title) }
  }

  @ViewBuilder private var surface: some View {
    // The inline shell has a height but no painted surface: its target stays invisible.
    if style.height != nil, style != .inline {
      let fill = style == .surface && !hovering ? Theme.Palette.card : Theme.Palette.canvas
      if style == .action {
        RoundedRectangle(cornerRadius: Theme.Form.actionRadius, style: .continuous)
          .fill(fill)
          .overlay {
            RoundedRectangle(cornerRadius: Theme.Form.actionRadius, style: .continuous)
              .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
          }
      } else {
        Capsule().fill(fill)
          .overlay { Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline) }
      }
    }
  }
}
