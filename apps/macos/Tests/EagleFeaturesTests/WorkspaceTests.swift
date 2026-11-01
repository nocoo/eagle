import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Mock workspace")
struct MockWorkspaceTests {
  @Test("groups are populated with unique ids")
  func groups() {
    let groups = MockWorkspace.groups
    #expect(!groups.isEmpty)
    #expect(groups.allSatisfy { !$0.items.isEmpty })
    let ids = groups.flatMap(\.items).map(\.id)
    #expect(Set(ids).count == ids.count)
  }

  @Test("items carry a subtitle and a valid tint")
  func items() {
    for item in MockWorkspace.groups.flatMap(\.items) {
      #expect(!item.title.isEmpty)
      #expect(!item.subtitle.isEmpty)
      #expect((0..<Theme.Palette.avatarTints.count).contains(item.tintIndex))
    }
  }

  @Test("the transcript covers assistant, note and user rows")
  func transcript() {
    let entries = MockWorkspace.botTranscript
    #expect(entries.contains { if case .assistant = $0 { true } else { false } })
    #expect(entries.contains { if case .user = $0 { true } else { false } })
    #expect(entries.contains { if case .note = $0 { true } else { false } })
    #expect(Set(entries.map(\.id)).count == entries.count)
  }

  @Test("inspector fixtures are deep")
  func inspector() {
    #expect(MockWorkspace.pulls.count >= 2)
    #expect(MockWorkspace.pulls.allSatisfy { !$0.title.isEmpty && $0.url.hasPrefix("https://") })
  }
}

@Suite("Workspace list")
struct WorkspaceListTests {
  @Test("selection resolves the sidebar item")
  func selection() {
    let model = WorkspaceListViewModel()
    model.select("knowledge")
    #expect(model.selection == "knowledge")
    #expect(model.selectedItem?.title == "知识库")
    model.select("missing")
    #expect(model.selectedItem == nil)
  }

  @Test("sections mirror the expansion set")
  func expansion() {
    let model = WorkspaceListViewModel()
    #expect(model.sections.allSatisfy { $0.isExpanded })
    model.toggleSection("review")
    #expect(model.sections.first { $0.id == "review" }?.isExpanded == false)
    model.toggleSection("review")
    #expect(model.sections.first { $0.id == "review" }?.isExpanded == true)
  }

  @Test("groups can be created, renamed and deleted")
  func groupCRUD() throws {
    let model = WorkspaceListViewModel()
    let initial = model.groups.count

    model.createSection()
    #expect(model.groups.count == initial + 1)
    let created = try #require(model.groups.last)
    #expect(created.title.hasPrefix("新分组"))
    #expect(model.sections.contains { $0.id == created.id && $0.isExpanded })

    model.renameSection(created.id, to: "  运维夜班  ")
    #expect(model.groups.last?.title == "运维夜班")
    model.renameSection(created.id, to: "   ")
    #expect(model.groups.last?.title == "运维夜班")

    model.deleteSection(created.id)
    #expect(model.groups.count == initial)
  }

  @Test("deleting a group moves the selection to another conversation")
  func deleteSelectedGroup() throws {
    let model = WorkspaceListViewModel()
    let group = try #require(model.groups.first { $0.items.contains { $0.id == model.selection } })
    model.deleteSection(group.id)
    #expect(model.selection != nil)
    #expect(model.selectedItem != nil)
    #expect(model.sections.contains { $0.id == group.id } == false)
  }

  @Test("conversations can be renamed and deleted")
  func itemCRUD() {
    let model = WorkspaceListViewModel()
    let before = model.groups.flatMap(\.items).count

    model.renameItem("deps", to: "  依赖修复专家 A  ")
    let renamed = model.groups.flatMap(\.items).first { $0.id == "deps" }
    #expect(renamed?.title == "依赖修复专家 A")
    #expect(renamed?.tag == "GitHub")
    model.renameItem("deps", to: "")
    #expect(model.groups.flatMap(\.items).first { $0.id == "deps" }?.title == "依赖修复专家 A")

    model.deleteItem("deps")
    #expect(model.groups.flatMap(\.items).count == before - 1)
    #expect(model.selection != "deps")
    #expect(model.selectedItem != nil)
  }

  @Test("unknown identifiers are ignored")
  func unknownIdentifiers() {
    let model = WorkspaceListViewModel()
    let snapshot = model.groups
    model.renameSection("nope", to: "x")
    model.deleteSection("nope")
    model.renameItem("nope", to: "x")
    model.deleteItem("nope")
    model.moveItem("nope", to: "secretariat")
    #expect(model.groups == snapshot)
  }

  /// The section that owns a row; the demo list keeps this out of its public surface.
  private func group(holding id: String, in model: WorkspaceListViewModel) -> String? {
    model.groups.first { $0.items.contains { $0.id == id } }?.id
  }

  @Test("moveItem relocates a row to the end of another group")
  func moveItem() throws {
    let model = WorkspaceListViewModel(selection: "deps")
    let source = try #require(group(holding: "deps", in: model))
    let target = try #require(model.groups.first { $0.id != source }?.id)
    let targetCount = try #require(model.groups.first { $0.id == target }?.items.count)
    model.moveItem("deps", to: target)
    #expect(group(holding: "deps", in: model) == target)
    #expect(model.groups.first { $0.id == source }?.items.contains { $0.id == "deps" } == false)
    #expect(model.groups.first { $0.id == target }?.items.count == targetCount + 1)
    #expect(model.groups.first { $0.id == target }?.items.last?.id == "deps")
    #expect(model.selection == "deps")
  }

  @Test("moveItem ignores same-group and unknown targets")
  func moveItemNoOps() throws {
    let model = WorkspaceListViewModel()
    let home = try #require(group(holding: "deps", in: model))
    let snapshot = model.groups
    model.moveItem("deps", to: home)
    #expect(model.groups == snapshot)
    model.moveItem("deps", to: "missing-group")
    #expect(model.groups == snapshot)
  }
}

@Suite("Chat")
struct ChatTests {
  @Test("send appends a user turn, waits for an answer and clears the draft")
  func send() {
    let model = BotChatViewModel(entries: [])
    #expect(model.waiting)
    model.draft = "  今天 eagle 会修吗  "
    model.send()

    #expect(model.entries.count == 1)
    #expect(model.entries[0].id == "local-0")
    if case .user(_, let text, _) = model.entries[0] {
      #expect(text == "今天 eagle 会修吗")
    } else {
      Issue.record("expected a user turn")
    }
    #expect(model.waiting)
    #expect(model.draft.isEmpty)
    #expect(model.sentCount == 1)
  }

  @Test("blank drafts do not send")
  func blank() {
    let model = BotChatViewModel(entries: [])
    model.draft = "  \n "
    model.send()
    #expect(model.entries.isEmpty)
    #expect(model.sentCount == 0)
  }

  @Test("repeated sends keep identifiers unique")
  func uniqueIdentifiers() {
    let model = BotChatViewModel(entries: [])
    for text in ["一", "二", "三"] {
      model.draft = text
      model.send()
    }
    let ids = model.entries.map(\.id)
    #expect(Set(ids).count == ids.count)
    #expect(model.sentCount == 3)
  }
}

@Suite("Inspector")
struct InspectorTests {
  @Test("the detail tab is the default")
  func defaultTab() {
    #expect(InspectorViewModel().tab == .detail)
  }
}

@Suite("Shell layout")
struct ShellLayoutTests {
  @Test("widths resize and clamp")
  func widths() {
    let layout = ShellLayoutViewModel()
    let wider = Theme.Metric.sidebarWidth + 40
    layout.setSidebarWidth(wider)
    #expect(abs(layout.sidebarWidth - wider) < 0.001)
    layout.setSidebarWidth(-1000)
    #expect(abs(layout.sidebarWidth - Theme.Metric.sidebarMinWidth) < 0.001)
    layout.setSidebarWidth(10_000)
    #expect(abs(layout.sidebarWidth - Theme.Metric.sidebarMaxWidth) < 0.001)

    let widerInspector = Theme.Metric.inspectorWidth + 30
    layout.setInspectorWidth(widerInspector)
    #expect(abs(layout.inspectorWidth - widerInspector) < 0.001)
    layout.setInspectorWidth(10_000)
    #expect(abs(layout.inspectorWidth - Theme.Metric.inspectorMaxWidth) < 0.001)
    layout.setInspectorWidth(0)
    #expect(abs(layout.inspectorWidth - Theme.Metric.inspectorMinWidth) < 0.001)
  }

  @Test("columns collapse and return")
  func collapse() {
    let layout = ShellLayoutViewModel()
    #expect(layout.showsSidebar)
    layout.toggleSidebar()
    #expect(layout.showsSidebar == false)
    layout.toggleSidebar()
    #expect(layout.showsSidebar)
    layout.toggleInspector()
    #expect(layout.showsInspector == false)
    layout.toggleInspector()
    #expect(layout.showsInspector)
  }
}
