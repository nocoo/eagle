import SwiftUI

/// Visual reference for every token and component. Used while the shell is
/// still being aligned to the reference design.
public struct TemplateGallery: View {
  @State private var section: GallerySection = .activity
  @State private var darkPreview = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var tab: InspectorColumn.Tab = .detail
  @State private var toggleOne = true
  @State private var toggleTwo = true
  @State private var draft = ""
  @State private var draftSteerable = ""
  @State private var previewRunning = true
  @State private var previewInspector = false
  private let onShowSettings: () -> Void

  public init(darkPreview: Bool = false, onShowSettings: @escaping () -> Void = {}) {
    _darkPreview = State(initialValue: darkPreview)
    self.onShowSettings = onShowSettings
  }

  public var body: some View {
    HStack(spacing: 0) {
      navigation
      Rectangle().fill(Theme.Palette.line).frame(width: Theme.Metric.hairline)
      VStack(spacing: 0) {
        header
        ScrollView {
          selectedContent
            .padding(Theme.Metric.galleryInset)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .id(section)
        }
        .background(Theme.Palette.canvas)
      }
    }
    .frame(minWidth: 960, minHeight: 640)
    .background(Theme.Palette.surface)
    .preferredColorScheme(darkPreview ? .dark : .light)
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: section)
  }

  private var navigation: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack(spacing: 10) {
        Image(systemName: "square.stack.3d.up.fill")
          .font(.system(size: 24, weight: .medium))
          .foregroundStyle(Theme.Palette.accentStrong)
        VStack(alignment: .leading, spacing: 2) {
          Text("Eagle").font(Theme.TypeScale.brand)
          Text("原生设计工坊").font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
      VStack(spacing: 6) {
        ForEach(GallerySection.allCases) { item in
          Button {
            section = item
          } label: {
            HStack(spacing: 12) {
              Image(systemName: item.symbol).frame(width: 20)
              Text(item.rawValue).font(Theme.TypeScale.cardTitle)
              Spacer(minLength: 0)
              if section == item {
                Circle().fill(Theme.Palette.accentStrong).frame(width: 5, height: 5)
              }
            }
            .foregroundStyle(
              section == item ? Theme.Palette.accentStrong : Theme.Palette.textSecondary
            )
            .padding(12)
            .background(
              RoundedRectangle(cornerRadius: Theme.Metric.controlRadius)
                .fill(section == item ? Theme.Palette.accentFill.opacity(0.09) : .clear)
            )
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(section == item ? .isSelected : [])
        }
        Divider().overlay(Theme.Palette.line)
        Button(action: onShowSettings) {
          HStack(spacing: 12) {
            Image(systemName: "gearshape").frame(width: 20)
            Text("设置…").font(Theme.TypeScale.cardTitle)
            Spacer(minLength: 0)
            Text("⌘,").font(Theme.TypeScale.note)
          }
          .foregroundStyle(Theme.Palette.textSecondary)
          .padding(12)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("设置…")
        .accessibilityIdentifier("eagle.gallery.settings")
      }
      Spacer(minLength: 24)
      VStack(alignment: .leading, spacing: 6) {
        Text("SWIFTUI / MACOS").font(Theme.TypeScale.mono)
        Text("真实组件 · 隔离预览")
          .font(Theme.TypeScale.note)
      }
      .foregroundStyle(Theme.Palette.textMuted)
    }
    .padding(.horizontal, Theme.Metric.contentInset)
    .padding(.top, 40)
    .padding(.bottom, Theme.Metric.galleryInset)
    .frame(width: Theme.Metric.galleryRailWidth)
    .background(Theme.Palette.surface)
  }

  @ViewBuilder
  private var selectedContent: some View {
    switch section {
    case .activity: activitySection
    case .chat: chatSection
    case .primitives: primitivesSection
    case .palette: paletteSection
    case .typography: typographySection
    case .panels: panelSection
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 24) {
      VStack(alignment: .leading, spacing: 6) {
        Text("EAGLE / COMPONENT LIBRARY")
          .font(Theme.TypeScale.mono)
          .foregroundStyle(Theme.Palette.accentStrong)
        Text(section.rawValue)
          .font(.system(size: 26, weight: .semibold))
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(section.detail)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      Spacer(minLength: 0)
      Toggle("深色预览", isOn: $darkPreview)
        .toggleStyle(.switch)
        .font(Theme.TypeScale.note)
        .fixedSize()
    }
    .padding(Theme.Metric.galleryInset)
    .padding(.top, 12)
    .background(Theme.Palette.surface)
  }

  private var paletteSection: some View {
    GalleryCard(title: "配色") {
      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 5), spacing: 12
      ) {
        swatch("canvas", Theme.Palette.canvas)
        swatch("surface", Theme.Palette.surface)
        swatch("card", Theme.Palette.card)
        swatch("line", Theme.Palette.line)
        swatch("textPrimary", Theme.Palette.textPrimary)
        swatch("textSecondary", Theme.Palette.textSecondary)
        swatch("accent", Theme.Palette.accent)
        swatch("accentFill", Theme.Palette.accentFill)
        swatch("accentStrong", Theme.Palette.accentStrong)
        swatch("hover", Theme.Palette.hover)
      }
    }
  }

  private var activitySection: some View {
    GalleryCard(title: "会话状态 · 交互预览") {
      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 24) {
          ParticipantBubble(
            name: "研究员", tintIndex: 2,
            status: ParticipantStatus(
              label: previewRunning ? "回答中" : "已连接",
              phase: previewRunning ? .working : .idle, canStop: previewRunning
            ),
            onStop: { previewRunning = false },
            action: { previewInspector.toggle() }
          )
          ParticipantBubble(
            name: "工作秘书", tintIndex: 1,
            status: ParticipantStatus(label: "正在重连（第 2 次）", phase: .connecting), action: {}
          )
          ParticipantBubble(
            name: "调研助手", tintIndex: 3,
            status: ParticipantStatus(
              label: "等待恢复", phase: .attention, canRecover: true,
              error: "组件预览：连接中断后，任务需要恢复。"
            ), action: {}
          )
          Spacer(minLength: 0)
          Button("预览回答") { previewRunning = true }
        }
        Text(previewInspector ? "预览检查器已打开" : "独立组件预览，不连接 Bot 或模型。")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
        Composer(placeholder: "测试换行与内部滚动", text: $draft) { draft = "" }
      }
    }
  }

  private var typographySection: some View {
    GalleryCard(title: "字号") {
      VStack(alignment: .leading, spacing: 10) {
        row("行标题 · 15 medium", Theme.TypeScale.rowTitle)
        row("行副标题 · 13.5 regular", Theme.TypeScale.rowSubtitle)
        row("区块标签 · 13.5 medium", Theme.TypeScale.sectionLabel)
        row("正文 · 15 regular", Theme.TypeScale.body)
        row("气泡文字 · 15", Theme.TypeScale.bubble)
        row("提示 · 13", Theme.TypeScale.note)
        row("检查器标题 · 18 semibold", Theme.TypeScale.inspectorTitle)
        row("卡片标题 · 14 medium", Theme.TypeScale.cardTitle)
        row("等宽 · 13", Theme.TypeScale.mono)
      }
    }
  }

  private var primitivesSection: some View {
    GalleryCard(title: "基础控件") {
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 12) {
          Avatar(
            initial: "监", tint: Theme.Palette.avatarTint(1), size: Theme.Metric.avatarProfile,
            badge: Theme.Palette.avatarTint(3))
          Avatar(
            initial: "G", tint: Theme.Palette.accentStrong, size: Theme.Metric.avatarProfile,
            shape: .blob)
          ForEach(Array(Theme.Palette.avatarTints.enumerated()), id: \.offset) { index, tint in
            Avatar(initial: "依", tint: tint)
          }
          Spacer(minLength: 0)
        }

        HStack(spacing: 12) {
          Text("工作秘书").font(Theme.TypeScale.rowTitle).foregroundStyle(Theme.Palette.textPrimary)
          Tag("Personal")
          Tag("GitHub")
          Spacer(minLength: 0)
        }

        HStack(spacing: 14) {
          IconButton(systemName: "magnifyingglass", label: "搜索") {}
          IconButton(systemName: "plus", label: "新建会话") {}
          IconButton(systemName: "square.and.arrow.up", label: "分享") {}
          IconButton(systemName: "xmark", label: "关闭") {}
          TextAction("更多未读消息") {}
          Spacer(minLength: 0)
        }

        SectionLabel("新闻组", unreadCount: 2)

        SegmentedTabs(values: InspectorColumn.Tab.allCases, selection: $tab) { $0.rawValue }
          .frame(maxWidth: 320)

        VStack(spacing: 8) {
          ChevronRow(
            systemName: "chevron.left.forwardslash.chevron.right", title: "deps 2026-10-24 sleepy"
          ) {}
          ToggleRow(title: "每日依赖修复调度", detail: "每天 8:47", isOn: $toggleOne)
          ToggleRow(title: "依赖修复进度 10-24", detail: "每小时，10月24日，10:00 – 20:00", isOn: $toggleTwo)
        }
        .frame(maxWidth: 320)
      }
    }
  }

  private var chatSection: some View {
    GalleryCard(title: "会话") {
      VStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
        AssistantBubble(text: "**可以正常轮询。**截至本机时间，最近一次检查已完成。\n\n- 历史消息保持不变\n- 悬停气泡可复制原始 Markdown")
        DeliveryNote("2 条消息往来：", avatars: Array(Theme.Palette.avatarTints.prefix(2)))
        UserBubble("今天 eagle 会修吗")
        WaitingLine(face: BotFace.Style(shape: .blob, tint: .violet), tintIndex: 4)
        Composer(placeholder: "给 依赖修复专家 发消息", text: $draft) {}
        Composer(
          placeholder: "给 依赖修复专家 发消息", hint: "⌘↩ 插入当前回答", text: $draftSteerable
        ) {}
      }
    }
  }

  private var panelSection: some View {
    GalleryCard(title: "栏目") {
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 16) {
          SidebarPanel(
            sections: [
              SidebarSection(
                id: "s", title: "秘书处",
                items: [
                  SidebarItem(
                    id: "1", title: "首席调查官", subtitle: "哥，最值得借鉴的是 OpenClaw 的聊天界面模块...", tintIndex: 0
                  ),
                  SidebarItem(
                    id: "2", title: "工作秘书", subtitle: "哥，周末早上有两件事：", tag: "Personal", tintIndex: 1),
                ]),
              SidebarSection(
                id: "n", title: "新闻组",
                items: [
                  SidebarItem(
                    id: "3", title: "知识库", subtitle: "哥，我查过了：翻墙大师的知识库 key 现在只能...", tintIndex: 5)
                ]),
            ],
            selection: "2",
            onSelect: { _ in },
            unreadCount: 2
          )
          .frame(height: 620)
          .overlay(alignment: .topTrailing) { cornerLabel("侧栏") }

          InspectorColumn(
            name: "依赖修复专家",
            subtitle: "GitHub",
            tintIndex: 2,
            pulls: [
              InspectorPullRow(
                id: "p1", title: "deps: 依赖升级到 2.4.0",
                host: "github.com", status: "merged",
                url: "https://github.com/nocoo/eagle/pull/490"),
              InspectorPullRow(
                id: "p2", title: "fix: reconnect after sleep",
                host: "dev.azure.com", status: "reviewing",
                url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12"),
            ],
            tasks: [
              InspectorTaskRow(
                id: "t_12", title: "生成回答", symbolName: "sparkles", status: "运行中", depth: 0,
                isRunning: true, isBlocked: false),
              InspectorTaskRow(
                id: "t_13", title: "工具调用", symbolName: "wrench.and.screwdriver", status: "等待",
                depth: 1, isRunning: false, isBlocked: false),
              InspectorTaskRow(
                id: "t_14", title: "子 Agent", symbolName: "person.2", status: "已停放：重试次数过多",
                depth: 2, isRunning: false, isBlocked: true),
            ],
            tab: .constant(.detail)
          )
          .frame(height: 620)
          .overlay(alignment: .topTrailing) { cornerLabel("检查器") }

          InspectorColumn(
            name: "新的 Bot",
            subtitle: "Bots",
            tintIndex: 5,
            pulls: [],
            tab: .constant(.detail)
          )
          .frame(height: 620)
          .overlay(alignment: .topTrailing) { cornerLabel("空状态") }
        }
      }
    }
  }

  private func swatch(_ name: String, _ color: Color) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(color)
        .frame(height: 44)
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
      Text(name).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textPrimary)
      Text("动态色彩").font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
    }
  }

  private func row(_ text: String, _ font: Font) -> some View {
    Text(text)
      .font(font)
      .foregroundStyle(Theme.Palette.textPrimary)
  }

  private func cornerLabel(_ text: String) -> some View {
    Text(text)
      .font(Theme.TypeScale.pill)
      .foregroundStyle(Theme.Palette.textSecondary)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Capsule().fill(Theme.Palette.card))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
      .padding(8)
  }
}

private struct GalleryCard<Content: View>: View {
  private let title: String
  private let content: Content

  init(title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack(spacing: 10) {
        RoundedRectangle(cornerRadius: 2)
          .fill(Theme.Palette.accentFill)
          .frame(width: 4, height: 18)
        Text(title).font(Theme.TypeScale.inspectorTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Spacer(minLength: 0)
        Text("PREVIEW").font(Theme.TypeScale.mono)
          .foregroundStyle(Theme.Palette.textMuted)
      }
      content
    }
    .padding(Theme.Metric.galleryInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.galleryRadius, style: .continuous).fill(
        Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.galleryRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }
}

private enum GallerySection: String, CaseIterable, Identifiable {
  case activity = "会话状态"
  case chat = "消息与输入"
  case primitives = "基础控件"
  case palette = "色彩令牌"
  case typography = "文字排版"
  case panels = "应用面板"

  var id: Self { self }

  var symbol: String {
    switch self {
    case .activity: "waveform"
    case .chat: "text.bubble"
    case .primitives: "slider.horizontal.3"
    case .palette: "circle.lefthalf.filled"
    case .typography: "textformat"
    case .panels: "rectangle.split.3x1"
    }
  }

  var detail: String {
    switch self {
    case .activity: "名字、实时反馈与操作，在一个控件中协作。"
    case .chat: "从一行输入到流式回答，保留清晰的对话节奏。"
    case .primitives: "可组合的原生控件，统一的尺寸与交互语言。"
    case .palette: "语义化色彩随浅色与深色外观自动切换。"
    case .typography: "清晰的字号层级，服务高密度阅读。"
    case .panels: "侧栏与检查器，共享同一套布局网格。"
    }
  }
}
