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
