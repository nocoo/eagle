import SwiftUI

/// Right column: participant summary, text tabs, then the decorated sections of the
/// selected tab. Every section is a header (glyph, title, hairline) plus rows or an empty
/// state, so the column keeps one grid whether or not a bot has anything to show.
public struct InspectorColumn: View {
  public enum Tab: String, CaseIterable, Hashable, Sendable {
    case detail = "详情"
    case model = "模型"
    case triggers = "触发器"
    case library = "资料库"
    case computer = "电脑"
  }

  private let name: String
  private let subtitle: String
  private let tintIndex: Int
  private let width: CGFloat
  /// The reported pull requests the 编码 section shows.
  private let pulls: [InspectorPullRow]
  private let tasks: [InspectorTaskRow]
  private let usage: [InspectorUsageRow]
  private let choices: [InspectorChoiceRow]
  /// The selected trigger's read-only detail; empty leaves the section's placeholder.
  private let triggers: [InspectorTriggerRow]
  private let onChoose: (String, String) -> Void
  private let onToggleTrigger: (String, Bool) -> Void
  @Binding private var tab: Tab
  private let onRetryTask: (String) -> Void
  private let onStopTask: (String) -> Void
  private let onExpand: () -> Void
  private let onCollapse: () -> Void
  private let onShare: () -> Void
  private let face: BotFace.Style?
  private let label: String?
  private let onEditFace: (() -> Void)?
  private let onCommitName: ((String) -> Void)?
  private let onCommitLabel: ((String) -> Void)?
  private let computerContent: AnyView?
  private let libraryContent: AnyView?

  public init(
    name: String,
    subtitle: String,
    tintIndex: Int,
    width: CGFloat = Theme.Metric.inspectorWidth,
    pulls: [InspectorPullRow] = [],
    tasks: [InspectorTaskRow] = [],
    usage: [InspectorUsageRow] = [],
    choices: [InspectorChoiceRow] = [],
    triggers: [InspectorTriggerRow] = [],
    onChoose: @escaping (String, String) -> Void = { _, _ in },
    onToggleTrigger: @escaping (String, Bool) -> Void = { _, _ in },
    tab: Binding<Tab>,
    onRetryTask: @escaping (String) -> Void = { _ in },
    onStopTask: @escaping (String) -> Void = { _ in },
    onExpand: @escaping () -> Void = {},
    onCollapse: @escaping () -> Void = {},
    onShare: @escaping () -> Void = {},
    face: BotFace.Style? = nil,
    label: String? = nil,
    onEditFace: (() -> Void)? = nil,
    onCommitName: ((String) -> Void)? = nil,
    onCommitLabel: ((String) -> Void)? = nil,
    computerContent: AnyView? = nil,
    libraryContent: AnyView? = nil
  ) {
    self.name = name
    self.subtitle = subtitle
    self.tintIndex = tintIndex
    self.width = width
    self.pulls = pulls
    self.tasks = tasks
    self.usage = usage
    self.choices = choices
    self.triggers = triggers
    self.onChoose = onChoose
    self.onToggleTrigger = onToggleTrigger
    self._tab = tab
    self.onRetryTask = onRetryTask
    self.onStopTask = onStopTask
    self.onExpand = onExpand
    self.onCollapse = onCollapse
    self.onShare = onShare
    self.face = face
    self.label = label
    self.onEditFace = onEditFace
    self.onCommitName = onCommitName
    self.onCommitLabel = onCommitLabel
    self.computerContent = computerContent
    self.libraryContent = libraryContent
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HeaderRow {
        HStack(spacing: Theme.Metric.headerControlGap) {
          Spacer(minLength: 0)
          IconButton(
            systemName: "square.and.arrow.up", label: "分享",
            size: Theme.Metric.headerControlHeight, style: .circled, action: onShare)
          IconButton(
            systemName: "xmark",
            label: "收起检查器",
            size: Theme.Metric.headerControlHeight,
            style: .circled,
            action: onCollapse
          )
        }
        .padding(.trailing, Theme.Metric.panelInset)
      }

      Identity(
        name: name,
        subtitle: subtitle,
        tintIndex: tintIndex,
        face: face,
        label: label,
        onEditFace: onEditFace,
        onCommitName: onCommitName,
        onCommitLabel: onCommitLabel
      )

      SegmentedTabs(values: Tab.allCases, selection: $tab) { $0.rawValue }
        .padding(.horizontal, Theme.Metric.panelInset)

      ScrollView {
        VStack(alignment: .leading, spacing: Theme.Metric.panelSectionGap) {
          content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.18), value: tab)
        .padding(.horizontal, Theme.Metric.panelInset)
        .padding(.top, 16)
        .padding(.bottom, 20)
      }
      .scrollEdgeFades(
        Theme.Palette.surface, top: Theme.Metric.edgeFadeHeight, bottom: Theme.Metric.edgeFadeHeight
      )
    }
    .frame(width: width)
    .frame(maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }

  private var sections: [InspectorSectionModel] {
    switch tab {
    case .detail:
      return InspectorSections.detail(pulls: pulls, tasks: tasks)
    case .model:
      return InspectorSections.model(choices: choices, usage: usage)
    case .triggers:
      return [InspectorSections.triggersSection.with(.triggers(triggers))]
    case .library:
      return InspectorSections.library()
    case .computer:
      return InspectorSections.computer()
    }
  }

  @ViewBuilder private var content: some View {
    if tab == .computer, let computerContent {
      computerContent
    } else if tab == .library, let libraryContent {
      libraryContent
    } else {
      ForEach(sections) { section in
        InspectorSectionView(
          section: section,
          onExpand: onExpand,
          onRetryTask: onRetryTask,
          onStopTask: onStopTask,
          onChoose: onChoose,
          onToggleTrigger: onToggleTrigger
        )
      }
    }
  }
}

private struct Identity: View {
  let name: String
  let subtitle: String
  let tintIndex: Int
  let face: BotFace.Style?
  let label: String?
  let onEditFace: (() -> Void)?
  let onCommitName: ((String) -> Void)?
  let onCommitLabel: ((String) -> Void)?

  @State private var hoveringAvatar = false
  @State private var editingName = false
  @State private var editingLabel = false
  @State private var nameDraft = ""
  @State private var labelDraft = ""
  @FocusState private var nameFocused: Bool
  @FocusState private var labelFocused: Bool

  var body: some View {
    VStack(spacing: 8) {
      avatar
      VStack(spacing: 3) {
        nameView
        HStack(spacing: 5) {
          if onCommitLabel != nil {
            labelView
            Text("·")
              .font(Theme.TypeScale.rowSubtitle)
              .foregroundStyle(Theme.Palette.textMuted)
          }
          Text(subtitle)
            .font(Theme.TypeScale.rowSubtitle)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 16)
    .padding(.bottom, 18)
  }

  @ViewBuilder
  private var avatar: some View {
    if let face {
      BotFace(style: face, size: Theme.Metric.avatarInspector)
        .overlay {
          if hoveringAvatar, onEditFace != nil {
            ZStack {
              Circle()
                .fill(Color.black.opacity(0.36))
              Image(systemName: "pencil")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
            }
          }
        }
        .contentShape(Circle())
        .onHover { hoveringAvatar = $0 }
        .onTapGesture { onEditFace?() }
        .help(onEditFace == nil ? "" : "点击编辑头像")
        .accessibilityLabel("编辑 \(name) 的头像")
    } else {
      Avatar(
        initial: String(name.prefix(1)),
        tint: Theme.Palette.avatarTint(tintIndex),
        size: Theme.Metric.avatarInspector,
        shape: .blob
      )
    }
  }

  @ViewBuilder
  private var nameView: some View {
    if editingName {
      TextField("", text: $nameDraft)
        .textFieldStyle(.plain)
        .font(Theme.TypeScale.inspectorTitle)
        .multilineTextAlignment(.center)
        .focused($nameFocused)
        .onSubmit(commitName)
        .onExitCommand { editingName = false }
        .onChange(of: nameFocused) { if !nameFocused { commitName() } }
        .padding(.horizontal, 8)
        .frame(height: 30)
        .background(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(Theme.Palette.canvas)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .strokeBorder(Theme.Palette.accent.opacity(0.55), lineWidth: Theme.Metric.hairline)
        )
        .frame(maxWidth: 220)
    } else {
      Text(name)
        .font(Theme.TypeScale.inspectorTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
        .contentShape(Rectangle())
        .onTapGesture {
          guard onCommitName != nil else { return }
          nameDraft = name
          editingName = true
          nameFocused = true
        }
        .help(onCommitName == nil ? "" : "点击编辑名字")
    }
  }

  @ViewBuilder
  private var labelView: some View {
    if editingLabel {
      TextField("", text: $labelDraft)
        .textFieldStyle(.plain)
        .font(Theme.TypeScale.rowSubtitle)
        .multilineTextAlignment(.center)
        .focused($labelFocused)
        .onSubmit(commitLabel)
        .onExitCommand { editingLabel = false }
        .onChange(of: labelFocused) { if !labelFocused { commitLabel() } }
        .padding(.horizontal, 7)
        .frame(height: 24)
        .background(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Theme.Palette.canvas)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .strokeBorder(Theme.Palette.accent.opacity(0.55), lineWidth: Theme.Metric.hairline)
        )
        .frame(maxWidth: 150)
    } else {
      Button {
        labelDraft = label ?? ""
        editingLabel = true
        labelFocused = true
      } label: {
        Text(label?.isEmpty == false ? (label ?? "") : "添加标签")
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(label == nil ? Theme.Palette.textMuted : Theme.Palette.textSecondary)
      }
      .buttonStyle(.plain)
      .help("点击编辑标签")
    }
  }

  private func commitName() {
    guard editingName else { return }
    editingName = false
    let trimmed = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed != name else { return }
    onCommitName?(trimmed)
  }

  private func commitLabel() {
    guard editingLabel else { return }
    editingLabel = false
    let trimmed = labelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed != (label ?? "") else { return }
    onCommitLabel?(trimmed)
  }
}
