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

  public func orderedAnswers(_ chosen: [Int: Set<String>]) -> [[String]] {
    questions.map { question in
      question.options.map(\.label).filter { chosen[question.id]?.contains($0) ?? false }
    }
  }
}

/// The card itself: every option is a whole-row target, the chosen rows carry a filled check on
/// the left, and submit stays disabled until every question has a choice.
public struct AskCardRow: View {
  private let card: AskCard
  private let onAnswer: (String, [[String]], Bool) async -> Result<Void, AskCardFailure>
  /// Chosen labels per question, kept here so a reload never pretends a choice was made.
  @State private var chosen: [Int: Set<String>] = [:]
  @StateObject private var submission = AskCardSubmission()

  public init(
    card: AskCard,
    onAnswer: @escaping (String, [[String]], Bool) async -> Result<Void, AskCardFailure>
  ) {
    self.card = card
    self.onAnswer = onAnswer
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
      if let failure = submission.failure {
        Text(failure)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.destructive)
          .padding(Theme.Layout.sectionGap)
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
    HStack(spacing: Theme.Layout.controlGap) {
      Image(systemName: locked ? "checkmark.circle.fill" : "questionmark.circle")
        .font(Theme.TypeScale.noteEmphasis)
        .foregroundStyle(locked ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
      Text(
        card.answered ? "已回答" : submission.pending ? "提交中" : submission.confirmed ? "已提交" : "需要你确认"
      )
      .font(Theme.TypeScale.noteEmphasis)
      .foregroundStyle(Theme.Palette.textPrimary)
      Spacer(minLength: 0)
      if !locked {
        Button("忽略") {
          send(skipped: true)
        }
        .buttonStyle(.plain)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .accessibilityLabel("忽略这次提问")
      }
    }
    .padding(.horizontal, Theme.Layout.controlInset)
    .frame(height: Theme.Card.headerHeight)
  }

  private func questionBlock(_ question: AskCardQuestion) -> some View {
    VStack(alignment: .leading, spacing: Theme.Layout.rowGap) {
      HStack(spacing: Theme.Layout.rowGap) {
        Text(question.prompt)
          .font(Theme.TypeScale.sectionLabel)
          .foregroundStyle(Theme.Palette.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Text(question.multiple ? "多选" : "单选")
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textMuted)
        Spacer(minLength: 0)
      }
      VStack(spacing: Theme.Layout.labelGap) {
        ForEach(question.options) { option in
          optionRow(question: question, option: option)
        }
      }
    }
    .padding(.horizontal, Theme.Layout.controlInset)
    .padding(.vertical, Theme.Layout.sectionGap)
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
      HStack(alignment: .top, spacing: Theme.Layout.controlGap) {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(Theme.TypeScale.cardTitle)
          .foregroundStyle(selected ? Theme.Palette.accentStrong : Theme.Palette.textMuted)
          .frame(width: Theme.Card.optionGlyphSlot, alignment: .center)
        VStack(alignment: .leading, spacing: Theme.Layout.microGap) {
          Text(option.label)
            .font(Theme.TypeScale.note)
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
      .padding(.horizontal, Theme.Layout.controlGap)
      .padding(.vertical, Theme.Layout.rowGap)
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
    HStack(spacing: Theme.Layout.controlGap) {
      CardActionButton("提交", enabled: complete) { send(skipped: false) }
        .accessibilityLabel("提交回答")

      Text(complete ? "已选好，可以提交" : "每个问题都选一项后可提交")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textMuted)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, Theme.Layout.controlInset)
    .padding(.vertical, Theme.Layout.sectionGap)
  }

  /// Read-only once the person answered or has just submitted.
  private var locked: Bool { card.answered || submission.pending || submission.confirmed }

  private var complete: Bool {
    card.questions.allSatisfy { !(chosen[$0.id]?.isEmpty ?? true) }
  }

  private func send(skipped: Bool) {
    let answers = skipped ? [] : card.orderedAnswers(chosen)
    Task { @MainActor in
      await submission.submit { await onAnswer(card.id, answers, skipped) }
    }
  }
}
