import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

/// Scrolling must not re-place the transcript. The number this guards is the ratio
/// between a real `ConversationColumn` and the same rows in a bare `LazyVStack`: the
/// column's scroll bookkeeping runs once per tick, so any SwiftUI state written there
/// makes every tick re-lay out every visible row. The bound is a ratio, measured in
/// the same process, because an absolute millisecond budget would depend on the host.
@MainActor
@Suite("Transcript scroll cost", .serialized)
struct TranscriptScrollCostTests {
  @Test("scrolling a conversation costs little more than the same rows without bookkeeping")
  func costRatio() throws {
    let entries = Self.entries(turns: 40)
    let markdown = Self.prepared(entries)
    let columnView = ConversationColumn(
      title: "Bot", tintIndex: 1, entries: entries,
      preparedMarkdown: markdown, draft: .constant(""), onSend: {})
    // The lowest of interleaved rounds, for the same reason as the row-cost guard: load can
    // only add time, and a bookkeeping regression (10x when it happened) raises every round.
    var ratios: [Double] = []
    for _ in 0..<5 {
      let column = Self.measure(columnView)
      let bare = Self.measure(Self.bareRows(entries, markdown))
      ratios.append(column / max(bare, 0.000_001))
    }
    let ratio = ratios.min() ?? .greatestFiniteMagnitude
    print(
      "SCROLLBENCH rounds=\(ratios.map { String(format: "%.2f", $0) }.joined(separator: ",")) "
        + "min=\(String(format: "%.2f", ratio))")
    #expect(ratio < 4, "conversation scroll costs \(String(format: "%.1f", ratio))x the same rows")
  }

  private static func entries(turns: Int) -> [TranscriptEntry] {
    var out: [TranscriptEntry] = []
    let body = String(
      repeating: "这一段用来模拟真实回答的长度，中英文混排，带 `inline code` 与 **粗体**。", count: 6)
    for index in 0..<turns {
      out.append(.user(id: "u\(index)", text: "第 \(index) 个问题：检查构建脚本为什么失败"))
      out.append(
        .assistant(
          id: "a\(index)",
          blocks: [.paragraph("先看结论：构建脚本本身没有问题。"), .paragraph(body)]))
      out.append(.note(id: "n\(index)", text: "已送达", tintIndices: [0, 1]))
    }
    return out
  }

  private static func prepared(_ entries: [TranscriptEntry]) -> [String: [RenderedMarkdownBlock]] {
    entries.reduce(into: [:]) { result, entry in
      if case .assistant(let id, let blocks, _) = entry {
        result[id] = [.paragraph(AttributedString(blocks.markdown))]
      }
    }
  }

  private static func bareRows(
    _ entries: [TranscriptEntry], _ markdown: [String: [RenderedMarkdownBlock]]
  ) -> some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
        ForEach(entries) { entry in
          switch entry {
          case .user(_, let text, let origin):
            UserBubble(text, origin: origin)
          case .assistant(_, let blocks, _):
            AssistantBubble(text: blocks.markdown, preparedBlocks: markdown[entry.id]).equatable()
          case .note(_, let text, let tints):
            DeliveryNote(text, avatars: tints.map(Theme.Palette.avatarTint))
          default:
            EmptyView()
          }
        }
      }
      .padding(.horizontal, Theme.Metric.conversationInset)
    }
  }

  /// Milliseconds per scroll tick for 300 programmatic 12 pt steps.
  private static func measure(_ view: some View) -> Double {
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(x: 0, y: 0, width: 760, height: 700)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    defer { window.contentView = nil }
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    guard let scroll = scrollView(in: host), scroll.documentView != nil else {
      return .greatestFiniteMagnitude
    }
    scroll.layoutSubtreeIfNeeded()
    let clip = scroll.contentView
    let limit = max(0, (scroll.documentView?.frame.height ?? 0) - clip.bounds.height)
    let steps = 300
    var offset: CGFloat = 0
    let start = Date()
    for _ in 0..<steps {
      offset = min(limit, offset + 12)
      clip.scroll(to: NSPoint(x: 0, y: offset))
      scroll.reflectScrolledClipView(clip)
      host.layoutSubtreeIfNeeded()
      if offset == limit {
        offset = 0
        clip.scroll(to: .zero)
        scroll.reflectScrolledClipView(clip)
      }
    }
    let elapsed = Date().timeIntervalSince(start) * 1_000 / Double(steps)
    window.orderOut(nil)
    return elapsed
  }

  private static func scrollView(in view: NSView) -> NSScrollView? {
    if let found = view as? NSScrollView { return found }
    for child in view.subviews {
      if let found = scrollView(in: child) { return found }
    }
    return nil
  }
}
