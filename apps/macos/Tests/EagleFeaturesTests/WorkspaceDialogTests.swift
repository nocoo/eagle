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
    state.present(.toolRun(id: "run-c_1", owner: .bot))
    let closed = state.dismiss()
    #expect(closed == .toolRun(id: "run-c_1", owner: .bot))
    #expect(!state.isPresenting)
    #expect(state.dismiss() == nil, "a second close has nothing to report")
    let reopened = state.present(.editFace(BotFace.Style(shape: .hex, tint: .violet)))
    #expect(reopened)
  }

  @Test("a tool run is opened by the entry that owns it, not by a copy of its rows")
  func toolRunPayload() {
    var state = WorkspaceDialogState()
    state.present(.toolRun(id: "run-c_1", owner: .sample))
    #expect(state.active == .toolRun(id: "run-c_1", owner: .sample))
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
