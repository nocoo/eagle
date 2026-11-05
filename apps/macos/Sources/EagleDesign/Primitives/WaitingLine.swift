import SwiftUI

/// The line above the composer while a bot works with nothing to show yet: the bot's own face,
/// breathing exactly like its busy sidebar row, and a label that swaps between `正在输入` and
/// three travelling dots. Its avatar shares the composer's first control slot and its text
/// starts where the field's first character does, so the line reads as the top row of the
/// composer rather than a stray strip. The band keeps its height, so work starting and settling
/// never moves a message or the composer.
public struct WaitingLine: View {
  private let face: BotFace.Style?
  private let tintIndex: Int
  private let initial: String

  public init(face: BotFace.Style? = nil, tintIndex: Int = 0, initial: String = "") {
    self.face = face
    self.tintIndex = tintIndex
    self.initial = initial
  }

  public var body: some View {
    HStack(spacing: Theme.Layout.rowGap) {
      // The same slot the composer's `+` occupies: the avatar centres on that control.
      BusyFace { avatar }
        .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
      label
        .font(Theme.TypeScale.body)
        .foregroundStyle(Theme.Palette.textMuted)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Theme.Metric.composerInnerInset)
    .frame(height: Theme.Metric.waitingBandHeight)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("正在输入")
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var avatar: some View {
    Group {
      if let face {
        BotFace(style: face, size: Theme.Metric.waitingAvatar)
      } else {
        Avatar(
          initial: initial, tint: Theme.Palette.avatarTint(tintIndex),
          size: Theme.Metric.waitingAvatar, shape: .blob)
      }
    }
  }

  /// The word and the dots share one slot: the wider of the two sets the width, so the swap
  /// never nudges anything beside it.
  @ViewBuilder
  private var label: some View {
    if reduceMotion {
      HStack(spacing: Theme.Motion.waitingLabelGap) {
        Text("正在输入")
        dots(at: 0)
      }
    } else {
      TimelineView(.animation(minimumInterval: Theme.Motion.frameInterval)) { context in
        let instant = context.date.timeIntervalSinceReferenceDate
        let word = wordWeight(instant)
        ZStack(alignment: .leading) {
          // The two cross with a small vertical drift, so no frame shows the word and the
          // dots stacked on top of each other.
          Text("正在输入")
            .opacity(word)
            .offset(y: (1 - word) * -Theme.Motion.waitingWordLift)
          dots(at: instant)
            .opacity(1 - word)
            .offset(y: word * Theme.Motion.waitingWordLift)
        }
      }
    }
  }

  /// 3.4 s of cycle: the word holds, crosses out over 0.2 s, the dots travel, then the word
  /// crosses back in.
  private func wordWeight(_ instant: TimeInterval) -> Double {
    let phase = instant.truncatingRemainder(dividingBy: Theme.Motion.waitingCycle)
    switch phase {
    case ..<Theme.Motion.waitingWordEnd: return 1
    case ..<Theme.Motion.waitingCrossEnd:
      return (Theme.Motion.waitingCrossEnd - phase) / Theme.Motion.waitingCrossDuration
    case ..<Theme.Motion.waitingDotsEnd: return 0
    default: return (phase - Theme.Motion.waitingDotsEnd) / Theme.Motion.waitingCrossDuration
    }
  }

  private func dots(at instant: TimeInterval) -> some View {
    HStack(spacing: Theme.Metric.waitingDotGap) {
      ForEach(0..<Theme.Motion.waitingDotCount, id: \.self) { index in
        let wave =
          reduceMotion
          ? 0
          : sin(
            instant * 2 * .pi / Theme.Motion.waitingDotPeriod - Double(index)
              * Theme.Motion.waitingDotPhase)
        Circle()
          .fill(Theme.Palette.textMuted)
          .frame(width: Theme.Metric.waitingDot, height: Theme.Metric.waitingDot)
          .offset(y: -wave * Theme.Metric.waitingDotLift)
      }
    }
    .frame(
      width: CGFloat(Theme.Motion.waitingDotCount) * Theme.Metric.waitingDot + CGFloat(
        Theme.Motion.waitingDotCount - 1) * Theme.Metric.waitingDotGap)
  }
}
