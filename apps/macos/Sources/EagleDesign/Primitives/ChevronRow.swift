import SwiftUI

/// White card row with a leading glyph and a trailing chevron.
public struct ChevronRow: View {
  private let systemName: String
  private let title: String
  private let action: (() -> Void)?
  @State private var hovering = false

  public init(systemName: String, title: String, action: (() -> Void)? = nil) {
    self.systemName = systemName
    self.title = title
    self.action = action
  }

  public var body: some View {
    Button {
      action?()
    } label: {
      HStack(spacing: Theme.Primitive.chevronGap) {
        Image(systemName: systemName)
          .font(Theme.TypeScale.activity)
          .foregroundStyle(Theme.Palette.textSecondary)
          .frame(width: Theme.Layout.glyphSlot)
        Text(title)
          .font(Theme.TypeScale.cardTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: Theme.Layout.rowGap)
        Image(systemName: "chevron.right")
          .font(Theme.TypeScale.Glyph.action)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, Theme.Layout.controlInset)
      .frame(height: Theme.Metric.inspectorRowHeight)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
      .opacity(hovering ? Theme.Primitive.hoverContentOpacity : 1)
    }
    .buttonStyle(.plain)
    .disabled(action == nil)
    .onHover { hovering = $0 }
    .accessibilityLabel(title)
  }
}
