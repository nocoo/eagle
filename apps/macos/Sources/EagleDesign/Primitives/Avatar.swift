import SwiftUI

/// Colored circle with an initial, optionally carrying a status dot.
public struct Avatar: View {
  public enum Shape {
    case circle
    /// Soft rounded blob used by agent/organization avatars in the reference.
    case blob
  }

  private let initial: String
  private let tint: Color
  private let size: CGFloat
  private let shape: Shape
  private let badge: Color?

  public init(
    initial: String,
    tint: Color,
    size: CGFloat = Theme.Metric.avatarRow,
    shape: Shape = .circle,
    badge: Color? = nil
  ) {
    self.initial = initial
    self.tint = tint
    self.size = size
    self.shape = shape
    self.badge = badge
  }

  public var body: some View {
    ZStack(alignment: .bottomTrailing) {
      Group {
        switch shape {
        case .circle:
          Circle().fill(tint)
        case .blob:
          RoundedRectangle(cornerRadius: size * 0.34, style: .continuous).fill(tint)
        }
      }
      .frame(width: size, height: size)
      .overlay {
        Text(initial)
          .font(Theme.TypeScale.avatarInitial(size: size))
          .foregroundStyle(Theme.Palette.onColor)
      }

      if let badge {
        Circle()
          .fill(badge)
          .frame(width: size * 0.28, height: size * 0.28)
          .overlay {
            Circle()
              .strokeBorder(Theme.Palette.canvas, lineWidth: size * 0.05)
          }
          .offset(x: size * 0.04, y: size * 0.04)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
