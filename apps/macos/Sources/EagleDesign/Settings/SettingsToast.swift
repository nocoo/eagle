import SwiftUI

extension SettingsNotice {
  var marker: String? {
    switch kind {
    case .neutral: return nil
    case .success: return "✅"
    case .failure: return "⚠️"
    }
  }

  var tint: Color {
    switch kind {
    case .neutral: return Theme.Palette.textSecondary
    case .success: return Theme.Palette.accentStrong
    case .failure: return Theme.Palette.destructive
    }
  }
}

/// What a settings window says for a moment and then forgets. A save's answer belongs to no
/// card, so it must not change the height of the page it came from.
@MainActor
public final class ToastCenter: ObservableObject {
  public struct Toast: Identifiable, Equatable {
    public let id = UUID()
    public let notice: SettingsNotice
  }

  @Published public private(set) var toast: Toast?
  private let dwell: Duration
  private var retirement: Task<Void, Never>?

  public init(dwell: Duration = .seconds(Theme.Motion.toastDwell)) {
    self.dwell = dwell
  }

  /// A new answer replaces the one on screen and restarts its own dwell time.
  public func show(_ notice: SettingsNotice) {
    let toast = Toast(notice: notice)
    withAnimation(Theme.Motion.toast) { self.toast = toast }
    retirement?.cancel()
    retirement = Task {
      try? await Task.sleep(for: dwell)
      guard !Task.isCancelled, toast.id == self.toast?.id else { return }
      withAnimation(Theme.Motion.toast) { self.toast = nil }
    }
  }
}

/// The floating line a settings action reports through: the same marker as a card note, on a
/// card of its own, over the page and out of its layout.
public struct SettingsToast: View {
  private let notice: SettingsNotice

  public init(_ notice: SettingsNotice) {
    self.notice = notice
  }

  public var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.Form.noteMarkerGap) {
      if let marker = notice.marker {
        Text(marker)
          .font(Theme.TypeScale.note)
      }
      Text(notice.text)
        .font(Theme.TypeScale.note)
        .foregroundStyle(notice.tint)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, Theme.Form.controlInset)
    .padding(.vertical, Theme.Form.noteInset)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .shadow(
      color: Theme.Palette.roundShadow,
      radius: Theme.Metric.toastShadowRadius,
      y: Theme.Metric.toastShadowY
    )
    .accessibilityIdentifier("settings.toast")
  }
}
