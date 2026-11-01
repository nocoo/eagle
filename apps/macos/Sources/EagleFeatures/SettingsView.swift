import BotsCore
import EagleDesign
import SwiftUI

/// The settings window content, one screen per rail section.
public struct SettingsView: View {
  @StateObject private var model: SettingsViewModel
  /// The CLI page keeps its switch state, credentials and error message across redraws: a
  /// fresh view model per render silently discarded all three.
  @StateObject private var cli = CLISettingsViewModel()
  @ObservedObject private var devices: DeviceSettingsViewModel
  @AppStorage("eagle.appearance") private var appearance = "system"
  @AppStorage("eagle.hideToolCalls") private var hideToolCalls = false
  @AppStorage("eagle.loadMockData") private var loadMockData = false
  private let onClose: () -> Void
  private let daemon: BotsDaemonSupervisor?
  private let showsCloseButton: Bool

  public init(
    model: SettingsViewModel = SettingsViewModel(),
    onClose: @escaping () -> Void = {},
    daemon: BotsDaemonSupervisor? = nil,
    devices: DeviceSettingsViewModel = .shared,
    showsCloseButton: Bool = true
  ) {
    _model = StateObject(wrappedValue: model)
    self.onClose = onClose
    self.daemon = daemon
    self.devices = devices
    self.showsCloseButton = showsCloseButton
  }

  public var body: some View {
    SettingsScaffold(
      selection: $model.selection, onClose: onClose, showsCloseButton: showsCloseButton
    ) {
      switch model.selection {
      case .general:
        general
      case .bots:
        bots
      case .tools:
        tools
      case .providers:
        providersPage
      case .machines:
        DeviceSettingsView(model: devices)
      case .cli:
        CLISettingsView(model: cli)
      case .usage:
        usage
      case .about:
        about
      }
    }
    .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
  }

  private var general: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(spacing: 0) {
          SettingsRow("登录时自动启动", detail: "让 Eagle 在后台保持机器在线") {
            Toggle("", isOn: $model.launchAtLogin)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("显示未聚焦的 Space", detail: "侧栏同时列出所有 Herdr 工作区") {
            Toggle("", isOn: $model.showUnfocusedSpaces)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("加载 Mock 数据", detail: "在侧栏显示示例分组与示例对话") {
            Toggle("", isOn: $loadMockData)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("隐藏工具调用", detail: "对话里不显示工具调用和结果") {
            Toggle("", isOn: $hideToolCalls)
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("外观", detail: "浅色、深色或跟随系统") {
            PillSelect(
              options: [
                .init("system", "跟随系统"),
                .init("light", "浅色"),
                .init("dark", "深色"),
              ],
              selection: $appearance
            )
          }
        }
      }
    }
  }

  /// Model gateway: the one place a person configures the bot's endpoint, key and model.
  private var bots: some View {
    VStack(alignment: .leading, spacing: 18) {
      if let daemon {
        SettingsCaption("Bot 服务")
        BotsDaemonCard(daemon: daemon)
      }
      SettingsCaption("Bot 使用这台机器上的模型网关，保存后立即生效。")
      SettingsCard {
        VStack(alignment: .leading, spacing: 14) {
          gatewayField(
            "网关地址",
            detail: "OpenAI 兼容地址，例如 http://127.0.0.1:3425/v1"
          ) {
            SettingsTextField("https://…/v1", text: $model.gatewayBaseURL)
          }
          gatewayField(
            "API Key",
            detail: model.gateway?.hasApiKey == true ? "已保存；留空则保持不变" : "与网关匹配的密钥"
          ) {
            SettingsTextField(
              model.gateway?.hasApiKey == true ? "已保存" : "sk-…",
              text: $model.gatewayAPIKey,
              secure: true
            )
          }
          gatewayField("模型", detail: "Bot 使用的模型 id，例如 auto/gpt-6-luna") {
            SettingsTextField("模型 id", text: $model.gatewayModel)
          }
          gatewayField("思考等级", detail: "Bot 的推理努力程度，保存后立即生效") {
            HStack(spacing: 0) {
              thinkingLevelMenu
              Spacer(minLength: 0)
            }
          }
          HStack(spacing: 10) {
            SettingsActionButton("测试连接") {
              Task { @MainActor in await model.testGateway() }
            }
            .disabled(model.gatewayBusy)
            SettingsActionButton("保存", prominent: true) {
              Task { @MainActor in await model.saveGateway() }
            }
            .disabled(model.gatewayBusy)
            if model.gatewayBusy { SpinnerArc(size: 12) }
            Spacer(minLength: 0)
            if let probe = model.gatewayProbe {
              Label(
                "\(probe.message) · \(probe.latencyMs) ms",
                systemImage: probe.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
              )
              .font(Theme.TypeScale.note)
              .foregroundStyle(probe.ok ? Theme.Palette.accentStrong : Theme.Palette.destructive)
              // The gateway's own live endpoint names the build behind the address.
              if let health = probe.health, health.ok {
                Text(health.version.map { "live 报告 \($0)" } ?? "live 报告正常")
                  .font(Theme.TypeScale.note)
                  .foregroundStyle(Theme.Palette.textSecondary)
              } else if probe.health?.status == 404 {
                Text("该地址没有 /api/live，已用 /models 探测")
                  .font(Theme.TypeScale.note)
                  .foregroundStyle(Theme.Palette.textMuted)
              }
            } else if let message = model.gatewayMessage {
              Text(message)
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
            }
          }
        }
        .padding(.vertical, 16)
      }
    }
    .task { @MainActor in
      await model.loadGatewayIfNeeded()
      await model.probeGatewayIfNeeded()
    }
  }

  /// The 工具 page: the two core prompts first, because they are the first sections of every
  /// bot's system prompt, then the groups a person opts into.
  private var tools: some View {
    VStack(alignment: .leading, spacing: 16) {
      SettingsCaption("Core")
      SettingsCard {
        VStack(alignment: .leading, spacing: 0) {
          SettingsRow("Core Prompt", detail: "每个 Bot 都先读这段话：它是谁、怎么做事") {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.personaToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          SettingsTextArea(
            "例如：你是一个务实、友好的 agent。先说结论，再给依据。",
            text: Binding(
              get: { model.gatewayCorePrompt },
              set: { next in
                // A person typing owns the field: a later reload must not overwrite it.
                model.gatewayCorePromptChosen = true
                model.gatewayCorePrompt = next
              }
            )
          )
          .padding(.horizontal, 16)
          .padding(.top, 10)
          .padding(.bottom, 14)

          Divider().overlay(Theme.Palette.line)

          SettingsRow(
            "Core Machine Prompt",
            detail: "这台机器的 AGENTS.md，只读；先找共享入口，再找 pi、Codex、Claude Code"
          ) {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.machineToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          machinePromptPreview
        }
      }

      SettingsCaption("工具")
      SettingsCard {
        VStack(spacing: 0) {
          SettingsRow(
            "Core 基础工具", detail: "列出文件与目录；始终启用"
          ) {
            Toggle("", isOn: .constant(true))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
              .disabled(true)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("Coding 编码工具", detail: "原生读取、写入、编辑与命令执行；始终启用") {
            Toggle("", isOn: .constant(true))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
              .disabled(true)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("Herdr 终端协作", detail: "让 Bot 开终端工作区、派发和读取子 agent") {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.herdrToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("子 Agent", detail: "把独立任务委派给子 agent，拿回它的答案") {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.agentsToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow("搜索", detail: "web_search 与 web_fetch；在“服务”里保存 Key 并选择搜索服务商") {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.searchToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow(
            "触发器",
            detail: "Bot 自己设置定时任务与 Webhook；开关与详情在侧栏，修改仍由 Bot 完成"
          ) {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.triggerToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
          Divider().overlay(Theme.Palette.line)
          SettingsRow(
            "Bot 互通",
            detail: "让 Bot 一对一给别的 Bot 发消息并读回它的回答；每个来回每边最多 10 条"
          ) {
            Toggle("", isOn: toolGroupBinding(SettingsViewModel.peersToolGroup))
              .labelsHidden()
              .toggleStyle(.switch)
              .tint(Theme.Palette.accentStrong)
          }
        }
      }

      HStack(spacing: 10) {
        SettingsActionButton("保存", prominent: true) {
          Task { @MainActor in await model.saveTools() }
        }
        .disabled(model.gatewayBusy)
        if model.gatewayBusy { SpinnerArc(size: 12) }
        if let message = model.gatewayMessage {
          Text(message)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
        Spacer(minLength: 0)
      }
    }
    .task { @MainActor in await model.loadGatewayIfNeeded() }
  }

  /// What the machine contributes, read-only: the file a person would open and what it says.
  @ViewBuilder private var machinePromptPreview: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let machine = model.gatewayMachinePrompt {
        Text(machine.path)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(Theme.Palette.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
        ScrollView {
          Text(machine.text)
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.Palette.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        .frame(maxHeight: 150)
      } else {
        Text("没有找到机器指令文件：~/.agents、~/.pi/agent、~/.codex、~/.claude 下的 AGENTS.md")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 16)
  }

  private func toolGroupBinding(_ name: String) -> Binding<Bool> {
    Binding(
      get: { model.isToolGroupEnabled(name) },
      set: { model.setToolGroup(name, isOn: $0) }
    )
  }

  private func gatewayField<Content: View>(
    _ title: String,
    detail: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title)
        .font(.system(size: 13.5, weight: .medium))
        .foregroundStyle(Theme.Palette.textPrimary)
      content()
        .frame(maxWidth: 460)
      Text(detail)
        .font(.system(size: 11.5))
        .foregroundStyle(Theme.Palette.textMuted)
    }
  }

  /// The seven reasoning levels as a popup, drawn like the other capsules so the tab keeps one style.
  private var thinkingLevelMenu: some View {
    Menu {
      ForEach(model.thinkingLevels, id: \.value) { level in
        Button(level.label) { model.setGatewayThinkingLevel(level.value) }
      }
    } label: {
      HStack(spacing: 6) {
        Text(model.gatewayThinkingLevelLabel)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 14)
      .frame(height: 32)
      .background(Capsule().fill(Theme.Palette.canvas))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
  }

  private var providersPage: some View {
    VStack(alignment: .leading, spacing: 12) {
      SettingsCard {
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              Text("搜索")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Palette.textPrimary)
              Text("网页检索与正文提取，共用一个服务商")
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
            }
            Spacer(minLength: 0)
            if model.providerBusy { SpinnerArc(size: 12) }
            searchProviderMenu
          }
          .padding(.vertical, 16)
          ForEach(model.providers) { provider in
            Divider().overlay(Theme.Palette.line)
            searchProviderRow(provider)
          }
          if let message = model.providerMessage {
            Text(message)
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
              .padding(.bottom, 12)
          }
        }
      }
      Text("Key 独立保存在本机，保存不会切换服务商。选择后从下一次调用生效，不会自动切换。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      Text("测试会使用已保存的 Key 发起一次搜索，可能消耗服务额度。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
    }
    .task { await model.loadProviders() }
  }

  private var searchProviderMenu: some View {
    Menu {
      Button("不使用搜索服务") {
        if let selected = model.selectedSearchProvider {
          Task { await model.setProviderEnabled(selected.id, false) }
        }
      }
      Divider()
      ForEach(model.providers) { provider in
        Button(provider.hasApiKey ? provider.title : "\(provider.title) · 请先保存 Key") {
          Task { await model.setProviderEnabled(provider.id, true) }
        }
        .disabled(!provider.hasApiKey)
      }
    } label: {
      HStack(spacing: 6) {
        Text(model.selectedSearchProvider.map { "使用 \($0.title)" } ?? "选择服务商")
        Image(systemName: "chevron.down")
      }
      .font(Theme.TypeScale.note)
      .foregroundStyle(Theme.Palette.textPrimary)
      .padding(.horizontal, 12)
      .frame(height: 32)
      .background(Capsule().fill(Theme.Palette.canvas))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .disabled(model.providerBusy)
    .accessibilityLabel("当前搜索服务商")
  }

  private func searchProviderRow(_ provider: ProviderSettings) -> some View {
    let hasDraft = !(model.providerKeys[provider.id] ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text(provider.title)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(provider.enabled ? "使用中" : (provider.hasApiKey ? "Key 已保存" : "未配置"))
          .font(Theme.TypeScale.note)
          .foregroundStyle(provider.enabled ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
        Spacer(minLength: 0)
        if let url = URL(string: provider.docsUrl) {
          Link(destination: url) { Label("文档", systemImage: "arrow.up.right") }
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
      HStack(spacing: 8) {
        SettingsTextField(
          provider.hasApiKey ? "已保存 · 输入新 Key 可替换" : provider.keyLabel,
          text: keyBinding(provider.id), secure: true
        )
        .disabled(model.providerBusy)
        .accessibilityLabel(provider.keyLabel)
        SettingsActionButton("保存", prominent: hasDraft) {
          Task { await model.saveProvider(provider.id) }
        }
        .disabled(model.providerBusy || !hasDraft)
        .fixedSize()
        SettingsActionButton("测试") {
          Task { await model.testProvider(provider.id) }
        }
        .disabled(model.providerBusy || !provider.hasApiKey || hasDraft)
        .fixedSize()
      }
      if let probe = model.providerProbe[provider.id] {
        Label(
          "\(probe.message) · \(probe.latencyMs) ms",
          systemImage: probe.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
        )
        .font(Theme.TypeScale.note)
        .foregroundStyle(probe.ok ? Theme.Palette.accentStrong : Theme.Palette.destructive)
      }
    }
    .padding(.vertical, 16)
  }

  private func keyBinding(_ id: String) -> Binding<String> {
    Binding(
      get: { model.providerKeys[id] ?? "" },
      set: { model.providerKeys[id] = $0 }
    )
  }

  private var usage: some View {
    VStack(alignment: .leading, spacing: 18) {
      if model.usageReport == nil {
        SettingsCard {
          HStack(spacing: 10) {
            if model.usageBusy { SpinnerArc() }
            Text(model.usageBusy ? "正在读取用量…" : "还没有用量数据")
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
            Spacer(minLength: 0)
          }
          .padding(.vertical, 14)
        }
      } else {
        SettingsCard {
          VStack(spacing: 0) {
            ForEach(model.usageSummaryRows, id: \.id) { row in
              if row.id != model.usageSummaryRows.first?.id {
                Divider().overlay(Theme.Palette.line)
              }
              SettingsRow(row.title, detail: row.detail) {
                Text(row.value)
                  .font(Theme.TypeScale.mono)
                  .foregroundStyle(Theme.Palette.textPrimary)
              }
            }
          }
        }
        usageChart
        usageSources
        usageBots
        SettingsCaption("保留 \(model.usageReport?.retentionDays ?? 90) 天，按本机日期切分")
      }
    }
    .task { await model.loadUsage() }
  }

  /// Where the work went: models spend tokens, search spends calls.
  private var usageSources: some View {
    let rows = model.usageSourceRows
    return VStack(alignment: .leading, spacing: 6) {
      SettingsCaption("来源")
      SettingsCard {
        if rows.isEmpty {
          HStack(spacing: 8) {
            Image(systemName: "square.stack.3d.up")
              .font(.system(size: 12))
              .foregroundStyle(Theme.Palette.textMuted)
            Text("还没有消耗记录")
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
            Spacer(minLength: 0)
          }
          .padding(.vertical, 12)
        } else {
          VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
              if index > 0 { Divider().overlay(Theme.Palette.line) }
              SettingsRow(row.title, detail: "") {
                Text(row.value)
                  .font(Theme.TypeScale.mono)
                  .foregroundStyle(Theme.Palette.textPrimary)
              }
            }
          }
        }
      }
    }
  }

  /// Thirty bars, one per day; the tallest day fills the card, a quiet day is a hairline.
  private var usageChart: some View {
    let days = model.usageReport?.days ?? []
    let peak = days.map(\.totalTokens).max() ?? 0
    return VStack(alignment: .leading, spacing: 6) {
      SettingsCaption("近 30 天")
      SettingsCard {
        HStack(alignment: .bottom, spacing: 3) {
          ForEach(days) { day in
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .fill(
                day.totalTokens == 0
                  ? Theme.Palette.line
                  : Theme.Palette.accentFill.opacity(0.85)
              )
              .frame(height: barHeight(day.totalTokens, peak: peak))
              .frame(maxWidth: .infinity)
              .help("\(UsageFormat.shortDay(day.day)) · \(UsageFormat.tokens(day.totalTokens))")
          }
        }
        .frame(height: 56, alignment: .bottom)
        .padding(.vertical, 10)
      }
    }
  }

  private func barHeight(_ tokens: Int, peak: Int) -> CGFloat {
    guard peak > 0, tokens > 0 else { return 2 }
    return max(3, 56 * CGFloat(tokens) / CGFloat(peak))
  }

  private var usageBots: some View {
    let bots = model.usageBotRows
    return VStack(alignment: .leading, spacing: 6) {
      SettingsCaption("消耗最多")
      SettingsCard {
        if bots.isEmpty {
          HStack(spacing: 8) {
            Image(systemName: "chart.bar")
              .font(.system(size: 12))
              .foregroundStyle(Theme.Palette.textMuted)
            Text("近 90 天还没有消耗")
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
            Spacer(minLength: 0)
          }
          .padding(.vertical, 12)
        } else {
          VStack(spacing: 0) {
            ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
              if index > 0 { Divider().overlay(Theme.Palette.line) }
              SettingsRow(bot.title, detail: bot.detail) {
                Text(bot.value)
                  .font(Theme.TypeScale.mono)
                  .foregroundStyle(Theme.Palette.textPrimary)
              }
            }
          }
        }
      }
    }
  }

  /// What one check found: the newest published build, the current one, or why it is silent.
  @ViewBuilder private var updateSummary: some View {
    switch model.updateState {
    case .idle:
      Text("没有检查过。检查会读取公开的版本信息，不会上传本机数据。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
    case .checking:
      HStack(spacing: 10) {
        SpinnerArc()
        Text("正在检查更新…")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    case .current(let version):
      InfoBanner("已是最新版本 \(version)")
    case .available(let latest, let release):
      HStack(spacing: 12) {
        Image(systemName: "arrow.down.circle.fill")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.Palette.accentStrong)
        VStack(alignment: .leading, spacing: 2) {
          Text("有新版本 \(latest)")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.Palette.textPrimary)
          Text("下载安装包后手动安装；Eagle 不会自行替换。")
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
        Spacer(minLength: 0)
        if let release {
          SettingsActionButton("去 GitHub 下载", prominent: true) {
            NSWorkspace.shared.open(release)
          }
        }
      }
      .padding(12)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .fill(Theme.Palette.accentStrong.opacity(0.10))
      )
    case .development(let version):
      InfoBanner("已是最新版本 \(version)")
    case .unavailable:
      Text("这一版没有可用的版本信息。")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
    }
  }

  /// Identity, the update check and where to get the code; the app's own versions below.
  private var about: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsCard {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .center, spacing: 18) {
            aboutMark
            VStack(alignment: .leading, spacing: 4) {
              Text(DevAppIdentity.currentDisplayName)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.Palette.textPrimary)
              Text("多机工作态势 · 本地优先")
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textSecondary)
              HStack(spacing: 8) {
                Text(model.appVersion.display)
                  .font(Theme.TypeScale.mono)
                  .foregroundStyle(Theme.Palette.textSecondary)
                  .textSelection(.enabled)
                if !model.appVersion.isRelease {
                  Text("开发版")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Palette.textMuted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                      RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(Theme.Palette.canvas)
                    )
                }
              }
            }
            Spacer(minLength: 0)
            SettingsActionButton("检查更新") {
              Task { await model.checkForUpdates() }
            }
          }
          .padding(.vertical, 20)

          Divider().overlay(Theme.Palette.line)
          updateSummary
            .padding(.vertical, 14)
        }
      }

      if let github = model.links.github {
        SettingsCard {
          VStack(spacing: 0) {
            SettingsRow("GitHub", detail: github.absoluteString) {
              SettingsActionButton("打开") { NSWorkspace.shared.open(github) }
            }
            .padding(.vertical, 12)
            if let release = model.links.release {
              Divider().overlay(Theme.Palette.line)
              SettingsRow("版本发布", detail: release.absoluteString) {
                SettingsActionButton("打开") { NSWorkspace.shared.open(release) }
              }
              .padding(.vertical, 12)
            }
          }
        }
      }

      SettingsCard {
        VStack(spacing: 0) {
          SettingsRow("应用", detail: "界面、设备与 Bot 的控制台") {
            Text(model.appVersion.display)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
          }
          .padding(.vertical, 12)
          Divider().overlay(Theme.Palette.line)
          SettingsRow("Bot 服务", detail: botServiceDetail) {
            Text(botServiceVersion)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
          }
          .padding(.vertical, 12)
          Divider().overlay(Theme.Palette.line)
          SettingsRow("设备服务", detail: "本机执行与配对；身份只存放在本机") {
            Text(devices.localReady ? "已就绪" : "未就绪")
              .font(Theme.TypeScale.note)
              .foregroundStyle(
                devices.localReady ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
          }
          .padding(.vertical, 12)
        }
      }

      Text("\(String(Calendar.current.component(.year, from: Date()))) Eagle · 数据保留在这台机器上")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
    }
    .task { await model.checkForUpdatesIfNeeded() }
  }

  /// The app's own icon, so the about card carries the product rather than a placeholder.
  @ViewBuilder private var aboutMark: some View {
    if let icon = Self.bundledIcon {
      Image(nsImage: icon)
        .resizable()
        .interpolation(.high)
        .frame(width: 64, height: 64)
    } else {
      Image(systemName: "bird")
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(Theme.Palette.textPrimary)
        .frame(width: 64, height: 64)
    }
  }

  /// The product mark shipped in the bundle; a source run draws the glyph instead.
  private static var bundledIcon: NSImage? {
    if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
      let image = NSImage(contentsOf: url)
    {
      return image
    }
    let image = NSApplication.shared.applicationIconImage
    guard let image, image.size.width >= 128 else { return nil }
    return image
  }

  private var botServiceVersion: String {
    switch daemon?.status {
    case .running(let version, _, _): return "v\(version)"
    case .stopped: return "未运行"
    case .failed: return "启动失败"
    case .starting: return "启动中"
    case nil: return "未知"
    }
  }

  private var botServiceDetail: String {
    switch daemon?.status {
    case .running(_, _, let external): return external ? "外部启动的 daemon" : "由这个 App 启动"
    default: return "本机 Bots daemon"
    }
  }
}

/// The daemon's live state: running (and who started it), stopped or failed, with the root
/// and port the app is wired to. This is where a first-run problem such as a missing Node
/// becomes visible instead of a silent connection error.
private struct BotsDaemonCard: View {
  @ObservedObject var daemon: BotsDaemonSupervisor

  var body: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Circle()
            .fill(tint)
            .frame(width: 8, height: 8)
          Text(statusText)
            .font(.system(size: 14))
            .foregroundStyle(Theme.Palette.textPrimary)
          Spacer(minLength: 8)
          actions
        }
        Text("根目录 \(daemon.rootPath) · 端口 \(daemon.port)")
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(Theme.Palette.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
        if case .failed(let message) = daemon.status {
          Text(message)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.destructive)
            .fixedSize(horizontal: false, vertical: true)
        }
        Toggle("启动 App 时自动运行", isOn: $daemon.autoStart)
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
          .font(.system(size: 13))
      }
      .padding(.vertical, 14)
    }
  }

  @ViewBuilder
  private var actions: some View {
    switch daemon.status {
    case .starting:
      SpinnerArc(size: 12)
    case .running(_, _, let external):
      if !external {
        SettingsActionButton("重启") { Task { await daemon.restart() } }
        SettingsActionButton("停止") { Task { await daemon.stop() } }
      } else {
        Text("由外部启动，不随 App 退出")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
      }
    case .stopped, .failed:
      SettingsActionButton("启动", prominent: true) { Task { await daemon.startIfNeeded() } }
    }
  }

  private var statusText: String {
    switch daemon.status {
    case .stopped: return "未运行"
    case .starting: return "正在启动…"
    case .running(let version, let pid, let external):
      return "运行中 · v\(version) · pid \(pid)\(external ? "（外部）" : "")"
    case .failed: return "启动失败"
    }
  }

  private var tint: Color {
    switch daemon.status {
    case .stopped: return Theme.Palette.textMuted
    case .starting: return Theme.Palette.avatarTint(3)
    case .running: return Theme.Palette.accentStrong
    case .failed: return Theme.Palette.destructive
    }
  }
}
