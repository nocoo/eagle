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
        VStack(spacing: 16) {
          BotFace(style: BotFace.Style(shape: shape, tint: tint), size: 132)
            .padding(.top, 20)
          fields
          BotFacePicker(shape: $shape, tint: $tint)
        }
        .padding(.horizontal, Theme.Metric.settingsCardInset)
        .padding(.bottom, 18)
      }
      Divider().overlay(Theme.Palette.line)
      footer
    }
    // Proportions measured from the reference dialog: 879 × 1 116 at 560 wide keeps its
    // header, preview, two field rows, the shape grid, the swatches and the footer in the
    // same rhythm.
    .frame(width: 560, height: 712)
    .background(Theme.Palette.surface)
    .onAppear { nameFocused = true }
  }

  private var header: some View {
    HStack {
      Text("创建新 Bot")
        .font(Theme.TypeScale.inspectorTitle)
      Spacer()
      IconButton(systemName: "xmark", label: "关闭", size: 28, action: onCancel)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .frame(height: 62)
  }

  private var fields: some View {
    VStack(spacing: 8) {
      TextField(
        "",
        text: $name,
        prompt: Text("给你的 Bot 起个名字").foregroundStyle(Theme.Palette.textSecondary)
      )
      .textFieldStyle(.plain)
      .font(Theme.TypeScale.body)
      .focused($nameFocused)
      .padding(.horizontal, 14)
      .frame(height: 43)
      .background(fieldBackground)
      .onSubmit { create() }

      TextField(
        "",
        text: $label,
        prompt: Text("标签（可选）").foregroundStyle(Theme.Palette.textSecondary)
      )
      .textFieldStyle(.plain)
      .font(Theme.TypeScale.note)
      .padding(.horizontal, 14)
      .frame(height: 36)
      .background(fieldBackground)
    }
  }

  private var footer: some View {
    HStack {
      Spacer()
      Button("取消", action: onCancel)
        .buttonStyle(.bordered)
        .keyboardShortcut(.cancelAction)
      Button("创建") { create() }
        .buttonStyle(.borderedProminent)
        .tint(Theme.Palette.accentFill)
        .disabled(!canCreate)
        .keyboardShortcut(.defaultAction)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .frame(height: 46)
  }

  private var fieldBackground: some View {
    RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
      .fill(Theme.Palette.card)
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
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
