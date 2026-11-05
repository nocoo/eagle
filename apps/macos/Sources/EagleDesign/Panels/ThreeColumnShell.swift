import SwiftUI

/// The whole window: sidebar, conversation, inspector. Side columns collapse
/// with a slide; their dividers drag to resize.
public struct ThreeColumnShell<Sidebar: View, Conversation: View, Inspector: View>: View {
  private let sidebar: Sidebar
  private let conversation: Conversation
  private let inspector: Inspector
  private let showsSidebar: Bool
  private let showsInspector: Bool
  private let availableWidth: CGFloat
  private let sidebarWidth: CGFloat
  private let inspectorWidth: CGFloat
  private let onResizeSidebar: (CGFloat) -> Void
  private let onResizeInspector: (CGFloat) -> Void

  public init(
    availableWidth: CGFloat,
    showsSidebar: Bool = true,
    showsInspector: Bool = true,
    sidebarWidth: CGFloat = Theme.Metric.sidebarWidth,
    inspectorWidth: CGFloat = Theme.Metric.inspectorWidth,
    onResizeSidebar: @escaping (CGFloat) -> Void = { _ in },
    onResizeInspector: @escaping (CGFloat) -> Void = { _ in },
    @ViewBuilder sidebar: () -> Sidebar,
    @ViewBuilder conversation: () -> Conversation,
    @ViewBuilder inspector: () -> Inspector
  ) {
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.availableWidth = availableWidth
    self.sidebarWidth = sidebarWidth
    self.inspectorWidth = inspectorWidth
    self.onResizeSidebar = onResizeSidebar
    self.onResizeInspector = onResizeInspector
    self.sidebar = sidebar()
    self.conversation = conversation()
    self.inspector = inspector()
  }

  public var body: some View {
    HStack(spacing: 0) {
      if showsSidebar {
        sidebar
          .frame(width: sidebarWidth)
          .transition(.move(edge: .leading).combined(with: .opacity))
      }

      conversation
        .frame(maxWidth: .infinity)
        .overlay(alignment: .leading) {
          if showsSidebar {
            ResizeHandle(
              width: sidebarWidth,
              minimum: Theme.Metric.sidebarMinWidth,
              maximum: min(
                Theme.Metric.sidebarMaxWidth,
                availableWidth - Theme.Metric.conversationMinWidth
                  - (showsInspector ? inspectorWidth : 0)),
              onChange: onResizeSidebar
            )
            .offset(x: -Theme.Metric.resizeOverhang)
          }
        }
        .overlay(alignment: .trailing) {
          if showsInspector {
            ResizeHandle(
              width: inspectorWidth,
              minimum: Theme.Metric.inspectorMinWidth,
              maximum: min(
                Theme.Metric.inspectorMaxWidth,
                availableWidth - Theme.Metric.conversationMinWidth
                  - (showsSidebar ? sidebarWidth : 0)),
              inverted: true,
              onChange: onResizeInspector
            )
            .offset(x: Theme.Metric.resizeOverhang)
          }
        }

      if showsInspector {
        inspector
          .frame(width: inspectorWidth)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
    .animation(Theme.Motion.columns, value: showsSidebar)
    .animation(Theme.Motion.columns, value: showsInspector)
  }
}
