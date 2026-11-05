import SwiftUI

public struct Checkbox: View {
  @Binding private var isOn: Bool
  private let label: String

  public init(isOn: Binding<Bool>, label: String) {
    self._isOn = isOn
    self.label = label
  }

  public var body: some View {
    Toggle(label, isOn: $isOn)
      .toggleStyle(.checkbox)
  }
}
