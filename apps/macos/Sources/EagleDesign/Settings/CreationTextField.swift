import SwiftUI

public struct CreationTextField: View {
  public enum Kind { case name, label }
  private let prompt: String
  private let kind: Kind
  @Binding private var text: String

  public init(_ prompt: String, text: Binding<String>, kind: Kind) {
    self.prompt = prompt
    self._text = text
    self.kind = kind
  }

  public var body: some View {
    TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Theme.Palette.textSecondary))
      .textFieldStyle(.plain)
      .font(kind == .name ? Theme.TypeScale.body : Theme.TypeScale.note)
      .padding(.horizontal, Theme.Layout.controlInset)
      .frame(height: kind == .name ? Theme.Dialog.nameFieldHeight : Theme.Dialog.labelFieldHeight)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .fill(Theme.Palette.card)
          .overlay {
            RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
              .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
          }
      )
  }
}
