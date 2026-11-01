import SwiftUI

/// A bot's face: one silhouette from a closed set, filled with one tint, with two eyes.
/// The same view draws the sidebar avatar and the create preview, so what a user picks is
/// what they get.
public struct BotFace: View {
  public enum Shape: String, CaseIterable, Hashable, Sendable {
    case blob, pebble, squircle, star, cloud, shield, drop, hex, heart, flower
  }

  public struct Style: Hashable, Sendable {
    public let shape: Shape
    public let tint: Theme.Palette.BotTint

    public init(shape: Shape, tint: Theme.Palette.BotTint) {
      self.shape = shape
      self.tint = tint
    }

  }

  private let style: Style
  private let size: CGFloat

  public init(style: Style, size: CGFloat) {
    self.style = style
    self.size = size
  }

  public var body: some View {
    ZStack {
      ShapePath(shape: style.shape)
        .fill(Theme.Palette.botTint(style.tint))
      eyes
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  private var eyes: some View {
    let eyeWidth = size * 0.085
    let eyeHeight = size * 0.17
    let gap = size * 0.11
    return HStack(spacing: gap) {
      RoundedRectangle(cornerRadius: eyeWidth / 2, style: .continuous)
        .frame(width: eyeWidth, height: eyeHeight)
      RoundedRectangle(cornerRadius: eyeWidth / 2, style: .continuous)
        .frame(width: eyeWidth, height: eyeHeight)
    }
    .foregroundStyle(Theme.Palette.botEye)
    .offset(y: size * 0.04)
  }
}

/// The silhouette in a unit square, scaled to the view's frame.
private struct ShapePath: Shape {
  let shape: BotFace.Shape

  func path(in rect: CGRect) -> Path {
    let width = rect.width
    let height = rect.height
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + x * width, y: rect.minY + y * height)
    }
    var path = Path()
    switch shape {
    case .blob:
      path.move(to: point(0.50, 0.02))
      path.addCurve(
        to: point(0.98, 0.46),
        control1: point(0.83, 0.00),
        control2: point(1.00, 0.16)
      )
      path.addCurve(
        to: point(0.62, 0.98),
        control1: point(0.96, 0.74),
        control2: point(0.86, 0.98)
      )
      path.addCurve(
        to: point(0.04, 0.58),
        control1: point(0.36, 0.98),
        control2: point(0.02, 0.82)
      )
      path.addCurve(
        to: point(0.50, 0.02),
        control1: point(0.06, 0.28),
        control2: point(0.22, 0.04)
      )
    case .pebble:
      path.addEllipse(
        in: CGRect(
          x: rect.minX + 0.04 * width,
          y: rect.minY + 0.08 * height,
          width: 0.92 * width,
          height: 0.84 * height
        ))
    case .squircle:
      path.addRoundedRect(
        in: CGRect(
          x: rect.minX + 0.05 * width,
          y: rect.minY + 0.05 * height,
          width: 0.90 * width,
          height: 0.90 * height
        ),
        cornerSize: CGSize(width: 0.32 * width, height: 0.32 * height),
        style: .continuous
      )
    case .star:
      // Eight alternating radii around the centre, rounded through the midpoints.
      let center = point(0.5, 0.5)
      var vertices: [CGPoint] = []
      for index in 0..<8 {
        let angle = Double(index) * Double.pi / 4 - Double.pi / 2
        let radius: CGFloat = index % 2 == 0 ? 0.48 : 0.23
        vertices.append(
          CGPoint(
            x: center.x + CGFloat(cos(angle)) * radius * width,
            y: center.y + CGFloat(sin(angle)) * radius * height
          )
        )
      }
      path.move(to: vertices[0])
      for index in 1...8 {
        let previous = vertices[index - 1]
        let next = vertices[index % 8]
        path.addQuadCurve(
          to: next,
          control: CGPoint(x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2)
        )
      }
    case .cloud:
      path.addEllipse(
        in: CGRect(
          x: rect.minX + 0.02 * width, y: rect.minY + 0.28 * height,
          width: 0.56 * width, height: 0.52 * height))
      path.addEllipse(
        in: CGRect(
          x: rect.minX + 0.30 * width, y: rect.minY + 0.10 * height,
          width: 0.66 * width, height: 0.66 * height))
      path.addEllipse(
        in: CGRect(
          x: rect.minX + 0.10 * width, y: rect.minY + 0.46 * height,
          width: 0.62 * width, height: 0.46 * height))
    case .shield:
      path.move(to: point(0.50, 0.02))
      path.addLine(to: point(0.94, 0.22))
      path.addCurve(
        to: point(0.50, 0.98),
        control1: point(0.94, 0.58),
        control2: point(0.74, 0.86)
      )
      path.addCurve(
        to: point(0.06, 0.22),
        control1: point(0.26, 0.86),
        control2: point(0.06, 0.58)
      )
      path.addLine(to: point(0.50, 0.02))
    case .drop:
      path.move(to: point(0.50, 0.02))
      path.addCurve(
        to: point(0.96, 0.66),
        control1: point(0.70, 0.18),
        control2: point(0.96, 0.38)
      )
      path.addCurve(
        to: point(0.04, 0.66),
        control1: point(0.96, 0.98),
        control2: point(0.04, 0.98)
      )
      path.addCurve(
        to: point(0.50, 0.02),
        control1: point(0.04, 0.38),
        control2: point(0.30, 0.18)
      )
    case .heart:
      path.move(to: point(0.50, 0.92))
      path.addCurve(
        to: point(0.04, 0.34),
        control1: point(0.20, 0.80),
        control2: point(0.02, 0.56)
      )
      path.addCurve(
        to: point(0.50, 0.18),
        control1: point(0.06, 0.10),
        control2: point(0.34, 0.06)
      )
      path.addCurve(
        to: point(0.96, 0.34),
        control1: point(0.66, 0.06),
        control2: point(0.94, 0.10)
      )
      path.addCurve(
        to: point(0.50, 0.92),
        control1: point(0.98, 0.56),
        control2: point(0.80, 0.80)
      )
    case .flower:
      let center = point(0.5, 0.5)
      for index in 0..<5 {
        let angle = Double(index) * 2 * Double.pi / 5 - Double.pi / 2
        let petal = CGPoint(
          x: center.x + CGFloat(cos(angle)) * 0.26 * width,
          y: center.y + CGFloat(sin(angle)) * 0.26 * height
        )
        path.addEllipse(
          in: CGRect(
            x: petal.x - 0.24 * width,
            y: petal.y - 0.24 * height,
            width: 0.48 * width,
            height: 0.48 * height
          ))
      }
    case .hex:
      let corners = [
        point(0.50, 0.02), point(0.93, 0.26), point(0.93, 0.74),
        point(0.50, 0.98), point(0.07, 0.74), point(0.07, 0.26),
      ]
      path.move(to: corners[0])
      for corner in corners.dropFirst() { path.addLine(to: corner) }
      path.closeSubpath()
    }
    return path
  }
}

extension Theme.Palette {
  /// The tints a bot may pick. The order is the picker's order.
  public enum BotTint: String, CaseIterable, Hashable, Sendable {
    case paper, clay, red, orange, yellow, green, teal, sky, blue, violet, pink, graphite
  }

  public static let botEye = Color(light: 0x2A2A2E, dark: 0x1A1A1C)

  public static func botTint(_ tint: BotTint) -> Color {
    switch tint {
    case .paper: return Color(light: 0xFFFFFF, dark: 0xF4F4F6)
    case .clay: return Color(light: 0xA9713F, dark: 0xB98052)
    case .red: return Color(light: 0xE5484D, dark: 0xF4646A)
    case .orange: return Color(light: 0xF5752B, dark: 0xFF8C4D)
    case .yellow: return Color(light: 0xF5B51B, dark: 0xFFC63D)
    case .green: return Color(light: 0x3DBB6A, dark: 0x4CD47C)
    case .teal: return Color(light: 0x2FB7A3, dark: 0x3FD0BC)
    case .sky: return Color(light: 0x56B4E9, dark: 0x6FC8F5)
    case .blue: return Color(light: 0x3B7CF6, dark: 0x5A94FF)
    case .violet: return Color(light: 0x8B5CF6, dark: 0xA479FF)
    case .pink: return Color(light: 0xF04FA0, dark: 0xFF6FB5)
    case .graphite: return Color(light: 0x6E6E76, dark: 0x8A8A93)
    }
  }
}
