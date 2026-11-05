import SwiftUI

public struct SwitchToggle: View {
  @Binding private var isOn: Bool
  private let label: String

  public init(isOn: Binding<Bool>, label: String) {
    self._isOn = isOn
    self.label = label
  }

  public var body: some View {
    Toggle(label, isOn: $isOn)
      .toggleStyle(.switch)
  }
}

/// The shared activity arc: tool rows, task rows and settings. Deterministic start state so
/// snapshots and the offscreen renderer agree with the app.
public struct SpinnerArc: View {
  private let size: CGFloat
  private let lineWidth: CGFloat
  @State private var spinning = false

  public init(
    size: CGFloat = Theme.Metric.spinnerSize, lineWidth: CGFloat = Theme.Metric.spinnerStroke
  ) {
    self.size = size
    self.lineWidth = lineWidth
  }

  public var body: some View {
    Circle()
      .trim(from: Theme.Primitive.arcStart, to: Theme.Primitive.arcEnd)
      .stroke(
        Theme.Palette.accentStrong,
        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
      )
      .frame(width: size, height: size)
      .rotationEffect(.degrees(spinning ? 360 : 0))
      .animation(
        Theme.Motion.spinner,
        value: spinning
      )
      .onAppear { spinning = true }
      .accessibilityHidden(true)
  }
}
