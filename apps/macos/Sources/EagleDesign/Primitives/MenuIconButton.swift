import SwiftUI

/// Circled icon that opens a menu instead of acting on click, drawn like
/// `IconButton(style: .circled)` so the header keeps one shape.
public struct MenuIconButton<Content: View>: View {
  private let systemName: String
  private let label: String
  private let size: CGFloat
  private let content: Content

  @State private var hovering = false

  public init(
    systemName: String,
    label: String,
    size: CGFloat = Theme.Metric.headerControlHeight,
    @ViewBuilder content: () -> Content
  ) {
    self.systemName = systemName
    self.label = label
    self.size = size
    self.content = content()
  }

  public var body: some View {
    Menu {
      content
    } label: {
      Image(systemName: systemName)
        .font(
          Theme.TypeScale.buttonGlyph(size: size * Theme.Metric.roundGlyphRatio, circled: true)
        )
        .foregroundStyle(Theme.Palette.textPrimary)
        .frame(width: size, height: size)
        .background { RoundControlSurface(size: size, hovering: hovering) }
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .contentShape(Circle())
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
  }
}
