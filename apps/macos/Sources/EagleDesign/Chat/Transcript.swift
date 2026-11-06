import SwiftUI

/// A block of an assistant turn: how the demo transcript carries structured text.
public enum AssistantBlock: Hashable, Sendable {
  case paragraph(String)
  case bullets([String])
  case note(String)
}

/// The only colored surface in the transcript: a green pill aligned right.
public struct UserBubble: View {
  private let text: String
  private let origin: String?
  private let onInsertSelection: ((String) -> Void)?
  private let onClearSelection: () -> Void
  private let selectionSource: String
  private let selectedText: String
  private let selectionOverride: Bool?
  @State private var hovering = false

  public init(
    _ text: String,
    origin: String? = nil,
    onInsertSelection: ((String) -> Void)? = nil,
    onClearSelection: @escaping () -> Void = {},
    selectionSource: String = "",
    selectedText: String = "",
    selectionOverride: Bool? = nil
  ) {
    self.text = text
    self.origin = origin
    self.onInsertSelection = onInsertSelection
    self.onClearSelection = onClearSelection
    self.selectionSource = selectionSource
    self.selectedText = selectedText
    self.selectionOverride = selectionOverride
  }

  public var body: some View {
    let hasSelection =
      selectionSource == text
      && !selectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let selectionEnabled =
      selectionOverride
      ?? (hovering || hasSelection
        || ProcessInfo.processInfo.environment["EAGLE_COMPOSER_FOCUS_FIXTURE"] == "1")
    HStack(spacing: Theme.Layout.rowGap) {
      Spacer(minLength: Theme.Chat.userLeadingSpace)
      HStack(alignment: .bottom, spacing: Theme.Layout.rowGap) {
        copyAction
        bubbleText(selectionEnabled: selectionEnabled)
          .padding(.horizontal, Theme.Chat.bubbleHorizontalInset)
          .padding(.vertical, Theme.Chat.userVerticalInset)
          .background(
            RoundedRectangle(cornerRadius: Theme.Chat.userRadius, style: .continuous)
              .fill(Theme.Palette.accentFill)
          )
          .overlay(alignment: .topTrailing) {
            if hasSelection {
              selectionAction
            }
          }
          .messageCopyAlignment()
      }
      .frame(maxWidth: Theme.Chat.rowMaxWidth, alignment: .trailing)
      .onHover { hovering = $0 }
    }
  }

  /// One `Text` for an ordinary message: the common row must not pay for a container it
  /// does not need. Only a message with a cause other than a person gains a second line.
  @ViewBuilder
  private func bubbleText(selectionEnabled: Bool) -> some View {
    VStack(alignment: .leading, spacing: Theme.Layout.captionGap) {
      if let origin {
        Text(origin)
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.onColorSecondary)
      }
      ZStack(alignment: .topLeading) {
        messageText
          .opacity(selectionEnabled ? 0 : 1)
          .allowsHitTesting(!selectionEnabled)
        if selectionEnabled {
          SelectableTranscriptText(attributedText: BubbleTextBuilder.plainUserText(text))
        }
      }
    }
  }

  private var messageText: some View {
    Text(text)
      .font(Theme.TypeScale.bubble)
      .foregroundStyle(Theme.Palette.onColor)
      .fixedSize(horizontal: false, vertical: true)
  }

  private var selectionAction: some View {
    CardActionButton("发送到对话") {
      let text = selectedText
      onClearSelection()
      onInsertSelection?(text)
    }
    .offset(y: -Theme.Form.actionHeight)
  }

  private var copyAction: some View {
    Group {
      if hovering {
        MessageCopyButton(text: text, label: "复制用户消息")
      } else {
        Theme.Palette.clear
      }
    }
    .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
  }
}

/// Centered meta line between turns, with optional participant avatars.
public struct DeliveryNote: View {
  private let text: String
  private let avatars: [Color]

  public init(_ text: String, avatars: [Color] = []) {
    self.text = text
    self.avatars = avatars
  }

  public var body: some View {
    HStack(spacing: Theme.Layout.labelGap) {
      Spacer(minLength: 0)
      ForEach(Array(avatars.enumerated()), id: \.offset) { index, tint in
        Avatar(initial: "", tint: tint, size: Theme.Metric.avatarNote)
          .overlay(alignment: .center) {
            Image(systemName: index % 2 == 0 ? "person.fill" : "sparkle")
              .font(Theme.TypeScale.Glyph.delivery)
              .foregroundStyle(Theme.Palette.darkInk)
          }
      }
      Text(text)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}
