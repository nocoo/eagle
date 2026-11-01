import AppKit
import EagleDesign
import SwiftUI

/// The App's trusted management surface; Bots receive only the shared execution port.
public struct DeviceSettingsView: View {
  @ObservedObject private var model: DeviceSettingsViewModel
  @State private var pairingCode = ""
  @State private var ttlSeconds = 3600
  @State private var removing: DeviceDirectoryEntry?

  public init(model: DeviceSettingsViewModel = .shared) {
    self.model = model
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      connectionStatus
      serviceAddressCard
      SettingsCard {
        pairingContent.padding(.vertical, 18)
      }
      directoryCard
    }
    .task { await model.observe() }
    .alert(
      "移除设备？",
      isPresented: Binding(
        get: { removing != nil }, set: { if !$0 { removing = nil } }
      )
    ) {
      Button("取消", role: .cancel) { removing = nil }
      Button("移除", role: .destructive) {
        guard let device = removing else { return }
        removing = nil
        Task { await model.removeMember(device.deviceId) }
      }
    } message: {
      Text("移除后，\(removing?.name ?? "此设备") 与群内其他设备不能再互相执行操作。可以通过新配对码重新加入。")
    }
  }

  private var connectionStatus: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 18) {
        if model.isStarting { SpinnerArc(size: 12) }
        Label(model.localReady ? "本机可用" : "本机未就绪", systemImage: "desktopcomputer")
          .foregroundStyle(
            model.localReady ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
        Label(cloudLabel, systemImage: "network")
          .foregroundStyle(Theme.Palette.textSecondary)
        Spacer(minLength: 0)
        Toggle("设备服务", isOn: serviceBinding)
          .toggleStyle(.switch)
          .tint(Theme.Palette.accentStrong)
          .font(Theme.TypeScale.note)
          .disabled(!model.canToggleService)
          .accessibilityIdentifier("devices.service")
        SettingsActionButton("刷新") {
          Task {
            await model.startIfNeeded()
            await model.refresh()
          }
        }
        .disabled(model.controlsBusy)
      }
      .font(Theme.TypeScale.note)
      serviceRecovery
    }
  }

  /// The one control that starts and stops the local service: every other action on this page
  /// needs it running, and stopping it unregisters the helper while keeping the choice stored.
  private var serviceBinding: Binding<Bool> {
    Binding(
      get: { model.enabled },
      set: { next in Task { await model.setEnabled(next) } }
    )
  }

  /// A published App names no relay: this field is where a person points it at their own.
  private var serviceAddressCard: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 12) {
          SettingsTextField(
            "https://devices.example.com", text: $model.serviceAddressDraft)
          SettingsActionButton("保存") {
            Task { await model.saveServiceAddress() }
          }
          .disabled(model.controlsBusy)
        }
        Text(
          model.needsServiceAddress
            ? "这台 Mac 还没有可连接的设备服务地址。填写你自己部署的 relay 地址后才会连接；App 不自带任何默认地址。"
            : "设备服务地址由你配置，App 不内置默认值；修改后会重启本机服务。"
        )
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("devices.serviceAddress")
      }
      .padding(.vertical, 18)
    }
  }

  @ViewBuilder private var serviceRecovery: some View {
    if let message = model.errorMessage {
      Label(message, systemImage: "exclamationmark.triangle")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.destructive)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("devices.error")
      if model.needsBackgroundApproval {
        HStack {
          SettingsActionButton("打开系统设置") { model.openSystemSettings() }
          SettingsActionButton("已允许，重试") { Task { await model.startIfNeeded() } }
            .disabled(model.controlsBusy)
        }
      }
    }
    if model.canRetryService {
      SettingsActionButton("重试") { Task { await model.retryService() } }
        .disabled(model.controlsBusy)
    }
  }

  private var cloudLabel: String {
    guard model.enabled else { return "云端未连接" }
    switch model.cloudStatus {
    case "online": return "云端已连接"
    case "connecting": return "正在连接云端"
    case "offline": return "云端离线"
    default: return "云端状态未知"
    }
  }

  private func policyMenu(for device: DeviceDirectoryEntry? = nil) -> some View {
    let policy: DevicePolicyState?
    if let device { policy = model.policy(for: device) } else { policy = model.policy }
    let canEdit =
      device.map { model.canEditPolicy(for: $0) }
      ?? (model.enabled && model.localReady && !model.controlsBusy && model.policy != nil)
    return Menu {
      ForEach(DevicePolicyState.Mode.allCases, id: \.self) { mode in
        Button(mode.title) { Task { await model.setPolicy(mode, deviceId: device?.deviceId) } }
      }
    } label: {
      HStack(spacing: 6) {
        Text(policy?.mode.title ?? "策略未知")
        Image(systemName: "chevron.down")
      }
      .font(Theme.TypeScale.note)
      .foregroundStyle(Theme.Palette.textPrimary)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .disabled(!canEdit)
    .accessibilityLabel("\(device?.name ?? "本机")执行策略")
    .accessibilityIdentifier("devices.policy.\(device?.deviceId ?? "local")")
    .help(canEdit ? "设置这台设备如何执行请求" : "设备就绪且支持权限设置后可修改")
  }

  /// The validity of a new code. It is the same control grid as every button beside it: 30 pt,
  /// radius 8, canvas fill and a hairline, with the chevron inside the tap target.
  private var validityMenu: some View {
    Menu {
      ForEach(Self.validityChoices, id: \.self) { seconds in
        Button(Self.validityTitle(seconds)) { ttlSeconds = seconds }
      }
    } label: {
      HStack(spacing: 6) {
        Text("有效期 \(Self.validityTitle(ttlSeconds))")
        Image(systemName: "chevron.down")
      }
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(Theme.Palette.textPrimary)
      .padding(.horizontal, 14)
      .frame(height: 30)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Theme.Palette.canvas)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .disabled(model.controlsBusy || !model.localReady)
    .accessibilityLabel("配对码有效期")
    .accessibilityIdentifier("devices.pairing.validity")
  }

  static let validityChoices = [3600, 86400]

  static func validityTitle(_ seconds: Int) -> String {
    seconds >= 86400 ? "24 小时" : "1 小时"
  }

  private var pairingContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let invitation = model.invitation {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let expiry = Date(timeIntervalSince1970: Double(invitation.expiresAt) / 1000)
          VStack(alignment: .leading, spacing: 8) {
            Text(invitation.code)
              .font(Theme.TypeScale.mono)
              .foregroundStyle(Theme.Palette.textPrimary)
              .textSelection(.enabled)
              .accessibilityLabel("本机配对码")
            HStack(spacing: 10) {
              Text(
                context.date < expiry
                  ? "有效至 \(expiry.formatted(date: .omitted, time: .shortened)) · 仅可使用一次"
                  : "配对码已过期"
              )
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textMuted)
              Spacer(minLength: 0)
              SettingsActionButton("复制") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(invitation.code, forType: .string)
              }
              .disabled(context.date >= expiry)
              SettingsActionButton("作废") { Task { await model.revokePairing() } }
                .disabled(model.controlsBusy || !model.localReady)
            }
          }
        }
      } else {
        HStack(spacing: 10) {
          validityMenu
          Spacer(minLength: 0)
          SettingsActionButton("生成本机配对码", prominent: true) {
            Task { await model.createPairing(ttlSeconds: ttlSeconds) }
          }
          .disabled(model.controlsBusy || !model.localReady)
        }
      }
      Divider().overlay(Theme.Palette.line)
      if let requestId = model.pendingRedeemRequestId {
        Text("上次配对尚未确认，请先查询原请求。不会自动重复兑换。")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
        DisclosureGroup("配对请求详情") {
          Text(requestId)
            .font(Theme.TypeScale.mono)
            .textSelection(.enabled)
        }
        .disclosureGroupStyle(DeviceDisclosureStyle())
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
        SettingsActionButton("查询配对结果", prominent: true) {
          Task { await model.recoverPairing() }
        }
        .disabled(model.controlsBusy || !model.localReady)
        HStack(spacing: 10) {
          SettingsTextField("重新输入原配对码", text: $pairingCode)
            .frame(maxWidth: .infinity)
            .accessibilityLabel("原请求的配对码")
            .onSubmit { redeem() }
          SettingsActionButton("用原请求重试", action: redeem)
            .disabled(
              model.controlsBusy || !model.localReady
                || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      } else {
        HStack(spacing: 10) {
          SettingsTextField("输入另一台设备的配对码", text: $pairingCode)
            .frame(maxWidth: .infinity)
            .accessibilityLabel("另一台设备的配对码")
            .onSubmit { redeem() }
          SettingsActionButton("添加设备", prominent: true, action: redeem)
            .disabled(
              model.controlsBusy || !model.localReady
                || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }

  private func redeem() {
    guard !model.controlsBusy else { return }
    let code = pairingCode
    pairingCode = ""
    Task { await model.redeem(code: code) }
  }

  private var hasLocalDirectoryEntry: Bool {
    guard let directory = model.directory else { return false }
    return directory.devices.contains { $0.deviceId == directory.localDeviceId }
  }

  private var localDevicePlaceholder: some View {
    HStack(alignment: .top, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 16))
          .foregroundStyle(Theme.Palette.textMuted)
          .frame(width: 20)
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 6) {
            Text(Host.current().localizedName ?? ProcessInfo.processInfo.hostName)
              .foregroundStyle(Theme.Palette.textPrimary)
            Text("本机").foregroundStyle(Theme.Palette.textMuted)
          }
          .font(Theme.TypeScale.note)
          .lineLimit(1)
          DeviceStatusIcon(
            online: model.localReady ? true : nil,
            label: model.localReady ? "本机可用" : "本机未就绪")
        }
        Spacer(minLength: 0)
      }
      .accessibilityElement(children: .combine)
      policyMenu()
    }
    .padding(.vertical, 14)
  }

  private var directoryCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      SettingsCaption("我的设备")
      if model.directory != nil && model.directoryIsStale {
        SettingsCaption("以下为上次读取的目录，当前状态尚未确认。")
      }
      SettingsCard {
        VStack(spacing: 0) {
          if !hasLocalDirectoryEntry {
            localDevicePlaceholder
            if let directory = model.directory, !directory.devices.isEmpty {
              Divider().overlay(Theme.Palette.line)
            }
          }
          if let directory = model.directory {
            ForEach(directory.devices) { device in
              HStack(alignment: .top, spacing: 12) {
                DeviceSummaryView(
                  device: device, isLocal: device.deviceId == directory.localDeviceId,
                  localReady: model.localReady, stale: model.directoryIsStale,
                  showsPolicy: false,
                  serviceEnabled: model.enabled)
                HStack(spacing: 16) {
                  policyMenu(for: device)
                  if directory.groupId != nil {
                    SettingsActionButton("移除") {
                      removing = device
                    }
                    .disabled(
                      !model.enabled || !model.localReady || model.controlsBusy
                        || model.directoryIsStale)
                  }
                }
              }
              .padding(.vertical, 14)
              if device.id != directory.devices.last?.id { Divider().overlay(Theme.Palette.line) }
            }
          }
        }
      }
    }
  }
}

/// The same observed identity appears in settings and every Bot's inspector.
struct DeviceSummaryView: View {
  let device: DeviceDirectoryEntry
  let isLocal: Bool
  let localReady: Bool
  let stale: Bool
  var compact = false
  var showsPolicy = true
  var serviceEnabled = true

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 16))
        .foregroundStyle(Theme.Palette.textMuted)
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(device.name).foregroundStyle(Theme.Palette.textPrimary)
          if isLocal { Text("本机").foregroundStyle(Theme.Palette.textMuted) }
        }
        .font(Theme.TypeScale.note)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        if compact {
          DeviceStatusIcon(online: connectionOnline, label: statusLabel)
        }
        if showsPolicy {
          Text(device.policy?.mode.title ?? "策略未知")
            .font(Theme.TypeScale.pill)
            .foregroundStyle(Theme.Palette.textMuted)
        }
        if !compact {
          DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
              Text(device.deviceId)
                .font(Theme.TypeScale.mono)
                .textSelection(.enabled)
              Text("系统：\(device.platform) · \(device.arch)")
              Text("支持操作：\(capabilityLabels)")
                .fixedSize(horizontal: false, vertical: true)
              if let seen = device.lastSeenAt {
                Text("最近观察：\(Date(timeIntervalSince1970: Double(seen) / 1000).formatted())")
              }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
          } label: {
            Text("详情").underline()
          }
          .disclosureGroupStyle(
            DeviceDetailsStyle(online: connectionOnline, statusLabel: statusLabel)
          )
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textMuted)
        }
      }
      Spacer(minLength: 0)
    }
  }

  private var capabilityLabels: String {
    guard let capabilities = device.capabilities else { return "尚未观察到" }
    let labels = [
      "command": "运行命令", "file.read": "读取文件", "file.write": "写入文件", "file.list": "浏览目录",
      "native": "本机工具", "policy.manage": "权限设置",
    ]
    return capabilities.isEmpty
      ? "无" : capabilities.map { labels[$0] ?? "其他操作" }.joined(separator: "、")
  }

  private var statusLabel: String {
    if isLocal && !serviceEnabled { return "本机未就绪" }
    if isLocal && !localReady { return "本机未就绪" }
    if stale { return isLocal && localReady ? "本机可用 · 云端观察待刷新" : "观察待刷新" }
    return isLocal && localReady ? "本机可用 · \(device.connectionLabel)" : device.connectionLabel
  }

  private var connectionOnline: Bool? {
    if isLocal && (!serviceEnabled || !localReady) { return false }
    return stale ? nil : device.online
  }
}

private struct DeviceStatusIcon: View {
  let online: Bool?
  let label: String

  var body: some View {
    Image(systemName: online == true ? "circle.fill" : online == false ? "circle" : "circle.dashed")
      .font(.system(size: 9, weight: .medium))
      .foregroundStyle(online == true ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
      .frame(width: 12, height: 20)
      .help(label)
      .accessibilityLabel(label)
  }
}

private struct DeviceDetailsStyle: DisclosureGroupStyle {
  let online: Bool?
  let statusLabel: String

  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        DeviceStatusIcon(online: online, label: statusLabel)
        Button {
          configuration.isExpanded.toggle()
        } label: {
          configuration.label
            .padding(.vertical, 6)
            .padding(.trailing, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(configuration.isExpanded ? "已展开" : "已折叠")
      }
      if configuration.isExpanded { configuration.content }
    }
  }
}

/// Keep native disclosure state and Button keyboard/AX actions with a full rectangular target.
private struct DeviceDisclosureStyle: DisclosureGroupStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        configuration.isExpanded.toggle()
      } label: {
        HStack {
          configuration.label
          Spacer(minLength: 12)
          Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityValue(configuration.isExpanded ? "已展开" : "已折叠")
      if configuration.isExpanded { configuration.content }
    }
  }
}
