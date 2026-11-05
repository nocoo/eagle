import SwiftUI

/// A bot that is working moves its own face in a slow breath: a few degrees of sway, a lift,
/// and a gentle swell. The same animation serves the sidebar row and the waiting line above
/// the composer, so "this bot is busy" looks identical wherever it is shown. Reduce Motion
/// holds the face still.
public struct BusyFace<Content: View>: View {
  private let rise: CGFloat
  private let content: Content

  /// `rise` is how far the face lifts on its own scale; a large portrait needs more than a
  /// sidebar chip to read as the same motion.
  public init(rise: CGFloat = Theme.Motion.faceRise, @ViewBuilder content: () -> Content) {
    self.rise = rise
    self.content = content()
  }

  public var body: some View {
    if reduceMotion {
      content
    } else {
      TimelineView(.animation(minimumInterval: Theme.Motion.frameInterval, paused: false)) {
        context in
        let wave = wave(at: context.date)
        content
          .scaleEffect(1 + Theme.Motion.faceScale * (wave + 1) / 2)
          .rotationEffect(.degrees(wave * Theme.Motion.faceSway))
          .offset(y: -wave * rise)
      }
    }
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// A 2.2 s breath, so the eye catches it without it ever becoming a distraction.
  private func wave(at date: Date) -> Double {
    sin(date.timeIntervalSinceReferenceDate * 2 * .pi / Theme.Motion.facePeriod)
  }
}

/// Applies the shared busy breath only while `active`, so a face that is not working sits
/// still and every working face on screen moves in step.
struct BusyWhenWorking: ViewModifier {
  let active: Bool
  var rise: CGFloat = Theme.Motion.faceRise

  func body(content: Content) -> some View {
    if active {
      BusyFace(rise: rise) { content }
    } else {
      content
    }
  }
}
