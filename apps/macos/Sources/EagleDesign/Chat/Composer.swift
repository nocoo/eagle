import SwiftUI

/// Rounded white composer: attach, text field, mic and waveform actions.
public struct Composer: View {
  private let placeholder: String
  /// What the field says while a run can be steered: it replaces the placeholder for as long
  /// as the answer is being written, with a small flip between the two lines.
  private let hint: String?
  @Binding private var text: String
  private let onSend: () -> Void
  /// Steers the running answer; nil while there is nothing to steer.
  private let onInsert: (() -> Void)?
  private let onAttach: () -> Void
  private let onMic: () -> Void
  private let onWaveform: () -> Void
  private let autofocus: Bool
  private let focusRequest: Int
  @FocusState private var focused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(
    placeholder: String,
    hint: String? = nil,
    text: Binding<String>,
    onSend: @escaping () -> Void,
    onInsert: (() -> Void)? = nil,
    onAttach: @escaping () -> Void = {},
    onMic: @escaping () -> Void = {},
    onWaveform: @escaping () -> Void = {},
    autofocus: Bool = false,
    focusRequest: Int = 0
  ) {
    self.placeholder = placeholder
    self.hint = hint
    self._text = text
    self.onSend = onSend
    self.onInsert = onInsert
    self.onAttach = onAttach
    self.onMic = onMic
    self.onWaveform = onWaveform
    self.autofocus = autofocus
    self.focusRequest = focusRequest
  }

  public var body: some View {
    HStack(alignment: .bottom, spacing: Theme.Layout.rowGap) {
      IconButton(systemName: "plus", label: "添加附件", size: Theme.Metric.hitTarget, action: onAttach)

      ZStack(alignment: .leading) {
        TextField("", text: $text, axis: .vertical)
          .textFieldStyle(.plain)
          .font(Theme.TypeScale.composer)
          .foregroundStyle(Theme.Palette.textPrimary)
          .focused($focused)
          .lineLimit(Theme.Chat.composerLines)
          .fixedSize(horizontal: false, vertical: true)
          .frame(minHeight: Theme.Metric.hitTarget)
          .onSubmit(onSend)
          .accessibilityLabel(placeholder)

        if text.isEmpty {
          fieldPlaceholder
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      IconButton(
        systemName: "mic", label: "语音输入", size: Theme.Metric.hitTarget,
        tint: Theme.Palette.textSecondary, action: onMic
      )
      IconButton(
        systemName: "waveform",
        label: "发送",
        size: Theme.Metric.hitTarget,
        tint: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          ? Theme.Palette.textSecondary
          : Theme.Palette.accentFill,
        action: onSend
      )
    }
    // ⌘↩ steers the running answer. A hidden button carries the shortcut so the field keeps
    // its Return behaviour; the hint above the composer tells a person it exists.
    .background {
      if let onInsert {
        Button("插入当前回答", action: onInsert)
          .keyboardShortcut(.return, modifiers: .command)
          .opacity(0)
          .frame(width: 0, height: 0)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, Theme.Metric.composerInnerInset)
    .padding(.vertical, Theme.Metric.composerVerticalInset)
    .frame(minHeight: Theme.Metric.composerHeight)
    // The transcript above is the flexible child. Without this the composer gives up its own
    // height when the column is short, and a squeezed pill leaves the caret off centre.
    .fixedSize(horizontal: false, vertical: true)
    .background(
      RoundedRectangle(cornerRadius: Theme.Chat.composerRadius, style: .continuous)
        .fill(Theme.Palette.card)
        .onTapGesture { focused = true }
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Chat.composerRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        .allowsHitTesting(false)
    )
    .task {
      guard autofocus else { return }
      await Task.yield()
      guard !Task.isCancelled else { return }
      focused = true
    }
    .onChange(of: focusRequest) { focused = true }
  }

  /// The two lines cross with a shallow 3D flip: the placeholder turns away as the steering
  /// hint turns in. Reduce Motion keeps the swap to a fade.
  private var fieldPlaceholder: some View {
    let steered = hint != nil
    return ZStack(alignment: .leading) {
      placeholderLine(
        placeholder, visible: !steered, turn: steered ? Theme.Chat.placeholderTurn : 0,
        rise: steered ? -Theme.Chat.placeholderRise : 0)
      placeholderLine(
        hint ?? "", visible: steered, turn: steered ? 0 : -Theme.Chat.placeholderTurn,
        rise: steered ? 0 : Theme.Chat.placeholderRise)
    }
    .animation(
      reduceMotion ? Theme.Motion.placeholderReduced : Theme.Motion.placeholder,
      value: steered
    )
  }

  private func placeholderLine(
    _ text: String, visible: Bool, turn: Double, rise: CGFloat
  ) -> some View {
    Text(text)
      .font(Theme.TypeScale.composer)
      .foregroundStyle(Theme.Palette.textSecondary)
      .lineLimit(1)
      .opacity(visible ? 1 : 0)
      .offset(y: reduceMotion ? 0 : rise)
      .rotation3DEffect(
        .degrees(reduceMotion ? 0 : turn),
        axis: (x: 1, y: 0, z: 0),
        anchor: .center,
        perspective: Theme.Chat.placeholderPerspective
      )
  }
}
