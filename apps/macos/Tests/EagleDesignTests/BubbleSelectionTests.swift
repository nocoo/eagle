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

  @Test("hovering a user bubble keeps its height")
  func userBubbleHeight() {
    let text = String(repeating: "中英文 mixed text for a long message. ", count: 12)
    let resting = NSHostingView(
      rootView: UserBubble(text, selectionOverride: false).frame(width: 360))
    let hovering = NSHostingView(
      rootView: UserBubble(text, selectionOverride: true).frame(width: 360))
    #expect(resting.fittingSize.height > Theme.Metric.rowHeight)
    #expect(abs(resting.fittingSize.height - hovering.fittingSize.height) < 1)
  }

  @Test("hovering an assistant bubble keeps its markdown height")
  func assistantBubbleHeight() {
    let blocks: [RenderedMarkdownBlock] = [
      .heading(level: 2, text: AttributedString("Heading")),
      .paragraph(AttributedString("First paragraph with words.")),
      .bullets([AttributedString("Bullet one"), AttributedString("Bullet two")]),
      .code(language: "sh", body: "echo hello"),
      .paragraph(AttributedString("Second paragraph")),
    ]
    func height(_ hovering: Bool) -> CGFloat {
      NSHostingView(
        rootView: AssistantBubble(
          text: "source", preparedBlocks: blocks, selectionOverride: hovering
        ).frame(width: 420)
      ).fittingSize.height
    }
    #expect(height(false) > Theme.Metric.rowHeight)
    #expect(abs(height(false) - height(true)) < 1)
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
