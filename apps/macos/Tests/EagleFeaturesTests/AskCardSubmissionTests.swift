import Testing

@testable import EagleDesign

@Suite("Question card admission", .serialized)
@MainActor
struct AskCardSubmissionTests {
  @Test("repeated labels retain their question identity")
  func groupedAnswers() {
    let choices = [AskCardQuestion.Option(label: "Yes"), AskCardQuestion.Option(label: "No")]
    let card = AskCard(
      id: "e_1",
      questions: [
        AskCardQuestion(id: 0, prompt: "First?", multiple: false, options: choices),
        AskCardQuestion(id: 1, prompt: "Second?", multiple: true, options: choices),
      ])
    #expect(card.orderedAnswers([0: ["Yes"], 1: ["No"]]) == [["Yes"], ["No"]])
  }

  @Test("offline or refused answers unlock for retry, pending answers do not duplicate")
  func retry() async {
    let state = AskCardSubmission()
    await state.submit { .failure(AskCardFailure("Offline")) }
    #expect(!state.pending)
    #expect(!state.confirmed)
    #expect(state.failure == "Offline")
    await state.submit { .failure(AskCardFailure("Refused")) }
    #expect(!state.confirmed)
    #expect(state.failure == "Refused")
    var calls = 0
    var release: (() -> Void)?
    let task = Task { @MainActor in
      await state.submit {
        calls += 1
        await withCheckedContinuation { continuation in release = { continuation.resume() } }
        return .success(())
      }
    }
    while release == nil { await Task.yield() }
    #expect(state.pending)
    await state.submit {
      calls += 1
      return .success(())
    }
    #expect(calls == 1)
    release?()
    await task.value
    #expect(state.confirmed)
    #expect(!state.pending)
    #expect(state.failure == nil)
  }
}
