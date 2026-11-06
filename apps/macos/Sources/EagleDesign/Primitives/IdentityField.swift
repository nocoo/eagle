import SwiftUI

/// A borderless field shaped like the inspector's identity: the name in title type and the
/// optional tag in subtitle type, on the card's own surface. A dialog that asks for both
/// therefore reads as a person's identity, not as two stacked form boxes; the caret marks
/// the field being typed in.
public struct IdentityField: View {
  public enum Kind { case name, tag }

  private let placeholder: String
  private let kind: Kind
  @Binding private var text: String
  private let autoFocus: Bool
  private let onSubmit: () -> Void
  @FocusState private var focused: Bool

  public init(
    _ placeholder: String,
    text: Binding<String>,
    kind: Kind,
    autoFocus: Bool = false,
    onSubmit: @escaping () -> Void = {}
  ) {
    self.placeholder = placeholder
    self._text = text
    self.kind = kind
    self.autoFocus = autoFocus
    self.onSubmit = onSubmit
  }

  public var body: some View {
    TextField(
      "", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.Palette.textMuted)
    )
    .textFieldStyle(.plain)
    .font(kind == .name ? Theme.TypeScale.inspectorTitle : Theme.TypeScale.rowSubtitle)
    .foregroundStyle(Theme.Palette.textPrimary)
    .focused($focused)
    .onSubmit(onSubmit)
    .accessibilityLabel(placeholder)
    .padding(.horizontal, inset)
    .frame(height: height)
    .background(
      RoundedRectangle(cornerRadius: radius, style: .continuous)
        .fill(focused ? Theme.Palette.canvas : Theme.Palette.clear)
    )
    .overlay(
      RoundedRectangle(cornerRadius: radius, style: .continuous)
        .strokeBorder(
          focused ? Theme.Palette.inlineEditFocus : Theme.Palette.clear,
          lineWidth: Theme.Metric.hairline
        )
    )
    .task {
      guard autoFocus else { return }
      await Task.yield()
      guard !Task.isCancelled else { return }
      focused = true
    }
  }

  private var inset: CGFloat {
    kind == .name ? Theme.Inspector.nameInset : Theme.Inspector.labelInset
  }

  private var height: CGFloat {
    kind == .name ? Theme.Inspector.nameHeight : Theme.Inspector.labelHeight
  }

  private var radius: CGFloat {
    kind == .name ? Theme.Inspector.nameRadius : Theme.Inspector.labelRadius
  }
}
