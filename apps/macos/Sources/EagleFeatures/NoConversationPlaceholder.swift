import EagleDesign
import SwiftUI

/// Shown when no conversation is selected: real bots only, no sample transcript to fall back
/// on once the sample data is switched off.
struct NoConversationPlaceholder: View {
  let onCreate: () -> Void
  let onShowSidebar: () -> Void
  let showsSidebar: Bool
  /// The Bots daemon could not be reached: say so and offer one explicit retry instead of
  /// leaving an empty window that only a person who knows the daemon would understand.
  var daemonMessage: String?
  var onRetry: (() -> Void)?

  var body: some View {
    VStack(spacing: Theme.Layout.controlGap) {
      Text(daemonMessage == nil ? "没有打开的对话" : "Bots daemon 未连接")
        .font(Theme.TypeScale.bodyEmphasis)
        .foregroundStyle(Theme.Palette.textPrimary)
      Text(daemonMessage ?? "从侧栏选一个 Bot，或者新建一个")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: Theme.Page.emptyMaxWidth)
      if let onRetry {
        SettingsActionButton("重新连接", prominent: true, action: onRetry)
          .padding(.top, Theme.Layout.detailGap)
        SettingsActionButton("新建 Bot", action: onCreate)
      } else {
        SettingsActionButton("新建 Bot", prominent: true, action: onCreate)
          .padding(.top, Theme.Layout.detailGap)
      }
      if !showsSidebar {
        IconButton(
          systemName: "sidebar.left", label: "展开侧栏", style: .circled, action: onShowSidebar
        )
        .padding(.top, Theme.Layout.labelGap)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }
}
