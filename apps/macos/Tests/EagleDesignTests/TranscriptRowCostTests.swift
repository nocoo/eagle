import AppKit
import Foundation
import SwiftUI
import Testing

@testable import EagleDesign

/// Rich transcript rows vs plain `Text` with the same words (commit `cbffb5b`), both in
/// [`TranscriptScrollColumn`]. Bubble timings in the same loop are **diagnostic only** (no gate):
/// CI has shown wrapper≈1.0× while rich/Text≈4×, so the regression budget applies to rich vs Text.
@MainActor
@Suite("Transcript row cost", .serialized)
struct TranscriptRowCostTests {
  @Test("a page of conversation rows costs little more than plain text rows")
  func pageCost() {
    Self.logRunContext()
    let entries = Self.entries(turns: 40)
    let markdown = Self.prepared(entries)
    Self.logPreparedFixture(
      label: "gate", entries: entries, prepared: markdown,
      note: "flattened single .paragraph(AttributedString) per assistant"
    )
    let rich = Self.transcriptRows(entries, preparedMarkdown: markdown)
    let plain = Self.plainTextShell(entries)
    let bubbleDirect = Self.baselineBubbleRows(entries, preparedMarkdown: markdown)
    for _ in 0..<2 {
      _ = Self.pageCost(rich)
      _ = Self.pageCost(plain)
      _ = Self.pageCost(bubbleDirect)
    }

    // Balance measure order across the six permutations so no single variant sits in the middle
    // every round (diagnostics + fairer paired ratios).
    let orderings: [Ordering] = [.rtb, .rbt, .trb, .tbr, .brt, .btr]

    var ratiosVsText: [Double] = []
    var ratiosVsBubble: [Double] = []

    for round in 0..<9 {
      let ord = orderings[round % orderings.count]
      var msRich = 0.0
      var msText = 0.0
      var msBubble = 0.0
      for step in ord.steps {
        switch step {
        case .rich: msRich = Self.pageCost(rich)
        case .text: msText = Self.pageCost(plain)
        case .bubble: msBubble = Self.pageCost(bubbleDirect)
        }
      }
      let rt = msRich / max(msText, 0.000_001)
      let rb = msRich / max(msBubble, 0.000_001)
      ratiosVsText.append(rt)
      ratiosVsBubble.append(rb)
      print(
        "ROWCOST sample r=\(round) perm=\(ord.label) ms_rich=\(Self.fmt(msRich)) "
          + "ms_text=\(Self.fmt(msText)) ms_bubble=\(Self.fmt(msBubble)) "
          + "rat_rt=\(Self.fmt(rt)) rat_rb=\(Self.fmt(rb))")
    }

    let medianVsText = Self.median(ratiosVsText) ?? .greatestFiniteMagnitude
    let medianVsBubble = Self.median(ratiosVsBubble) ?? 0
    print(
      "ROWCOST vs_text rounds=\(ratiosVsText.map { Self.fmt($0) }.joined(separator: ",")) "
        + "median=\(Self.fmt(medianVsText)) "
        + "vs_bubble rounds=\(ratiosVsBubble.map { Self.fmt($0) }.joined(separator: ",")) "
        + "median=\(Self.fmt(medianVsBubble)) jumps=\(Self.jumpsPerSample)")
    #expect(
      medianVsText < 2.5,
      "rich rows vs plain Text: median ratio \(Self.fmt(medianVsText)) (budget 2.5)"
    )
  }

  /// Assistant-only rows with a single `.paragraph` prepared block (AttributedString), same
  /// rendering path as `prepared()` in this file. Does not prove or disprove fenced **code**
  /// blocks — those are flattened to paragraph AttributedString here anyway; it narrows
  /// **corpus/row mix** vs the default `entries` transcript.
  @Test("ROWCOST experiment: assistant paragraphs only (diagnostic)")
  func paragraphOnlyAssistantExperiment() {
    Self.logRunContext()
    let line =
      "这一段用来模拟真实回答的长度，中英文混排，带 `inline code` 与 **粗体**。"
    let entries: [TranscriptEntry] = (0..<40).map { index in
      .assistant(id: "p\(index)", blocks: [.paragraph(line)])
    }
    let prepared: [String: [RenderedMarkdownBlock]] = Dictionary(
      uniqueKeysWithValues: entries.compactMap { entry -> (String, [RenderedMarkdownBlock])? in
        guard case .assistant(let id, _, _) = entry else { return nil }
        return (id, [.paragraph(AttributedString(line))])
      })
    for _ in 0..<2 {
      _ = Self.pageCost(Self.transcriptRows(entries, preparedMarkdown: prepared))
      _ = Self.pageCost(Self.plainTextShell(entries))
    }
    let msRich = Self.pageCost(Self.transcriptRows(entries, preparedMarkdown: prepared))
    let msText = Self.pageCost(Self.plainTextShell(entries))
    print(
      "ROWCOST_EXPT paragraph_only count=\(entries.count) ms_rich=\(Self.fmt(msRich)) "
        + "ms_text=\(Self.fmt(msText)) rat=\(Self.fmt(msRich / max(msText, 0.000_001)))")
  }

  /// Slices the same corpus by role to localize cost (diagnostic only; always passes).
  @Test("ROWCOST slice diagnostics (assistant vs user/note vs Text)")
  func sliceDiagnostics() {
    Self.logRunContext()
    let entries = Self.entries(turns: 40)
    let markdown = Self.prepared(entries)
    Self.logPreparedFixture(
      label: "gate", entries: entries, prepared: markdown,
      note: "flattened single .paragraph(AttributedString) per assistant"
    )
    let assistants = entries.filter { entry in
      if case .assistant = entry { return true }
      return false
    }
    let usersAndNotes = entries.filter { entry in
      switch entry {
      case .user, .note: return true
      default: return false
      }
    }
    let warm = {
      _ = Self.pageCost(Self.transcriptRows(assistants, preparedMarkdown: markdown))
      _ = Self.pageCost(Self.plainTextShell(assistants))
      _ = Self.pageCost(Self.transcriptRows(usersAndNotes, preparedMarkdown: markdown))
      _ = Self.pageCost(Self.plainTextShell(usersAndNotes))
    }
    for _ in 0..<2 { warm() }

    let aRich = Self.pageCost(Self.transcriptRows(assistants, preparedMarkdown: markdown))
    let aText = Self.pageCost(Self.plainTextShell(assistants))
    let uRich = Self.pageCost(Self.transcriptRows(usersAndNotes, preparedMarkdown: markdown))
    let uText = Self.pageCost(Self.plainTextShell(usersAndNotes))

    print(
      "ROWCOST_DIAG assistant count=\(assistants.count) ms_rich=\(Self.fmt(aRich)) "
        + "ms_text=\(Self.fmt(aText)) rat=\(Self.fmt(aRich / max(aText, 0.000_001)))")
    print(
      "ROWCOST_DIAG user_note count=\(usersAndNotes.count) ms_rich=\(Self.fmt(uRich)) "
        + "ms_text=\(Self.fmt(uText)) rat=\(Self.fmt(uRich / max(uText, 0.000_001)))")
  }

  /// [`MarkdownRenderer`]-prepared assistant markdown (real `.code`, etc.) in the same row shell;
  /// paragraph path only swaps `MarkdownInline` for `Text(AttributedString)` with the same
  /// font/lineSpacing/fixedSize. **Diagnostic only** — not a hotspot proof. Gate unchanged.
  @Test("ROWCOST experiment: production-prepared blocks vs plain paragraph Text (diagnostic)")
  func productionPreparedVsPlainAttributedParagraph() {
    Self.logRunContext()
    let entries = Self.entries(turns: 40)
    let preparedProduction = Self.productionPreparedMarkdown(entries)
    Self.logPreparedFixture(
      label: "expt_prod_prepared", entries: entries, prepared: preparedProduction,
      note: "MarkdownRenderer.blocks(from:) multi-block prepared map"
    )
    let prodView = Self.transcriptRows(
      entries, preparedMarkdown: preparedProduction, paragraphMode: .productionMarkdownInline)
    let plainView = Self.transcriptRows(
      entries, preparedMarkdown: preparedProduction,
      paragraphMode: .plainTextWithParagraphStyling)
    let warm = {
      _ = Self.pageCost(prodView)
      _ = Self.pageCost(plainView)
    }
    for _ in 0..<2 { warm() }
    let msProd = Self.pageCost(prodView)
    let msPlain = Self.pageCost(plainView)
    print(
      "ROWCOST_EXPT prod_prepared vs plain_attributed_paragraph ms_prod=\(Self.fmt(msProd)) "
        + "ms_plain=\(Self.fmt(msPlain)) rat=\(Self.fmt(msProd / max(msPlain, 0.000_001))) "
        + "(MarkdownRenderer blocks + bubble shell; paragraph only differs)"
    )
  }

  private enum Kind {
    case rich
    case text
    case bubble
  }

  private enum Ordering {
    case rtb, rbt, trb, tbr, brt, btr

    var label: String {
      switch self {
      case .rtb: return "RTB"
      case .rbt: return "RBT"
      case .trb: return "TRB"
      case .tbr: return "TBR"
      case .brt: return "BRT"
      case .btr: return "BTR"
      }
    }

    var steps: [Kind] {
      switch self {
      case .rtb: return [.rich, .text, .bubble]
      case .rbt: return [.rich, .bubble, .text]
      case .trb: return [.text, .rich, .bubble]
      case .tbr: return [.text, .bubble, .rich]
      case .brt: return [.bubble, .rich, .text]
      case .btr: return [.bubble, .text, .rich]
      }
    }
  }

  private static func fmt(_ x: Double) -> String { String(format: "%.3f", x) }

  /// Matches `pageCost` measurement: one timed loop's jump count (printed as `jumps=`).
  private static let jumpsPerSample = 24

  private static func logRunContext() {
    let env = ProcessInfo.processInfo.environment
    let ref = env["GITHUB_REF"] ?? ""
    let event = env["GITHUB_EVENT_NAME"] ?? ""
    let job = env["GITHUB_JOB"] ?? ""
    let ramGb = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
    let fixture = env["EAGLE_COMPOSER_FOCUS_FIXTURE"] ?? ""
    print(
      "ROWCOST_CTX ref=\(ref) event=\(event) job=\(job) ram_gb=\(String(format: "%.1f", ramGb)) "
        + "ci=\(env["CI"] ?? "") EAGLE_COMPOSER_FOCUS_FIXTURE=\(fixture)"
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

  /// Same string pipeline as [`MarkdownViewModel`] / [`AssistantBubble`] when `preparedBlocks` are
  /// absent: fenced code, block quotes, tables — not flattened to one paragraph.
  private static func productionPreparedMarkdown(_ entries: [TranscriptEntry])
    -> [String: [RenderedMarkdownBlock]]
  {
    var out: [String: [RenderedMarkdownBlock]] = [:]
    for entry in entries {
      guard case .assistant(let id, let blocks, _) = entry else { continue }
      out[id] = MarkdownRenderer.blocks(from: blocks.markdown)
    }
    return out
  }

  /// Documents transcript assistant rows vs the **actual** `prepared` map passed into the test.
  private static func logPreparedFixture(
    label: String,
    entries: [TranscriptEntry],
    prepared: [String: [RenderedMarkdownBlock]],
    note: String
  ) {
    var assistantFromBlocks = 0
    var noteBlocksInTranscript = 0
    for entry in entries {
      guard case .assistant(_, let blocks, _) = entry else { continue }
      assistantFromBlocks += 1
      for block in blocks {
        if case .note = block { noteBlocksInTranscript += 1 }
      }
    }
    var renderedKinds: [String: Int] = [:]
    for blocks in prepared.values {
      for block in blocks {
        let kind: String
        switch block {
        case .paragraph: kind = "paragraph"
        case .heading: kind = "heading"
        case .bullets: kind = "bullets"
        case .code: kind = "code"
        case .quote: kind = "quote"
        case .table: kind = "table"
        }
        renderedKinds[kind, default: 0] += 1
      }
    }
    let kinds =
      renderedKinds.sorted { $0.key < $1.key }
      .map { "\($0.key)=\($0.value)" }
      .joined(separator: ",")
    print(
      "ROWCOST_FIXTURE label=\(label) assistant_entries=\(assistantFromBlocks) "
        + "prepared_map=\(prepared.count) note_blocks_in_source=\(noteBlocksInTranscript) "
        + "rendered_block_kinds=\(kinds) (\(note))"
    )
  }

  private static func transcriptRows(
    _ entries: [TranscriptEntry], preparedMarkdown: [String: [RenderedMarkdownBlock]],
    paragraphMode: AssistantBubbleParagraphExperiment = .productionMarkdownInline
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
        .environment(\.assistantBubbleParagraphExperiment, paragraphMode)
      }
    }
  }

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
