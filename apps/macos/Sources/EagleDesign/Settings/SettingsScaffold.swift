import SwiftUI

/// Sections of the settings window.
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
  case general = "通用"
  case bots = "模型"
  case tools = "工具"
  case prompts = "提示词"
  case providers = "服务"
  case passwords = "密码"
  case machines = "设备"
  case cli = "CLI"
  case usage = "用量"
  case about = "关于"

  public var id: String { rawValue }

  public var symbol: String {
    switch self {
    case .general: return "gearshape"
    case .bots: return "sparkles"
    case .tools: return "wrench.and.screwdriver"
    case .prompts: return "text.alignleft"
    case .providers: return "antenna.radiowaves.left.and.right"
    case .passwords: return "key"
    case .machines: return "desktopcomputer"
    case .cli: return "terminal"
    case .usage: return "chart.bar"
    case .about: return "info.circle"
    }
  }
}

/// Left rail of the settings window.
public struct SettingsRail: View {
  @Binding private var selection: SettingsSection

  public init(selection: Binding<SettingsSection>) {
    self._selection = selection
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(SettingsSection.allCases) { section in
        Button {
          selection = section
        } label: {
          HStack(spacing: 10) {
            Image(systemName: section.symbol)
              .font(Theme.TypeScale.fieldLabel)
              .foregroundStyle(Theme.Palette.textPrimary)
              .frame(width: 20)
            Text(section.rawValue)
              .font(section == selection ? Theme.TypeScale.cardTitle : Theme.TypeScale.fieldLabel)
              .foregroundStyle(Theme.Palette.textPrimary)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 12)
          .frame(height: 40)
          .background(
            RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
              .fill(section == selection ? Theme.Palette.selection : .clear)
          )
          .overlay(
            RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
              .strokeBorder(
                section == selection ? Theme.Palette.line : .clear,
                lineWidth: Theme.Metric.hairline)
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.top, 16)
    .frame(width: Theme.Metric.settingsRailWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    // The rail keeps the main window's own surface: grey field, white card for the open tab.
    .background(Theme.Palette.canvas)
  }
}

/// Two-column settings window: rail, scrollable content, close button.
public struct SettingsScaffold<Content: View>: View {
  @Binding private var selection: SettingsSection
  private let content: Content
  private let onClose: () -> Void
  private let showsCloseButton: Bool

  public init(
    selection: Binding<SettingsSection>,
    onClose: @escaping () -> Void = {},
    showsCloseButton: Bool = true,
    @ViewBuilder content: () -> Content
  ) {
    self._selection = selection
    self.content = content()
    self.onClose = onClose
    self.showsCloseButton = showsCloseButton
  }

  public var body: some View {
    HStack(spacing: 0) {
      SettingsRail(selection: $selection)
      Rectangle()
        .fill(Theme.Palette.line)
        .frame(width: Theme.Metric.hairline)
      VStack(spacing: 0) {
        HStack(spacing: 16) {
          Text(selection.rawValue)
            .font(Theme.TypeScale.settingsTitle)
            .foregroundStyle(Theme.Palette.textPrimary)
          Spacer(minLength: 0)
          if showsCloseButton {
            IconButton(
              systemName: "xmark",
              label: "关闭设置",
              size: Theme.Metric.headerControlHeight,
              style: .circled,
              action: onClose
            )
          }
        }
        .padding(.horizontal, Theme.Metric.settingsContentInset)
        .padding(.top, 16)
        .padding(.bottom, 10)

        ScrollView {
          content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Metric.settingsContentInset)
            .padding(.top, 6)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.never)
      }
    }
    .frame(minWidth: 760, minHeight: 560)
    .background(Theme.Palette.surface)
  }
}
