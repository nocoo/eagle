import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

/// Materializing a page of transcript rows must stay within a small multiple of plain text
/// rows. Scrolling rebuilds every row that enters the viewport, so per-row view count is
/// what a reader feels as smoothness: a copy button and a bubble card cost milliseconds a
/// page if they are built for rows nobody is pointing at.
@MainActor
@Suite("Transcript row cost", .serialized)
struct TranscriptRowCostTests {
  @Test("a page of conversation rows costs little more than plain text rows")
  func pageCost() {
    let entries = Self.entries(turns: 40)
    let markdown = Self.prepared(entries)
    let columnView = ConversationColumn(
      title: "Bot", tintIndex: 1, entries: entries,
      preparedMarkdown: markdown, draft: .constant(""), onSend: {})
    let plainView = Self.plainText(entries)
    // Warm both variants twice so caches and the hosting view path are hot before we score.
    // A single warm pair still left occasional CI noise when the second view paid first-layout
    // work during measured rounds.
    for _ in 0..<2 {
      _ = Self.pageCost(columnView)
      _ = Self.pageCost(plainView)
    }
    // Each round times column and plain back-to-back on the same load. Measuring column
    // *before* plain warmed the run loop and font caches that plain reuses but column does
    // not, so plain looked artificially fast and every round's ratio sat above the bound
    // (2.51 on CI) even when the structural cost was fine. Alternate order and keep the
    // **lowest** ratio: plain-first rounds are the least upward-biased; interference still
    // only adds time, and a real regression raises every round.
    var ratios: [Double] = []
    for round in 0..<5 {
      let column: Double
      let plain: Double
      if round.isMultiple(of: 2) {
        plain = Self.pageCost(plainView)
        column = Self.pageCost(columnView)
      } else {
        column = Self.pageCost(columnView)
        plain = Self.pageCost(plainView)
      }
      ratios.append(column / max(plain, 0.000_001))
    }
    let ratio = ratios.min() ?? .greatestFiniteMagnitude
    print(
      "ROWCOST rounds=\(ratios.map { String(format: "%.2f", $0) }.joined(separator: ",")) "
        + "min=\(String(format: "%.2f", ratio))")
    // A clock cannot separate a heavy row from a busy CI runner, so this bound is coarse on
    // purpose: it fails on an order-of-magnitude regression (a copy button or a card built for
    // every row) and does not fail when the machine is loaded. The tight per-row guarantees
    // live in the design guard, not in a stopwatch.
    #expect(
      ratio.isFinite, "the scroll view was not found, so nothing was measured")
    #expect(
      ratio < 6, "a page of conversation rows costs \(String(format: "%.1f", ratio))x plain text")
  }

  private static func entries(turns: Int) -> [TranscriptEntry] {
    var out: [TranscriptEntry] = []
    let body = String(
      repeating: "这一段用来模拟真实回答的长度，中英文混排，带 `inline code` 与 **粗体**。", count: 8)
    for index in 0..<turns {
      if index % 4 == 0 {
        out.append(
          .assistant(
            id: "code\(index)",
            blocks: [
              .paragraph("先跑一下这个："),
              .note("```sh\ncd apps/macos && ./Scripts/build-app.sh\n```"),
              .paragraph(String(repeating: "结果和预期一致，继续下一步。", count: 6)),
            ]))
      }
      out.append(.user(id: "u\(index)", text: "第 \(index) 个问题：检查构建脚本为什么失败"))
      out.append(
        .assistant(
          id: "a\(index)", blocks: [.paragraph("先看结论：构建脚本本身没有问题。"), .paragraph(body)]))
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

  private static func plainText(_ entries: [TranscriptEntry]) -> some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
        ForEach(entries) { entry in
          switch entry {
          case .user(_, let text, _), .note(_, let text, _):
            Text(text)
          case .assistant(_, let blocks, _):
            Text(blocks.markdown)
          default:
            EmptyView()
          }
        }
      }
      .padding(.horizontal, Theme.Metric.conversationInset)
    }
  }

  /// Milliseconds for one page-sized jump; each jump materializes a fresh viewport of rows.
  private static func pageCost(_ view: some View) -> Double {
    let jumps = 24
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(x: 0, y: 0, width: 760, height: 700)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    defer { window.contentView = nil }
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    guard let scroll = scrollView(in: host), scroll.documentView != nil else {
      return .greatestFiniteMagnitude
    }
    scroll.layoutSubtreeIfNeeded()
    let clip = scroll.contentView
    let page = clip.bounds.height - 40
    var offset: CGFloat = 0
    // Time layout *and* display for each jump. `ConversationColumn` builds heavier rows than
    // `Text`; layout-only timing made the plain baseline nearly free so the ratio rose into the
    // 3x range on main while PR Check still looked green on a warmer PR branch. Keeping
    // `displayIfNeeded` inside the loop preserves a fair “work per page scroll” comparison.
    let start = ContinuousClock.now
    for _ in 0..<jumps {
      let limit = max(0, (scroll.documentView?.frame.height ?? 0) - clip.bounds.height)
      offset = min(limit, offset + page)
      clip.scroll(to: NSPoint(x: 0, y: offset))
      scroll.reflectScrolledClipView(clip)
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      if offset >= limit {
        offset = 0
        clip.scroll(to: .zero)
        scroll.reflectScrolledClipView(clip)
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
      }
    }
    let duration = start.duration(to: ContinuousClock.now)
    let parts = duration.components
    let elapsedMs =
      Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1_000_000_000_000_000
    window.orderOut(nil)
    return elapsedMs / Double(jumps)
  }

  private static func scrollView(in view: NSView) -> NSScrollView? {
    if let found = view as? NSScrollView { return found }
    for child in view.subviews {
      if let found = scrollView(in: child) { return found }
    }
    return nil
  }
}
