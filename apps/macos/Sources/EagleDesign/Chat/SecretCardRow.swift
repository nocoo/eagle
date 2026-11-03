import SwiftUI

/// Where a secret card's record lives: this Bot's own record, or one every Bot on this
/// machine reads (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5, "Two scopes").
public enum SecretCardScope: String, Hashable, Sendable, CaseIterable {
  case bot
  case shared
}

/// What the answer says about the expiry. The Bot's suggestion and the person's last word
/// are two different things, so the card keeps them apart.
public enum SecretCardExpiry: Hashable, Sendable {
  /// The card offered no expiry choice at all: the answer says nothing about it.
  case unspecified
  /// The person chose: the record never expires.
  case permanent
  /// The person chose a number of minutes.
  case minutes(Int)
}

/// A `secret_request` call as the conversation shows it: what the Bot wants the password for,
/// the name the record will carry, and the two choices the person has.
public struct SecretCard: Identifiable, Hashable, Sendable {
  /// The transcript entry that carries the call: what an answer names.
  public var id: String
  /// The record's name. The person cannot rename it, so the name the Bot will use is the name
  /// on the card.
  public var key: String
  /// One line saying what the value is for, in the Bot's own words.
  public var purpose: String?
  /// The scope the Bot proposed; the person has the last word.
  public var scope: SecretCardScope
  /// The minutes the Bot suggested. Nil means the card shows no expiry control at all.
  public var ttlMinutes: Int?
  /// True once the person's answer to this call has arrived.
  public var answered: Bool

  public init(
    id: String,
    key: String,
    purpose: String? = nil,
    scope: SecretCardScope = .bot,
    ttlMinutes: Int? = nil,
    answered: Bool = false
  ) {
    self.id = id
    self.key = key
    self.purpose = purpose
    self.scope = scope
    self.ttlMinutes = ttlMinutes
    self.answered = answered
  }
}

/// Why a secret card's answer did not go through. The message is what the card shows.
public struct SecretCardFailure: Error, Hashable, Sendable {
  public var message: String

  public init(_ message: String) {
    self.message = message
  }
}

/// What a person sends back on a secret card. The value is here for the length of one
/// request and nowhere else.
public struct SecretCardAnswer: Hashable, Sendable {
  public var entryId: String
  public var key: String
  public var scope: SecretCardScope
  public var expiry: SecretCardExpiry
  public var value: String
  /// True when the person declined to answer: nothing is stored.
  public var skipped: Bool

  public init(
    entryId: String,
    key: String,
    scope: SecretCardScope,
    expiry: SecretCardExpiry,
    value: String,
    skipped: Bool = false
  ) {
    self.entryId = entryId
    self.key = key
    self.scope = scope
    self.expiry = expiry
    self.value = value
    self.skipped = skipped
  }
}

/// The card a Bot puts in front of a person when it needs a password. One field, one name,
/// two choices: the card is a control, not chat history, so it never hides with the tool
/// traffic. The value leaves this view as soon as the daemon has it.
public struct SecretCardRow: View {
  /// The minutes a person may choose, in the order the contract lists them.
  static let presetMinutes = [5, 30, 60, 240, 480, 1440]

  private let card: SecretCard
  private let onAnswer: (SecretCardAnswer) async -> Result<Void, SecretCardFailure>

  @State private var value = ""
  @State private var revealed = false
  /// The scope the Bot proposed; the person may widen it to every bot on this machine.
  @State private var shared: Bool
  @State private var expiry: SecretCardExpiry
  /// The person already acted: the card locks at once instead of waiting for the round trip.
  @State private var submitted = false
  @State private var working = false
  /// Why the last attempt failed; the value stays, so the person decides what to do next.
  @State private var failure: String?

  public init(
    card: SecretCard,
    onAnswer: @escaping (SecretCardAnswer) async -> Result<Void, SecretCardFailure>
  ) {
    self.card = card
    self.onAnswer = onAnswer
    _shared = State(initialValue: card.scope == .shared)
    _expiry = State(
      initialValue: card.ttlMinutes.map { SecretCardExpiry.minutes($0) } ?? .unspecified)
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      rule
      fields
      if !locked {
        rule
        actions
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous))
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .fill(Theme.Palette.card)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.cardRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
    .accessibilityElement(children: .contain)
  }

  private var rule: some View {
    Rectangle()
      .fill(Theme.Palette.line)
      .frame(height: Theme.Metric.hairline)
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(systemName: locked ? "checkmark.circle.fill" : "key.fill")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(locked ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
      Text(locked ? "已保存" : "需要你提供密码")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.Palette.textPrimary)
      Spacer(minLength: 0)
      if working { SpinnerArc(size: 12) }
    }
    .padding(.horizontal, 14)
    .frame(height: 40)
  }

  private var fields: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let purpose = card.purpose, !purpose.isEmpty {
        Text(purpose)
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if locked {
        savedValue
      } else {
        valueField
        nameRow
        scopeRow
        if card.ttlMinutes != nil { expiryRow }
      }
      if let failure {
        Text(failure)
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.Palette.destructive)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  /// The field the password goes into, with the eye that shows it. The value is never put
  /// anywhere else.
  private var valueField: some View {
    HStack(spacing: 6) {
      Group {
        if revealed {
          TextField("", text: $value)
        } else {
          SecureField("", text: $value)
        }
      }
      .textFieldStyle(.plain)
      .font(.system(size: 13))
      .foregroundStyle(Theme.Palette.textPrimary)
      .accessibilityLabel("密码")
      IconButton(
        systemName: revealed ? "eye.slash" : "eye",
        label: revealed ? "隐藏密码" : "显示密码",
        size: 22,
        action: { revealed.toggle() }
      )
    }
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .fill(Theme.Palette.canvas)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
        .strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline)
    )
  }

  /// The record's name, read-only: the Bot named it and the Bot reads it back by that name.
  private var nameRow: some View {
    HStack(spacing: 8) {
      Text("名称")
        .font(.system(size: 12.5))
        .foregroundStyle(Theme.Palette.textSecondary)
      Text(card.key)
        .font(.system(size: 12.5, design: .monospaced))
        .foregroundStyle(Theme.Palette.textPrimary)
      Spacer(minLength: 0)
    }
  }

  private var scopeRow: some View {
    Toggle("共享给所有 Bot", isOn: $shared)
      .toggleStyle(.checkbox)
      .font(.system(size: 12.5))
      .foregroundStyle(Theme.Palette.textPrimary)
  }

  /// The expiry, only when the Bot asked for one: a card without a suggestion shows no
  /// control at all.
  private var expiryRow: some View {
    HStack(spacing: 8) {
      Text("有效期")
        .font(.system(size: 12.5))
        .foregroundStyle(Theme.Palette.textSecondary)
      expiryMenu
      Spacer(minLength: 0)
    }
  }

  private var expiryMenu: some View {
    Menu {
      ForEach(expiryOptions) { option in
        Button(option.title) { expiry = option.expiry }
      }
    } label: {
      HStack(spacing: 6) {
        Text(expiryTitle(expiry))
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.Palette.textSecondary)
      }
      .padding(.horizontal, 12)
      .frame(height: 26)
      .background(Capsule().fill(Theme.Palette.canvas))
      .overlay(Capsule().strokeBorder(Theme.Palette.line, lineWidth: Theme.Metric.hairline))
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .accessibilityLabel("有效期")
  }

  /// One choice of the expiry menu.
  private struct ExpiryChoice: Identifiable {
    var expiry: SecretCardExpiry
    var title: String

    var id: String { title }
  }

  /// The choices a person may pick: the presets, the Bot's own suggestion when it is not one
  /// of them, and the record that never expires.
  private var expiryOptions: [ExpiryChoice] {
    var minutes = Self.presetMinutes
    if let suggested = card.ttlMinutes, !minutes.contains(suggested) {
      minutes.append(suggested)
      minutes.sort()
    }
    return [ExpiryChoice(expiry: .permanent, title: "永久")]
      + minutes.map { ExpiryChoice(expiry: .minutes($0), title: "\($0) 分钟") }
  }

  private func expiryTitle(_ expiry: SecretCardExpiry) -> String {
    switch expiry {
    case .unspecified, .permanent: return "永久"
    case .minutes(let minutes): return "\(minutes) 分钟"
    }
  }

  /// After the answer arrived the card shows what was stored, never the value itself.
  private var savedValue: some View {
    HStack(spacing: 8) {
      Text("已保存")
        .font(.system(size: 12.5))
        .foregroundStyle(Theme.Palette.textSecondary)
      Text(card.key)
        .font(.system(size: 12.5, design: .monospaced))
        .foregroundStyle(Theme.Palette.textPrimary)
      Spacer(minLength: 0)
    }
  }

  private var actions: some View {
    HStack(spacing: 10) {
      Button {
        send(value: value, skipped: false)
      } label: {
        Text("保存")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Color.white)
          .padding(.horizontal, 16)
          .frame(height: 30)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(canSave ? Theme.Palette.accentStrong : Theme.Palette.textMuted.opacity(0.4))
          )
      }
      .buttonStyle(.plain)
      .disabled(!canSave)
      .accessibilityLabel("保存密码")

      Button {
        send(value: "", skipped: true)
      } label: {
        Text("取消")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Theme.Palette.textSecondary)
          .padding(.horizontal, 12)
          .frame(height: 30)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("取消这次提问")

      if !canSave && !working {
        Text("填入密码后可保存")
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.Palette.textMuted)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  private var canSave: Bool { !value.isEmpty && !working }

  /// Read-only once the person answered or has just submitted.
  private var locked: Bool { card.answered || submitted }

  /// The answer leaves the card in one request. On success the value is gone from this view;
  /// on failure it stays, and the person decides whether to try again or to give up.
  private func send(value: String, skipped: Bool) {
    guard !working else { return }
    working = true
    failure = nil
    let answer = SecretCardAnswer(
      entryId: card.id,
      key: card.key,
      scope: shared ? .shared : .bot,
      expiry: expiry,
      value: value,
      skipped: skipped
    )
    Task { @MainActor in
      let result = await onAnswer(answer)
      working = false
      switch result {
      case .success:
        self.value = ""
        revealed = false
        submitted = true
      case .failure(let problem):
        failure = problem.message
      }
    }
  }
}
