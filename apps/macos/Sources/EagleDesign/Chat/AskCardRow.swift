import SwiftUI

/// One question the bot asked, with the options the person may choose.
public struct AskCardQuestion: Identifiable, Hashable, Sendable {
  public struct Option: Identifiable, Hashable, Sendable {
    public var label: String
    public var detail: String?

    public var id: String { label }

    public init(label: String, detail: String? = nil) {
      self.label = label
      self.detail = detail
    }
  }

  public var id: Int
  public var prompt: String
  /// One choice replaces the last one; several choices accumulate.
  public var multiple: Bool
  public var options: [Option]

  public init(id: Int, prompt: String, multiple: Bool, options: [Option]) {
    self.id = id
    self.prompt = prompt
    self.multiple = multiple
    self.options = options
  }
}

/// An `ask_user` call as the conversation shows it: the question, the choices, and — until the
/// person answers or skips — the two actions that close it. The card is a control, not chat
/// history, so `Settings → 通用 → 隐藏工具调用` never hides it.
public struct AskCard: Identifiable, Hashable, Sendable {
  /// The transcript entry that carries the call: what an answer names.
  public var id: String
  public var questions: [AskCardQuestion]
  /// True once the person's hidden answer to this call has arrived.
  public var answered: Bool

  public init(id: String, questions: [AskCardQuestion], answered: Bool = false) {
    self.id = id
    self.questions = questions
    self.answered = answered
  }
}

/// The card itself: every option is a whole-row target, the chosen rows carry a filled check on
/// the left, and submit stays disabled until every question has a choice.
public struct AskCardRow: View {
  private let card: AskCard
  private let onSubmit: (String, [String]) -> Void
  private let onSkip: (String) -> Void
  /// Chosen labels per question, kept here so a reload never pretends a choice was made.
  @State private var chosen: [Int: Set<String>] = [:]
  /// The person already acted: the card locks at once instead of waiting for the round trip,
  /// because a button that stays clickable reads as a click that did nothing.
  @State private var submitted = false

  public init(
    card: AskCard,
    onSubmit: @escaping (String, [String]) -> Void,
    onSkip: @escaping (String) -> Void
  ) {
    self.card = card
    self.onSubmit = onSubmit
    self.onSkip = onSkip
  }

  public var body: some View {
    // Dividers sit *between* blocks, never under the last one: a rule at the card's own edge
    // would run straight through the rounded corners.
    VStack(alignment: .leading, spacing: 0) {
      header
      ForEach(card.questions) { question in
        rule
        questionBlock(question)
      }
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
      Image(systemName: locked ? "checkmark.circle.fill" : "questionmark.circle")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(locked ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
      Text(card.answered ? "已回答" : submitted ? "已提交" : "需要你确认")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.Palette.textPrimary)
      Spacer(minLength: 0)
      if !locked {
        Button("忽略") {
          submitted = true
          onSkip(card.id)
        }
        .buttonStyle(.plain)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .accessibilityLabel("忽略这次提问")
      }
    }
    .padding(.horizontal, 14)
    .frame(height: 40)
  }

  private func questionBlock(_ question: AskCardQuestion) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(question.prompt)
          .font(.system(size: 13.5, weight: .medium))
          .foregroundStyle(Theme.Palette.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Text(question.multiple ? "多选" : "单选")
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textMuted)
        Spacer(minLength: 0)
      }
      VStack(spacing: 6) {
        ForEach(question.options) { option in
          optionRow(question: question, option: option)
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  private func optionRow(question: AskCardQuestion, option: AskCardQuestion.Option) -> some View {
    let selected = chosen[question.id]?.contains(option.label) ?? false
    return Button {
      guard !locked else { return }
      var current = chosen[question.id] ?? []
      if question.multiple {
        if selected {
          current.remove(option.label)
        } else {
          current.insert(option.label)
        }
      } else {
        current = selected ? [] : [option.label]
      }
      chosen[question.id] = current
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(selected ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
          .frame(width: 18, alignment: .center)
        VStack(alignment: .leading, spacing: 2) {
          Text(option.label)
            .font(.system(size: 13))
            .foregroundStyle(Theme.Palette.textPrimary)
          if let detail = option.detail, !detail.isEmpty {
            Text(detail)
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
          .fill(selected ? Theme.Palette.selection : Theme.Palette.canvas)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(locked)
    .accessibilityLabel(option.label)
    .accessibilityValue(selected ? "已选择" : "未选择")
  }

  private var actions: some View {
    HStack(spacing: 10) {
      Button {
        submitted = true
        onSubmit(card.id, orderedChoices)
      } label: {
        Text("提交")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Color.white)
          .padding(.horizontal, 16)
          .frame(height: 30)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(complete ? Theme.Palette.accentStrong : Theme.Palette.textMuted.opacity(0.4))
          )
      }
      .buttonStyle(.plain)
      .disabled(!complete)
      .accessibilityLabel("提交回答")

      Text(complete ? "已选好，可以提交" : "每个问题都选一项后可提交")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  /// Read-only once the person answered or has just submitted.
  private var locked: Bool { card.answered || submitted }

  private var complete: Bool {
    card.questions.allSatisfy { !(chosen[$0.id]?.isEmpty ?? true) }
  }

  /// Labels only: the daemon checks them against the card it drew and writes what the bot reads.
  private var orderedChoices: [String] {
    card.questions.flatMap { question in
      question.options.map(\.label).filter { chosen[question.id]?.contains($0) ?? false }
    }
  }
}
