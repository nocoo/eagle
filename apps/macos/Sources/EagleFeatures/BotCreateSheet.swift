import BotsCore
import EagleDesign
import SwiftUI

/// The create form: the face, a name and an optional tag arranged like the inspector's
/// identity card. The colour is already chosen when the card opens, so the preview and what
/// the daemon stores are the same colour.
public struct BotCreateSheet: View {
  let onCreate: (String, String?, BotCreationAppearance) -> Void
  let onCancel: () -> Void

  @State private var draft: BotsCreateDraft
  /// A field's Return and the dialog's default action can both land; the form submits once.
  @State private var submitted = false

  public init(
    draft: BotsCreateDraft = .presented(),
    onCreate: @escaping (String, String?, BotCreationAppearance) -> Void,
    onCancel: @escaping () -> Void
  ) {
    _draft = State(initialValue: draft)
    self.onCreate = onCreate
    self.onCancel = onCancel
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(Theme.Palette.line)
      VStack(spacing: Theme.Layout.sectionGap) {
        identity
        BotFacePicker(shape: $draft.shape, tint: draft.tint) { draft.tint = $0 }
      }
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .padding(.vertical, Theme.Layout.sectionGap)
      Divider().overlay(Theme.Palette.line)
      footer
    }
    .frame(width: Theme.Dialog.botWidth)
    .background(DialogShortcut(.defaultAction, action: create))
  }

  private var header: some View {
    HStack {
      Text("创建新 Bot")
        .font(Theme.TypeScale.sectionTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
      Spacer()
      IconButton(systemName: "xmark", label: "关闭", size: Theme.Metric.hitTarget, action: onCancel)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .frame(height: Theme.Dialog.compactHeaderHeight)
  }

  private var identity: some View {
    HStack(spacing: Theme.Layout.sectionGap) {
      BotFacePreview(style: draft.preview)
      VStack(alignment: .leading, spacing: Theme.Inspector.nameGap) {
        IdentityField(
          "给你的 Bot 起个名字", text: $draft.name, kind: .name, autoFocus: true
        ) { create() }
        IdentityField("标签（可选）", text: $draft.label, kind: .tag) { create() }
      }
      Spacer(minLength: 0)
    }
    .padding(Theme.Layout.sectionInset)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }

  private var footer: some View {
    HStack(spacing: Theme.Layout.controlGap) {
      Spacer()
      SettingsActionButton("取消", action: onCancel)
      SettingsActionButton("创建", prominent: true) { create() }
        .disabled(!draft.canCreate)
    }
    .padding(.horizontal, Theme.Metric.settingsCardInset)
    .frame(height: Theme.Dialog.footerHeight)
  }

  private func create() {
    guard draft.canCreate, !submitted else { return }
    submitted = true
    onCreate(draft.trimmedName, draft.trimmedLabel, draft.appearance())
  }
}
