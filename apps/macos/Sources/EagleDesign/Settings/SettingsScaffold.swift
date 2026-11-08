import SwiftUI

/// Sections of the settings window.
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
  case general = "通用"
  case bots = "模型"
  case tools = "工具"
  case skills = "技能"
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
    case .skills: return "square.stack.3d.up"
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
    ScrollView {
      VStack(alignment: .leading, spacing: Theme.Layout.detailGap) {
        ForEach(SettingsSection.allCases) { section in
          Button {
            selection = section
          } label: {
            HStack(spacing: Theme.Layout.controlGap) {
              Image(systemName: section.symbol)
                .font(Theme.TypeScale.fieldLabel)
                .foregroundStyle(Theme.Palette.textPrimary)
                .frame(width: Theme.Layout.glyphSlot)
              Text(section.rawValue)
                .font(section == selection ? Theme.TypeScale.cardTitle : Theme.TypeScale.fieldLabel)
                .foregroundStyle(Theme.Palette.textPrimary)
              Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Layout.sectionGap)
            .frame(height: Theme.Form.navigationRowHeight)
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
      }
      .padding(.horizontal, Theme.Layout.sectionGap)
      .padding(.vertical, Theme.Layout.sectionInset)
    }
    .scrollIndicators(.never)
    .frame(width: Theme.Metric.settingsRailWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Theme.Palette.canvas)
  }
}

/// Two-column settings window: rail, scrollable content, close button.
public struct SettingsScaffold<Content: View>: View {
  @Binding private var selection: SettingsSection
  @ObservedObject private var toasts: ToastCenter
  private let content: Content
  private let onClose: () -> Void
  private let showsCloseButton: Bool

  public init(
    selection: Binding<SettingsSection>,
    onClose: @escaping () -> Void = {},
    showsCloseButton: Bool = true,
    toasts: ToastCenter,
    @ViewBuilder content: () -> Content
  ) {
    self._selection = selection
    self._toasts = ObservedObject(wrappedValue: toasts)
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
        HStack(spacing: Theme.Layout.sectionInset) {
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
        .padding(.top, Theme.Layout.sectionInset)
        .padding(.bottom, Theme.Layout.controlGap)

        ScrollView {
          content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Metric.settingsContentInset)
            .padding(.top, Theme.Layout.labelGap)
            .padding(.bottom, Theme.Layout.pageBottomInset)
        }
        .scrollIndicators(.never)
        .overlay(alignment: .bottom) {
          if let toast = toasts.toast {
            SettingsToast(toast.notice)
              .padding(.bottom, Theme.Layout.sectionGap)
              .allowsHitTesting(false)
              .transition(.move(edge: .bottom).combined(with: .opacity))
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }
}
