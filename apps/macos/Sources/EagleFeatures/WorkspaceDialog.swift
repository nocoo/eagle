import EagleDesign

/// Which transcript owns a tool run: one bot's conversation, or the sample workspace. The
/// bot's id is part of it, because the transcript view model is shared and switches with the
/// selection: a run opened from `b_1` must not stay open over `b_2`'s rows.
enum ToolRunOwner: Hashable {
  case bot(id: String)
  case sample
}

/// What the shell shows over the workspace. One at a time: a dialog never stacks on
/// another, and the workspace behind the scrim stops taking clicks.
enum WorkspaceDialog: Hashable {
  case createBot
  case editFace(BotFace.Style)
  case peer(PeerExchange)
  /// A tool run is named by the entry that owns it, not by a copy of its rows: the detail
  /// view reads the run from the transcript so a call in flight keeps updating.
  case toolRun(id: String, owner: ToolRunOwner)
  case settings
}

extension WorkspaceDialog {
  /// Whether the dialog still belongs to the conversation on screen. Only a tool run is bound
  /// to one transcript; the shell's own dialogs are about the window, not one bot.
  func belongs(to owner: ToolRunOwner?) -> Bool {
    guard case .toolRun(_, let opened) = self else { return true }
    return opened == owner
  }
}

/// The shell's one modal slot. Presenting is refused while something is already up, so a
/// second surface can never take the window behind the person's back.
struct WorkspaceDialogState: Hashable {
  private(set) var active: WorkspaceDialog?

  var isPresenting: Bool { active != nil }

  @discardableResult
  mutating func present(_ dialog: WorkspaceDialog) -> Bool {
    guard active == nil else { return false }
    active = dialog
    return true
  }

  /// Clears whatever is up and names it, so the caller can release the state that raised
  /// it (a peer exchange read from the daemon, for instance).
  @discardableResult
  mutating func dismiss() -> WorkspaceDialog? {
    defer { active = nil }
    return active
  }
}
