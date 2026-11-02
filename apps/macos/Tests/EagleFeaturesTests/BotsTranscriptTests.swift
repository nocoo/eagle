import BotsCore
import EagleDesign
import Foundation
import Testing

@testable import EagleFeatures

@MainActor
@Suite("Transcript projection")
struct BotsTranscriptTests {
  @Test("published answers already contain prepared layout data")
  func preparedBeforePublication() async throws {
    let model = BotsTranscriptViewModel()
    let message = Message(
      id: "answer", role: .assistant, state: .complete, createdAt: "x",
      blocks: [.text("**Ready**\n\nBefore scrolling")])
    model.update(ConversationState(botId: "bot", messages: [message]))
    for _ in 0..<100 {
      if !model.entries.isEmpty { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let entry = try #require(model.entries.first)
    #expect(model.markdown[entry.id]?.count == 2)
    model.clear()
    #expect(model.markdown.isEmpty)
  }

  @Test("switching bots discards pending presentation work")
  func latestSelectionWins() async throws {
    let model = BotsTranscriptViewModel()
    let old = ConversationState(
      botId: "old",
      messages: (0..<200).map { index in
        Message(
          id: "old_\(index)", role: .assistant, state: .complete, createdAt: "x",
          blocks: [.text(String(repeating: "History ", count: 200))])
      })
    model.update(old)
    model.update(
      ConversationState(
        botId: "new",
        messages: [
          Message(
            id: "new_1", role: .user, state: .complete, createdAt: "x", blocks: [.text("Latest")])
        ]))
    for _ in 0..<100 {
      if model.entries.map(\.id) == ["new_1"] { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(model.entries.map(\.id) == ["new_1"])
    model.update(old)
    model.clear()
    try await Task.sleep(for: .milliseconds(30))
    #expect(model.entries.isEmpty)
  }
}

// MARK: - ask_user

@MainActor
@Suite("Ask card projection")
struct AskCardProjectionTests {
  private func state(messages: [Message]) -> ConversationState {
    ConversationState(botId: "bot", messages: messages)
  }

  private func call(id: String = "e_11", answered: Bool = false) -> Message {
    Message(
      id: id, role: .assistant, state: .complete, createdAt: "2026-11-02T10:00:00.000Z",
      blocks: [
        .toolCall(
          callId: "c_2", name: "ask_user",
          args: [
            "questions": .array([
              .object([
                "prompt": .string("要不要继续？"),
                "kind": .string("single"),
                "options": .array([
                  .object(["label": .string("继续")]),
                  .object(["label": .string("停止"), "detail": .string("今天到此为止")]),
                ]),
              ]),
              .object([
                "prompt": .string("跑哪些检查？"),
                "kind": .string("multi"),
                "options": .array([
                  .object(["label": .string("单测")]),
                  .object(["label": .string("浏览器")]),
                ]),
              ]),
            ])
          ])
      ])
  }

  private func answer(entry: String = "e_11") -> Message {
    Message(
      id: "e_16", role: .user, state: .complete, createdAt: "2026-11-02T10:01:00.000Z",
      blocks: [.text("The person answered the questions from e_11: …")],
      origin: MessageOrigin(kind: .human), hidden: true, answersTo: entry)
  }

  @Test("an ask_user call becomes a card with both questions, not a tool row")
  func cardRows() {
    let rows = BotsPresenter().transcript(for: state(messages: [call()]))
    guard
      case .question(let id, let card)? = rows.first(where: {
        if case .question = $0 { return true }
        return false
      })
    else {
      Issue.record("the transcript did not carry a question row")
      return
    }
    #expect(id == "ask-e_11")
    #expect(card.id == "e_11")
    #expect(card.questions.map(\.prompt) == ["要不要继续？", "跑哪些检查？"])
    #expect(card.questions.first?.multiple == false)
    #expect(card.questions.last?.multiple == true)
    #expect(card.questions.first?.options.last?.detail == "今天到此为止")
    #expect(card.answered == false)
  }

  @Test("the hidden answer closes the card and never shows as a chat turn")
  func answeredCard() {
    let rows = BotsPresenter().transcript(for: state(messages: [call(), answer()]))
    let cards = rows.compactMap { row -> AskCard? in
      if case .question(_, let card) = row { return card }
      return nil
    }
    #expect(cards.count == 1)
    #expect(cards.first?.answered == true)
    #expect(rows.contains { if case .user = $0 { return true } else { return false } } == false)
  }

  @Test("the card survives a call whose questions are malformed by falling back to a tool row")
  func malformedCard() {
    let broken = Message(
      id: "e_12", role: .assistant, state: .complete, createdAt: "2026-11-02T10:00:00.000Z",
      blocks: [.toolCall(callId: "c_3", name: "ask_user", args: ["questions": .string("nope")])])
    let rows = BotsPresenter().transcript(for: state(messages: [broken]))
    #expect(rows.contains { $0.isToolCall })
  }
}
