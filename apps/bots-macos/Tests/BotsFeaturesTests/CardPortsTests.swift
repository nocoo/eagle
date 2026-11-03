import BotsCore
import BotsFeatures
import XCTest

@MainActor
final class CardPortsTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-card-ports-\(UUID().uuidString)")
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func model(
    secrets: SecretPort? = nil, questions: QuestionPort? = nil,
    triggers: TriggerPort? = nil, peers: PeerPort? = nil
  ) -> AppViewModel {
    let outbox = OutboxStore(directory: directory)
    return AppViewModel(
      catalog: FakeCatalog(),
      conversation: ConversationViewModel(
        botId: "", conversation: FakeConversation(), outbox: outbox),
      outbox: outbox, triggers: triggers, peers: peers, secrets: secrets, questions: questions
    )
  }

  func testCardAnswersRequireTheirOwnPorts() async {
    let model = model()
    let answer = SecretAnswer(
      entryId: "e_12", key: "fixture", value: "fictional", scope: .bot, ttlMinutes: .inherit)
    do {
      try await model.answerQuestions(
        botId: "b_1", entryId: "e_11", answers: [["Yes"]], skipped: false)
      XCTFail("missing question port must refuse")
    } catch { XCTAssertEqual((error as? ClientError)?.message, "这个客户端不能提交回答") }
    do {
      try await model.answerSecret(botId: "b_1", answer: answer)
      XCTFail("missing secret port must refuse")
    } catch { XCTAssertEqual((error as? ClientError)?.message, "这个客户端不能保存密码") }
  }

  func testCardAnswersForwardIdentityScopeLifetimeAndGroupedChoices() async throws {
    let ports = RecordingCards()
    let model = model(secrets: ports, questions: ports)
    let answer = SecretAnswer(
      entryId: "e_12", callIndex: 1, key: "fixture", value: "fictional",
      scope: .bot, ttlMinutes: .minutes(5))
    try await model.answerSecret(botId: "b_1", answer: answer)
    XCTAssertEqual(ports.secretBot, "b_1")
    XCTAssertEqual(ports.secretAnswer, answer)
    try await model.answerQuestions(
      botId: "b_1", entryId: "e_11", answers: [["Yes"], ["No"]], skipped: false)
    XCTAssertEqual(ports.questionBot, "b_1")
    XCTAssertEqual(ports.questionEntry, "e_11")
    XCTAssertEqual(ports.answers, [["Yes"], ["No"]])
    XCTAssertFalse(ports.skipped)
    ports.refuse = true
    do {
      try await model.answerSecret(botId: "b_1", answer: answer)
      XCTFail("the port refusal must propagate")
    } catch { XCTAssertEqual((error as? ClientError)?.message, "refused") }
  }

  func testTriggerAndPeerDetailsRespectSelection() async throws {
    let triggers = RecordingTriggers()
    let peers = RecordingPeers()
    let model = model(triggers: triggers, peers: peers)
    let trigger = try await model.triggerDetail(botId: "b_1", triggerId: "t_1")
    XCTAssertEqual(trigger?.id, "t_1")
    let updated = try await model.setTriggerEnabled(botId: "b_1", triggerId: "t_1", enabled: false)
    XCTAssertEqual(updated?.summary.enabled, false)
    XCTAssertEqual(triggers.bot, "b_1")
    let unselected = await model.peerDetail("p_1")
    XCTAssertNil(unselected)
    model.select("b_1")
    await model.loadExchanges()
    XCTAssertEqual(model.exchanges.map(\.id), ["p_1"])
    let detail = await model.peerDetail("p_1")
    XCTAssertEqual(detail?.id, "p_1")
    model.select("b_2")
    XCTAssertTrue(model.exchanges.isEmpty)
  }
}

private final class RecordingCards: SecretPort, QuestionPort {
  var secretBot: String?
  var secretAnswer: SecretAnswer?
  var questionBot: String?
  var questionEntry: String?
  var answers: [[String]] = []
  var skipped = false
  var refuse = false

  func secrets() async throws -> [Secret] { [] }
  func revealSecret(key: String, scope: SecretScope, botId: String?) async throws -> String { "" }
  func deleteSecret(key: String, scope: SecretScope, botId: String?) async throws {}
  func answerSecret(
    botId: String, entryId: String, callIndex: Int, key: String, value: String,
    scope: SecretScope, ttlMinutes: SecretTTL, skipped: Bool
  ) async throws {
    if refuse { throw ClientError("refused") }
    secretBot = botId
    secretAnswer = SecretAnswer(
      entryId: entryId, callIndex: callIndex, key: key, value: value,
      scope: scope, ttlMinutes: ttlMinutes, skipped: skipped)
  }
  func answerQuestions(
    botId: String, entryId: String, answers: [[String]], skipped: Bool
  ) async throws {
    questionBot = botId
    questionEntry = entryId
    self.answers = answers
    self.skipped = skipped
  }
}

private final class RecordingTriggers: TriggerPort, @unchecked Sendable {
  var bot: String?
  let item = TriggerDetail(
    summary: TriggerSummary(id: "t_1", kind: .webhook, name: "Fixture", enabled: true),
    prompt: "fixture")
  func list(botId: String) async throws -> [TriggerDetail] {
    bot = botId
    return [item]
  }
  func setEnabled(botId: String, triggerId: String, enabled: Bool) async throws -> TriggerDetail {
    bot = botId
    var result = item
    result.summary.enabled = enabled
    return result
  }
}

private final class RecordingPeers: PeerPort, @unchecked Sendable {
  func list(botId: String) async throws -> [PeerExchangeSummary] {
    [
      PeerExchangeSummary(
        id: "p_1", participants: [], count: 1, status: "done", startedAt: "x", updatedAt: "x")
    ]
  }
  func detail(botId: String, exchangeId: String) async throws -> PeerExchangeDetail {
    PeerExchangeDetail(
      id: exchangeId, participants: [], status: "done", startedAt: "x", messages: [])
  }
}
