import SwiftUI

public struct ParticipantBubble: View {
  private let name: String
  private let tintIndex: Int
  /// The bot's own face, the same one its sidebar row draws; nil for a plain avatar.
  private let face: BotFace.Style?
  private let status: ParticipantStatus?
  private let action: () -> Void
  private let onStop: () -> Void
  private let onRecover: () -> Void
  private let onRetry: () -> Void
  private let onDismissError: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var statusTint: Color {
    guard let status else { return Theme.Palette.textMuted }
    if status.error != nil { return Theme.Palette.destructive }
    switch status.phase {
    case .idle: return Theme.Palette.accentStrong
    case .working: return Theme.Palette.accent
    case .connecting: return Theme.Palette.info
    case .attention: return Theme.Palette.warning
    case .offline: return Theme.Palette.textMuted
    }
  }
  @State private var hovering = false
  @State private var showsError = false

  public init(
    name: String, tintIndex: Int, face: BotFace.Style? = nil, status: ParticipantStatus? = nil,
    onStop: @escaping () -> Void = {}, onRecover: @escaping () -> Void = {},
    onRetry: @escaping () -> Void = {},
    onDismissError: @escaping () -> Void = {}, action: @escaping () -> Void
  ) {
    self.name = name
    self.tintIndex = tintIndex
    self.face = face
    self.status = status
    self.onStop = onStop
    self.onRecover = onRecover
    self.onRetry = onRetry
    self.onDismissError = onDismissError
    self.action = action
  }

  public var body: some View {
    HStack(spacing: Theme.Metric.participantGap) {
      Button(action: action) {
        HStack(spacing: Theme.Metric.participantGap) {
          avatar
          Text(name)
            .font(Theme.TypeScale.sectionLabelStrong)
            .foregroundStyle(Theme.Palette.textPrimary)
            .lineLimit(1)
          if let status {
            Image(systemName: status.glyph)
              .font(Theme.TypeScale.compactTitle)
              .foregroundStyle(statusTint)
              .id(status.glyph)
              .transition(.opacity)
              .help(status.label)
              .accessibilityLabel(status.label)
          }
        }
        .frame(height: Theme.Metric.headerControlHeight)
        .contentShape(Rectangle())
      }
      .accessibilityLabel("\(name)，\(status.map { $0.label + "，" } ?? "")切换检查器")
      .help("查看 \(name) 的详情")

      if let error = status?.error {
        Button {
          showsError.toggle()
        } label: {
          Image(systemName: "exclamationmark.circle")
            .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
        }
        .foregroundStyle(Theme.Palette.destructive)
        .accessibilityLabel("查看 Bot 错误")
        .popover(isPresented: $showsError) {
          VStack(alignment: .leading, spacing: 12) {
            Text(error).font(Theme.TypeScale.note).textSelection(.enabled)
            Button("关闭提示") {
              showsError = false
              onDismissError()
            }
          }
          .padding(Theme.Metric.contentInset)
          .frame(maxWidth: 320)
        }
      }
      if status?.canRetry == true {
        Button(action: onRetry) {
          Image(systemName: "arrow.clockwise")
            .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
        }
        .foregroundStyle(Theme.Palette.info)
        .help("重新连接")
        .accessibilityLabel("重新连接")
      } else if status?.canRecover == true {
        Button(action: onRecover) {
          Image(systemName: "arrow.clockwise")
            .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
        }
        .foregroundStyle(Theme.Palette.destructive)
        .help("恢复 Bot")
        .accessibilityLabel("恢复 Bot")
      }
      if status?.canStop == true {
        Button(action: onStop) {
          Image(systemName: "stop.fill")
            .font(Theme.TypeScale.pill)
            .frame(width: Theme.Metric.hitTarget, height: Theme.Metric.hitTarget)
            .background(tint.opacity(0.12), in: Circle())
        }
        .foregroundStyle(tint)
        .help("停止回答")
        .accessibilityLabel("停止回答")
        .transition(reduceMotion ? .opacity : .scale(scale: 0.7).combined(with: .opacity))
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, Theme.Metric.participantInset)
    .frame(height: Theme.Metric.participantHeight)
    // The reference pill is a capsule: half-height corners on white, with a soft shadow that
    // separates it from the transcript instead of a border.
    .background(
      Capsule(style: .continuous)
        .fill(Theme.Palette.card)
        .overlay { if hovering { Capsule(style: .continuous).fill(Theme.Palette.hover) } }
        .shadow(
          color: Theme.Palette.participantShadow,
          radius: Theme.Metric.participantShadowRadius,
          y: Theme.Metric.participantShadowY
        )
    )
    .overlay {
      if status?.isActive == true {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
          let turn =
            reduceMotion
            ? 0
            : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.8) / 2.8
          RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
            .strokeBorder(
              AngularGradient(
                stops: [
                  .init(color: tint.opacity(0.12), location: 0),
                  .init(color: tint.opacity(0.12), location: 0.62),
                  .init(color: tint, location: 0.88),
                  .init(color: tint.opacity(0.12), location: 1),
                ],
                center: .center,
                startAngle: .degrees(turn * 360), endAngle: .degrees(turn * 360 + 360)
              ), lineWidth: 1.5
            )
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
      } else {
        RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
          .allowsHitTesting(false)
      }
    }
    .shadow(color: tint.opacity(status?.isActive == true ? 0.1 : 0), radius: 8, y: 2)
    .onHover { hovering = $0 }
    .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.82), value: status)
    .accessibilityElement(children: .contain)
  }

  private var avatar: some View {
    Group {
      if let face {
        BotFace(style: face, size: Theme.Metric.participantAvatar)
      } else {
        Avatar(
          initial: String(name.prefix(1)), tint: Theme.Palette.avatarTint(tintIndex),
          size: Theme.Metric.participantAvatar, shape: .blob
        )
      }
    }
    .modifier(BusyWhenWorking(active: status?.phase == .working))
  }

  private var tint: Color {
    switch status?.phase {
    case .working: Theme.Palette.accentStrong
    case .connecting: Theme.Palette.info
    case .attention: Theme.Palette.destructive
    default: Theme.Palette.textSecondary
    }
  }
}
