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

/// Section heading above a card, e.g. `Bot 的电脑`.
public struct SettingsCaption: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    Text(text)
      .font(Theme.TypeScale.note)
      .foregroundStyle(Theme.Palette.textSecondary)
      .padding(.leading, 4)
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

  private let options: [Option]
  @Binding private var selection: Value
  @State private var hovering = false

  public init(options: [Option], selection: Binding<Value>) {
    self.options = options
    self._selection = selection
  }

  public var body: some View {
    Menu {
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
    } label: {
      HStack(spacing: 6) {
        Text(options.first { $0.id == selection }?.title ?? "")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 14)
      .frame(height: 32)
      .background(Capsule().fill(hovering ? Theme.Palette.canvas : Theme.Palette.card))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .onHover { hovering = $0 }
    .accessibilityLabel("外观")
  }
}

/// Light blue confirmation strip with a check icon.
public struct InfoBanner: View {
  private let text: String

  public init(_ text: String) {
    self.text = text
  }

  public var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "checkmark.circle")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(Theme.Palette.info)
      Text(text)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.Palette.info)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .frame(height: 40)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.infoFill)
    )
  }
}

/// Settings row with a label and a trailing control slot.
public struct SettingsRow<Trailing: View>: View {
  private let title: String
  private let detail: String?
  private let trailing: Trailing

  public init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title
    self.detail = detail
    self.trailing = trailing()
  }

  public var body: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 14))
          .foregroundStyle(Theme.Palette.textPrimary)
        if let detail {
          Text(detail)
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
        }
      }
      Spacer(minLength: 0)
      trailing
    }
    .frame(height: Theme.Metric.settingsRowHeight)
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

  public init(_ placeholder: String, text: Binding<String>, minHeight: CGFloat = 88) {
    self.placeholder = placeholder
    self._text = text
    self.minHeight = minHeight
  }

  public var body: some View {
    ZStack(alignment: .topLeading) {
      if text.isEmpty {
        Text(placeholder)
          .font(.system(size: 13.5))
          .foregroundStyle(Theme.Palette.textSecondary)
          .padding(.horizontal, 6)
          .padding(.vertical, 6)
          .allowsHitTesting(false)
      }
      TextEditor(text: $text)
        .font(.system(size: 13.5))
        .foregroundStyle(Theme.Palette.textPrimary)
        .scrollContentBackground(.hidden)
        .padding(.horizontal, 3)
        .padding(.vertical, 2)
        .frame(minHeight: minHeight)
        .accessibilityLabel(placeholder)
    }
    .padding(.horizontal, 4)
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
    HStack(spacing: 6) {
      Group {
        if secure {
          SecureField("", text: $text)
        } else {
          TextField("", text: $text)
        }
      }
      .textFieldStyle(.plain)
      .font(.system(size: 13.5))
      .foregroundStyle(Theme.Palette.textPrimary)
      .focused($focused)
      if !secure, !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 12))
            .foregroundStyle(Theme.Palette.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("清除")
      }
    }
    .padding(.horizontal, 11)
    .frame(height: 34)
    .background(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .strokeBorder(
          focused ? Theme.Palette.accent.opacity(0.65) : Theme.Palette.line,
          lineWidth: Theme.Metric.hairline
        )
    )
    .overlay(alignment: .leading) {
      if text.isEmpty {
        Text(placeholder)
          .font(.system(size: 13.5))
          .foregroundStyle(Theme.Palette.textMuted)
          .padding(.leading, 12)
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

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(prominent ? Color.white : Theme.Palette.textPrimary)
        .padding(.horizontal, 14)
        .frame(height: 30)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(
              prominent
                ? Theme.Palette.accentStrong
                : (hovering ? Theme.Palette.line : Theme.Palette.canvas)
            )
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(prominent ? .clear : Theme.Palette.line, lineWidth: Theme.Metric.hairline)
        )
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}
