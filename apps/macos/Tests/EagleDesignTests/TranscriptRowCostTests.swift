import AppKit
import Foundation
import SwiftUI
import Testing

@testable import EagleDesign

/// Rows must stay within a small multiple of **plain `Text`** with the same words (commit
/// `cbffb5b`): affordances such as copy controls and `textSelection` must not multiply per-row
/// work for rows nobody is hovering. Both sides use [`TranscriptScrollColumn`] so the shell
/// matches production without charging header/composer.
///
/// **Secondary:** `TranscriptEntryRow` vs direct bubble/note views catches wrapper/transitions
/// regressions without replacing the Text baseline (`TranscriptScrollCostTests` already covers
/// scroll bookkeeping vs bare stacks, not this ratio).
@MainActor
@Suite("Transcript row cost", .serialized)
struct TranscriptRowCostTests {
  @Test(
    "a page of conversation rows costs little more than plain text rows, and little more wrapped than direct bubbles"
  )
  func pageCost() {
    Self.logRunContext()
    let entries = Self.entries(turns: 40)
    let markdown = Self.prepared(entries)
    let transcriptRows = Self.transcriptRows(entries, preparedMarkdown: markdown)
    let plainTextShell = Self.plainTextShell(entries)
    let baselineBubbleRows = Self.baselineBubbleRows(entries, preparedMarkdown: markdown)
    for _ in 0..<2 {
      _ = Self.pageCost(transcriptRows)
      _ = Self.pageCost(plainTextShell)
      _ = Self.pageCost(baselineBubbleRows)
    }

    var ratiosVsText: [Double] = []
    var ratiosVsBubble: [Double] = []
    var richMsSamples: [Double] = []
    var textMsSamples: [Double] = []
    var bubbleMsSamples: [Double] = []

    for round in 0..<9 {
      let textMs: Double
      let bubbleMs: Double
      let richMs: Double
      // One rich sample per round; pair it with plain Text and direct bubbles (order alternates).
      if round.isMultiple(of: 2) {
        textMs = Self.pageCost(plainTextShell)
        bubbleMs = Self.pageCost(baselineBubbleRows)
        richMs = Self.pageCost(transcriptRows)
      } else {
        richMs = Self.pageCost(transcriptRows)
        bubbleMs = Self.pageCost(baselineBubbleRows)
        textMs = Self.pageCost(plainTextShell)
      }
      richMsSamples.append(richMs)
      textMsSamples.append(textMs)
      bubbleMsSamples.append(bubbleMs)
      ratiosVsText.append(richMs / max(textMs, 0.000_001))
      ratiosVsBubble.append(richMs / max(bubbleMs, 0.000_001))
    }

    let medianVsText = Self.median(ratiosVsText) ?? .greatestFiniteMagnitude
    let medianVsBubble = Self.median(ratiosVsBubble) ?? .greatestFiniteMagnitude
    let richMed = Self.median(richMsSamples) ?? 0
    let textMed = Self.median(textMsSamples) ?? 0
    let bubbleMed = Self.median(bubbleMsSamples) ?? 0
    print(
      "ROWCOST vs_text rounds=\(ratiosVsText.map { String(format: "%.2f", $0) }.joined(separator: ",")) "
        + "median=\(String(format: "%.2f", medianVsText)) "
        + "vs_bubble rounds=\(ratiosVsBubble.map { String(format: "%.2f", $0) }.joined(separator: ",")) "
        + "median=\(String(format: "%.2f", medianVsBubble)) "
        + "ms_rich_med=\(String(format: "%.3f", richMed)) "
        + "ms_text_med=\(String(format: "%.3f", textMed)) "
        + "ms_bubble_med=\(String(format: "%.3f", bubbleMed)) "
        + "jumps=\(Self.jumpsPerSample)")
    #expect(
      medianVsText < 2.5,
      "rich rows vs plain Text: median ratio \(String(format: "%.2f", medianVsText)) (budget 2.5)"
    )
    // Wrapper/transitions on top of bubble bodies: tightened from observed ~0.98 on CI when healthy.
    #expect(
      medianVsBubble < 1.2,
      "TranscriptEntryRow vs direct bubbles: median ratio \(String(format: "%.2f", medianVsBubble)) (budget 1.2)"
    )
  }

  /// Matches `pageCost` measurement: one timed loop's jump count (printed as `jumps=`).
  private static let jumpsPerSample = 24

  private static func logRunContext() {
    let env = ProcessInfo.processInfo.environment
    let ref = env["GITHUB_REF"] ?? ""
    let event = env["GITHUB_EVENT_NAME"] ?? ""
    let job = env["GITHUB_JOB"] ?? ""
    let ramGb = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
    print(
      "ROWCOST_CTX ref=\(ref) event=\(event) job=\(job) ram_gb=\(String(format: "%.1f", ramGb)) "
        + "ci=\(env["CI"] ?? "")"
    )
  }

  private static func median(_ values: [Double]) -> Double? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let mid = sorted.count / 2
    if sorted.count % 2 == 1 {
      return sorted[mid]
    }
    return (sorted[mid - 1] + sorted[mid]) / 2
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

  private static func transcriptRows(
    _ entries: [TranscriptEntry], preparedMarkdown: [String: [RenderedMarkdownBlock]]
  ) -> some View {
    TranscriptScrollColumn(focusRequestCounter: .constant(0)) {
      ForEach(entries) { entry in
        TranscriptEntryRow(
          entry: entry,
          preparedMarkdown: preparedMarkdown,
          onOpenPeerExchange: nil,
          onAnswerCard: nil,
          onAnswerSecret: nil
        )
        .id(entry.id)
      }
    }
  }

  /// Same words as bubbles, minimal `Text` rows (cbffb5b baseline intent).
  private static func plainTextShell(_ entries: [TranscriptEntry]) -> some View {
    TranscriptScrollColumn(focusRequestCounter: .constant(0)) {
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
  }

  /// Direct bubble/note bodies without `TranscriptEntryRow` (secondary wrapper guard).
  private static func baselineBubbleRows(
    _ entries: [TranscriptEntry], preparedMarkdown: [String: [RenderedMarkdownBlock]]
  ) -> some View {
    TranscriptScrollColumn(focusRequestCounter: .constant(0)) {
      ForEach(entries) { entry in
        switch entry {
        case .user(_, let text, let origin):
          UserBubble(text, origin: origin)
        case .assistant(_, let blocks, _):
          AssistantBubble(text: blocks.markdown, preparedBlocks: preparedMarkdown[entry.id])
            .equatable()
        case .note(_, let text, let tints):
          DeliveryNote(text, avatars: tints.map(Theme.Palette.avatarTint))
        default:
          EmptyView()
        }
      }
    }
  }

  /// Milliseconds for one page-sized jump; each jump materializes a fresh viewport of rows.
  private static func pageCost(_ view: some View) -> Double {
    let jumps = jumpsPerSample
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
