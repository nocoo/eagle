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
          RoundedRectangle(cornerRadius: size * Theme.Primitive.avatarBlobRatio, style: .continuous)
            .fill(tint)
        }
      }
      .frame(width: size, height: size)
      .overlay {
        Text(initial)
          .font(Theme.TypeScale.avatarInitial(size: size))
          .foregroundStyle(Theme.Palette.darkInk)
      }

      if let badge {
        Circle()
          .fill(badge)
          .frame(
            width: size * Theme.Primitive.avatarBadgeRatio,
            height: size * Theme.Primitive.avatarBadgeRatio
          )
          .overlay {
            Circle()
              .strokeBorder(
                Theme.Palette.canvas, lineWidth: size * Theme.Primitive.avatarBadgeStrokeRatio)
          }
          .offset(
            x: size * Theme.Primitive.avatarBadgeOffsetRatio,
            y: size * Theme.Primitive.avatarBadgeOffsetRatio)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
