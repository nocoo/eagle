import Foundation
import Testing

@testable import EagleDesign

@Suite("Peer exchange")
struct PeerExchangeTests {
  private let raven = PeerRef(
    id: "raven", title: "repo-raven", face: .init(shape: .blob, tint: .blue))
  private let vps = PeerRef(id: "vps", title: "VPS管家", face: .init(shape: .blob, tint: .green))

  private func exchange(_ messages: [PeerMessage]) -> PeerExchange {
    PeerExchange(id: "x1", participants: [raven, vps], messages: messages)
  }

  @Test("consecutive messages from one bot read as one burst")
  func bursts() {
    let result = exchange([
      PeerMessage(id: "m1", senderId: "raven", text: "a"),
      PeerMessage(id: "m2", senderId: "raven", text: "b"),
      PeerMessage(id: "m3", senderId: "vps", text: "c"),
      PeerMessage(id: "m4", senderId: "raven", text: "d"),
    ]).bursts()

    #expect(result.map(\.sender.title) == ["repo-raven", "VPS管家", "repo-raven"])
    #expect(result.map(\.messages.count) == [2, 1, 1])
    #expect(result.first?.id == "m1")
  }

  @Test("an empty exchange has no bursts and says so")
  func empty() {
    let subject = exchange([])
    #expect(subject.bursts().isEmpty)
    #expect(subject.summary == "0 条消息来往：")
  }

  @Test("the summary counts messages, never describes them")
  func summary() {
    #expect(exchange([PeerMessage(id: "m1", senderId: "vps", text: "a")]).summary == "1 条消息来往：")
    #expect(
      exchange((0..<4).map { PeerMessage(id: "m\($0)", senderId: "vps", text: "") }).summary
        == "4 条消息来往：")
  }

  @Test("a sender the exchange does not list keeps its own burst under its id")
  func unknownSender() {
    let result = exchange([PeerMessage(id: "m1", senderId: "ghost", text: "a")]).bursts()
    #expect(result.count == 1)
    #expect(result.first?.sender.id == "ghost")
    #expect(result.first?.sender.title == "ghost")
    #expect(result.first?.messages.first?.text == "a")
  }

  private func at(_ seconds: TimeInterval) -> Date {
    Date(timeIntervalSince1970: 1_790_000_000 + seconds)
  }

  @Test("a silence longer than the gap starts a new divider; a short one does not")
  func dividers() {
    let exchange = PeerExchange(
      id: "x1",
      participants: [raven, vps],
      messages: [
        PeerMessage(id: "m1", senderId: "raven", text: "a", at: at(0)),
        PeerMessage(id: "m2", senderId: "vps", text: "b", at: at(40)),
        // Three minutes later: still the same stretch of conversation.
        PeerMessage(id: "m3", senderId: "raven", text: "c", at: at(220)),
        // Ten minutes after that: the dialog says when it resumed.
        PeerMessage(id: "m4", senderId: "vps", text: "d", at: at(820)),
      ]
    )
    let bursts = exchange.bursts(label: { _ in "DIVIDER" })
    // The first run always says when it began; a gap under the threshold does not.
    #expect(bursts.map(\.divider) == ["DIVIDER", nil, nil, "DIVIDER"])
    #expect(bursts.map(\.messages.count) == [1, 1, 1, 1])
  }

  @Test("a message without a moment adds no divider and keeps the run")
  func withoutMoments() {
    let exchange = PeerExchange(
      id: "x1",
      participants: [raven, vps],
      messages: [
        PeerMessage(id: "m1", senderId: "raven", text: "a"),
        PeerMessage(id: "m2", senderId: "raven", text: "b"),
      ]
    )
    let bursts = exchange.bursts(label: { _ in "DIVIDER" })
    #expect(bursts.count == 1)
    #expect(bursts.first?.divider == nil)
    #expect(bursts.first?.messages.count == 2)
  }

  @Test("participants answer by id")
  func participants() {
    let subject = exchange([])
    #expect(subject.participant("vps")?.title == "VPS管家")
    #expect(subject.participant("nobody") == nil)
  }
}
