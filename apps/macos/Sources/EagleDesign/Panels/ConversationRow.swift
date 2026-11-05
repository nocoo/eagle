import SwiftUI

/// One conversation row on the 20 / 34 / 58 grid measured from the reference:
/// 20 pt inset, 34 pt avatar, 58 pt pitch, text at 65 pt.
public struct ConversationRow: View {
  private let item: SidebarItem
  private let selected: Bool
  @State private var hovering = false

  public init(item: SidebarItem, selected: Bool) {
    self.item = item
    self.selected = selected
  }

  public var body: some View {
    HStack(spacing: Theme.Metric.rowAvatarGap) {
      if let face = item.face {
        if item.busy {
          BusyFace { BotFace(style: face, size: Theme.Metric.avatarRow) }
        } else {
          BotFace(style: face, size: Theme.Metric.avatarRow)
        }
      } else {
        Avatar(
          initial: String(item.title.prefix(1)),
          tint: Theme.Palette.avatarTint(item.tintIndex),
          size: Theme.Metric.avatarRow
        )
      }
      VStack(alignment: .leading, spacing: Theme.Sidebar.rowTextGap) {
        HStack(spacing: Theme.Sidebar.rowMetaGap) {
          Text(item.title)
            .font(Theme.TypeScale.rowTitle)
            .foregroundStyle(Theme.Palette.textPrimary)
            .lineLimit(1)
          if let tag = item.tag {
            Tag(tag)
          }
          if item.pinned {
            Image(systemName: "pin.fill")
              .font(Theme.TypeScale.Glyph.pin)
              .foregroundStyle(Theme.Palette.textMuted)
          }
        }
        Text(item.subtitle)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textMuted)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 0)
      if item.unread {
        Circle()
          .fill(Theme.Palette.accent)
          .frame(width: Theme.Sidebar.unreadDot, height: Theme.Sidebar.unreadDot)
      }
    }
    .padding(.leading, Theme.Metric.rowContentInset)
    .padding(.trailing, Theme.Metric.rowContentInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(height: Theme.Metric.rowHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(selected ? Theme.Palette.selection : (hovering ? Theme.Palette.hover : .clear))
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .strokeBorder(selected ? Theme.Palette.line : .clear, lineWidth: Theme.Metric.hairline)
    )
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .animation(Theme.Motion.hover, value: hovering)
    .animation(Theme.Motion.rowSelection, value: selected)
    .accessibilityElement(children: .combine)
  }
}
