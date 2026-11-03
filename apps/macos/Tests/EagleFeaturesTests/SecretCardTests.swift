import BotsCore
import Testing

@testable import EagleDesign
@testable import EagleFeatures

/// A `secret_request` call as the conversation shows it (docs/bots/EXTENSIONS-AND-TOOLS.md
/// §6.5, "The card is the only write").
@Suite("Secret cards")
struct SecretCardPresenterTests {
  private let presenter = BotsPresenter()

  private func call(_ args: [String: JSONValue], id: String = "e_12") -> Message {
    Message(
      id: id,
      role: .assistant,
      state: .complete,
      createdAt: "2026-11-03T01:00:00.000Z",
      blocks: [.toolCall(callId: "c_1", name: "secret_request", args: args)]
    )
  }

  private func state(_ messages: [Message]) -> ConversationState {
    var state = ConversationState(botId: "b_1")
    for message in messages {
      state = Reducer.apply(.append(message: message, replaces: nil), to: state)
    }
    return state
  }

  @Test("the card carries the bot's own words and the name the bot will use")
  func card() {
    let entries = presenter.transcript(
      for: state([
        call([
          "key": .string("github-pat"),
          "purpose": .string("发布 Eagle 用"),
          "scope": .string("shared"),
          "ttlMinutes": .number(60),
        ])
      ]))
    guard case .secret(_, let card) = entries.first else {
      Issue.record("a secret request is a card, not a tool row")
      return
    }
    #expect(card.key == "github-pat")
    #expect(card.purpose == "发布 Eagle 用")
    #expect(card.scope == .shared)
    #expect(card.ttlMinutes == 60)
    #expect(card.answered == false)
  }

  @Test("a call without an expiry and without a scope asks for the plain card")
  func plainCard() {
    let entries = presenter.transcript(
      for: state([call(["key": .string("npm-token"), "purpose": .string("装依赖")])]))
    guard case .secret(_, let card) = entries.first else {
      Issue.record("a secret request is a card")
      return
    }
    #expect(card.scope == .bot, "the bot's own record is the default")
    #expect(card.ttlMinutes == nil, "no suggestion means no expiry control at all")
  }

  @Test("a call without a key is not a card")
  func withoutKey() {
    let entries = presenter.transcript(
      for: state([call(["purpose": .string("没有名字")])]))
    #expect(
      !entries.contains { if case .secret = $0 { true } else { false } },
      "a call the daemon would refuse is not a card")
  }

  @Test("a call without a purpose is not a card either")
  func withoutPurpose() {
    let entries = presenter.transcript(for: state([call(["key": .string("github-pat")])]))
    #expect(
      !entries.contains { if case .secret = $0 { true } else { false } },
      "the daemon refuses an answer for a call without a purpose")
  }

  @Test("the hidden answer closes the card")
  func answered() {
    let answer = Message(
      id: "e_20",
      role: .user,
      state: .complete,
      createdAt: "2026-11-03T01:05:00.000Z",
      blocks: [.text("")],
      hidden: true,
      answersTo: "e_12"
    )
    let entries = presenter.transcript(
      for: state([call(["key": .string("github-pat"), "purpose": .string("发布用")]), answer]))
    guard case .secret(_, let card) = entries.first else {
      Issue.record("a secret request is a card")
      return
    }
    #expect(card.answered == true)
  }

  @Test("the expiry the person chose travels as the daemon's three shapes")
  func expiry() {
    #expect(BotsWorkspaceViewModel.secretTTL(.unspecified) == .inherit)
    #expect(BotsWorkspaceViewModel.secretTTL(.permanent) == .permanent)
    #expect(BotsWorkspaceViewModel.secretTTL(.minutes(30)) == .minutes(30))
  }
}

/// One answer may ask for two passwords, and each card is its own question.
@Suite("Two secret cards in one answer")
struct SecretCardPairTests {
  private let presenter = BotsPresenter()

  private func pair() -> Message {
    Message(
      id: "e_12",
      role: .assistant,
      state: .complete,
      createdAt: "2026-11-03T01:00:00.000Z",
      blocks: [
        .toolCall(
          callId: "c_1", name: "secret_request",
          args: ["key": .string("github-pat"), "purpose": .string("发布用")]),
        .toolCall(
          callId: "c_2", name: "secret_request",
          args: ["key": .string("npm-token"), "purpose": .string("装依赖")]),
      ]
    )
  }

  private func transcript(_ messages: [Message]) -> [TranscriptEntry] {
    var state = ConversationState(botId: "b_1")
    for message in messages {
      state = Reducer.apply(.append(message: message, replaces: nil), to: state)
    }
    return presenter.transcript(for: state)
  }

  @Test("both cards render, each with its own index and identity")
  func twoCards() {
    let cards = transcript([pair()]).compactMap { entry -> SecretCard? in
      if case .secret(_, let card) = entry { return card }
      return nil
    }
    #expect(cards.count == 2, "one answer can ask for two passwords")
    #expect(cards.map(\.callIndex) == [0, 1])
    #expect(cards.map(\.id) == ["e_12", "e_12"], "both name the entry the daemon stores")
    #expect(cards.map(\.key) == ["github-pat", "npm-token"])
  }

  @Test("the answer names the call it answers, so the second card stays open")
  func answeredSecond() {
    let answer = Message(
      id: "e_13",
      role: .user,
      state: .complete,
      createdAt: "2026-11-03T01:05:00.000Z",
      blocks: [.text("")],
      hidden: true,
      answersTo: "e_12#1"
    )
    let cards = transcript([pair(), answer]).compactMap { entry -> SecretCard? in
      if case .secret(_, let card) = entry { return card }
      return nil
    }
    #expect(cards[0].answered == false, "the first card is still waiting for the person")
    #expect(cards[1].answered == true)
  }

  @Test("a cancelled card says so instead of claiming a saved password")
  func skippedCard() {
    let answer = Message(
      id: "e_13",
      role: .user,
      state: .complete,
      createdAt: "2026-11-03T01:05:00.000Z",
      blocks: [
        .text(
          "The person skipped the secret request for \"github-pat\" from e_12 without answering.")
      ],
      hidden: true,
      answersTo: "e_12"
    )
    let card = transcript([
      Message(
        id: "e_12",
        role: .assistant,
        state: .complete,
        createdAt: "2026-11-03T01:00:00.000Z",
        blocks: [
          .toolCall(
            callId: "c_1", name: "secret_request",
            args: ["key": .string("github-pat"), "purpose": .string("发布用")])
        ]),
      answer,
    ]).compactMap { entry -> SecretCard? in
      if case .secret(_, let card) = entry { return card }
      return nil
    }
    #expect(card.first?.skipped == true, "the record was never stored")
  }
}

/// The card only offers the choices the contract lists.
@Suite("Secret card presets")
struct SecretCardPresetTests {
  @Test("a suggestion between presets lands on the nearest one")
  func nearest() {
    #expect(SecretCardExpiry.nearestPreset(1) == 5)
    #expect(SecretCardExpiry.nearestPreset(15) == 5, "ten minutes away beats fifteen")
    #expect(SecretCardExpiry.nearestPreset(20) == 30)
    #expect(SecretCardExpiry.nearestPreset(90) == 60)
    #expect(SecretCardExpiry.nearestPreset(300) == 240)
    #expect(SecretCardExpiry.nearestPreset(1440) == 1440)
  }
}
