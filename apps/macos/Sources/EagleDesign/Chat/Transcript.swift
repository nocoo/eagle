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
  @State private var hovering = false

  public init(_ text: String, origin: String? = nil) {
    self.text = text
    self.origin = origin
  }

  public var body: some View {
    HStack {
      Spacer(minLength: 96)
      HStack(alignment: .bottom, spacing: 8) {
        copyAction
        selectable(
          bubbleText
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.Palette.accentFill)
            )
        )
        .messageCopyAlignment()
      }
      .onHover { hovering = $0 }
    }
  }

  /// One `Text` for an ordinary message: the common row must not pay for a container it
  /// does not need. Only a message with a cause other than a person gains a second line.
  @ViewBuilder
  private var bubbleText: some View {
    if let origin {
      VStack(alignment: .leading, spacing: 3) {
        Text(origin)
          .font(Theme.TypeScale.pill)
          .foregroundStyle(.white.opacity(0.72))
        messageText
      }
    } else {
      messageText
    }
  }

  private var messageText: some View {
    Text(text)
      .font(Theme.TypeScale.bubble)
      .foregroundStyle(.white)
  }

  /// Selection machinery is built only for the row under the pointer: it costs more
  /// per row than the text it serves.
  @ViewBuilder
  private func selectable<Content: View>(_ content: Content) -> some View {
    if hovering {
      content.textSelection(.enabled)
    } else {
      content
    }
  }

  private var copyAction: some View {
    Group {
      if hovering {
        MessageCopyButton(text: text, label: "复制用户消息")
      } else {
        Color.clear
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
    HStack(spacing: 6) {
      Spacer(minLength: 0)
      ForEach(Array(avatars.enumerated()), id: \.offset) { index, tint in
        Avatar(initial: "", tint: tint, size: Theme.Metric.avatarNote)
          .overlay(alignment: .center) {
            Image(systemName: index % 2 == 0 ? "person.fill" : "sparkle")
              .font(.system(size: 7, weight: .bold))
              .foregroundStyle(.white)
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
