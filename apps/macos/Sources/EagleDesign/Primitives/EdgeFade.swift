import SwiftUI

/// Fades scrolling content into the panel colour at a scroll edge. Rendered as
/// an overlay so hit testing on the content is untouched.
public struct EdgeFade: View {
  public enum Edge {
    case top
    case bottom
  }

  private let color: Color
  private let edge: Edge
  private let height: CGFloat

  public init(color: Color, edge: Edge, height: CGFloat = Theme.Primitive.edgeFadeDefault) {
    self.color = color
    self.edge = edge
    self.height = height
  }

  public var body: some View {
    LinearGradient(
      colors: edge == .top
        ? [color, color.opacity(0)]
        : [color.opacity(0), color],
      startPoint: .top,
      endPoint: .bottom
    )
    .frame(height: height)
    .frame(maxWidth: .infinity)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

extension View {
  /// Masks the top and bottom of a scroll view with panel-coloured gradients.
  public func scrollEdgeFades(
    _ color: Color, top: CGFloat = Theme.Primitive.edgeFadeDefault,
    bottom: CGFloat = Theme.Primitive.edgeFadeDefault
  ) -> some View {
    overlay(alignment: .top) { EdgeFade(color: color, edge: .top, height: top) }
      .overlay(alignment: .bottom) { EdgeFade(color: color, edge: .bottom, height: bottom) }
  }
}
