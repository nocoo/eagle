import SwiftUI

/// One inspector section header: a small glyph, the label, then a hairline that runs to the
/// panel edge. Every section starts with it, so the whole column reads as one grid instead of
/// a pile of unrelated lists.
public struct PanelSectionHeader: View {
  private let symbolName: String
  private let title: String

  public init(symbolName: String, title: String) {
    self.symbolName = symbolName
    self.title = title
  }

  public var body: some View {
    HStack(spacing: Theme.Metric.panelSectionRowGap) {
      Image(systemName: symbolName)
        .font(Theme.TypeScale.Glyph.section)
        .foregroundStyle(Theme.Palette.textMuted)
        .frame(width: Theme.Metric.panelSectionGlyphWidth)
      Text(title)
        .font(Theme.TypeScale.sectionLabel)
        .foregroundStyle(Theme.Palette.textSecondary)
        .tracking(0.2)
        .fixedSize()
      PanelDivider()
        .padding(.leading, 2)
    }
    .frame(height: Theme.Metric.sectionHeaderHeight)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

/// What a section shows when it holds nothing: the same glyph line as a row, a short title and
/// one sentence explaining what will appear. Compact on purpose — an empty panel still has to
/// leave room for the sections below it.
public struct PanelEmptyState: View {
  private let placeholder: InspectorPlaceholder

  public init(placeholder: InspectorPlaceholder) {
    self.placeholder = placeholder
  }

  public var body: some View {
    HStack(alignment: .top, spacing: Theme.Metric.panelSectionRowGap) {
      Image(systemName: placeholder.symbolName)
        .font(Theme.TypeScale.Glyph.empty)
        .foregroundStyle(Theme.Palette.textMuted)
        .frame(width: Theme.Metric.panelSectionGlyphWidth)
      VStack(alignment: .leading, spacing: Theme.Metric.panelTaskRowGap) {
        Text(placeholder.title)
          .font(Theme.TypeScale.activity)
          .foregroundStyle(Theme.Palette.textSecondary)
        Text(placeholder.detail)
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, Theme.Metric.panelEmptyVertical)
    .accessibilityElement(children: .combine)
  }
}
