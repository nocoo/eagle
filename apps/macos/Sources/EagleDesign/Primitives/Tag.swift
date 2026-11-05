import SwiftUI

/// Small neutral pill, e.g. the `Personal` label beside a conversation title.
public struct Tag: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text)
      .font(Theme.TypeScale.pill)
      .foregroundStyle(Theme.Palette.textMuted)
      .padding(.horizontal, Theme.Layout.labelGap)
      .padding(.vertical, Theme.Layout.microGap)
      .background(
        RoundedRectangle(cornerRadius: Theme.Layout.badgeRadius, style: .continuous)
          .fill(Theme.Palette.line)
      )
      .fixedSize()
  }
}

/// One-pixel separator that never accumulates inset.
public struct PanelDivider: View {
  private let vertical: Bool

  public init(vertical: Bool = false) {
    self.vertical = vertical
  }

  public var body: some View {
    Rectangle()
      .fill(Theme.Palette.line)
      .frame(
        width: vertical ? Theme.Metric.hairline : nil,
        height: vertical ? nil : Theme.Metric.hairline
      )
  }
}

/// 11 pt secondary label used for grouping and hints.
public struct SectionLabel: View {
  private let text: String
  private let unreadCount: Int

  public init(_ text: String, unreadCount: Int = 0) {
    self.text = text
    self.unreadCount = unreadCount
  }

  public var body: some View {
    HStack(spacing: Theme.Layout.labelGap) {
      Text(text)
        .font(Theme.TypeScale.sectionLabel)
        .foregroundStyle(Theme.Palette.textSecondary)
        .tracking(Theme.TypeScale.sectionTracking)
      Spacer(minLength: 0)
      if unreadCount > 0 {
        Text("\(unreadCount)")
          .font(Theme.TypeScale.sectionLabel)
          .monospacedDigit()
          .foregroundStyle(Theme.Palette.onColor)
          .padding(.horizontal, Theme.Metric.unreadBadgeInset)
          .frame(minWidth: Theme.Metric.unreadBadgeHeight)
          .frame(height: Theme.Metric.unreadBadgeHeight)
          .background(Capsule().fill(Theme.Palette.accent))
          .fixedSize()
          .accessibilityLabel("\(unreadCount) 个未读会话")
      }
    }
    .accessibilityElement(children: .combine)
  }
}
