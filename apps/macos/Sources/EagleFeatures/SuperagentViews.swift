import EagleDesign
import SuperagentCore
import SuperagentFeatures
import SwiftUI

/// Native conversation for the Super Bot. It reads the independent chat state and never
/// opens a worker catalog, socket or view model.
public struct SuperagentConversationContent: View {
  @ObservedObject private var model: SuperagentWorkspaceViewModel
  private let layout: ShellLayoutViewModel
  private let focusRestore: Int
  private let showsInspector: Bool

  public init(
    model: SuperagentWorkspaceViewModel, layout: ShellLayoutViewModel, focusRestore: Int,
    showsInspector: Bool
  ) {
    self.model = model
    self.layout = layout
    self.focusRestore = focusRestore
    self.showsInspector = showsInspector
  }

  public var body: some View {
    VStack(spacing: 0) {
      if let failure = model.chat.failure {
        SuperagentNotice(
          text: failureText(failure),
          action: failure.code == .storageFailed || failure.code == .taskParked
            ? "重启服务" : nil
        ) {
          Task { await model.reconnect() }
        }
      }
      if let pending = model.chat.unconfirmed.first {
        SuperagentNotice(
          text: pending.text, action: "重试未确认发送",
          perform: { Task { await model.chat.retry() } })
      }
      if !model.chat.modelReady {
        SuperagentNotice(text: "尚未配置模型。请在设置 → Super Bot 填写地址与模型。", action: nil) {}
      }
      if model.chat.canLoadOlder {
        HStack {
          Spacer(minLength: 0)
          SettingsActionButton("加载更早") {
            Task { await model.chat.loadOlder() }
          }
          Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Layout.rowGap)
      }
      ConversationColumn(
        title: "Super Bot",
        tintIndex: 4,
        entries: entries,
        showsToolCalls: false,
        queuedMessages: queued,
        draft: Binding(
          get: { model.chat.draft }, set: { model.chat.draft = $0 }),
        onSend: { Task { await model.chat.send() } },
        showsSidebar: layout.showsSidebar,
        showsInspector: showsInspector,
        participantStatus: ParticipantStatus(
          label: model.statusLine,
          phase: model.chat.isRunning ? .working : (model.isReady ? .idle : .offline),
          canStop: model.chat.isRunning,
          canRecover: !model.isReady,
          canRetry: !model.isReady,
          error: model.chat.error
        ),
        isWaiting: model.chat.isRunning && !entries.contains(where: { isStreaming($0) }),
        onStop: { Task { await model.chat.stop() } },
        onRecover: { Task { await model.reconnect() } },
        onRetryConnection: { Task { await model.reconnect() } },
        onDismissError: { model.chat.dismissError() },
        onShowSidebar: { layout.toggleSidebar() },
        onToggleInspector: { layout.toggleInspector() },
        focusRestore: focusRestore
      )
    }
  }

  private var entries: [TranscriptEntry] {
    ChatPresentation.rows(model.chat.state).map { row in
      switch row.kind {
      case .user:
        return .user(id: row.id, text: row.text, origin: nil)
      case .streaming:
        return .streamingAssistant(id: row.id, blocks: [.paragraph(row.text)])
      case .aborted:
        return .assistant(id: row.id, blocks: [.note("已停止，回答未完成"), .paragraph(row.text)])
      case .failed:
        return .assistant(id: row.id, blocks: [.note("回答失败"), .paragraph(row.text)])
      case .queued:
        return .user(id: row.id, text: row.text, origin: nil)
      case .assistant:
        return .assistant(id: row.id, blocks: [.paragraph(row.text)])
      }
    }
  }

  private var queued: [String: QueuedMessage] {
    ChatPresentation.queuedRequests(model.chat.state).mapValues {
      QueuedMessage(requestId: $0)
    }
  }

  private func isStreaming(_ entry: TranscriptEntry) -> Bool {
    if case .streamingAssistant = entry { return true }
    return false
  }

  private func failureText(_ failure: ServiceFailure) -> String {
    switch failure.code {
    case .storageFailed: return "Super Bot 存储不可用；历史没有被替换。"
    case .taskParked: return "上次回答被中断，服务需要重启后再试。"
    case .modelTimeout: return "模型请求超时；没有自动重发。"
    case .modelAuthentication: return "模型凭据被拒绝，请检查 Super Bot 设置。"
    case .modelError: return "模型未能完成回答。"
    }
  }
}

private struct SuperagentNotice: View {
  let text: String
  let action: String?
  let perform: () -> Void

  var body: some View {
    HStack(spacing: Theme.Layout.rowGap) {
      Text(text)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      Spacer(minLength: 0)
      if let action {
        SettingsActionButton(action, action: perform)
      }
    }
    .padding(.horizontal, Theme.Metric.conversationInset)
    .padding(.vertical, Theme.Layout.rowGap)
    .background(Theme.Palette.surface)
  }
}
