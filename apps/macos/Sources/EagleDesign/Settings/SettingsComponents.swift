import SwiftUI

/// Rounded white container used by every settings section.
public struct SettingsCard<Content: View>: View {
  private let content: Content

  public init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  public var body: some View {
    content
      .padding(.horizontal, Theme.Metric.settingsCardInset)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.settingsCardRadius, style: .continuous)
          .fill(Theme.Palette.card)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Metric.settingsCardRadius, style: .continuous)
          .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
      )
  }
}

/// A capsule that opens a menu of choices: it looks like the pill above, but a click shows the
/// options instead of silently cycling the value.
public struct PillSelect<Value: Hashable>: View {
  public struct Option: Identifiable, Hashable {
    public let id: Value
    public let title: String

    public init(_ id: Value, _ title: String) {
      self.id = id
      self.title = title
    }
  }

  private let label: String
  private let options: [Option]
  @Binding private var selection: Value

  public init(_ label: String, options: [Option], selection: Binding<Value>) {
    self.label = label
    self.options = options
    self._selection = selection
  }

  public var body: some View {
    SelectionMenu(options.first { $0.id == selection }?.title ?? "", style: .surface) {
      ForEach(options) { option in
        Button {
          selection = option.id
        } label: {
          if option.id == selection {
            Label(option.title, systemImage: "checkmark")
          } else {
            Text(option.title)
          }
        }
      }
    }
    .accessibilityLabel(label)
  }
}

/// Light blue confirmation strip with a check icon.
public struct InfoBanner: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    HStack(spacing: Theme.Form.bannerGap) {
      Image(systemName: "checkmark.circle")
        .font(Theme.TypeScale.cardTitle)
        .foregroundStyle(Theme.Palette.info)
      Text(text)
        .font(Theme.TypeScale.noteEmphasis)
        .foregroundStyle(Theme.Palette.info)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Theme.Form.controlInset)
    .frame(height: Theme.Form.bannerHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.infoFill)
    )
  }
}

/// Section header inside a card: title, one line of what it covers, and the control that
/// belongs to the section on the right. The 服务 page set this shape; every page follows it.
public struct SettingsSectionHeader<Trailing: View>: View {
  private let title: String
  private let detail: String?
  private let trailing: Trailing

  public init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title
    self.detail = detail
    self.trailing = trailing()
  }

  public var body: some View {
    HStack(alignment: .center, spacing: Theme.Form.sectionContentGap) {
      VStack(alignment: .leading, spacing: Theme.Form.headingDetailGap) {
        Text(title)
          .font(Theme.TypeScale.sectionTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        if let detail {
          Text(detail)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
      trailing
    }
    .padding(.vertical, Theme.Form.rowVerticalInset)
  }
}

/// A row at the section rhythm: label and detail on the left, one control on the right.
public struct SettingsSectionRow<Trailing: View>: View {
  private let title: String
  private let detail: String?
  private let trailing: Trailing

  public init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title
    self.detail = detail
    self.trailing = trailing()
  }

  public var body: some View {
    HStack(alignment: .center, spacing: Theme.Form.rowContentGap) {
      VStack(alignment: .leading, spacing: Theme.Form.rowDetailGap) {
        Text(title)
          .font(Theme.TypeScale.fieldLabel)
          .foregroundStyle(Theme.Palette.textPrimary)
        if let detail {
          Text(detail)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
      trailing
    }
    .padding(.vertical, Theme.Form.rowVerticalInset)
  }
}

/// What a section says after an action: the save's result, or why it failed. It closes the
/// card the action lives in, so the answer sits under the control that produced it.
public struct SettingsSectionNote: View {
  private let text: String
  private let destructive: Bool

  public init(_ text: String, destructive: Bool = false) {
    self.text = text
    self.destructive = destructive
  }

  public var body: some View {
    Text(text)
      .font(Theme.TypeScale.note)
      .foregroundStyle(destructive ? Theme.Palette.destructive : Theme.Palette.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.bottom, Theme.Form.noteBottomInset)
  }
}

/// A settings input with the app's own surface: rounded, fixed height, no native chrome.
/// The focus ring is a hairline in the accent, matching the shell's controls.
/// A multi-line setting: same paper as the text field, tall enough for a paragraph and
/// scrollable inside, because a standing instruction is prose and not a one-line value.
public struct SettingsTextArea: View {
  private let placeholder: String
  @Binding private var text: String
  private let minHeight: CGFloat

  public init(
    _ placeholder: String, text: Binding<String>, minHeight: CGFloat = Theme.Form.textAreaMinHeight
  ) {
    self.placeholder = placeholder
    self._text = text
    self.minHeight = minHeight
  }

  public var body: some View {
    ZStack(alignment: .topLeading) {
      if text.isEmpty {
        Text(placeholder)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textSecondary)
          .padding(.horizontal, Theme.Form.textAreaPlaceholderInset)
          .padding(.vertical, Theme.Form.textAreaPlaceholderInset)
          .allowsHitTesting(false)
      }
      TextEditor(text: $text)
        .font(Theme.TypeScale.rowSubtitle)
        .foregroundStyle(Theme.Palette.textPrimary)
        .scrollContentBackground(.hidden)
        .padding(.horizontal, Theme.Form.textAreaEditorHorizontalInset)
        .padding(.vertical, Theme.Form.textAreaEditorVerticalInset)
        .frame(minHeight: minHeight)
        .accessibilityLabel(placeholder)
    }
    .padding(.horizontal, Theme.Form.textAreaOuterInset)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }
}

public struct SettingsTextField: View {
  private let placeholder: String
  @Binding private var text: String
  private let secure: Bool
  @FocusState private var focused: Bool

  public init(_ placeholder: String, text: Binding<String>, secure: Bool = false) {
    self.placeholder = placeholder
    self._text = text
    self.secure = secure
  }

  public var body: some View {
    HStack(spacing: Theme.Form.controlGap) {
      Group {
        if secure {
          SecureField("", text: $text)
        } else {
          TextField("", text: $text)
        }
      }
      .textFieldStyle(.plain)
      .font(Theme.TypeScale.rowSubtitle)
      .foregroundStyle(Theme.Palette.textPrimary)
      .focused($focused)
      if !secure, !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(Theme.TypeScale.Glyph.compact)
            .foregroundStyle(Theme.Palette.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("清除")
      }
    }
    .padding(.horizontal, Theme.Form.fieldInset)
    .frame(height: Theme.Form.fieldHeight)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .strokeBorder(
          focused ? Theme.Palette.fieldFocus : Theme.Palette.line,
          lineWidth: Theme.Metric.hairline
        )
    )
    .overlay(alignment: .leading) {
      if text.isEmpty {
        Text(placeholder)
          .font(Theme.TypeScale.rowSubtitle)
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.leading, Theme.Form.fieldPlaceholderInset)
          .allowsHitTesting(false)
      }
    }
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
  }
}

/// A compact settings button: a soft surface by default, the accent when primary.
public struct SettingsActionButton: View {
  private let title: String
  private let action: () -> Void
  private let prominent: Bool
  @State private var hovering = false

  public init(_ title: String, prominent: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.action = action
    self.prominent = prominent
  }

  var fillColor: Color {
    prominent ? Theme.Palette.accentFill : (hovering ? Theme.Palette.line : Theme.Palette.canvas)
  }
  var textColor: Color { prominent ? Theme.Palette.onColor : Theme.Palette.textPrimary }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(Theme.TypeScale.noteEmphasis)
        .foregroundStyle(textColor)
        .padding(.horizontal, Theme.Form.controlInset)
        .frame(height: Theme.Form.actionHeight)
        .background(
          RoundedRectangle(cornerRadius: Theme.Form.actionRadius, style: .continuous)
            .fill(fillColor)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Theme.Form.actionRadius, style: .continuous)
            .strokeBorder(prominent ? .clear : Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}
