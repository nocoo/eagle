import AppKit
import BotsCore
import SwiftUI
import Testing

@testable import EagleDesign
@testable import EagleFeatures

/// A tool run opened from the transcript: its details follow the transcript while it is up.
@Suite("Tool run detail dialog", .serialized)
@MainActor
struct ToolRunDetailDialogTests {
  @Test("the run is found by its entry id and nowhere else")
  func derivation() {
    let rows = [ToolRow(id: "c_1", name: "read_file", subtitle: "path=a")]
    let entries: [TranscriptEntry] = [.toolRun(id: "run-c_1", rows: rows)]
    #expect(entries.toolRunRows(id: "run-c_1") == rows)
    #expect(entries.toolRunRows(id: "run-c_9") == nil)
    #expect(entries.toolRunRows(id: "c_1") == nil, "the id belongs to the entry, not the call")
  }

  @Test("a call that finishes while the dialog is open updates it")
  func liveRows() async throws {
    let transcript = BotsTranscriptViewModel()
    transcript.update(state(callIds: ["c_1", "c_2"], results: []))
    let id = try await waitForRun(transcript)
    let fixture = try DialogFixture(
      BotToolRunDetailDialog(transcript: transcript, id: id, onClose: {}))
    defer { fixture.close() }
    #expect(fixture.nodes.compactMap(fixture.title).contains { $0.contains("read_file") })
    #expect(!fixture.nodes.compactMap(fixture.title).contains { $0.contains("工作区里的内容") })

    transcript.update(state(callIds: ["c_1", "c_2"], results: ["c_1"]))
    try await waitUntil {
      fixture.host.layoutSubtreeIfNeeded()
      return fixture.nodes.compactMap(fixture.title).contains { $0.contains("工作区里的内容") }
    }
  }

  private func state(callIds: [String], results: [String]) -> ConversationState {
    var state = ConversationState(botId: "b_1")
    state = Reducer.apply(
      .append(
        message: Message(
          id: "e_call", role: .assistant, state: .complete, createdAt: "2026-10-29T12:00:00.000Z",
          blocks: callIds.map {
            .toolCall(callId: $0, name: "read_file", args: ["path": .string("notes.txt")])
          }
        ),
        replaces: nil),
      to: state)
    for callId in results {
      state = Reducer.apply(
        .append(
          message: Message(
            id: "e_result_\(callId)", role: .tool, state: .complete,
            createdAt: "2026-10-29T12:01:00.000Z",
            blocks: [
              .toolResult(
                callId: callId, name: "read_file", text: "工作区里的内容", isError: false,
                durationMs: 21)
            ]
          ),
          replaces: nil),
        to: state)
    }
    return state
  }

  private func waitForRun(_ transcript: BotsTranscriptViewModel) async throws -> String {
    for _ in 0..<200 {
      if let entry = transcript.entries.first(where: {
        if case .toolRun = $0 { true } else { false }
      }) {
        return entry.id
      }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(domain: "ToolRunDetailDialogTests", code: 1)
  }

  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<200 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(domain: "ToolRunDetailDialogTests", code: 2)
  }
}
