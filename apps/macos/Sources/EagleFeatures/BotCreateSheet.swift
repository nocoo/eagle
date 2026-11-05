import BotsCore
import EagleDesign
import SwiftUI

/// The create form: a name (required), an optional label, and the face the user picks.
/// It is a sheet on the main window, not a second window.
struct BotCreateSheet: View {
  let onCreate: (String, String?, BotAppearance) -> Void
  let onCancel: () -> Void

  @State private var name = ""
  @State private var label = ""
  @State private var shape: BotFace.Shape = .blob
  @State private var tint: Theme.Palette.BotTint = Theme.Palette.BotTint.green
  @FocusState private var nameFocused: Bool

  private var canCreate: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Theme.Palette.line)
      ScrollView {
        VStack(spacing: Theme.Layout.sectionInset) {
          BotFace(style: BotFace.Style(shape: shape, tint: tint), size: Theme.Picker.previewFace)
            .padding(.top, Theme.Metric.contentInset)
          fields
          BotFacePicker(shape: $shape, tint: $tint)
        }
        .padding(.horizontal, Theme.Metric.settingsCardInset)
        .padding(.bottom, Theme.Layout.groupGap)
      }
      Divider().overlay(Theme.Palette.line)
      footer
    }
    // Proportions measured from the reference dialog: 879 × 1 116 at 560 wide keeps its
    // header, preview, two field rows, the shape grid, the swatches and the footer in the
    // same rhythm.
    .frame(width: Theme.Dialog.botWidth, height: Theme.Dialog.createHeight)
    .background(Theme.Palette.surface)
    .onAppear { nameFocused = true }
  }

  private var header: some View {
    HStack {
      Text("创建新 Bot")
        .font(Theme.TypeScale.inspectorTitle)
      Spacer()
      IconButton(systemName: "xmark", label: "关闭", size: Theme.Metric.hitTarget, action: onCancel)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .frame(height: Theme.Dialog.botHeaderHeight)
  }

  private var fields: some View {
    VStack(spacing: Theme.Layout.rowGap) {
      CreationTextField("给你的 Bot 起个名字", text: $name, kind: .name)
        .focused($nameFocused)
        .onSubmit { create() }
      CreationTextField("标签（可选）", text: $label, kind: .label)
    }
  }

  private var footer: some View {
    HStack {
      Spacer()
      ActionControl("取消", style: .bordered, action: onCancel)
        .keyboardShortcut(.cancelAction)
      ActionControl("创建", style: .prominent) { create() }
        .tint(Theme.Palette.accentFill)
        .disabled(!canCreate)
        .keyboardShortcut(.defaultAction)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .frame(height: Theme.Dialog.createFooterHeight)
  }

  private func create() {
    guard canCreate else { return }
    let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
    onCreate(
      name.trimmingCharacters(in: .whitespacesAndNewlines),
      trimmedLabel.isEmpty ? nil : trimmedLabel,
      BotAppearance(
        shape: BotAppearance.Shape(rawValue: shape.rawValue) ?? .blob,
        tint: BotAppearance.Tint(rawValue: tint.rawValue) ?? BotAppearance.Tint.green
      )
    )
  }
}
