import AppKit
import EagleDesign
import SwiftUI

/// View-only sidebar state that belongs to neither the daemon nor the demo data:
/// pinned order, unread marks and hidden rows. It is keyed by row id, so it works the
/// same for a daemon bot and a demo bot.
@MainActor
final class SidebarChromeViewModel: ObservableObject {
  @Published private(set) var pinned: Set<String> = []
  @Published private(set) var unread: Set<String> = []
  @Published private(set) var hidden: Set<String> = []

  func togglePin(_ id: String) {
    if pinned.contains(id) { pinned.remove(id) } else { pinned.insert(id) }
  }

  func markUnread(_ id: String) {
    unread.insert(id)
  }

  func markRead(_ id: String) {
    unread.remove(id)
  }

  func hide(_ id: String) {
    hidden.insert(id)
  }

  func copyId(_ id: String) {
    let board = NSPasteboard.general
    board.clearContents()
    board.setString(id, forType: .string)
  }

  /// Applies the view state to a section: hidden rows drop out, pinned rows sort first.
  func decorate(_ section: SidebarSection) -> SidebarSection {
    let visible = section.items
      .filter { !hidden.contains($0.id) }
      .map { item in
        SidebarItem(
          id: item.id,
          title: item.title,
          subtitle: item.subtitle,
          tag: item.tag,
          tintIndex: item.tintIndex,
          face: item.face,
          pinned: pinned.contains(item.id),
          unread: unread.contains(item.id),
          busy: item.busy
        )
      }
    let ordered = visible.filter(\.pinned) + visible.filter { !$0.pinned }
    return SidebarSection(
      id: section.id,
      title: section.title,
      isExpanded: section.isExpanded,
      items: ordered,
      role: section.role
    )
  }
}
