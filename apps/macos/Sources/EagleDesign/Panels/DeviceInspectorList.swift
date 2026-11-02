import SwiftUI

/// One machine as the inspector draws it: the four facts that decide whether work can run there.
public struct DeviceInspectorEntry: Identifiable, Hashable, Sendable {
  public let id: String
  public let name: String
  public let isLocal: Bool
  public let online: Bool?
  public let policy: String

  public init(id: String, name: String, isLocal: Bool, online: Bool?, policy: String) {
    self.id = id
    self.name = name
    self.isLocal = isLocal
    self.online = online
    self.policy = policy
  }
}

/// The computer list: one compact line per machine, so a person sees where work can run without
/// leaving the conversation. Detail and policy live in 设置 → 设备, behind 管理设备.
public struct DeviceInspectorList: View {
  private let entries: [DeviceInspectorEntry]
  private let enabled: Bool
  private let stale: Bool
  private let localContent: AnyView?
  private let onManage: () -> Void

  public init(
    entries: [DeviceInspectorEntry],
    enabled: Bool = true,
    stale: Bool = false,
    localContent: AnyView? = nil,
    onManage: @escaping () -> Void = {}
  ) {
    self.entries = entries
    self.enabled = enabled
    self.stale = stale
    self.localContent = localContent
    self.onManage = onManage
  }

  private var online: Int { entries.filter { $0.online == true }.count }

  public var body: some View {
    VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
      header
      if entries.isEmpty {
        empty
      } else {
        VStack(spacing: 0) {
          ForEach(Array(entries.enumerated()), id: \.element.id) { index, device in
            if index > 0 { Divider().overlay(Theme.Palette.line) }
            VStack(alignment: .leading, spacing: 0) {
              row(device)
              if device.isLocal, let localContent {
                localContent
                  .padding(.horizontal, 10)
                  .padding(.bottom, 4)
              }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("devices.inspector.\(device.id)")
          }
        }
        .background(
          RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
            .fill(Theme.Palette.card)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
      }
      manageRow
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// One header line: what the list is, and how much of it is reachable right now.
  private var header: some View {
    HStack(spacing: Theme.Metric.panelSectionRowGap) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: Theme.Metric.panelSectionGlyph, weight: .semibold))
        .foregroundStyle(Theme.Palette.textMuted)
        .frame(width: Theme.Metric.panelSectionGlyphWidth)
      Text("可用电脑")
        .font(Theme.TypeScale.sectionLabel)
        .foregroundStyle(Theme.Palette.textSecondary)
        .tracking(0.2)
      Spacer(minLength: 8)
      Text(countLabel)
        .font(Theme.TypeScale.pill)
        .foregroundStyle(Theme.Palette.textMuted)
        .monospacedDigit()
    }
  }

  private var countLabel: String {
    guard !entries.isEmpty else { return "未连接" }
    return "\(entries.count) 台 · \(online) 在线"
  }

  private var empty: some View {
    HStack(spacing: 8) {
      Image(systemName: enabled ? "desktopcomputer.trianglebadge.exclamationmark" : "power")
        .font(.system(size: 12))
        .foregroundStyle(Theme.Palette.textMuted)
      Text(enabled ? "还没有读到设备目录" : "设备服务已停用")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .frame(height: Theme.Metric.inspectorRowHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }

  /// One machine, one line: the name, and the two facts that decide whether it can run work.
  private func row(_ device: DeviceInspectorEntry) -> some View {
    let isLocal = device.isLocal
    return HStack(spacing: 8) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(isLocal ? Theme.Palette.textSecondary : Theme.Palette.textMuted)
        .frame(width: 16)
      Text(device.name)
        .font(isLocal ? Theme.TypeScale.cardTitle.weight(.semibold) : Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      if isLocal {
        Text("本机")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.horizontal, 5)
          .padding(.vertical, 1)
          .background(
            Capsule().fill(Theme.Palette.canvas)
          )
      }
      Spacer(minLength: 8)
      Text(device.policy)
        .font(Theme.TypeScale.pill)
        .foregroundStyle(Theme.Palette.textMuted)
        .lineLimit(1)
        .fixedSize()
      Circle()
        .fill(statusTint(device))
        .frame(width: 6, height: 6)
        .accessibilityLabel(statusLabel(device))
    }
    .padding(.horizontal, 10)
    .frame(height: Theme.Metric.inspectorRowHeight)
    .accessibilityElement(children: .combine)
  }

  private var manageRow: some View {
    Button(action: onManage) {
      HStack(spacing: 6) {
        Text("管理设备")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.accent)
        Spacer(minLength: 0)
        Image(systemName: "arrow.up.forward")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Theme.Palette.textMuted)
      }
      .padding(.horizontal, 10)
      .frame(height: 30)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("管理设备")
  }

  /// An observation, not a promise: unknown stays gray rather than looking online.
  private func statusTint(_ device: DeviceInspectorEntry) -> Color {
    switch device.online {
    case .some(true): return Theme.Palette.accentStrong
    case .some(false): return Theme.Palette.textMuted
    case .none: return Theme.Palette.line
    }
  }

  private func statusLabel(_ device: DeviceInspectorEntry) -> String {
    if stale { return "状态未确认" }
    switch device.online {
    case .some(true): return "在线"
    case .some(false): return "离线"
    case .none: return "状态未知"
    }
  }
}
