import SwiftUI

public struct ActionControl<Label: View>: View {
  public enum Style { case plain, bordered, prominent, automatic }
  private let role: ButtonRole?
  private let style: Style
  private let action: () -> Void
  private let label: Label

  public init(
    role: ButtonRole? = nil, style: Style = .plain, action: @escaping () -> Void,
    @ViewBuilder label: () -> Label
  ) {
    self.role = role
    self.style = style
    self.action = action
    self.label = label()
  }

  public init(
    _ title: String, role: ButtonRole? = nil, style: Style = .plain,
    action: @escaping () -> Void
  ) where Label == Text {
    self.init(role: role, style: style, action: action) { Text(title) }
  }

  @ViewBuilder public var body: some View {
    switch style {
    case .plain: button.buttonStyle(.plain)
    case .bordered: button.buttonStyle(.bordered)
    case .prominent: button.buttonStyle(.borderedProminent)
    case .automatic: button
    }
  }

  private var button: some View { Button(role: role, action: action) { label } }
}
