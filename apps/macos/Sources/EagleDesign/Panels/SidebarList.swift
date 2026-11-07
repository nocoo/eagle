import SwiftUI

/// Presentation data for the left column. Deliberately dumb: the feature layer
/// owns the groups and maps them onto these sections.
/// A row's trailing switch: one click, no menu. A sidebar row that has one reserves the
/// space so its title truncates instead of sliding under it.
public struct SidebarItem: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let subtitle: String
  public let tag: String?
  public let tintIndex: Int
  /// A bot draws its own face instead of the circled initial.
  public let face: BotFace.Style?
  /// Pinned rows sort first and show a pin next to the title.
  public let pinned: Bool
  /// Unread rows carry the accent dot at the trailing edge.
  public let unread: Bool
  /// A bot that is answering: its face turns slowly instead of wearing a "working" tag.
  public let busy: Bool

  public init(
    id: String,
    title: String,
    subtitle: String,
    tag: String? = nil,
    tintIndex: Int = 0,
    face: BotFace.Style? = nil,
    pinned: Bool = false,
    unread: Bool = false,
    busy: Bool = false
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.tag = tag
    self.tintIndex = tintIndex
    self.face = face
    self.pinned = pinned
    self.unread = unread
    self.busy = busy
  }
}

public struct SidebarSection: Identifiable, Hashable, Sendable {
  /// What the section is, because the menu and the drop target differ: a daemon group is
  /// renamed, reordered and deleted; 未分组 is fixed; the sample workspace is client-only.
  public enum Role: Hashable, Sendable {
    case sample
    case group
    case ungrouped
    /// The permanent Super Bot: one row, no rename, move, hide or delete.
    case system
  }

  public let id: String
  public let title: String
  public var unreadCount: Int { items.filter(\.unread).count }
  public let isExpanded: Bool
  public let items: [SidebarItem]
  public let role: Role

  public init(
    id: String,
    title: String,
    isExpanded: Bool = true,
    items: [SidebarItem],
    role: Role = .sample
  ) {
    self.id = id
    self.title = title
    self.isExpanded = isExpanded
    self.items = items
    self.role = role
  }

  /// Why this section's delete item is disabled, or nil when it can be deleted. Emptying a
  /// group is the person's decision, not a side effect of deleting the folder.
  public var deleteBlockedReason: String? {
    switch role {
    case .sample:
      return nil
    case .ungrouped:
      return "未分组不能删除"
    case .group:
      return items.isEmpty ? nil : "组内还有 \(items.count) 个 Bot，先移走再删除"
    case .system:
      return "系统 Bot 不能删除"
    }
  }
}

/// One group a row can be moved to (the context menu's submenu).
public struct SidebarItemGroup: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}
