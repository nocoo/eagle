import Testing

@testable import EagleDesign

@Suite("Transcript following")
struct TranscriptScrollTests {
  @Test("content growth during a stationary gesture does not mean the user scrolled away")
  func growthDuringTracking() {
    var state = TranscriptScrollState()
    _ = state.update(.init(contentHeight: 700, visibleBottom: 700), userIsScrolling: false)
    _ = state.update(.init(contentHeight: 700, visibleBottom: 700), userIsScrolling: true)
    _ = state.update(.init(contentHeight: 900, visibleBottom: 700), userIsScrolling: true)
    #expect(state.followsBottom)
    #expect({ state.endUserScroll() }())
    #expect({ !state.endUserScroll() }())
  }

  @Test("an upward move during content growth still suspends following")
  func scrollDuringGrowth() {
    var state = TranscriptScrollState()
    _ = state.update(.init(contentHeight: 700, visibleBottom: 700), userIsScrolling: false)
    _ = state.update(.init(contentHeight: 900, visibleBottom: 600), userIsScrolling: true)
    #expect(!state.followsBottom)
    #expect({ !state.endUserScroll() }())
  }

  @Test("late prepared content follows the bottom without a new row")
  func asynchronousHeight() {
    var state = TranscriptScrollState()
    #expect(
      { state.update(.init(contentHeight: 100, visibleBottom: 100), userIsScrolling: false) }())
    #expect(
      { state.update(.init(contentHeight: 700, visibleBottom: 100), userIsScrolling: false) }())
    #expect(
      { !state.update(.init(contentHeight: 700, visibleBottom: 700), userIsScrolling: false) }())
  }

  @Test("reading history suspends following until the user returns to the bottom")
  func respectsHistory() {
    var state = TranscriptScrollState()
    #expect(
      { !state.update(.init(contentHeight: 700, visibleBottom: 300), userIsScrolling: true) }())
    #expect(!state.followsBottom)
    #expect(
      { !state.update(.init(contentHeight: 900, visibleBottom: 300), userIsScrolling: false) }())
    #expect(
      { !state.update(.init(contentHeight: 900, visibleBottom: 895), userIsScrolling: true) }())
    #expect(state.followsBottom)
    #expect(
      { state.update(.init(contentHeight: 1_200, visibleBottom: 900), userIsScrolling: false) }())
  }

  @Test("streaming and terminal assistant rows keep their identity")
  func assistantIdentity() {
    let streaming = TranscriptEntry.streamingAssistant(id: "answer", blocks: [.paragraph("Text")])
    let finished = TranscriptEntry.assistant(id: "answer", blocks: [.paragraph("Text")])
    #expect(streaming.id == finished.id)
  }
}
