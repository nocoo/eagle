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
  /// The width every text field on a settings row takes, so the right column lines up.
  private static let fieldWidth: CGFloat = 300

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
      case .prompts:
        prompts
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
    sectionCard(
      "外观与启动", detail: "打开 App 时的行为，以及对话里显示什么"
    ) {
      SettingsSectionRow("登录时自动启动", detail: "让 Eagle 在后台保持机器在线") {
        Toggle("", isOn: $model.launchAtLogin)
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
      }
      Divider().overlay(Theme.Palette.line)
      SettingsSectionRow("显示未聚焦的 Space", detail: "侧栏同时列出所有 Herdr 工作区") {
        Toggle("", isOn: $model.showUnfocusedSpaces)
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
      }
      Divider().overlay(Theme.Palette.line)
      SettingsSectionRow("加载 Mock 数据", detail: "在侧栏显示示例分组与示例对话") {
        Toggle("", isOn: $loadMockData)
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
      }
      Divider().overlay(Theme.Palette.line)
      SettingsSectionRow("隐藏工具调用", detail: "对话里不显示工具调用和结果") {
        Toggle("", isOn: $hideToolCalls)
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
      }
      Divider().overlay(Theme.Palette.line)
      SettingsSectionRow("外观", detail: "浅色、深色或跟随系统") {
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

  /// One settings section: the card, the header that names it, and the divider that opens the
  /// body. Every page is built from this, so the title, the rhythm and the inset never drift.
  private func sectionCard<Trailing: View, Body: View>(
    _ title: String,
    detail: String,
    @ViewBuilder trailing: () -> Trailing,
    @ViewBuilder body: () -> Body
  ) -> some View {
    SettingsCard {
      VStack(spacing: 0) {
        SettingsSectionHeader(title, detail: detail, trailing: trailing)
        Divider().overlay(Theme.Palette.line)
        body()
      }
    }
  }

  /// A section with no control of its own: the header carries only the title and its line.
  private func sectionCard<Body: View>(
    _ title: String,
    detail: String,
    @ViewBuilder body: () -> Body
  ) -> some View {
    sectionCard(title, detail: detail, trailing: { EmptyView() }, body: body)
  }

  /// Model gateway: the one place a person configures the bot's endpoint, key and model.
  private var bots: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let daemon {
        daemonSection(daemon)
      }
      sectionCard(
        "模型网关", detail: "Bot 使用这台机器上的网关，保存后立即生效"
      ) {
        HStack(spacing: 10) {
          if model.gatewayBusy { SpinnerArc(size: 12) }
          SettingsActionButton("测试连接") {
            Task { @MainActor in await model.testGateway() }
          }
          .disabled(model.gatewayBusy)
          SettingsActionButton("保存", prominent: true) {
            Task { @MainActor in await model.saveGateway() }
          }
          .disabled(model.gatewayBusy)
        }
      } body: {
        SettingsSectionRow(
          "网关地址", detail: "OpenAI 兼容地址，例如 127.0.0.1:3425/v1"
        ) {
          SettingsTextField("https://…/v1", text: $model.gatewayBaseURL)
            .frame(width: Self.fieldWidth)
        }
        Divider().overlay(Theme.Palette.line)
        SettingsSectionRow(
          "API Key",
          detail: model.gateway?.hasApiKey == true ? "已保存；留空则保持不变" : "与网关匹配的密钥"
        ) {
          SettingsTextField(
            model.gateway?.hasApiKey == true ? "已保存" : "sk-…",
            text: $model.gatewayAPIKey,
            secure: true
          )
          .frame(width: Self.fieldWidth)
        }
        Divider().overlay(Theme.Palette.line)
        SettingsSectionRow("模型", detail: "Bot 使用的模型 id，例如 auto/gpt-6-luna") {
          SettingsTextField("模型 id", text: $model.gatewayModel)
            .frame(width: Self.fieldWidth)
        }
        Divider().overlay(Theme.Palette.line)
        SettingsSectionRow("思考等级", detail: "Bot 的推理努力程度，保存后立即生效") {
          thinkingLevelMenu
        }
        Divider().overlay(Theme.Palette.line)
        gatewayProbeNote
      }
    }
    .task { @MainActor in
      await model.loadGatewayIfNeeded()
      await model.probeGatewayIfNeeded()
    }
  }

  /// What the last probe or save answered, in the card that owns the action.
  @ViewBuilder private var gatewayProbeNote: some View {
    if let probe = model.gatewayProbe {
      VStack(alignment: .leading, spacing: 6) {
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
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 14)
    } else if let message = model.gatewayMessage {
      SettingsSectionNote(message)
    }
  }

  /// The daemon's live state: whether it runs and who started it, where its root is, and the
  /// switch that decides whether the App keeps it running.
  private func daemonSection(_ daemon: BotsDaemonSupervisor) -> some View {
    sectionCard("Bot 服务", detail: "根目录 \(daemon.rootPath) · 端口 \(daemon.port)") {
      BotsDaemonActions(daemon: daemon)
    } body: {
      SettingsSectionRow("状态", detail: daemonStateDetail(daemon)) {
        HStack(spacing: 8) {
          Circle()
            .fill(daemonStatusTint(daemon))
            .frame(width: 8, height: 8)
          Text(daemonStatusText(daemon))
            .font(.system(size: 13))
            .foregroundStyle(Theme.Palette.textPrimary)
        }
      }
      Divider().overlay(Theme.Palette.line)
      SettingsSectionRow("启动 App 时自动运行", detail: "关掉后 daemon 只能手动启动") {
        Toggle(
          "",
          isOn: Binding(
            get: { daemon.autoStart }, set: { daemon.autoStart = $0 })
        )
        .labelsHidden()
        .toggleStyle(.switch)
        .tint(Theme.Palette.accentStrong)
      }
      if case .failed(let message) = daemon.status {
        Divider().overlay(Theme.Palette.line)
        SettingsSectionNote(message, destructive: true)
          .padding(.top, 12)
      }
    }
  }

  private func daemonStatusText(_ daemon: BotsDaemonSupervisor) -> String {
    switch daemon.status {
    case .stopped: return "未运行"
    case .starting: return "正在启动…"
    case .running(let version, let pid, let external):
      return "运行中 · v\(version) · pid \(pid)\(external ? "（外部）" : "")"
    case .failed: return "启动失败"
    }
  }

  private func daemonStateDetail(_ daemon: BotsDaemonSupervisor) -> String {
    switch daemon.status {
    case .running(_, _, let external):
      return external ? "由外部启动，不随 App 退出" : "由这个 App 启动"
    default: return "本机 Bots daemon"
    }
  }

  private func daemonStatusTint(_ daemon: BotsDaemonSupervisor) -> Color {
    switch daemon.status {
    case .stopped: return Theme.Palette.textMuted
    case .starting: return Theme.Palette.avatarTint(3)
    case .running: return Theme.Palette.accentStrong
    case .failed: return Theme.Palette.destructive
    }
  }

  /// The 提示词 page: the two core prompts, because they are the first sections of every
  /// bot's system prompt.
  private var prompts: some View {
    sectionCard(
      "系统提示词", detail: "每个 Bot 的提示词都以这两段开头，改完从下一轮开始生效"
    ) {
      HStack(spacing: 10) {
        if model.gatewayBusy { SpinnerArc(size: 12) }
        SettingsActionButton("保存", prominent: true) {
          Task { @MainActor in await model.savePrompts() }
        }
        .disabled(model.gatewayBusy)
      }
    } body: {
      SettingsSectionRow("Core Prompt", detail: "它是谁、怎么做事") {
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
      .padding(.bottom, 16)
      Divider().overlay(Theme.Palette.line)
      SettingsSectionRow(
        "Core Machine Prompt",
        detail: "这台机器的 AGENTS.md，只读；先找共享入口，再找 pi、Codex、Claude Code"
      ) {
        Toggle("", isOn: toolGroupBinding(SettingsViewModel.machineToolGroup))
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
      }
      machinePromptPreview
      if let message = model.gatewayMessage {
        Divider().overlay(Theme.Palette.line)
        SettingsSectionNote(message)
          .padding(.top, 12)
      }
    }
    .task { @MainActor in await model.loadGatewayIfNeeded() }
  }

  /// The 工具 page: every group a person can switch, one row each.
  private var tools: some View {
    sectionCard(
      "可用工具", detail: "Bot 能做的事，改完从下一轮开始生效"
    ) {
      HStack(spacing: 10) {
        if model.gatewayBusy { SpinnerArc(size: 12) }
        SettingsActionButton("保存", prominent: true) {
          Task { @MainActor in await model.saveTools() }
        }
        .disabled(model.gatewayBusy)
      }
    } body: {
      toolRow("Core 基础工具", detail: "列出文件与目录；始终启用", alwaysOn: true)
      Divider().overlay(Theme.Palette.line)
      toolRow("Coding 编码工具", detail: "原生读取、写入、编辑与命令执行；始终启用", alwaysOn: true)
      Divider().overlay(Theme.Palette.line)
      toolRow(
        "Herdr 终端协作", detail: "让 Bot 开终端工作区、派发和读取子 agent",
        group: SettingsViewModel.herdrToolGroup)
      Divider().overlay(Theme.Palette.line)
      toolRow(
        "子 Agent", detail: "把独立任务委派给子 agent，拿回它的答案",
        group: SettingsViewModel.agentsToolGroup)
      Divider().overlay(Theme.Palette.line)
      toolRow(
        "搜索", detail: "web_search 与 web_fetch；在“服务”里保存 Key 并选择搜索服务商",
        group: SettingsViewModel.searchToolGroup)
      Divider().overlay(Theme.Palette.line)
      toolRow(
        "触发器", detail: "Bot 自己设置定时任务与 Webhook；开关与详情在侧栏，修改仍由 Bot 完成",
        group: SettingsViewModel.triggerToolGroup)
      Divider().overlay(Theme.Palette.line)
      toolRow(
        "Bot 互通", detail: "让 Bot 一对一给别的 Bot 发消息并读回它的回答；每个来回每边最多 10 条",
        group: SettingsViewModel.peersToolGroup)
      if let message = model.gatewayMessage {
        Divider().overlay(Theme.Palette.line)
        SettingsSectionNote(message)
          .padding(.top, 12)
      }
    }
    .task { @MainActor in await model.loadGatewayIfNeeded() }
  }

  /// One tool switch. The two core groups run always; the rest follow the person's choice.
  private func toolRow(
    _ title: String, detail: String, group: String = "", alwaysOn: Bool = false
  ) -> some View {
    SettingsSectionRow(title, detail: detail) {
      if alwaysOn {
        Toggle("", isOn: .constant(true))
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
          .disabled(true)
      } else {
        Toggle("", isOn: toolGroupBinding(group))
          .labelsHidden()
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
      }
    }
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
    .padding(.bottom, 16)
  }

  private func toolGroupBinding(_ name: String) -> Binding<Bool> {
    Binding(
      get: { model.isToolGroupEnabled(name) },
      set: { model.setToolGroup(name, isOn: $0) }
    )
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
    sectionCard(
      "搜索", detail: "网页检索与正文提取，共用一个服务商"
    ) {
      HStack(spacing: 10) {
        if model.providerBusy { SpinnerArc(size: 12) }
        searchProviderMenu
      }
    } body: {
      ForEach(Array(model.providers.enumerated()), id: \.element.id) { index, provider in
        if index > 0 { Divider().overlay(Theme.Palette.line) }
        searchProviderRow(provider)
      }
      if let message = model.providerMessage {
        Divider().overlay(Theme.Palette.line)
        SettingsSectionNote(message)
          .padding(.top, 12)
      }
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
    VStack(alignment: .leading, spacing: 12) {
      if model.usageReport == nil {
        sectionCard("用量", detail: "所有 Bot 的 token、调用与花费") {
          SettingsSectionNote(model.usageBusy ? "正在读取用量…" : "还没有用量数据")
            .padding(.top, 14)
        }
      } else {
        sectionCard("用量", detail: "所有 Bot 的 token、调用与花费") {
          ForEach(model.usageSummaryRows, id: \.id) { row in
            if row.id != model.usageSummaryRows.first?.id {
              Divider().overlay(Theme.Palette.line)
            }
            SettingsSectionRow(row.title, detail: row.detail) {
              Text(row.value)
                .font(Theme.TypeScale.mono)
                .foregroundStyle(Theme.Palette.textPrimary)
            }
          }
          Divider().overlay(Theme.Palette.line)
          SettingsSectionNote("保留 \(retentionDays) 天，按本机日期切分")
            .padding(.top, 12)
        }
        usageChart
        usageSources
        usageBots
      }
    }
    .task { await model.loadUsage() }
  }

  private var retentionDays: Int {
    model.usageReport?.retentionDays ?? 90
  }

  /// Where the work went: models spend tokens, search spends calls.
  private var usageSources: some View {
    let rows = model.usageSourceRows
    return sectionCard("来源", detail: "模型花 token，搜索花调用") {
      if rows.isEmpty {
        SettingsSectionNote("还没有消耗记录")
          .padding(.top, 14)
      } else {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
          if index > 0 { Divider().overlay(Theme.Palette.line) }
          SettingsSectionRow(row.title, detail: "") {
            Text(row.value)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
          }
        }
      }
    }
  }

  /// Thirty bars, one per day; the tallest day fills the card, a quiet day is a hairline.
  private var usageChart: some View {
    let days = model.usageReport?.days ?? []
    let peak = days.map(\.totalTokens).max() ?? 0
    return sectionCard("近 30 天", detail: "每天一条，最忙的一天填满卡片") {
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
      .padding(.vertical, 16)
    }
  }

  private func barHeight(_ tokens: Int, peak: Int) -> CGFloat {
    guard peak > 0, tokens > 0 else { return 2 }
    return max(3, 56 * CGFloat(tokens) / CGFloat(peak))
  }

  private var usageBots: some View {
    let bots = model.usageBotRows
    return sectionCard("消耗最多", detail: "近 \(retentionDays) 天花得最多的 5 个 Bot") {
      if bots.isEmpty {
        SettingsSectionNote("近 \(retentionDays) 天还没有消耗")
          .padding(.top, 14)
      } else {
        ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
          if index > 0 { Divider().overlay(Theme.Palette.line) }
          SettingsSectionRow(bot.title, detail: bot.detail) {
            Text(bot.value)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
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
    VStack(alignment: .leading, spacing: 12) {
      SettingsCard {
        VStack(spacing: 0) {
          SettingsSectionHeader(
            "Eagle", detail: "多机工作态势 · 本地优先"
          ) {
            SettingsActionButton("检查更新") {
              Task { await model.checkForUpdates() }
            }
          }
          Divider().overlay(Theme.Palette.line)
          HStack(alignment: .center, spacing: 18) {
            aboutMark
            VStack(alignment: .leading, spacing: 4) {
              Text(DevAppIdentity.currentDisplayName)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.Palette.textPrimary)
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
          }
          .padding(.vertical, 20)
          Divider().overlay(Theme.Palette.line)
          updateSummary
            .padding(.vertical, 14)
        }
      }

      if let github = model.links.github {
        sectionCard("链接", detail: "代码与发布都在 GitHub") {
          SettingsSectionRow("GitHub", detail: github.absoluteString) {
            SettingsActionButton("打开") { NSWorkspace.shared.open(github) }
          }
          if let release = model.links.release {
            Divider().overlay(Theme.Palette.line)
            SettingsSectionRow("版本发布", detail: release.absoluteString) {
              SettingsActionButton("打开") { NSWorkspace.shared.open(release) }
            }
          }
        }
      }

      sectionCard("版本", detail: "这个 App 与它启动的两个本机服务") {
        SettingsSectionRow("应用", detail: "界面、设备与 Bot 的控制台") {
          Text(model.appVersion.display)
            .font(Theme.TypeScale.mono)
            .foregroundStyle(Theme.Palette.textPrimary)
        }
        Divider().overlay(Theme.Palette.line)
        SettingsSectionRow("Bot 服务", detail: botServiceDetail) {
          Text(botServiceVersion)
            .font(Theme.TypeScale.mono)
            .foregroundStyle(Theme.Palette.textPrimary)
        }
        Divider().overlay(Theme.Palette.line)
        SettingsSectionRow("设备服务", detail: "本机执行与配对；身份只存放在本机") {
          Text(devices.localReady ? "已就绪" : "未就绪")
            .font(Theme.TypeScale.note)
            .foregroundStyle(
              devices.localReady ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
        }
      }

      Text("\(String(Calendar.current.component(.year, from: Date()))) Eagle · 数据保留在这台机器上")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
        .padding(.leading, 4)
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

/// The daemon's own controls, in the header of the Bot 服务 section: restart, stop, or start
/// it, so a stopped service is one click from running again.
private struct BotsDaemonActions: View {
  @ObservedObject var daemon: BotsDaemonSupervisor

  var body: some View {
    switch daemon.status {
    case .starting:
      SpinnerArc(size: 12)
    case .running(_, _, let external):
      if external {
        Text("由外部启动，不随 App 退出")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
      } else {
        HStack(spacing: 10) {
          SettingsActionButton("重启") { Task { await daemon.restart() } }
          SettingsActionButton("停止") { Task { await daemon.stop() } }
        }
      }
    case .stopped, .failed:
      SettingsActionButton("启动", prominent: true) { Task { await daemon.startIfNeeded() } }
    }
  }
}
