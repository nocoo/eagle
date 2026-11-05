import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Prepared transcript layout")
struct MarkdownLayoutTests {
  @Test("wide viewports do not stretch a long user message's reading measure")
  func userReadingCap() {
    let text = String(repeating: "中英文 mixed text for a long message. ", count: 60)
    let wide = NSHostingView(rootView: UserBubble(text).frame(width: 1200))
    let wider = NSHostingView(rootView: UserBubble(text).frame(width: 1600))
    #expect(wide.fittingSize.height > Theme.Metric.rowHeight)
    #expect(abs(wide.fittingSize.height - wider.fittingSize.height) < 1)
  }

  @Test("a long answer has its full height on the first layout")
  func firstLayout() async throws {
    let text = String(repeating: "A paragraph with **bold** text.\n\n", count: 20)
    let prepared = try await MarkdownRenderer().render(text)
    let host = NSHostingView(
      rootView: AssistantBubble(text: text, preparedBlocks: prepared).frame(width: 500))
    #expect(host.fittingSize.height > 400)
  }
}
