import SwiftUI

/// One row inside the account popover.
public struct AccountMenuRow: Identifiable, Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case plan
    case plain
  }

  public let id: String
  public let systemName: String
  public let title: String
  public let detail: String?
  public let showsChevron: Bool
  public let kind: Kind
  public let destructive: Bool
  public let separatorBefore: Bool

  public init(
    id: String,
    systemName: String,
    title: String,
    detail: String? = nil,
    showsChevron: Bool = false,
    kind: Kind = .plain,
    destructive: Bool = false,
    separatorBefore: Bool = false
  ) {
    self.id = id
    self.systemName = systemName
    self.title = title
    self.detail = detail
    self.showsChevron = showsChevron
    self.kind = kind
    self.destructive = destructive
    self.separatorBefore = separatorBefore
  }
}

/// Popover anchored on the sidebar user row: plan usage, settings, sign-out.
public struct AccountMenu: View {
  private let rows: [AccountMenuRow]
  private let onSelect: (AccountMenuRow) -> Void
  @State private var hovering: String?

  public init(rows: [AccountMenuRow], onSelect: @escaping (AccountMenuRow) -> Void) {
    self.rows = rows
    self.onSelect = onSelect
  }

  public var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
        if index > 0, row.separatorBefore {
          Rectangle()
            .fill(Theme.Palette.line)
            .frame(height: Theme.Metric.hairline)
            .padding(.vertical, Theme.Layout.detailGap)
            .padding(.horizontal, Theme.Layout.sectionGap)
        }
        Button {
          onSelect(row)
        } label: {
          HStack(spacing: Theme.Layout.controlGap) {
            Image(systemName: row.systemName)
              .font(Theme.TypeScale.fieldLabel)
              .foregroundStyle(
                row.destructive ? Theme.Palette.destructive : Theme.Palette.textPrimary
              )
              .frame(width: Theme.Layout.glyphSlot)
            Text(row.title)
              .font(
                row.kind == .plan ? Theme.TypeScale.sectionLabelStrong : Theme.TypeScale.rowSubtitle
              )
              .foregroundStyle(
                row.destructive ? Theme.Palette.destructive : Theme.Palette.textPrimary)
            Spacer(minLength: Theme.Layout.rowGap)
            if let detail = row.detail {
              Text(detail)
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
            }
            if row.showsChevron {
              Image(systemName: "chevron.right")
                .font(Theme.TypeScale.Glyph.action)
                .foregroundStyle(Theme.Palette.textMuted)
            }
          }
          .padding(.horizontal, Theme.Layout.sectionGap)
          .frame(height: Theme.Metric.accountRowHeight)
          .background(
            RoundedRectangle(cornerRadius: Theme.Layout.selectionRadius, style: .continuous)
              .fill(hovering == row.id ? Theme.Palette.hover : .clear)
              .padding(.horizontal, Theme.Layout.detailGap)
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 ? row.id : (hovering == row.id ? nil : hovering) }
      }
    }
    .animation(Theme.Motion.accountHover, value: hovering)
    .padding(.vertical, Theme.Layout.labelGap)
    .frame(width: Theme.Metric.accountMenuWidth)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .shadow(
      color: Theme.Palette.accountShadow, radius: Theme.Dialog.accountShadowRadius,
      y: Theme.Dialog.accountShadowY)
  }
}
