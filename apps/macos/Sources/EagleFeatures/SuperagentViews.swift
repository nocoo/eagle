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

  public init(
    model: SuperagentWorkspaceViewModel, layout: ShellLayoutViewModel, focusRestore: Int
  ) {
    self.model = model
    self.layout = layout
    self.focusRestore = focusRestore
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
        showsInspector: false,
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
        focusRestore: focusRestore,
        allowsInspector: false,
        showsComposerAccessories: false
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

/// The independent configuration page: its own service API, never the worker gateway.
public struct SuperagentSettingsPage: View {
  @ObservedObject private var model: SuperagentSettingsViewModel
  private let levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

  public init(model: SuperagentSettingsViewModel) { self.model = model }

  public var body: some View {
    VStack(alignment: .leading, spacing: Theme.Layout.sectionGap) {
      if let failure = model.failure {
        SettingsStatusNote(failure, kind: .failure)
      }
      if let notice = model.notice {
        SettingsStatusNote(notice, kind: .success)
      }
      SettingsCard {
        VStack(spacing: 0) {
          SettingsSectionHeader(
            "Super Bot 模型", detail: "独立进程自己的模型，不使用 Bot 网关",
            trailing: { EmptyView() })
          Divider().overlay(Theme.Palette.line)
          SettingsSectionRow("地址", detail: "OpenAI 兼容地址，例如 http://127.0.0.1:3425/v1") {
            SettingsTextField("https://…/v1", text: $model.baseUrl)
              .frame(width: Theme.Form.fieldWidth)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsSectionRow(
            "API Key",
            detail: model.hasApiKey ? "已保存；留空保存则保持不变" : "与服务匹配的密钥"
          ) {
            SettingsTextField(model.hasApiKey ? "已保存" : "sk-…", text: $model.apiKey, secure: true)
              .frame(width: Theme.Form.fieldWidth)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsSectionRow("模型", detail: "请求使用的模型 id") {
            SettingsTextField("模型 id", text: $model.model)
              .frame(width: Theme.Form.fieldWidth)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsSectionRow("思考等级", detail: "随每个请求发送，不做静默降级") {
            PillSelect(
              "思考等级",
              options: levels.map { .init($0, $0) },
              selection: $model.thinkingLevel
            )
          }
          Divider().overlay(Theme.Palette.line)
          HStack(spacing: Theme.Layout.controlGap) {
            SettingsActionButton("保存", prominent: true) {
              Task { await model.save() }
            }
            .disabled(model.saving)
            if model.hasApiKey {
              SettingsActionButton("清除密钥") {
                Task { await model.clearKey() }
              }
              .disabled(model.saving)
            }
            Spacer(minLength: 0)
          }
          .padding(Theme.Layout.sectionInset)
        }
      }
    }
    .task { await model.load() }
    .onDisappear { Task { await model.close() } }
  }
}
