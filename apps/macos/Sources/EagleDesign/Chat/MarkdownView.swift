import SwiftUI

/// The assistant's turn inside a dialog bubble: rich text rendered from markdown — headings,
/// paragraphs, bullet and numbered lists, quotes, fenced code and tables — with inline
/// `**bold**`, `*italic*`, `` `code` `` chips and links. The card is the one surface a turn
/// gets; nothing here invents a second palette.
public struct AssistantBubble: View, Equatable {
  private let text: String
  private let streaming: Bool
  private let preparedBlocks: [RenderedMarkdownBlock]?
  private let cornerRadius: CGFloat
  private let maxWidth: CGFloat
  private let onInsertSelection: ((String) -> Void)?
  private let onClearSelection: () -> Void
  private let selectionSource: String
  private let selectedText: String
  private let selectionOverride: Bool?
  @StateObject private var model = MarkdownViewModel()
  @State private var hovering = false

  public init(
    text: String,
    streaming: Bool = false,
    preparedBlocks: [RenderedMarkdownBlock]? = nil,
    cornerRadius: CGFloat = Theme.Chat.assistantRadius,
    maxWidth: CGFloat = Theme.Chat.rowMaxWidth,
    onInsertSelection: ((String) -> Void)? = nil,
    onClearSelection: @escaping () -> Void = {},
    selectionSource: String = "",
    selectedText: String = "",
    selectionOverride: Bool? = nil
  ) {
    self.text = text
    self.streaming = streaming
    self.preparedBlocks = preparedBlocks
    self.cornerRadius = cornerRadius
    self.maxWidth = maxWidth
    self.onInsertSelection = onInsertSelection
    self.onClearSelection = onClearSelection
    self.selectionSource = selectionSource
    self.selectedText = selectedText
    self.selectionOverride = selectionOverride
  }

  public var body: some View {
    let blocks = preparedBlocks ?? model.blocks
    let attributedText = BubbleTextBuilder.attributedString(blocks: blocks, streaming: streaming)
    let sourceText = String(attributedText.characters)
    let hasSelection =
      selectionSource == sourceText
      && !selectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let selectionEnabled =
      selectionOverride
      ?? (hovering || hasSelection
        || ProcessInfo.processInfo.environment["EAGLE_COMPOSER_FOCUS_FIXTURE"] == "1")
    HStack(alignment: .bottom, spacing: Theme.Layout.rowGap) {
      HStack(alignment: .bottom, spacing: Theme.Layout.rowGap) {
        bubbleContent(
          blocks: blocks,
          attributedText: attributedText,
          selectionEnabled: selectionEnabled
        )
        .padding(.horizontal, Theme.Chat.bubbleHorizontalInset)
        .padding(.vertical, Theme.Chat.assistantVerticalInset)
        .background(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Theme.Palette.assistantFill)
        )
        .overlay(alignment: .topTrailing) {
          if hasSelection {
            selectionAction
          }
        }
        .messageCopyAlignment()
        copyAction
      }
      .frame(maxWidth: maxWidth, alignment: .leading)
      .onHover { hovering = $0 }
      Spacer(minLength: Theme.Chat.assistantTrailingSpace)
    }
    .frame(maxWidth: .infinity, alignment: .leading)

    .task(id: text) {
      if preparedBlocks == nil { await model.render(text) }
    }
  }

  @ViewBuilder
  private func blockView(_ block: RenderedMarkdownBlock, caret: Bool) -> some View {
    switch block {
    case .paragraph(let text):
      paragraph(text, caret: caret)
    case .heading(let level, let text):
      Text(text)
        .font(Theme.TypeScale.markdownHeading(level))
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineSpacing(Theme.Chat.headingLineSpacing)
        .fixedSize(horizontal: false, vertical: true)
    case .bullets(let items):
      VStack(alignment: .leading, spacing: Theme.Layout.labelGap) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .firstTextBaseline, spacing: Theme.Chat.bulletGap) {
            Text("•")
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
              .frame(width: Theme.Chat.bulletWidth, alignment: .leading)
            MarkdownInline(text: item, caret: caret && index == items.count - 1)
          }
          .font(Theme.TypeScale.body)
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineSpacing(Theme.Chat.listLineSpacing)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    case .code(let language, let body):
      code(language: language, body: body)
    case .quote(let text):
      HStack(alignment: .top, spacing: Theme.Layout.controlGap) {
        RoundedRectangle(cornerRadius: Theme.Chat.quoteRuleRadius)
          .fill(Theme.Palette.line)
          .frame(width: Theme.Chat.quoteRuleWidth)
        VStack(alignment: .leading, spacing: Theme.Layout.detailGap) {
          ForEach(Array(text.enumerated()), id: \.offset) {
            _, line in
            Text(line)
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
              .lineSpacing(Theme.Chat.listLineSpacing)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    case .table(let headers, let rows):
      table(headers: headers, rows: rows)
    }
  }

  private func paragraph(_ text: AttributedString, caret: Bool) -> some View {
    MarkdownInline(text: text, caret: caret)
      .font(Theme.TypeScale.body)
      .foregroundStyle(Theme.Palette.textPrimary)
      .lineSpacing(Theme.Chat.bodyLineSpacing)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func code(language: String?, body: String) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if let language, !language.isEmpty {
        Text(language)
          .font(Theme.TypeScale.codeLanguage)
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.horizontal, Theme.Chat.codeInset)
          .padding(.top, Theme.Chat.codeHeaderInset)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(body)
          .font(Theme.TypeScale.code)
          .foregroundStyle(Theme.Palette.textPrimary)

          .fixedSize(horizontal: true, vertical: true)
          .padding(.horizontal, Theme.Chat.codeInset)
          .padding(.vertical, Theme.Chat.codeVerticalInset)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: Theme.Chat.codeRadius, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Chat.codeRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }

  /// A grid, not raw pipes: header cells are dim and semibold, body cells wrap, and the
  /// whole table scrolls horizontally when a model writes many columns.
  private func table(
    headers: [AttributedString], rows: [[AttributedString]]
  ) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(
        alignment: .leading, horizontalSpacing: Theme.Chat.tableColumnGap,
        verticalSpacing: Theme.Chat.tableRowGap
      ) {
        GridRow {
          ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
            Text(header)
              .font(Theme.TypeScale.noteStrong)
              .foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Divider()
          .gridCellUnsizedAxes(.horizontal)
          .gridCellColumns(max(headers.count, 1))
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(cell)
                .font(Theme.TypeScale.rowSubtitle)
                .foregroundStyle(Theme.Palette.textPrimary)
                .lineSpacing(Theme.Chat.headingLineSpacing)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      .padding(.vertical, Theme.Chat.tableVerticalInset)
    }
  }

  public nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.text == rhs.text && lhs.streaming == rhs.streaming
      && lhs.preparedBlocks == rhs.preparedBlocks
      && lhs.cornerRadius == rhs.cornerRadius && lhs.maxWidth == rhs.maxWidth
      && lhs.selectionSource == rhs.selectionSource && lhs.selectedText == rhs.selectedText
      && lhs.selectionOverride == rhs.selectionOverride
  }

  @ViewBuilder
  private func bubbleContent(
    blocks: [RenderedMarkdownBlock],
    attributedText: AttributedString,
    selectionEnabled: Bool
  ) -> some View {
    ZStack(alignment: .topLeading) {
      VStack(alignment: .leading, spacing: Theme.Chat.blockGap) {
        ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
          blockView(block, caret: streaming && index == blocks.count - 1)
        }
      }
      .opacity(selectionEnabled ? 0 : 1)
      .allowsHitTesting(!selectionEnabled)
      if selectionEnabled {
        if blocks.count == 1, case .paragraph = blocks[0] {
          SelectableTranscriptText(attributedText: attributedText)
            .lineSpacing(Theme.Chat.bodyLineSpacing)
        } else {
          SelectableTranscriptText(attributedText: attributedText)
        }
      }
    }
  }

  private var selectionAction: some View {
    CardActionButton("发送到对话") {
      let text = selectedText
      onClearSelection()
      onInsertSelection?(text)
    }
    .offset(y: -Theme.Form.actionHeight)
  }

  /// The copy action exists only for the row under the pointer: building a button per
  /// row costs milliseconds of scroll work for rows nobody is pointing at.
  private var copyAction: some View {
    Group {
      if hovering {
        MessageCopyButton(text: text, label: "复制 Bot 消息")
      } else {
        Theme.Palette.clear
      }
    }
    .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
  }

}

private struct MarkdownInline: View {
  let text: AttributedString
  let caret: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if caret {
      TimelineView(.animation(minimumInterval: Theme.Motion.caretInterval, paused: reduceMotion)) {
        context in
        let visible =
          reduceMotion
          || Int(context.date.timeIntervalSinceReferenceDate / Theme.Motion.caretInterval) % 2 == 0
        Text(text)
          + Text("▍")
          .font(Theme.TypeScale.streamingCaret)
          .foregroundColor((visible ? Theme.Palette.accent : Theme.Palette.quietCaret))
      }
    } else {
      Text(text)
    }
  }
}
