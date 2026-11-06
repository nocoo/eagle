import BotsCore
import EagleDesign
import SwiftUI

/// Editing an existing bot's face: the same picker as creation, opened from the profile
/// avatar. Saving writes both fields to the daemon; the sidebar and inspector repaint from
/// the catalog push.
public struct BotFaceEditorSheet: View {
  let onSave: (BotAppearance) -> Void
  let onCancel: () -> Void

  @State private var shape: BotFace.Shape
  @State private var tint: Theme.Palette.BotTint

  public init(
    initial: BotFace.Style,
    onSave: @escaping (BotAppearance) -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.onSave = onSave
    self.onCancel = onCancel
    _shape = State(initialValue: initial.shape)
    _tint = State(initialValue: initial.tint)
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("编辑头像")
          .font(Theme.TypeScale.sectionTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Spacer()
        IconButton(
          systemName: "xmark", label: "关闭", size: Theme.Metric.hitTarget, action: onCancel)
      }
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .frame(height: Theme.Dialog.compactHeaderHeight)
      Divider().overlay(Theme.Palette.line)
      VStack(spacing: Theme.Layout.sectionGap) {
        BotFacePreview(style: BotFace.Style(shape: shape, tint: tint))
        BotFacePicker(shape: $shape, tint: tint) { tint = $0 }
      }
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .padding(.vertical, Theme.Layout.sectionGap)
      Divider().overlay(Theme.Palette.line)
      HStack(spacing: Theme.Layout.controlGap) {
        Spacer()
        SettingsActionButton("取消", action: onCancel)
        SettingsActionButton("保存", prominent: true) {
          onSave(
            BotAppearance(
              shape: BotAppearance.Shape(rawValue: shape.rawValue) ?? .blob,
              tint: BotAppearance.Tint(rawValue: tint.rawValue) ?? BotAppearance.Tint.green
            )
          )
        }
      }
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .frame(height: Theme.Dialog.footerHeight)
    }
    .frame(width: Theme.Dialog.botWidth)
  }
}
