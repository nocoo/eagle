import SwiftUI

/// What one settings action reports. A page cannot tell a save from a refusal by the wording
/// alone, so the notice carries the meaning and the view picks the marker and the colour.
public struct SettingsNotice: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case neutral
    case success
    case failure
  }

  public let kind: Kind
  public let text: String

  public init(_ kind: Kind, _ text: String) {
    self.kind = kind
    self.text = text
  }

  public static func success(_ text: String) -> SettingsNotice {
    SettingsNotice(.success, text)
  }

  public static func failure(_ text: String) -> SettingsNotice {
    SettingsNotice(.failure, text)
  }
}

/// The line a settings card ends with: a marker, the sentence, and the row's own insets, so an
/// answer sits inside the card that owns the action instead of hugging its edge.
public struct SettingsStatusNote: View {
  private let notice: SettingsNotice

  public init(_ text: String, kind: SettingsNotice.Kind = .neutral) {
    self.notice = SettingsNotice(kind, text)
  }

  public init(_ notice: SettingsNotice) {
    self.notice = notice
  }

  private var marker: String? {
    switch notice.kind {
    case .neutral: return nil
    case .success: return "✅"
    case .failure: return "⚠️"
    }
  }

  private var tint: Color {
    switch notice.kind {
    case .neutral: return Theme.Palette.textSecondary
    case .success: return Theme.Palette.accentStrong
    case .failure: return Theme.Palette.destructive
    }
  }

  public var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.Form.noteMarkerGap) {
      if let marker {
        Text(marker)
          .font(Theme.TypeScale.note)
      }
      Text(notice.text)
        .font(Theme.TypeScale.note)
        .foregroundStyle(tint)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, Theme.Form.noteInset)
  }
}
