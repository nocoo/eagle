import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Bubble text selection", .serialized)
struct BubbleSelectionTests {
  @Test("markdown blocks become one attributed text spanning paragraphs")
  func crossBlockText() {
    let blocks: [RenderedMarkdownBlock] = [
      .heading(level: 2, text: AttributedString("Heading")),
      .paragraph(AttributedString("First paragraph")),
      .bullets([AttributedString("Bullet one")]),
      .paragraph(AttributedString("Second paragraph")),
    ]
    let text = String(
      BubbleTextBuilder.attributedString(blocks: blocks, streaming: false).characters)

    #expect(text.contains("Heading"))
    #expect(text.contains("First paragraph"))
    #expect(text.contains("Bullet one"))
    #expect(text.contains("Second paragraph"))
    #expect(text.contains("\n"))
  }

  @Test("insertion preserves the draft, trims whitespace and ignores empty text")
  func insertDraft() {
    var draft = "已有草稿"
    BubbleSelectionAction.insert("  跨段落选中的文字  \n", into: &draft)
    #expect(draft == "已有草稿\n跨段落选中的文字")

    var unchanged = "已有草稿"
    BubbleSelectionAction.insert(" \n\t ", into: &unchanged)
    #expect(unchanged == "已有草稿")

    var empty = ""
    BubbleSelectionAction.insert("  首段  ", into: &empty)
    #expect(empty == "首段")
  }

  @Test("clearing a selection hides the action")
  func clearSelection() {
    let model = TranscriptSelectionModel()
    model.sourceText = "First paragraph\nSecond paragraph"
    model.selectedText = "First paragraph"
    model.clearSelection()
    #expect(model.sourceText.isEmpty)
    #expect(model.selectedText.isEmpty)
  }
}
