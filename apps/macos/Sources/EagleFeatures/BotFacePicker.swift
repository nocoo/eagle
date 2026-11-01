import BotsCore
import EagleDesign
import SwiftUI

/// The face grid shared by the create sheet and the profile editor: ten silhouettes and
/// twelve tints, each rendered with the same BotFace the sidebar draws.
struct BotFacePicker: View {
  @Binding var shape: BotFace.Shape
  @Binding var tint: Theme.Palette.BotTint

  var body: some View {
    VStack(spacing: 16) {
      VStack(alignment: .leading, spacing: 8) {
        Text("形状")
          .font(Theme.TypeScale.sectionLabel)
          .foregroundStyle(Theme.Palette.textSecondary)
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 5),
          spacing: 8
        ) {
          ForEach(BotFace.Shape.allCases, id: \.self) { candidate in
            Button {
              shape = candidate
            } label: {
              BotFace(style: BotFace.Style(shape: candidate, tint: tint), size: 52)
                .padding(4)
                .background(
                  RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
                    .strokeBorder(candidate == shape ? Theme.Palette.accent : .clear, lineWidth: 2)
                )
            }
            .buttonStyle(.plain)
            .help(candidate.rawValue)
          }
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        Text("颜色")
          .font(Theme.TypeScale.sectionLabel)
          .foregroundStyle(Theme.Palette.textSecondary)
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 6),
          spacing: 10
        ) {
          ForEach(Theme.Palette.BotTint.allCases, id: \.self) { candidate in
            Button {
              tint = candidate
            } label: {
              Circle()
                .fill(Theme.Palette.botTint(candidate))
                .frame(width: 32, height: 32)
                .padding(4)
                .overlay(
                  Circle()
                    .strokeBorder(
                      candidate == tint ? Theme.Palette.textPrimary.opacity(0.6) : .clear,
                      lineWidth: 2
                    )
                )
            }
            .buttonStyle(.plain)
            .help(candidate.rawValue)
          }
        }
      }
    }
  }
}

/// Editing an existing bot's face: the same picker as creation, opened from the profile
/// avatar. Apply writes the face to the daemon; the sidebar and inspector repaint from the
/// catalog push.
struct BotFaceEditorSheet: View {
  let onSave: (BotAppearance) -> Void
  let onCancel: () -> Void

  @State private var shape: BotFace.Shape
  @State private var tint: Theme.Palette.BotTint

  init(
    initial: BotFace.Style,
    onSave: @escaping (BotAppearance) -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.onSave = onSave
    self.onCancel = onCancel
    _shape = State(initialValue: initial.shape)
    _tint = State(initialValue: initial.tint)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("编辑头像")
          .font(Theme.TypeScale.inspectorTitle)
        Spacer()
        IconButton(systemName: "xmark", label: "关闭", size: 28, action: onCancel)
      }
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .frame(height: 62)
      Divider().overlay(Theme.Palette.line)
      ScrollView {
        VStack(spacing: 16) {
          BotFace(style: BotFace.Style(shape: shape, tint: tint), size: 132)
            .padding(.top, 20)
          BotFacePicker(shape: $shape, tint: $tint)
        }
        .padding(.horizontal, Theme.Metric.settingsCardInset)
        .padding(.bottom, 18)
      }
      Divider().overlay(Theme.Palette.line)
      HStack(spacing: 10) {
        Spacer()
        SettingsActionButton("取消", action: onCancel)
        SettingsActionButton("保存", prominent: true) {
          onSave(
            BotAppearance(
              shape: BotAppearance.Shape(rawValue: shape.rawValue) ?? .blob,
              tint: BotAppearance.Tint(rawValue: tint.rawValue) ?? .green
            )
          )
        }
      }
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .frame(height: 56)
    }
    .frame(width: 560, height: 640)
    .background(Theme.Palette.surface)
  }
}
