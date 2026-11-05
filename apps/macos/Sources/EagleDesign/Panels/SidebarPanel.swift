import SwiftUI

/// Left column on the reference grid: traffic lights and the toolbar in the window's top corner,
/// then the list, 58 pt rows, unread pill at 28 pt and a 62 pt user card.
public struct SidebarPanel: View {
  private let sections: [SidebarSection]
  private let selection: String?
  private let onSelect: (String) -> Void
  private let onToggleSection: (String) -> Void
  private let onRenameSection: (String, String) -> Void
  private let onDeleteSection: (String) -> Void
  private let onCreateSection: () -> Void
  private let onCreateGroup: () -> Void
  private let onCreateBot: () -> Void
  private let canCreateBot: Bool
  private let onRenameItem: (String, String) -> Void
  private let onDeleteItem: (String) -> Void
  private let onSearch: () -> Void
  private let onCollapse: () -> Void
  private let onAccount: () -> Void
  private let onGallery: () -> Void
  private let unreadCount: Int
  private let onUnread: () -> Void
  /// The product's own name and version, lowercase as the brand writes them.
  private let userName: String
  private let productVersion: String
  private let onPinItem: (String) -> Void
  private let moveTargets: (String) -> [SidebarItemGroup]
  private let onMoveItem: (String, String?) -> Void
  private let onMarkUnread: (String) -> Void
  private let onCopyId: (String) -> Void
  private let onHideItem: (String) -> Void
  private let onMoveGroup: (String, Int) -> Void

  @State private var editingSection: String?
  @State private var editingItem: String?
  @State private var draftTitle = ""
  @State private var hoveringSection: String?

  public init(
    sections: [SidebarSection],
    selection: String?,
    onSelect: @escaping (String) -> Void,
    onToggleSection: @escaping (String) -> Void = { _ in },
    onRenameSection: @escaping (String, String) -> Void = { _, _ in },
    onDeleteSection: @escaping (String) -> Void = { _ in },
    onCreateSection: @escaping () -> Void = {},
    onCreateGroup: @escaping () -> Void = {},
    onCreateBot: @escaping () -> Void = {},
    canCreateBot: Bool = true,
    onRenameItem: @escaping (String, String) -> Void = { _, _ in },
    onDeleteItem: @escaping (String) -> Void = { _ in },
    onSearch: @escaping () -> Void = {},
    onCollapse: @escaping () -> Void = {},
    onAccount: @escaping () -> Void = {},
    onGallery: @escaping () -> Void = {},
    unreadCount: Int = 0,
    onUnread: @escaping () -> Void = {},
    userName: String = "eagle",
    productVersion: String = "",
    onPinItem: @escaping (String) -> Void = { _ in },
    moveTargets: @escaping (String) -> [SidebarItemGroup] = { _ in [] },

    onMoveItem: @escaping (String, String?) -> Void = { _, _ in },
    onMarkUnread: @escaping (String) -> Void = { _ in },
    onCopyId: @escaping (String) -> Void = { _ in },
    onHideItem: @escaping (String) -> Void = { _ in },
    onMoveGroup: @escaping (String, Int) -> Void = { _, _ in }
  ) {
    self.sections = sections
    self.selection = selection
    self.onSelect = onSelect
    self.onToggleSection = onToggleSection
    self.onRenameSection = onRenameSection
    self.onDeleteSection = onDeleteSection
    self.onCreateSection = onCreateSection
    self.onCreateGroup = onCreateGroup
    self.onCreateBot = onCreateBot
    self.canCreateBot = canCreateBot
    self.onRenameItem = onRenameItem
    self.onDeleteItem = onDeleteItem
    self.onSearch = onSearch
    self.onCollapse = onCollapse
    self.onAccount = onAccount
    self.onGallery = onGallery
    self.unreadCount = unreadCount
    self.onUnread = onUnread
    self.userName = userName
    self.productVersion = productVersion
    self.onPinItem = onPinItem
    self.moveTargets = moveTargets
    self.onMoveItem = onMoveItem
    self.onMarkUnread = onMarkUnread
    self.onCopyId = onCopyId
    self.onHideItem = onHideItem
    self.onMoveGroup = onMoveGroup
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      list
      footer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.canvas)
  }

  /// The toolbar shares the window's top corner with the traffic lights. The list follows it, so
  /// the panel's first section sits one content inset under the controls rather than on the
  /// three-column grid the other panels use.
  private var header: some View {
    HStack(spacing: Theme.Sidebar.headerGap) {
      Spacer(minLength: 0)
      toolbar
    }
    .frame(height: Theme.Metric.headerControlHeight, alignment: .top)
    .padding(.horizontal, Theme.Metric.contentInset)
    // The list below would paint over the controls' shadows without this room.
    .padding(.bottom, Theme.Metric.roundShadowBleed)
    .padding(.top, Theme.Metric.headerTopInset)
  }

  private var toolbar: some View {
    // One spacing for every header group, so the circle rhythm matches the reference.
    HStack(spacing: Theme.Metric.headerControlGap) {
      IconButton(
        systemName: "magnifyingglass",
        label: "搜索",
        size: Theme.Metric.headerControlHeight,
        style: .circled,
        action: onSearch
      )
      MenuIconButton(
        systemName: "plus",
        label: "新建",
        size: Theme.Metric.headerControlHeight
      ) {
        Button(action: onCreateBot) {
          Label("新建 Bot", systemImage: "person.badge.plus")
        }
        .disabled(!canCreateBot)
        Button(action: onCreateGroup) {
          Label("新建分组", systemImage: "folder.badge.plus")
        }
        .disabled(!canCreateBot)
      }
      IconButton(
        systemName: "sidebar.left",
        label: "收起侧栏",
        size: Theme.Metric.headerControlHeight,
        style: .circled,
        action: onCollapse
      )
    }
  }

  private var list: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
            block(section, isFirst: index == 0)
          }
        }
        .padding(.horizontal, Theme.Metric.listCardInset)
        .padding(.top, Theme.Metric.contentInset)
        .padding(.bottom, Theme.Sidebar.listBottomInset)
      }
      .scrollIndicators(.never)
      .scrollEdgeFades(
        Theme.Palette.canvas, top: Theme.Metric.edgeFadeHeight, bottom: Theme.Metric.edgeFadeHeight
      )
      .overlay(alignment: .bottom) { unreadPill }
      .onChange(of: selection) {
        guard let selection else { return }
        withAnimation(Theme.Motion.selection) {
          proxy.scrollTo(selection, anchor: .center)
        }
      }
    }
  }

  /// A section and its rows: one drop target, so a bot can be filed by dropping it on the
  /// header or anywhere inside the group.
  @ViewBuilder
  private func block(_ section: SidebarSection, isFirst: Bool) -> some View {
    VStack(alignment: .leading, spacing: Theme.Sidebar.blockGap) {
      sectionHeader(section, isFirst: isFirst)
      if section.isExpanded {
        ForEach(section.items) { item in
          row(item)
            .transition(.opacity)
        }
      }
    }
    .padding(.vertical, Theme.Sidebar.blockVerticalInset)
    .animation(Theme.Motion.sectionExpansion, value: section.isExpanded)
  }

  @ViewBuilder
  private func sectionHeader(_ section: SidebarSection, isFirst: Bool) -> some View {
    if section.role == .ungrouped {
      sectionHeaderContent(section, isFirst: isFirst)
    } else {
      sectionHeaderContent(section, isFirst: isFirst)
        .contextMenu { sectionMenu(section) }
    }
  }

  private func sectionHeaderContent(_ section: SidebarSection, isFirst: Bool) -> some View {
    HStack(spacing: Theme.Sidebar.groupContentGap) {
      Button {
        withAnimation(Theme.Motion.disclosure) { onToggleSection(section.id) }
      } label: {
        HStack(spacing: Theme.Sidebar.disclosureGap) {
          Image(systemName: "chevron.right")
            .font(Theme.TypeScale.Glyph.groupChevron)
            .foregroundStyle(Theme.Palette.disclosure)
            .rotationEffect(.degrees(section.isExpanded ? Theme.Sidebar.disclosureAngle : 0))
            // The collapse control is always visible: a group's state should be readable
            // without hovering.
            .opacity(
              section.isExpanded
                ? Theme.Sidebar.expandedDisclosureOpacity : Theme.Sidebar.collapsedDisclosureOpacity
            )
            .frame(width: Theme.Sidebar.disclosureWidth)
          if editingSection == section.id {
            TextField("", text: $draftTitle)
              .textFieldStyle(.plain)
              .font(Theme.TypeScale.sectionLabel)
              .foregroundStyle(Theme.Palette.textPrimary)
              .onSubmit { commitSectionRename(section.id) }
          } else {
            SectionLabel(section.title, unreadCount: section.unreadCount)
          }
        }
      }
      .buttonStyle(.plain)
      Spacer(minLength: 0)
    }
    .padding(.leading, Theme.Metric.rowContentInset)
    .padding(.trailing, Theme.Metric.rowContentInset)
    .frame(height: Theme.Metric.sectionHeaderHeight, alignment: .top)
    .padding(.top, isFirst ? 0 : Theme.Metric.sectionGap)
    .onHover { hoveringSection = $0 ? section.id : nil }
    .animation(Theme.Motion.hover, value: section.isExpanded)
    .animation(Theme.Motion.hover, value: hoveringSection)
  }

  /// The section menu is what a group can be: a sample section is client-only, a daemon
  /// group is renamed, reordered and deleted, and 未分组 has no menu at all.
  @ViewBuilder
  private func sectionMenu(_ section: SidebarSection) -> some View {
    Button {
      beginSectionRename(section)
    } label: {
      Label("重命名", systemImage: "pencil")
    }
    if section.role == .group {
      let groups = sections.filter { $0.role == .group }
      let index = groups.firstIndex { $0.id == section.id } ?? 0
      Button(action: onCreateGroup) {
        Label("新建分组", systemImage: "folder.badge.plus")
      }
      Divider()
      Button {
        onMoveGroup(section.id, -1)
      } label: {
        Label("上移", systemImage: "arrow.up")
      }
      .disabled(index == 0)
      Button {
        onMoveGroup(section.id, 1)
      } label: {
        Label("下移", systemImage: "arrow.down")
      }
      .disabled(index >= groups.count - 1)
      Divider()
    } else {
      Button(action: onCreateSection) {
        Label("新建分组", systemImage: "folder.badge.plus")
      }
      Divider()
    }
    if let reason = section.deleteBlockedReason {
      Button("删除分组（\(reason)）") {}
        .disabled(true)
    } else {
      Button("删除分组", role: .destructive) { onDeleteSection(section.id) }
    }
  }

  @ViewBuilder
  private func row(_ item: SidebarItem) -> some View {
    selectableRow(item).id(item.id)
  }

  @ViewBuilder
  private func selectableRow(_ item: SidebarItem) -> some View {
    Button {
      withAnimation(Theme.Motion.selection) { onSelect(item.id) }
    } label: {
      if editingItem == item.id {
        TextField("", text: $draftTitle)
          .textFieldStyle(.plain)
          .font(Theme.TypeScale.rowTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
          .padding(.leading, Theme.Metric.contentInset)
          .frame(height: Theme.Metric.rowHeight)
          .background(
            RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
              .fill(Theme.Palette.card)
          )
          .onSubmit { commitItemRename(item.id) }
      } else {
        ConversationRow(item: item, selected: item.id == selection)
      }
    }
    .buttonStyle(.plain)
    .contextMenu { itemMenu(item) }
  }

  @ViewBuilder
  private func itemMenu(_ item: SidebarItem) -> some View {
    Button {
      onPinItem(item.id)
    } label: {
      Label("置顶", systemImage: "pin")
    }
    let targets = moveTargets(item.id)
    if !targets.isEmpty {
      Menu {
        ForEach(targets) { group in
          Button {
            onMoveItem(item.id, group.id)
          } label: {
            Label(group.title, systemImage: "folder")
          }
        }
      } label: {
        Label("移至", systemImage: "folder")
      }
    }
    Button {
      onMarkUnread(item.id)
    } label: {
      Label("标为未读", systemImage: "bell.slash")
    }
    Divider()
    Button {
      beginItemRename(item)
    } label: {
      Label("重命名 Bot", systemImage: "pencil")
    }
    Divider()
    Button {
      onCopyId(item.id)
    } label: {
      Label("复制对话 ID", systemImage: "doc.on.doc")
    }
    Divider()
    Button {
      onHideItem(item.id)
    } label: {
      Label("从侧边栏隐藏", systemImage: "eye.slash")
    }
    Button(role: .destructive) {
      onDeleteItem(item.id)
    } label: {
      Label("删除", systemImage: "trash")
    }
  }

  @ViewBuilder
  private var unreadPill: some View {
    if unreadCount > 0 {
      Button(action: onUnread) {
        HStack(spacing: Theme.Sidebar.unreadContentGap) {
          Circle()
            .fill(Theme.Palette.unreadHighlight)
            .frame(
              width: Theme.Sidebar.unreadHighlightSize, height: Theme.Sidebar.unreadHighlightSize
            )
            .overlay {
              Image(systemName: "chevron.down")
                .font(Theme.TypeScale.Glyph.unreadChevron)
                .foregroundStyle(Theme.Palette.onColor)
            }
          Text("更多未读消息")
            .font(Theme.TypeScale.activity)
            .foregroundStyle(Theme.Palette.onColor)
        }
        .padding(.horizontal, Theme.Sidebar.unreadHorizontalInset)
        .frame(height: Theme.Metric.unreadPillHeight)
        .background(Capsule().fill(Theme.Palette.unreadFill))
        .shadow(
          color: Theme.Palette.unreadShadow, radius: Theme.Sidebar.unreadShadowRadius,
          y: Theme.Sidebar.unreadShadowY)
      }
      .buttonStyle(.plain)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.bottom, Theme.Metric.unreadPillBottom)
    }
  }

  /// No card and no border: the avatar lines up with the list avatars at the
  /// shared 20 pt content inset.
  @ViewBuilder private var productMark: some View {
    if let icon = EagleIcon.image {
      Image(nsImage: icon)
        .resizable()
        .interpolation(.high)
        .frame(width: Theme.Metric.avatarRow, height: Theme.Metric.avatarRow)
        .clipShape(
          RoundedRectangle(
            cornerRadius: Theme.Metric.productMarkRadius, style: .continuous)
        )
    } else {
      Avatar(initial: "e", tint: Theme.Palette.productFallback, size: Theme.Metric.avatarRow)
    }
  }

  private var footer: some View {
    HStack(spacing: Theme.Metric.rowAvatarGap) {
      Button(action: onAccount) {
        HStack(spacing: Theme.Metric.rowAvatarGap) {
          productMark
          VStack(alignment: .leading, spacing: Theme.Layout.microGap) {
            Text(userName)
              .font(Theme.TypeScale.rowTitle)
              .foregroundStyle(Theme.Palette.textPrimary)
              .lineLimit(1)
            if !productVersion.isEmpty {
              Text(productVersion)
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
                .lineLimit(1)
                .help(productVersion)
            }
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("eagle \(productVersion)，账户与设置")
      Spacer(minLength: 0)
      HStack(spacing: Theme.Metric.headerControlGap) {
        IconButton(
          systemName: "gearshape", label: "设置",
          size: Theme.Metric.headerControlHeight,
          style: .circled,
          action: onAccount
        )
        IconButton(
          systemName: "square.grid.2x2", label: "Eagle 模板库",
          size: Theme.Metric.headerControlHeight,
          style: .circled, action: onGallery
        )
      }
    }
    .padding(.leading, Theme.Metric.contentInset)
    .padding(.trailing, Theme.Metric.contentInset)
    .frame(height: Theme.Metric.footerHeight)
    .padding(.bottom, Theme.Metric.footerBottom)
  }

  private func beginSectionRename(_ section: SidebarSection) {
    draftTitle = section.title
    editingSection = section.id
  }

  private func commitSectionRename(_ id: String) {
    let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    editingSection = nil
    guard !title.isEmpty else { return }
    onRenameSection(id, title)
  }

  private func beginItemRename(_ item: SidebarItem) {
    draftTitle = item.title
    editingItem = item.id
  }

  private func commitItemRename(_ id: String) {
    let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    editingItem = nil
    guard !title.isEmpty else { return }
    onRenameItem(id, title)
  }
}
