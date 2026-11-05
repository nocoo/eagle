import SwiftUI

/// Custom switch. SwiftUI's `Toggle(.switch)` ignores `.tint` on macOS and its
/// mini size does not match the reference, so the track is drawn directly.
public struct SwitchToggle: View {
  /// Two sizes, one drawing: the inspector uses the regular switch, a sidebar row uses the
  /// compact one so a 58 pt pitch keeps its text legible.
  public enum Size: Hashable, Sendable {
    case regular
    case compact
  }

  @Binding private var isOn: Bool
  private let label: String
  private let size: Size

  public init(isOn: Binding<Bool>, label: String, size: Size = .regular) {
    self._isOn = isOn
    self.label = label
    self.size = size
  }

  private var track: CGSize {
    switch size {
    case .regular: return CGSize(width: 34, height: 20)
    case .compact: return CGSize(width: 26, height: 15)
    }
  }

  private var knob: CGFloat {
    switch size {
    case .regular: return 16
    case .compact: return 11
    }
  }

  public var body: some View {
    Button {
      isOn.toggle()
    } label: {
      Capsule()
        .fill(isOn ? Theme.Palette.accentStrong : Theme.Palette.line)
        .frame(width: track.width, height: track.height)
        .overlay(alignment: isOn ? .trailing : .leading) {
          Circle()
            .fill(Theme.Palette.card)
            .frame(width: knob, height: knob)
            .padding(2)
            .shadow(color: Theme.Palette.switchShadow, radius: 1, y: 0.5)
        }
        .animation(.easeOut(duration: 0.14), value: isOn)
    }
    .buttonStyle(.plain)
    .contentShape(Capsule())
    .accessibilityLabel(label)
    .accessibilityAddTraits(isOn ? [.isSelected] : [])
  }
}

/// The shared activity arc: tool rows, task rows and settings. Deterministic start state so
/// snapshots and the offscreen renderer agree with the app.
public struct SpinnerArc: View {
  private let size: CGFloat
  private let lineWidth: CGFloat
  @State private var spinning = false

  public init(size: CGFloat = 12, lineWidth: CGFloat = 1.6) {
    self.size = size
    self.lineWidth = lineWidth
  }

  public var body: some View {
    Circle()
      .trim(from: 0.12, to: 0.78)
      .stroke(
        Theme.Palette.accentStrong,
        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
      )
      .frame(width: size, height: size)
      .rotationEffect(.degrees(spinning ? 360 : 0))
      .animation(
        .linear(duration: 0.9).repeatForever(autoreverses: false),
        value: spinning
      )
      .onAppear { spinning = true }
      .accessibilityHidden(true)
  }
}
