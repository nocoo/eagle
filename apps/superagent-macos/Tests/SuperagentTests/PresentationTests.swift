import Foundation
import SuperagentCore
import SuperagentFeatures
import XCTest

final class PresentationTests: XCTestCase {
  private func state(_ messages: [ChatMessage], pending: [QueuedInput] = []) throws -> ChatState {
    var state = ChatState()
    let snapshot = SnapshotFrame(
      instance: "11111111-1111-4111-8111-111111111111", rev: 1,
      value: ChatSnapshot(
        messages: messages,
        window: ChatWindow(
          oldestEntryId: messages.first.flatMap { Int($0.id.dropFirst(2)) },
          newestEntryId: messages.last.flatMap { Int($0.id.dropFirst(2)) })))
    try state.accept(snapshot)
    var withPending = snapshot
    withPending.rev = 2
    withPending.value.pending = pending
    try state.accept(withPending)
    return state
  }

  func testCommittedQueueAndFailureStatesHaveDistinctRows() throws {
    let rows = ChatPresentation.rows(
      try state(
        [
          ChatMessage(id: "e_1", role: .user, text: "ask"),
          ChatMessage(id: "e_2", role: .assistant, text: "partial", state: .aborted),
          ChatMessage(id: "e_3", role: .assistant, text: "failed", state: .error),
          ChatMessage(id: "e_4", role: .assistant, text: "answer"),
        ], pending: [QueuedInput(id: "s_5", requestId: "r_5", text: "next")]))
    XCTAssertEqual(rows.map(\.kind), [.user, .aborted, .failed, .assistant, .queued])
    XCTAssertEqual(rows.last?.text, "next")
    XCTAssertEqual(
      ChatPresentation.queuedRequests(
        try state(
          [],
          pending: [
            QueuedInput(id: "s_6", requestId: "r_6", text: "q")
          ])), ["q_s_6": "r_6"])
  }
}
