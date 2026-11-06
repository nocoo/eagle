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

  @Test("selectable assistant text keeps the body font and inline styles")
  func selectableTypography() {
    for source in ["普通文本 normal text", "普通 **粗体** normal *italic* `code`"] {
      let text = BubbleTextBuilder.attributedString(
        blocks: [.paragraph(MarkdownDocument.inline(source))], streaming: false)
      let regular = NSHostingView(rootView: Text(text).font(Theme.TypeScale.body))
      let selectable = NSHostingView(rootView: SelectableTranscriptText(attributedText: text))
      #expect(abs(regular.fittingSize.width - selectable.fittingSize.width) < 1)
      #expect(abs(regular.fittingSize.height - selectable.fittingSize.height) < 1)
    }
  }

  @Test("selectable assistant text keeps the paragraph line spacing")
  func selectableLineSpacing() throws {
    for source in [
      "First line\nSecond line\nThird line\nFourth line",
      String(repeating: "中英文 mixed text for a long paragraph. ", count: 8),
    ] {
      let blocks: [RenderedMarkdownBlock] = [.paragraph(MarkdownDocument.inline(source))]
      func inkHeight(_ selection: Bool) throws -> Int {
        let renderer = ImageRenderer(
          content: AssistantBubble(
            text: source, preparedBlocks: blocks, selectionOverride: selection
          ).frame(width: 420).preferredColorScheme(.light))
        renderer.scale = 1
        let bitmap = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
        var rows: [Int] = []
        for y in 0..<bitmap.pixelsHigh {
          for x in 0..<bitmap.pixelsWide {
            guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
            if color.alphaComponent > 0.9 && color.redComponent < 0.25
              && color.greenComponent < 0.25 && color.blueComponent < 0.25
            {
              rows.append(y)
            }
          }
        }
        return try #require(rows.max()) - #require(rows.min()) + 1
      }
      let normal = try inkHeight(false)
      let selected = try inkHeight(true)
      #expect(normal > 40)
      #expect(abs(normal - selected) <= 1)
    }
  }

  @Test("selectable code keeps its line spacing")
  func selectableCodeSpacing() throws {
    let source = Array(repeating: "echo hello", count: 10).joined(separator: "\n")
    let blocks: [RenderedMarkdownBlock] = [.code(language: nil, body: source)]
    func inkHeight(_ content: some View) throws -> Int {
      let renderer = ImageRenderer(content: content.preferredColorScheme(.light))
      renderer.scale = 1
      let bitmap = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
      var rows: [Int] = []
      for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide {
          guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
          if color.alphaComponent > 0.9 && color.redComponent < 0.25
            && color.greenComponent < 0.25 && color.blueComponent < 0.25
          {
            rows.append(y)
          }
        }
      }
      return try #require(rows.max()) - #require(rows.min()) + 1
    }
    let normal = try inkHeight(
      Text(source).font(Theme.TypeScale.code).foregroundStyle(Theme.Palette.textPrimary))
    let selected = try inkHeight(
      AssistantBubble(text: source, preparedBlocks: blocks, selectionOverride: true)
        .frame(width: 420))
    #expect(normal > 100)
    #expect(abs(normal - selected) <= 1)
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
