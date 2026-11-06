import BotsCore
import BotsFeatures
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

/// A peer read is a request, not a result: a dialog that comes and goes while it is in flight
/// invalidates it, so a late answer never opens a transcript nobody asked for any more.
@MainActor
@Suite("Peer read race", .serialized)
struct PeerReadRaceTests {
  @Test("a read that lands after a dialog came and went does not reopen itself")
  func staleReadIgnored() async throws {
    let harness = try await DialogRaceHarness()
    let read = Task { await harness.bots.openExchange("x_1") }
    try await harness.waitForRequest("x_1")

    // The shell presents another dialog, then dismisses it.
    harness.bots.cancelPeerRead()
    harness.bots.closeExchange()
    await harness.peers.release()
    await read.value

    #expect(harness.bots.openedExchange == nil, "the late answer belongs to a dialog that is gone")
  }

  @Test("a deliberate read after all of that still opens")
  func freshReadOpens() async throws {
    let harness = try await DialogRaceHarness()
    let read = Task { await harness.bots.openExchange("x_1") }
    try await harness.waitForRequest("x_1")
    harness.bots.cancelPeerRead()
    harness.bots.closeExchange()
    await harness.peers.release()
    await read.value
    #expect(harness.bots.openedExchange == nil)

    await harness.bots.openExchange("x_1")
    #expect(harness.bots.openedExchange?.id == "x_1", "a new ask is not the old one")
  }

  @Test("two reads keep only the newest")
  func newestWins() async throws {
    let harness = try await DialogRaceHarness()
    let first = Task { await harness.bots.openExchange("x_1") }
    try await harness.waitForRequest("x_1")
    let second = Task { await harness.bots.openExchange("x_2") }
    try await harness.waitForRequest("x_2")
    await harness.peers.release()
    await first.value
    await second.value
    #expect(harness.bots.openedExchange?.id == "x_2")
  }
}

/// A tool run belongs to the conversation that opened it, so a pending create that moves the
/// selection must not leave another bot's rows under the old entry id.
@MainActor
@Suite("Tool run ownership", .serialized)
struct ToolRunOwnershipTests {
  @Test("a pending create that selects another bot stops the run belonging to the chat")
  func delayedSelection() async throws {
    let harness = try await DialogRaceHarness()
    let gate = StubCatalog.Gate()
    harness.catalog.createGate = gate
    let run = WorkspaceDialog.toolRun(id: "run-c_1", owner: .bot(id: "b_1"))
    #expect(run.belongs(to: .bot(id: "b_1")))

    let create = Task {
      await harness.bots.createBot(title: "二号", label: nil, appearance: .init())
    }
    await gate.open()
    await create.value

    let selected = try #require(harness.bots.selectedId)
    #expect(selected == "b_new", "the created bot is selected")
    #expect(!run.belongs(to: .bot(id: selected)), "the chat moved on; the detail must close")
  }
}

@MainActor
private struct DialogRaceHarness {
  let bots: BotsWorkspaceViewModel
  let peers: StubPeers
  let catalog: StubCatalog

  init() async throws {
    peers = StubPeers()
    let catalog = StubCatalog()
    catalog.bots = [
      BotSummary(
        id: "b_1", title: "研究员", createdAt: "x", updatedAt: "x",
        model: ModelRef(provider: "p", modelId: "m"), state: .idle)
    ]
    self.catalog = catalog
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("dialog-race-\(UUID().uuidString)", isDirectory: true)
    let outbox = OutboxStore(directory: directory)
    let port = StubConversation()
    let app = AppViewModel(
      catalog: catalog,
      conversation: ConversationViewModel(botId: "", conversation: port, outbox: outbox),
      outbox: outbox, triggers: StubTriggers(), peers: peers)
    bots = BotsWorkspaceViewModel(
      settings: BotsSettings(environment: [:]), makeApp: { _ in app },
      gatewayProbe: { true })
    await bots.start()
    bots.select("b_1")
    port.emit(.connection(.ready))
    port.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { bots.connection == .ready }
  }

  func waitForRequest(_ id: String) async throws {
    for _ in 0..<300 {
      if await peers.requested().contains(id) { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(domain: "DialogRaceTests", code: 1)
  }

  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<300 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(domain: "DialogRaceTests", code: 2)
  }
}

/// A peer port whose detail answer is held open until the test lets it land.
private actor StubPeers: PeerPort {
  private var held: [CheckedContinuation<Void, Never>] = []
  private var open = false
  private var seen: [String] = []

  func requested() -> [String] { seen }

  func list(botId: String) async throws -> [PeerExchangeSummary] { [] }

  func detail(botId: String, exchangeId: String) async throws -> PeerExchangeDetail {
    seen.append(exchangeId)
    if !open {
      await withCheckedContinuation { held.append($0) }
    }
    return PeerExchangeDetail(
      id: exchangeId,
      participants: [
        PeerExchangeParticipant(id: "b_1", title: "研究员"),
        PeerExchangeParticipant(id: "b_2", title: "依赖修复专家"),
      ],
      status: "complete",
      startedAt: "2026-10-29T12:00:00.000Z",
      messages: [
        PeerExchangeMessage(
          id: "m_1", fromBotId: "b_1", toBotId: "b_2", at: "2026-10-29T12:00:00.000Z",
          text: "看一下这个依赖", answer: "收到")
      ]
    )
  }

  func release() {
    open = true
    for waiter in held { waiter.resume() }
    held.removeAll()
  }
}
