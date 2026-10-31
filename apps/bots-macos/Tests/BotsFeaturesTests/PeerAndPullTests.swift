import BotsCore
import BotsFeatures
import Foundation
import XCTest

@MainActor
final class PeerAndPullTests: XCTestCase {
  func testExchangeReadsStaySelectedAndFailurePreservesTheLastList() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-peer-client-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let outbox = OutboxStore(directory: directory)
    let port = FakeConversation()
    let peers = PeerFixture()
    let conversation = ConversationViewModel(conversation: port, outbox: outbox)
    let model = AppViewModel(
      catalog: FakeCatalog(), conversation: conversation, outbox: outbox, peers: peers)
    await model.loadExchanges()
    XCTAssertTrue(model.exchanges.isEmpty)
    let absent = await model.peerDetail("x_1")
    XCTAssertNil(absent)
    model.select("b_1")
    await model.loadExchanges()
    XCTAssertEqual(model.exchanges, [peers.summary])
    await model.loadExchanges()
    XCTAssertEqual(model.exchanges, [peers.summary])
    let detail = await model.peerDetail("x_1")
    XCTAssertEqual(detail, peers.exchange)
    XCTAssertEqual(detail?.messages.first?.text, "question")
    XCTAssertEqual(detail?.messages.first?.answer, "answer")
    XCTAssertEqual(peers.reads, ["b_1:x_1"])
    peers.fails = true
    await model.loadExchanges()
    XCTAssertEqual(model.exchanges, [peers.summary], "unreachable does not mean empty")
    let failed = await model.peerDetail("x_1")
    XCTAssertNil(failed)
    model.select("b_2")
    XCTAssertTrue(model.exchanges.isEmpty, "another bot never inherits the prior list")
    conversation.disconnect()
  }

  func testReportedPullsReplaceTheListWithoutChangingConversationOrAdmittingWork() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-pull-client-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let port = FakeConversation()
    let model = ConversationViewModel(conversation: port, outbox: OutboxStore(directory: directory))
    model.select(botId: "b_1")
    defer { model.disconnect() }
    let original = PullSummary(
      url: "https://github.com/nocoo/eagle/pull/109", title: "report", status: "open",
      host: "github.com", updatedAt: "2026-10-31T00:00:00Z")
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1", pulls: [original])))
    try await waitUntil { model.hasSnapshot }
    XCTAssertEqual(model.pulls, [original])
    var changed = original
    changed.status = "merged"
    changed.updatedAt = "2026-10-31T00:01:00Z"
    let before = model.state
    port.emit(.pulls([changed]))
    try await waitUntil { model.pulls == [changed] }
    var expected = before
    expected.pulls = [changed]
    XCTAssertEqual(model.state, expected)
    XCTAssertEqual(model.pulls.first?.id, original.url)
    port.emit(.pulls([]))
    try await waitUntil { model.pulls.isEmpty }
    XCTAssertTrue(port.sent.isEmpty)
    XCTAssertEqual(model.state.messages, before.messages)
  }

  private func waitUntil(_ ready: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(2)
    while !ready() {
      guard Date() < deadline else { XCTFail("client event did not arrive"); return }
      await Task.yield()
    }
  }
}

private final class PeerFixture: PeerPort, @unchecked Sendable {
  var fails = false
  var reads: [String] = []
  let summary = PeerExchangeSummary(
    id: "x_1", participants: [PeerExchangeParticipant(id: "b_1", title: "One"),
                              PeerExchangeParticipant(id: "b_2", title: "Two")],
    count: 2, status: "open", startedAt: "start", updatedAt: "answer")
  var exchange: PeerExchangeDetail {
    PeerExchangeDetail(
      id: summary.id, participants: summary.participants, status: summary.status,
      startedAt: summary.startedAt,
      messages: [PeerExchangeMessage(id: "pr_1", fromBotId: "b_1", toBotId: "b_2",
                                     at: "question", text: "question", answer: "answer")])
  }
  func list(botId: String) async throws -> [PeerExchangeSummary] {
    if fails { throw ClientError("unreachable") }
    return [summary]
  }
  func detail(botId: String, exchangeId: String) async throws -> PeerExchangeDetail {
    if fails { throw ClientError("unreachable") }
    reads.append("\(botId):\(exchangeId)")
    return exchange
  }
}
