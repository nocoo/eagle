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
  @State private var gridField = "共享前导线与控件高度"
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
    .frame(minWidth: Theme.Gallery.minWidth, minHeight: Theme.Gallery.minHeight)
    .background(Theme.Palette.surface)
    .preferredColorScheme(darkPreview ? .dark : .light)
    .animation(reduceMotion ? nil : Theme.Motion.sectionExpansion, value: section)
  }

  private var navigation: some View {
    VStack(alignment: .leading, spacing: Theme.Layout.pageInset) {
      HStack(spacing: Theme.Layout.controlGap) {
        Image(systemName: "square.stack.3d.up.fill")
          .font(Theme.TypeScale.gallerySymbol)
          .foregroundStyle(Theme.Palette.accentStrong)
        VStack(alignment: .leading, spacing: Theme.Layout.microGap) {
          Text("Eagle").font(Theme.TypeScale.brand)
          Text("原生设计工坊").font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
      VStack(spacing: Theme.Layout.labelGap) {
        ForEach(GallerySection.allCases) { item in
          Button {
            section = item
          } label: {
            HStack(spacing: Theme.Layout.sectionGap) {
              Image(systemName: item.symbol).frame(width: Theme.Layout.glyphSlot)
              Text(item.rawValue).font(Theme.TypeScale.cardTitle)
              Spacer(minLength: 0)
              if section == item {
                Circle().fill(Theme.Palette.accentStrong).frame(
                  width: Theme.Gallery.activeMarker, height: Theme.Gallery.activeMarker)
              }
            }
            .foregroundStyle(
              section == item ? Theme.Palette.accentStrong : Theme.Palette.textSecondary
            )
            .padding(Theme.Layout.sectionGap)
            .background(
              RoundedRectangle(cornerRadius: Theme.Metric.controlRadius)
                .fill(section == item ? Theme.Palette.gallerySelection : .clear)
            )
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(section == item ? .isSelected : [])
        }
        Divider().overlay(Theme.Palette.line)
        Button(action: onShowSettings) {
          HStack(spacing: Theme.Layout.sectionGap) {
            Image(systemName: "gearshape").frame(width: Theme.Layout.glyphSlot)
            Text("设置…").font(Theme.TypeScale.cardTitle)
            Spacer(minLength: 0)
            Text("⌘,").font(Theme.TypeScale.note)
          }
          .foregroundStyle(Theme.Palette.textSecondary)
          .padding(Theme.Layout.sectionGap)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("设置…")
        .accessibilityIdentifier("eagle.gallery.settings")
      }
      Spacer(minLength: Theme.Layout.pageInset)
      VStack(alignment: .leading, spacing: Theme.Layout.labelGap) {
        Text("SWIFTUI / MACOS").font(Theme.TypeScale.mono)
        Text("真实组件 · 隔离预览")
          .font(Theme.TypeScale.note)
      }
      .foregroundStyle(Theme.Palette.textMuted)
    }
    .padding(.horizontal, Theme.Metric.contentInset)
    .padding(.top, Theme.Gallery.navigationTop)
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
    HStack(alignment: .center, spacing: Theme.Layout.pageInset) {
      VStack(alignment: .leading, spacing: Theme.Layout.labelGap) {
        Text("EAGLE / COMPONENT LIBRARY")
          .font(Theme.TypeScale.mono)
          .foregroundStyle(Theme.Palette.accentStrong)
        Text(section.rawValue)
          .font(Theme.TypeScale.galleryTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Text(section.detail)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      Spacer(minLength: 0)
      SwitchToggle(isOn: $darkPreview, label: "深色预览")
        .font(Theme.TypeScale.note)
        .fixedSize()
    }
    .padding(Theme.Metric.galleryInset)
    .padding(.top, Theme.Layout.sectionGap)
    .background(Theme.Palette.surface)
  }

  private var paletteSection: some View {
    VStack(alignment: .leading, spacing: Theme.Layout.pageInset) {
      GalleryCard(title: "八色身份 · light / dark 同一色相") {
        VStack(spacing: Theme.Layout.rowGap) {
          HStack(spacing: Theme.Layout.rowGap) {
            Text("身份").frame(width: Theme.Gallery.identityLabelWidth, alignment: .leading)
            ForEach(["糖果原色", "深底白字", "浅底深字", "彩色文字"], id: \.self) { role in
              Text(role).frame(maxWidth: .infinity)
            }
          }
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
          ForEach(Theme.Palette.BotTint.selectable, id: \.self) { tint in
            let colors = Theme.Palette.family(tint)
            HStack(spacing: Theme.Layout.rowGap) {
              Text(tint.rawValue).font(Theme.TypeScale.note)
                .frame(width: Theme.Gallery.identityLabelWidth, alignment: .leading)
              paletteSample("Aa", background: colors.identity, foreground: Theme.Palette.darkInk)
              paletteSample("Aa 白字", background: colors.solid, foreground: colors.onSolid)
              paletteSample("Aa 深字", background: colors.soft, foreground: colors.onSoft)
              paletteSample("Aa 色字", background: Theme.Palette.card, foreground: colors.ink)
            }
          }
          Text("切换右上角外观预览。原色用于身份标记；正文使用配对色，不把颜色当作状态。")
            .font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      GalleryCard(title: "4 pt 主栅格 · 2 pt 紧凑细分") {
        VStack(alignment: .leading, spacing: Theme.Layout.sectionInset) {
          HStack(alignment: .top, spacing: Theme.Layout.sectionInset) {
            ForEach(
              [
                Theme.Layout.detailGap, Theme.Layout.rowGap, Theme.Layout.sectionGap,
                Theme.Layout.sectionInset, Theme.Layout.pageInset, Theme.Layout.pageBottomInset,
              ], id: \.self
            ) { gap in
              VStack(alignment: .leading, spacing: Theme.Layout.detailGap) {
                Text("\(Int(gap)) pt").font(Theme.TypeScale.note)
                RoundedRectangle(cornerRadius: Theme.Layout.badgeRadius)
                  .fill(Theme.Palette.family(Theme.Palette.BotTint.blue).identity)
                  .frame(width: gap, height: Theme.Form.actionHeight)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          VStack(spacing: 0) {
            SettingsSectionRow("字段", detail: "36 pt 高 · 12 pt 内容边距") {
              SettingsTextField("输入样本", text: $gridField)
            }
            Divider().overlay(Theme.Palette.line)
            SettingsSectionRow("动作", detail: "32 pt 高 · 相同前导线") {
              SettingsActionButton("动作样本", prominent: true) {}
                .frame(width: Theme.Form.fieldWidth, alignment: .leading)
            }
          }
        }
      }
      neutralPalette
    }
  }

  private func paletteSample(_ label: String, background: Color, foreground: Color) -> some View {
    Text(label).font(Theme.TypeScale.noteEmphasis)
      .foregroundStyle(foreground)
      .frame(maxWidth: .infinity)
      .frame(height: Theme.Form.fieldHeight)
      .background(background, in: RoundedRectangle(cornerRadius: Theme.Metric.controlRadius))
  }

  private var neutralPalette: some View {
    GalleryCard(title: "中性色与语义角色") {
      LazyVGrid(
        columns: Array(
          repeating: GridItem(.flexible(), spacing: Theme.Layout.sectionGap),
          count: Theme.Gallery.paletteColumns), spacing: Theme.Layout.sectionGap
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
      VStack(alignment: .leading, spacing: Theme.Layout.sectionInset) {
        HStack(spacing: Theme.Layout.pageInset) {
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
      VStack(alignment: .leading, spacing: Theme.Layout.controlGap) {
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
      VStack(alignment: .leading, spacing: Theme.Layout.groupGap) {
        HStack(spacing: Theme.Layout.sectionGap) {
          Avatar(
            initial: "监", tint: Theme.Palette.avatarTint(1), size: Theme.Metric.avatarProfile,
            badge: Theme.Palette.avatarTint(3))
          Avatar(
            initial: "G", tint: Theme.Palette.family(Theme.Palette.BotTint.green).identity,
            size: Theme.Metric.avatarProfile,
            shape: .blob)
          ForEach(Array(Theme.Palette.avatarTints.enumerated()), id: \.offset) { index, tint in
            Avatar(initial: "依", tint: tint)
          }
          Spacer(minLength: 0)
        }

        HStack(spacing: Theme.Layout.sectionGap) {
          Text("工作秘书").font(Theme.TypeScale.rowTitle).foregroundStyle(Theme.Palette.textPrimary)
          Tag("Personal")
          Tag("GitHub")
          Spacer(minLength: 0)
        }

        HStack(spacing: Theme.Layout.controlInset) {
          IconButton(systemName: "magnifyingglass", label: "搜索") {}
          IconButton(systemName: "plus", label: "新建会话") {}
          IconButton(systemName: "square.and.arrow.up", label: "分享") {}
          IconButton(systemName: "xmark", label: "关闭") {}
          TextAction("更多未读消息") {}
          Spacer(minLength: 0)
        }

        SectionLabel("新闻组", unreadCount: 2)

        SegmentedTabs(values: InspectorColumn.Tab.allCases, selection: $tab) { $0.rawValue }
          .frame(maxWidth: Theme.Gallery.controlsWidth)

        VStack(spacing: Theme.Layout.rowGap) {
          ChevronRow(
            systemName: "chevron.left.forwardslash.chevron.right", title: "deps 2026-10-24 sleepy"
          ) {}
          SettingsCard {
            VStack(spacing: 0) {
              SettingsSectionRow("每日依赖修复调度", detail: "每天 8:47") {
                SwitchToggle(isOn: $toggleOne, label: "每日依赖修复调度").labelsHidden()
              }
              Divider().overlay(Theme.Palette.line)
              SettingsSectionRow("依赖修复进度 10-24", detail: "每小时，10月24日，10:00 – 20:00") {
                SwitchToggle(isOn: $toggleTwo, label: "依赖修复进度 10-24").labelsHidden()
              }
            }
          }
        }
        .frame(maxWidth: Theme.Gallery.controlsWidth)
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
        HStack(alignment: .top, spacing: Theme.Layout.sectionInset) {
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
          .frame(width: Theme.Metric.sidebarWidth, height: Theme.Gallery.previewHeight)
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
          .frame(width: Theme.Metric.inspectorWidth, height: Theme.Gallery.previewHeight)
          .overlay(alignment: .topTrailing) { cornerLabel("检查器") }

          InspectorColumn(
            name: "新的 Bot",
            subtitle: "Bots",
            tintIndex: 5,
            pulls: [],
            tab: .constant(.detail)
          )
          .frame(width: Theme.Metric.inspectorWidth, height: Theme.Gallery.previewHeight)
          .overlay(alignment: .topTrailing) { cornerLabel("空状态") }
        }
      }
    }
  }

  private func swatch(_ name: String, _ color: Color) -> some View {
    VStack(alignment: .leading, spacing: Theme.Layout.labelGap) {
      RoundedRectangle(cornerRadius: Theme.Primitive.smallRadius, style: .continuous)
        .fill(color)
        .frame(height: Theme.Gallery.swatchHeight)
        .overlay(
          RoundedRectangle(cornerRadius: Theme.Primitive.smallRadius, style: .continuous)
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
      .padding(.horizontal, Theme.Layout.labelGap)
      .padding(.vertical, Theme.Layout.microGap)
      .background(Capsule().fill(Theme.Palette.card))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
      .padding(Theme.Layout.rowGap)
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
    VStack(alignment: .leading, spacing: Theme.Layout.pageInset) {
      HStack(spacing: Theme.Layout.controlGap) {
        RoundedRectangle(cornerRadius: Theme.Gallery.sectionMarkerRadius)
          .fill(Theme.Palette.accentFill)
          .frame(width: Theme.Gallery.sectionMarkerWidth, height: Theme.Gallery.sectionMarkerHeight)
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
