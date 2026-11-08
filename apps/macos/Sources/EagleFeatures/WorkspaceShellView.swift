import AppKit
import EagleDesign
import SwiftUI

/// Composes the three columns with their view models. This is the only place
/// where design components and feature state meet.
public struct WorkspaceShellView: View {
  @StateObject private var list: WorkspaceListViewModel
  @StateObject private var chat: BotChatViewModel
  @StateObject private var inspector: InspectorViewModel
  @StateObject private var layout: ShellLayoutViewModel
  @StateObject private var settings = SettingsViewModel()
  @StateObject private var daemon = BotsDaemonSupervisor.shared
  @StateObject private var devices = DeviceSettingsViewModel.shared
  @StateObject private var bots = BotsWorkspaceViewModel()
  @StateObject private var superagent = SuperagentWorkspaceViewModel()
  @StateObject private var chrome = SidebarChromeViewModel()
  /// The dialog the shell itself raised; a peer exchange reads from its transcript instead.
  @State private var dialogs = WorkspaceDialogState()
  /// The sample exchange a person opened from a folded row.
  @State private var openedSampleExchange: PeerExchange?
  /// Bumped on every dismissal so the composer takes the keyboard back.
  @State private var focusRestore = 0
  @AppStorage("eagle.hideToolCalls") private var hideToolCalls = false
  @AppStorage("eagle.loadMockData") private var loadMockData = false
  private let onShowGallery: (@escaping () -> Void) -> Void

  public init(
    list: WorkspaceListViewModel = WorkspaceListViewModel(),
    chat: BotChatViewModel = BotChatViewModel(),
    inspector: InspectorViewModel = InspectorViewModel(),
    layout: ShellLayoutViewModel = ShellLayoutViewModel(),
    onShowGallery: @escaping (@escaping () -> Void) -> Void = { _ in }
  ) {
    _list = StateObject(wrappedValue: list)
    _chat = StateObject(wrappedValue: chat)
    _inspector = StateObject(wrappedValue: inspector)
    _layout = StateObject(wrappedValue: layout)
    self.onShowGallery = onShowGallery
  }

  private var sidebarSections: [SidebarSection] {
    var sections = SidebarComposition.sections(
      botSections: bots.sections,
      mock: list.sections,
      showsMock: loadMockData
    )
    .map(chrome.decorate)
    sections.insert(
      SidebarComposition.systemSection(subtitle: superagent.statusLine), at: 0)
    return sections
  }

  /// The Super Bot is selected by a source-qualified id: no worker Bot can claim it.
  private var selectedIsSuperagent: Bool {
    list.selection == SuperagentWorkspaceViewModel.selectionID
  }

  /// Identifiers that belong to the sample workspace, so switching it off drops them.
  private var mockIDs: Set<String> {
    Set(list.groups.flatMap(\.items).map(\.id))
  }

  /// The one dialog on screen. A peer exchange is read from whichever transcript opened it,
  /// so it can never stack with a dialog the shell is already showing.
  private var activeDialog: WorkspaceDialog? {
    if dialogs.active == nil,
      let exchange = openedSampleExchange ?? bots.openedExchange
    {
      return .peer(exchange)
    }
    return dialogs.active
  }

  /// Opening is refused while something is already up: one dialog owns the window. Taking
  /// the window also drops a peer read that has not landed yet.
  private func present(_ dialog: WorkspaceDialog) {
    guard activeDialog == nil else { return }
    bots.cancelPeerRead()
    dialogs.present(dialog)
  }

  /// Every dialog leaves the same way, so a pending exchange never surfaces after it.
  private func closeDialog() {
    openedSampleExchange = nil
    bots.closeExchange()
    dialogs.dismiss()
    focusRestore += 1
  }

  private func dropSampleSelectionIfHidden() {
    guard
      !SidebarComposition.keepsSelection(list.selection, mockIDs: mockIDs, showsMock: loadMockData)
    else { return }
    list.selection = nil
  }

  private var moveGroups: [SidebarItemGroup] {
    list.groups.map { SidebarItemGroup(id: $0.id, title: $0.title) }
  }

  /// A real bot moves between the daemon's groups (plus 未分组); a sample row moves between
  /// the sample groups.
  private func moveTargets(for id: String) -> [SidebarItemGroup] {
    guard bots.owns(id) else { return moveGroups }
    var targets = bots.groups.map { SidebarItemGroup(id: $0.id, title: $0.title) }
    // A grouped bot can always be unfiled, even while no 未分组 section is on screen yet.
    if bots.groupId(of: id) != nil {
      targets.append(
        SidebarItemGroup(id: SidebarComposition.ungroupedSectionID, title: "未分组"))
    }
    return targets
  }

  private func moveItem(_ id: String, to groupId: String?) {
    guard bots.owns(id) else { return }
    let target = groupId == SidebarComposition.ungroupedSectionID ? nil : groupId
    Task { await bots.moveBot(id, toGroup: target) }
  }

  private func selectAfterHide(_ id: String) {
    guard list.selection == id else { return }
    guard let next = sidebarSections.flatMap(\.items).first?.id else {
      list.selection = nil
      return
    }
    // Hiding the open bot must move the conversation too, not only the sidebar's
    // highlight.
    if next == SuperagentWorkspaceViewModel.selectionID {
      list.selection = next
      Task { await superagent.start() }
    } else if bots.owns(next) {
      bots.select(next)
    } else {
      list.selection = next
    }
  }

  private var selectedIsBot: Bool { bots.owns(list.selection) }

  /// The inspector belongs to an open conversation: with nothing selected there is nothing to
  /// inspect, so the column (and its drag handle) stay away instead of showing an empty panel.
  private var showsInspector: Bool {
    layout.showsInspector && list.selection != nil
      && list.selection != SuperagentWorkspaceViewModel.selectionID
  }

  /// The sample transcript carries its own exchanges, so opening one only needs the entry that
  /// holds it. A bot's exchanges will be read from the daemon by id.
  private func openPeerExchange(_ id: String) {
    guard activeDialog == nil else { return }
    for case .peerExchange(_, let exchange) in chat.entries where exchange.id == id {
      openedSampleExchange = exchange
      return
    }
  }

  /// The conversation a tool run would belong to right now: its bot, or the sample workspace.
  private var conversationOwner: ToolRunOwner {
    selectedIsBot ? .bot(id: bots.selectedId ?? "") : .sample
  }

  /// A tool detail is bound to the transcript that opened it; when the conversation moves on,
  /// the dialog closes instead of showing another bot's rows under the old entry id.
  private func closeStaleToolRun() {
    guard let dialog = dialogs.active, !dialog.belongs(to: conversationOwner) else { return }
    closeDialog()
  }

  private func openBotExchange(_ id: String) {
    guard activeDialog == nil else { return }
    Task { await bots.openExchange(id) }
  }

  /// The sample transcript is only reachable while the sample data is switched on.
  private var selectedIsMock: Bool {
    loadMockData && list.selection != nil && !selectedIsBot
  }

  public var body: some View {
    GeometryReader { viewport in
      ModalWorkspace(
        showsDialog: activeDialog != nil,
        workspace: { workspace(in: viewport.size) },
        dialog: { dialogLayer(in: viewport.size) }
      )
    }
  }

  @ViewBuilder private func dialogLayer(in available: CGSize) -> some View {
    if let dialog = activeDialog {
      WorkspaceDialogHost(
        dialog: dialog,
        available: available,
        peerInsets: EdgeInsets(
          top: Theme.Dialog.peerOverlayVertical,
          leading: layout.showsSidebar
            ? columns(in: available).sidebar + Theme.Metric.contentInset
            : Theme.Metric.contentInset,
          bottom: Theme.Dialog.peerOverlayVertical,
          trailing: Theme.Dialog.peerOverlayTrailing
        ),
        settings: settings,
        daemon: daemon,
        devices: devices,
        transcript: bots.transcript,
        sampleTranscript: chat,
        onCreate: { title, label, appearance in
          closeDialog()
          Task { await bots.createBot(title: title, label: label, appearance: appearance) }
        },
        onSaveFace: { appearance in
          closeDialog()
          Task { await bots.updateSelected(appearance: appearance) }
        },
        onDismiss: closeDialog
      )
    }
  }

  /// The effective side widths; a modal that has to keep clear of the sidebar uses the
  /// same answer the columns themselves are framed with.
  private func columns(in available: CGSize) -> (sidebar: CGFloat, inspector: CGFloat) {
    Theme.Metric.columnWidths(
      available: available.width, sidebar: layout.sidebarWidth, inspector: layout.inspectorWidth,
      showsSidebar: layout.showsSidebar, showsInspector: showsInspector)
  }

  private func workspace(in available: CGSize) -> some View {
    let item = list.selectedItem
    let columns = columns(in: available)
    return ZStack(alignment: .bottomLeading) {
      ThreeColumnShell(
        availableWidth: available.width,
        showsSidebar: layout.showsSidebar,
        showsInspector: showsInspector,
        sidebarWidth: columns.sidebar,
        inspectorWidth: columns.inspector,
        onResizeSidebar: { layout.setSidebarWidth($0) },
        onResizeInspector: { layout.setInspectorWidth($0) }
      ) {
        SidebarPanel(
          sections: sidebarSections,
          selection: list.selection,
          onSelect: { id in
            chrome.markRead(id)
            if id == SuperagentWorkspaceViewModel.selectionID {
              list.selection = id
              Task { await superagent.start() }
            } else if bots.owns(id) {
              bots.select(id)
              list.selection = id
            } else {
              list.select(id)
            }
          },
          onToggleSection: { id in
            if bots.ownsSection(id) {
              bots.toggleSection(id)
            } else {
              list.toggleSection(id)
            }
          },
          onRenameSection: { id, title in
            if bots.ownsSection(id) {
              Task { await bots.renameGroup(id, to: title) }
            } else {
              list.renameSection(id, to: title)
            }
          },
          onDeleteSection: { id in
            if bots.ownsSection(id) {
              Task { await bots.deleteGroup(id) }
            } else {
              list.deleteSection(id)
            }
          },
          onCreateSection: { list.createSection() },
          onCreateGroup: { completion in
            Task {
              if let created = await bots.createGroup() {
                completion(created.id, created.title)
              }
            }
          },
          onCreateBot: { present(.createBot) },
          canCreateBot: bots.isConnected,
          onRenameItem: { id, title in
            if bots.owns(id) {
              Task { await bots.rename(id, to: title) }
            } else {
              list.renameItem(id, to: title)
            }
          },
          onDeleteItem: { id in
            if bots.owns(id) {
              Task { await bots.remove(id) }
            } else {
              list.deleteItem(id)
            }
          },
          onCollapse: { layout.toggleSidebar() },
          onSettings: { present(.settings) },
          onGallery: { onShowGallery { present(.settings) } },
          productVersion: AppVersion.current().display,
          onPinItem: { id in chrome.togglePin(id) },
          moveTargets: { id in moveTargets(for: id) },
          onMoveItem: { id, groupId in
            if bots.owns(id) {
              moveItem(id, to: groupId)
            } else if let groupId {
              list.moveItem(id, to: groupId)
            }
          },
          onMarkUnread: { id in chrome.markUnread(id) },
          onCopyId: { id in chrome.copyId(id) },
          onHideItem: { id in
            chrome.hide(id)
            selectAfterHide(id)
          },
          onMoveGroup: { id, offset in
            Task { await bots.reorderGroups(moving: id, by: offset) }
          }
        )
      } conversation: {
        VStack(spacing: 0) {
          if selectedIsBot && bots.needsModelSetup {
            BotsModelSetupBanner(
              onOpen: { bots.onOpenSettings?() },
              onDismiss: { bots.dismissModelSetup() }
            )
          }
          if selectedIsSuperagent {
            SuperagentConversationContent(
              model: superagent, layout: layout, focusRestore: focusRestore)
          } else if selectedIsBot {
            BotsConversationContent(
              bots: bots,
              layout: layout,
              focusRestore: focusRestore,
              onOpenPeerExchange: openBotExchange,
              onOpenToolRun: { present(.toolRun(id: $0, owner: conversationOwner)) }
            )
          } else if selectedIsMock {
            ConversationColumn(
              title: item?.title ?? "依赖修复专家",
              tintIndex: item?.tintIndex ?? 2,
              entries: chat.entries,
              showsToolCalls: !hideToolCalls,
              draft: $chat.draft,
              onSend: { chat.send() },
              showsSidebar: layout.showsSidebar,
              showsInspector: showsInspector,
              isWaiting: chat.waiting,
              onShowSidebar: { layout.toggleSidebar() },
              onToggleInspector: { layout.toggleInspector() },
              focusRestore: focusRestore,
              onOpenPeerExchange: { openPeerExchange($0) },
              onOpenToolRun: { present(.toolRun(id: $0, owner: .sample)) }
            )
          } else {
            NoConversationPlaceholder(
              onCreate: { present(.createBot) },
              onShowSidebar: { layout.toggleSidebar() },
              showsSidebar: layout.showsSidebar,
              daemonMessage: bots.error,
              onRetry: bots.error == nil ? nil : { Task { await bots.retryConnectionAsync() } }
            )
          }
        }
      } inspector: {
        InspectorColumn(
          name: selectedIsSuperagent
            ? "Super Bot"
            : (selectedIsBot ? bots.title : (selectedIsMock ? (item?.title ?? "示例") : "未选择")),
          subtitle: selectedIsSuperagent
            ? superagent.statusLine
            : (selectedIsBot ? "Bots" : (selectedIsMock ? (item?.tag ?? "示例") : "")),
          tintIndex: item?.tintIndex ?? 2,
          pulls: selectedIsBot ? bots.pullRows : (selectedIsMock ? inspector.pulls : []),
          tasks: selectedIsBot ? bots.tasks : [],
          usage: selectedIsBot ? bots.usage : [],
          choices: selectedIsBot ? bots.choices : [],
          triggers: selectedIsBot ? bots.triggerItems : [],
          onChoose: { row, value in
            guard selectedIsBot else { return }
            Task { await bots.choose(row, value: value) }
          },
          onToggleTrigger: { id, enabled in
            guard selectedIsBot else { return }
            bots.setTriggerEnabled(id, enabled)
          },
          tab: $inspector.tab,
          onRetryTask: { id in
            guard selectedIsBot else { return }
            Task { await bots.retryTask(id) }
          },
          onStopTask: { id in
            guard selectedIsBot else { return }
            Task { await bots.stopTask(id) }
          },
          onCollapse: { layout.toggleInspector() },
          face: selectedIsBot ? bots.selectedFace : nil,
          isBusy: selectedIsBot && bots.running,
          label: selectedIsBot ? bots.selectedLabel : nil,
          onEditFace: selectedIsBot
            ? { bots.selectedFace.map { present(.editFace($0)) } } : nil,
          onCommitName: selectedIsBot
            ? { title in Task { await bots.updateSelected(title: title) } } : nil,
          onCommitLabel: selectedIsBot
            ? { label in Task { await bots.updateSelected(label: label) } } : nil,
          computerContent: AnyView(
            DeviceInspectorView(model: devices) {
              settings.selection = .machines
              present(.settings)
            }),
          detailSections: selectedIsSuperagent
            ? SuperagentInspectorPresenter.detailSections(superagent.observation.summary) : []
        )
      }
      // Selecting the Super Bot reads the workers once; the inspector never carries a
      // surface-specific control that a bot's panel does not have.
      .task(id: list.selection) {
        guard selectedIsSuperagent else { return }
        await superagent.observation.refresh()
      }
      .task {
        bots.onSelect = { id in list.selection = id }
        bots.onOpenSettings = {
          settings.selection = .bots
          present(.settings)
        }
        if list.selection == nil {
          list.selection = SuperagentWorkspaceViewModel.selectionID
          await superagent.start()
        }
        guard ProcessInfo.processInfo.environment["EAGLE_DISABLE_WORKERS"] != "1" else { return }
        await daemon.startIfNeeded()
      }
      .task(id: daemon.status) {
        guard ProcessInfo.processInfo.environment["EAGLE_DISABLE_WORKERS"] != "1" else { return }
        // Every window follows readiness, including a shared start or a Settings retry.
        guard case .running = daemon.status else {
          bots.disconnect()
          return
        }
        await bots.start()
        guard !Task.isCancelled else { return }
        await bots.loadModels()
      }
      .task {
        guard ProcessInfo.processInfo.environment["EAGLE_DISABLE_WORKERS"] != "1" else { return }
        await devices.observeLocal()
      }
      .onDisappear {
        // Closing the window must release the bot's connection, or its subscriber slot
        // stays taken for as long as the process lives.
        bots.disconnect()
        Task { await superagent.closeWindow() }
      }
      .onChange(of: loadMockData) { _, _ in dropSampleSelectionIfHidden() }
      .task { dropSampleSelectionIfHidden() }
      .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSidebar)) { _ in
        // A dialog owns the window: a menu shortcut must not move what is behind it.
        guard activeDialog == nil else { return }
        layout.toggleSidebar()
      }
      .onReceive(NotificationCenter.default.publisher(for: .eagleToggleInspector)) { _ in
        guard activeDialog == nil else { return }
        layout.toggleInspector()
      }
      .onChange(of: bots.selectedId) { _, _ in closeStaleToolRun() }
      .onChange(of: list.selection) { _, _ in closeStaleToolRun() }
      // An exchange that arrives after another dialog took the window is discarded rather
      // than left pending behind it.
      .onChange(of: bots.openedExchange) { _, exchange in
        guard exchange != nil else { return }
        if dialogs.active != nil || openedSampleExchange != nil { bots.closeExchange() }
      }

    }
    .onReceive(NotificationCenter.default.publisher(for: .eagleToggleSettings)) { _ in
      guard activeDialog == nil else { return }
      present(.settings)
    }
  }
}
