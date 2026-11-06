import EagleDesign

/// What the shell shows over the workspace. One at a time: a dialog never stacks on
/// another, and the workspace behind the scrim stops taking clicks.
enum WorkspaceDialog: Hashable {
  case createBot
  case editFace(BotFace.Style)
  case peer(PeerExchange)
  case toolRun([ToolRow])
  case settings
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
