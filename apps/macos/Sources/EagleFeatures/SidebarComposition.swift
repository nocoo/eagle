import EagleDesign
import Foundation

/// One bot row and the group it is filed under, as the sidebar needs it.
public struct SidebarBotRow: Hashable, Sendable {
  public let groupId: String?
  public let item: SidebarItem

  public init(groupId: String?, item: SidebarItem) {
    self.groupId = groupId
    self.item = item
  }
}

/// What the sidebar shows. Real bots live in the daemon's groups; the sample workspace is
/// only there when the reader asked for it in settings (`加载 Mock 数据`, off by default)
/// and always follows the real sections.
public enum SidebarComposition {
  /// The fixed section that holds every bot the daemon did not file: it cannot be renamed,
  /// reordered or deleted, because it is not a group the person owns.
  public static let ungroupedSectionID = "bots.ungrouped"
  public static let ungroupedTitle = "未分组"
  static let newGroupPrefix = "新分组"

  public static func sections(
    botSections: [SidebarSection],
    mock: [SidebarSection],
    showsMock: Bool
  ) -> [SidebarSection] {
    showsMock ? botSections + mock : botSections
  }

  /// The permanent row above every group, independent of the worker catalog. It is not a
  /// worker Bot and no group, mock setting or catalog event can remove it.
  public static func systemSection(
    title: String = "Super Bot",
    subtitle: String
  ) -> SidebarSection {
    SidebarSection(
      id: "superagent.section",
      title: "",
      items: [
        SidebarItem(
          id: "superagent:main", title: title, subtitle: subtitle,
          tintIndex: 4, pinned: false, unread: false, busy: false)
      ],
      role: .system
    )
  }

  /// A selection that belongs to the sample workspace cannot survive switching it off.
  public static func keepsSelection(
    _ selection: String?,
    mockIDs: Set<String>,
    showsMock: Bool
  ) -> Bool {
    guard let selection else { return false }
    return showsMock || !mockIDs.contains(selection)
  }

  /// A membership that points at a group the catalog does not list reads as ungrouped,
  /// exactly like the daemon (PROTOCOL.md, "Group rules").
  public static func membership(_ groupId: String?, known: Set<String>) -> String? {
    guard let groupId, known.contains(groupId) else { return nil }
    return groupId
  }

  /// One section per group in the daemon's order — an empty group is still the person's to
  /// rename or delete — and one fixed `未分组` section at the end when a bot is unfiled.
  public static func groupSections(
    rows: [SidebarBotRow],
    groups: [SidebarItemGroup],
    collapsed: Set<String> = []
  ) -> [SidebarSection] {
    let known = Set(groups.map(\.id))
    let sections = groups.map { group in
      SidebarSection(
        id: group.id,
        title: group.title,
        isExpanded: !collapsed.contains(group.id),
        items: rows.filter { membership($0.groupId, known: known) == group.id }.map(\.item),
        role: .group
      )
    }
    let ungrouped = rows.filter { membership($0.groupId, known: known) == nil }
    guard !ungrouped.isEmpty else { return sections }
    return sections + [
      SidebarSection(
        id: ungroupedSectionID,
        title: ungroupedTitle,
        isExpanded: !collapsed.contains(ungroupedSectionID),
        items: ungrouped.map(\.item),
        role: .ungrouped
      )
    ]
  }

  /// A default name that is not already taken, so two new groups are told apart.
  public static func newGroupTitle(existing: [String]) -> String {
    let taken = Set(existing)
    guard taken.contains(newGroupPrefix) else { return newGroupPrefix }
    var index = 2
    while taken.contains("\(newGroupPrefix) \(index)") { index += 1 }
    return "\(newGroupPrefix) \(index)"
  }

  /// 上移/下移 is the whole order sent once, so the result is nil when the group is already
  /// at that end (the menu item is disabled) or unknown.
  public static func moved(_ ids: [String], moving id: String, by offset: Int) -> [String]? {
    guard let index = ids.firstIndex(of: id) else { return nil }
    let target = index + offset
    guard target >= 0, target < ids.count, target != index else { return nil }
    var reordered = ids
    reordered.swapAt(index, target)
    return reordered
  }
}
