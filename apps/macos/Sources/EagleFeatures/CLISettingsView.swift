import EagleDesign
import SwiftUI

/// Settings → CLI: one switch for the command line client, the credentials it uses, and the
/// document another agent reads (docs/bots/CLI.md).
public struct CLISettingsView: View {
  @ObservedObject private var model: CLISettingsViewModel
  @State private var newName = ""
  @State private var newScopes: Set<String> = ["read", "write"]
  @State private var showsIssueRow = false

  public init(model: CLISettingsViewModel = CLISettingsViewModel()) {
    self.model = model
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      serviceCard
      if let token = model.issuedToken {
        issuedCard(token)
      }
      credentialsCard
      skillCard
      if let failure = model.failure {
        Text(failure)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.destructive)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("cli.failure")
      }
      if let message = model.message {
        Text(message)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .task { await model.load() }
  }

  private var serviceCard: some View {
    SettingsCard {
      VStack(spacing: 0) {
        SettingsRow(
          "本机 CLI",
          detail: model.canInstall
            ? "让其他 agent 用 \(model.commandName) 管理 Bot 并和它们对话"
            : "源码运行时没有内置 CLI，只能查看与撤销凭据"
        ) {
          HStack(spacing: 10) {
            if model.busy { SpinnerArc(size: 12) }
            Toggle("", isOn: installBinding)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
              .disabled(model.busy || (!model.installed && !model.canInstall))
              .accessibilityIdentifier("cli.switch")
              .accessibilityLabel("启用本机 CLI")
          }
        }
        Divider().overlay(Theme.Palette.line)
        SettingsRow("命令", detail: model.linkLabel) {
          Text(model.commandName)
            .font(Theme.TypeScale.mono)
            .foregroundStyle(Theme.Palette.textPrimary)
            .textSelection(.enabled)
        }
        Divider().overlay(Theme.Palette.line)
        SettingsRow("配置", detail: model.configLabel) {
          Text(model.binaryLabel)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
        if let hint = model.pathHint {
          Divider().overlay(Theme.Palette.line)
          Text(hint)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textMuted)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
            .accessibilityIdentifier("cli.pathHint")
        }
      }
    }
  }

  private var installBinding: Binding<Bool> {
    Binding(
      get: { model.installed },
      set: { next in Task { next ? await model.enable() : await model.disable() } }
    )
  }

  /// The secret exists in this card and nowhere else: it is never shown again.
  private func issuedCard(_ token: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SettingsCaption("新凭据只显示这一次，请立刻复制给要使用它的 agent。")
      SettingsCard {
        HStack(spacing: 10) {
          Text(token)
            .font(Theme.TypeScale.mono)
            .foregroundStyle(Theme.Palette.textPrimary)
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)
            .accessibilityIdentifier("cli.token")
          Spacer(minLength: 0)
          SettingsActionButton("复制") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(token, forType: .string)
          }
          SettingsActionButton("完成") { model.dismissIssuedToken() }
        }
        .padding(.vertical, 14)
      }
    }
  }

  private var credentialsCard: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        SettingsCaption("凭据")
        Spacer(minLength: 0)
        SettingsActionButton("新建凭据", prominent: true) {
          showsIssueRow.toggle()
          model.dismissIssuedToken()
        }
        .disabled(model.busy)
      }
      SettingsCard {
        VStack(spacing: 0) {
          if showsIssueRow {
            issueRow
            Divider().overlay(Theme.Palette.line)
          }
          if model.clients.isEmpty {
            Text("还没有 CLI 凭据")
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.vertical, 14)
          }
          ForEach(Array(model.clients.enumerated()), id: \.element.id) { index, client in
            if index > 0 { Divider().overlay(Theme.Palette.line) }
            row(client)
          }
        }
      }
    }
  }

  private var issueRow: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        SettingsTextField("名称，例如 claude-code", text: $newName)
          .frame(maxWidth: .infinity)
          .accessibilityLabel("凭据名称")
        SettingsActionButton("生成", prominent: true) {
          Task {
            await model.issue(name: newName, scopes: Self.ordered(newScopes))
            if model.failure == nil {
              newName = ""
              showsIssueRow = false
            }
          }
        }
        .disabled(model.busy || newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      HStack(spacing: 16) {
        ForEach(["read", "write", "admin"], id: \.self) { scope in
          Toggle(scope, isOn: scopeBinding(scope))
            .toggleStyle(.switch)
            .tint(Theme.Palette.accentStrong)
            .font(Theme.TypeScale.note)
            .accessibilityIdentifier("cli.scope.\(scope)")
        }
        Spacer(minLength: 0)
        Text("read 只读，write 能发消息和整理目录，admin 能删除")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
      }
    }
    .padding(.vertical, 14)
  }

  private func scopeBinding(_ scope: String) -> Binding<Bool> {
    Binding(
      get: { newScopes.contains(scope) },
      set: { on in
        if on {
          newScopes.insert(scope)
        } else if newScopes.count > 1 {
          newScopes.remove(scope)
        }
      }
    )
  }

  static func ordered(_ scopes: Set<String>) -> [String] {
    ["read", "write", "admin"].filter { scopes.contains($0) }
  }

  private func row(_ client: CLIClient) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Text(client.name)
            .font(.system(size: 14))
            .foregroundStyle(Theme.Palette.textPrimary)
          Text(client.statusLabel)
            .font(Theme.TypeScale.pill)
            .foregroundStyle(
              client.isRevoked ? Theme.Palette.textMuted : Theme.Palette.accentStrong)
        }
        Text(detail(client))
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      Spacer(minLength: 0)
      if client.isRevoked {
        SettingsActionButton("删除") {
          Task { await model.delete(client.id) }
        }
        .disabled(model.busy)
        .accessibilityIdentifier("cli.delete.\(client.name)")
      } else {
        SettingsActionButton("撤销") {
          Task { await model.revoke(client.id) }
        }
        .disabled(model.busy)
        .accessibilityIdentifier("cli.revoke.\(client.name)")
      }
    }
    .padding(.vertical, 12)
  }

  private func detail(_ client: CLIClient) -> String {
    var parts = [client.scopeLabel]
    parts.append("创建 \(Self.day(client.createdAt))")
    if let used = client.lastUsedAt {
      parts.append("最近使用 \(Self.day(used))")
    } else {
      parts.append("尚未使用")
    }
    if client.isRevoked { parts.append("已撤销，可删除") }
    return parts.joined(separator: " · ")
  }

  private static func day(_ iso: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
      return iso
    }
    return date.formatted(date: .abbreviated, time: .shortened)
  }

  private var skillCard: some View {
    VStack(alignment: .leading, spacing: 8) {
      SettingsCaption("交给 agent 的自描述文档")
      SettingsCard {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            Text("\(model.commandName) --skill")
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
            Text("一次调用就能读到命令表、退出码和规则，形状与 herdr --skill 相同。")
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
          }
          Spacer(minLength: 0)
          SettingsActionButton("复制命令") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("\(model.commandName) --skill", forType: .string)
          }
        }
        .padding(.vertical, 14)
      }
    }
  }
}
