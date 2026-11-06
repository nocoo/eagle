import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Workspace dialog")
struct WorkspaceDialogTests {
  @Test("the shell never stacks two dialogs on the same window")
  func exclusivity() {
    var state = WorkspaceDialogState()
    #expect(!state.isPresenting)
    let first = state.present(.createBot)
    let second = state.present(.settings)
    #expect(first)
    #expect(!second, "a dialog already up refuses a second one")
    #expect(state.active == .createBot)
  }

  @Test("closing frees the slot and names what was up")
  func dismiss() throws {
    var state = WorkspaceDialogState()
    let rows = [ToolRow(id: "tool-1", name: "read", subtitle: "path=notes.txt")]
    state.present(.toolRun(rows))
    let closed = state.dismiss()
    #expect(closed == .toolRun(rows))
    #expect(!state.isPresenting)
    #expect(state.dismiss() == nil, "a second close has nothing to report")
    let reopened = state.present(.editFace(BotFace.Style(shape: .hex, tint: .violet)))
    #expect(reopened)
  }

  @Test("a dialog keeps the values it was opened with")
  func payload() {
    var state = WorkspaceDialogState()
    let face = BotFace.Style(shape: .drop, tint: .teal)
    state.present(.editFace(face))
    guard case .editFace(let opened) = state.active else {
      Issue.record("the face dialog lost its payload")
      return
    }
    #expect(opened == face)
  }
}
