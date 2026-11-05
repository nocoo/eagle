import SwiftUI

/// Borderless icon control with a hover fill and an accessibility label.
public struct IconButton: View {
  public enum Style {
    /// Plain glyph with a hover wash, used in the sidebar toolbar.
    case plain
    /// Circular button with a hairline border, used in the inspector header.
    case circled
  }

  private let systemName: String
  private let label: String
  private let size: CGFloat
  private let glyphSize: CGFloat
  private let tint: Color
  private let style: Style
  private let action: () -> Void
  @State private var hovering = false

  public init(
    systemName: String,
    label: String,
    size: CGFloat = Theme.Metric.iconButton,
    glyphSize: CGFloat? = nil,
    tint: Color = Theme.Palette.textPrimary,
    style: Style = .plain,
    action: @escaping () -> Void
  ) {
    self.systemName = systemName
    self.label = label
    self.size = size
    switch style {
    case .plain: self.glyphSize = glyphSize ?? size * Theme.Primitive.plainGlyphRatio
    case .circled: self.glyphSize = glyphSize ?? size * Theme.Metric.roundGlyphRatio
    }
    self.tint = tint
    self.style = style
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Image(systemName: systemName)
        .font(Theme.TypeScale.buttonGlyph(size: glyphSize, circled: style == .circled))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .background { background }
    }
    .buttonStyle(.plain)
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
  }

  @ViewBuilder
  private var background: some View {
    switch style {
    case .plain:
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(hovering ? Theme.Palette.hover : .clear)
    case .circled:
      RoundControlSurface(size: size, hovering: hovering)
    }
  }
}

/// The white circle every header control shares: a hairline ring, a soft shadow that lifts it off
/// the sidebar, and a hover wash that keeps the ring readable.
struct RoundControlSurface: View {
  let size: CGFloat
  let hovering: Bool

  var body: some View {
    Circle()
      .fill(Theme.Palette.card)
      .overlay {
        Circle().fill(hovering ? Theme.Palette.hover : .clear)
      }
      .overlay {
        Circle().strokeBorder(
          hovering ? Theme.Palette.hoveredControlBorder : Theme.Palette.line,
          lineWidth: Theme.Metric.hairline
        )
      }
      .shadow(
        color: Theme.Palette.roundShadow,
        radius: Theme.Metric.roundShadowRadius,
        y: Theme.Metric.roundShadowY
      )
      .frame(width: size, height: size)
  }
}

/// Small link-styled text button, e.g. `更多未读消息` / `展开`.
public struct TextAction: View {
  private let title: String
  private let action: () -> Void

  public init(_ title: String, action: @escaping () -> Void) {
    self.title = title
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.accent)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }
}
