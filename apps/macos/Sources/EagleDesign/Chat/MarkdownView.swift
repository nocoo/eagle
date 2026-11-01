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
  /// Nil keeps the transcript's own card colour; a peer bubble passes its sender's tint.
  private let fill: Color?
  private let border: Color?
  @StateObject private var model = MarkdownViewModel()
  @State private var hovering = false

  /// The assistant's card carries no accent: one neutral fill a shade apart from the column,
  /// no border, no second colour behind the markdown. A peer bubble passes its sender's tint.
  public init(
    text: String,
    streaming: Bool = false,
    preparedBlocks: [RenderedMarkdownBlock]? = nil,
    cornerRadius: CGFloat = 20,
    maxWidth: CGFloat = Theme.Metric.conversationMaxContentWidth - 120,
    fill: Color? = nil,
    border: Color? = nil
  ) {
    self.text = text
    self.streaming = streaming
    self.preparedBlocks = preparedBlocks
    self.cornerRadius = cornerRadius
    self.maxWidth = maxWidth
    self.fill = fill
    self.border = border
  }

  public var body: some View {
    let blocks = preparedBlocks ?? model.blocks
    HStack(alignment: .bottom, spacing: 8) {
      HStack(alignment: .bottom, spacing: 8) {
        selectable(
          VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
              blockView(block, caret: streaming && index == blocks.count - 1)
            }
          }
        )
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .background(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Theme.Palette.assistantFill)
            .overlay {
              if let fill {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).fill(fill)
              }
            }
        )
        .overlay {
          if let border {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .strokeBorder(border, lineWidth: Theme.Metric.hairline)
          }
        }
        .messageCopyAlignment()
        copyAction
      }
      .frame(maxWidth: maxWidth, alignment: .leading)
      .onHover { hovering = $0 }
      Spacer(minLength: 40)
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
        .font(.system(size: headingSize(level), weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    case .bullets(let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text("•")
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
              .frame(width: 8, alignment: .leading)
            MarkdownInline(text: item, caret: caret && index == items.count - 1)
          }
          .font(Theme.TypeScale.body)
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineSpacing(4)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    case .code(let language, let body):
      code(language: language, body: body)
    case .quote(let text):
      HStack(alignment: .top, spacing: 10) {
        RoundedRectangle(cornerRadius: 1.5)
          .fill(Theme.Palette.line)
          .frame(width: 3)
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(text.enumerated()), id: \.offset) {
            _, line in
            Text(line)
              .font(Theme.TypeScale.body)
              .foregroundStyle(Theme.Palette.textSecondary)
              .lineSpacing(4)
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
      .lineSpacing(5)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func code(language: String?, body: String) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if let language, !language.isEmpty {
        Text(language)
          .font(.system(size: 11, weight: .medium, design: .monospaced))
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.horizontal, 12)
          .padding(.top, 8)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(body)
          .font(.system(size: 12.5, design: .monospaced))
          .foregroundStyle(Theme.Palette.textPrimary)

          .fixedSize(horizontal: true, vertical: true)
          .padding(.horizontal, 12)
          .padding(.vertical, 9)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }

  /// A grid, not raw pipes: header cells are dim and semibold, body cells wrap, and the
  /// whole table scrolls horizontally when a model writes many columns.
  private func table(
    headers: [AttributedString], rows: [[AttributedString]]
  ) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
        GridRow {
          ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
            Text(header)
              .font(.system(size: 13, weight: .semibold))
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
                .font(.system(size: 13.5))
                .foregroundStyle(Theme.Palette.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      .padding(.vertical, 2)
    }
  }

  public nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.text == rhs.text && lhs.streaming == rhs.streaming
      && lhs.preparedBlocks == rhs.preparedBlocks
  }

  @ViewBuilder
  private func selectable<Content: View>(_ content: Content) -> some View {
    if hovering || ProcessInfo.processInfo.environment["EAGLE_COMPOSER_FOCUS_FIXTURE"] == "1" {
      content.textSelection(.enabled)
    } else {
      content
    }
  }

  /// The copy action exists only for the row under the pointer: building a button per
  /// row costs milliseconds of scroll work for rows nobody is pointing at.
  private var copyAction: some View {
    Group {
      if hovering {
        MessageCopyButton(text: text, label: "复制 Bot 消息")
      } else {
        Color.clear
      }
    }
    .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
  }

  private func headingSize(_ level: Int) -> CGFloat {
    switch level {
    case 1: return 20
    case 2: return 17
    default: return 15.5
    }
  }

}

private struct MarkdownInline: View {
  let text: AttributedString
  let caret: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if caret {
      TimelineView(.animation(minimumInterval: 0.62, paused: reduceMotion)) { context in
        let visible =
          reduceMotion || Int(context.date.timeIntervalSinceReferenceDate / 0.62) % 2 == 0
        Text(text)
          + Text("▍")
          .font(.system(size: 14, design: .monospaced))
          .foregroundColor(Theme.Palette.accent.opacity(visible ? 1 : 0.12))
      }
    } else {
      Text(text)
    }
  }
}
