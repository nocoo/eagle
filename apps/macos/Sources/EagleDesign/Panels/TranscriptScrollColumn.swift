import SwiftUI

/// Scroll chrome shared by [`ConversationColumn`] and perf tests: `ScrollViewReader`,
/// `GeometryReader` min-height, edge fades, and transcript scroll bookkeeping. Benchmarks should
/// wrap **only** differing row content in this shell so ratios reflect row cost, not structural
/// differences between a bare `ScrollView` and this tree.
struct TranscriptScrollColumn<Content: View>: View {
  @ViewBuilder private let content: () -> Content

  @State private var scroller = TranscriptScroller()
  @State private var composerFocusRequest = 0

  init(@ViewBuilder content: @escaping () -> Content) {
    self.content = content
  }

  var body: some View {
    ScrollViewReader { proxy in
      GeometryReader { viewport in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
            content()
            Theme.Palette.clear.frame(height: Theme.Metric.hairline).id("bottom")
          }
          .padding(.horizontal, Theme.Metric.conversationInset)
          .frame(maxWidth: Theme.Chat.laneMaxWidth)
          .frame(maxWidth: .infinity)
          // Clear of the top edge fade: the first row must not start under it.
          .padding(.top, Theme.Metric.edgeFadeHeight + Theme.Chat.transcriptTopClearance)
          .padding(.bottom, Theme.Chat.transcriptBottomInset)
          .frame(minHeight: viewport.size.height, alignment: .top)
          // The document's background catches only blank space, behind message controls.
          .background {
            Theme.Palette.clear
              .contentShape(Rectangle())
              .onTapGesture { composerFocusRequest += 1 }
              .accessibilityHidden(true)
          }
        }
        .scrollEdgeFades(
          Theme.Palette.surface, top: Theme.Metric.edgeFadeHeight,
          bottom: Theme.Metric.edgeFadeHeight
        )
        .onScrollPhaseChange { _, phase in
          scroller.setUserScrolling(
            phase == .tracking || phase == .interacting || phase == .decelerating)
          if phase == .idle, scroller.endUserScroll() {
            proxy.scrollTo("bottom", anchor: .bottom)
          }
        }
        .onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
          TranscriptScrollMetrics(
            contentHeight: geometry.contentSize.height, visibleBottom: geometry.visibleRect.maxY
          )
        } action: { _, metrics in
          if scroller.update(metrics) {
            proxy.scrollTo("bottom", anchor: .bottom)
          }
        }
      }
    }
  }
}
