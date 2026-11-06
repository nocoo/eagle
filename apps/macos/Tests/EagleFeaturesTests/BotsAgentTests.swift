import BotsCore
import BotsFeatures
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

/// The bot's own pair in the inspector (docs/bots/PROTOCOL.md, "Per-bot agent"): the levels
/// the model takes, the state of a save, and the rule that an answer for one bot never
/// lands on another.
@MainActor
@Suite("Bots agent", .serialized)
struct BotsAgentTests {
  private func bot(_ id: String, model: String = "auto/gpt-6-luna") -> BotSummary {
    BotSummary(
      id: id,
      title: id,
      createdAt: "x",
      updatedAt: "x",
      model: ModelRef(provider: "magpie", modelId: model),
      state: .idle
    )
  }

  private func app(catalog: StubCatalog) -> AppViewModel {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-agent-\(UUID().uuidString)", isDirectory: true)
    let outbox = OutboxStore(directory: directory)
    let conversation = ConversationViewModel(
      botId: "",
      conversation: StubConversation(),
      outbox: outbox
    )
    return AppViewModel(catalog: catalog, conversation: conversation, outbox: outbox)
  }

  @Test("the inspector offers the levels the bot's own model takes")
  func levelsFollowTheModel() async throws {
    let presenter = BotsPresenter()
    let detail = ModelDetail(
      id: "auto/gpt-6-luna",
      contextWindow: 272_000,
      maxTokens: 128_000,
      reasoning: true,
      thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"]
    )
    let rows = presenter.agentChoices(
      for: bot("b_1"),
      agent: AgentView(
        model: ModelRef(provider: "magpie", modelId: "auto/gpt-6-luna"),
        thinkingLevel: "xhigh",
        instructions: ""
      ),
      models: ["auto/gpt-6-luna"],
      detail: detail
    )
    let thinking = try #require(rows.first { $0.id == "thinking" })
    #expect(
      thinking.choices.map(\.id) == ["off", "low", "medium", "high", "xhigh", "max"],
      "the menu never offers a level the model would refuse"
    )
    #expect(thinking.selected == "xhigh", "the bot's own saved level is what shows")
    #expect(thinking.value == "极高")
  }

  @Test("a save shows only on the bot it was made for, and another selection keeps its own")
  func completionStaysWithItsBot() async throws {
    let catalog = StubCatalog()
    catalog.bots = [bot("b_1"), bot("b_2")]
    let app = app(catalog: catalog)
    await app.refresh()
    app.select("b_1")
    let gate = StubCatalog.Gate()
    catalog.agentGate = gate
    let edit = Task { await app.setAgent(model: "auto/gpt-6-sol", thinkingLevel: nil) }
    try await waitUntil { app.agentEdit?.isSaving == true }
    #expect(app.agentEdit?.botId == "b_1")
    // The person moves to the other bot while the save is still in flight.
    app.select("b_2")
    await gate.open()
    await edit.value
    #expect(
      app.agentEdit == nil,
      "the answer for b_1 does not describe the bot on screen"
    )
    #expect(catalog.agentChanges.count == 1)
    #expect(catalog.agentChanges.first?.0 == "b_1")
  }

  @Test("a refusal stays on the bot that asked for the change")
  func refusalStaysWithItsBot() async throws {
    let catalog = StubCatalog()
    catalog.bots = [bot("b_1")]
    catalog.agentError = ClientError("auto/gpt-6-luna does not support the minimal thinking level")
    let app = app(catalog: catalog)
    await app.refresh()
    app.select("b_1")
    await app.setAgent(model: nil, thinkingLevel: "minimal")
    let edit = try #require(app.agentEdit)
    #expect(edit.botId == "b_1")
    #expect(edit.field == "thinking")
    #expect(edit.isSaving == false)
    #expect(edit.error?.contains("does not support") == true)
  }

  @Test("two rapid edits are applied one after the other")
  func rapidEditsSerialize() async throws {
    let catalog = StubCatalog()
    catalog.bots = [bot("b_1")]
    let app = app(catalog: catalog)
    await app.refresh()
    app.select("b_1")
    let gate = StubCatalog.Gate()
    catalog.agentGate = gate
    let first = Task { await app.setAgent(model: "auto/gpt-6-sol", thinkingLevel: nil) }
    try await waitUntil { catalog.agentChanges.count == 1 }
    let second = Task { await app.setAgent(model: nil, thinkingLevel: "low") }
    // The second waits for the first: it has not been sent yet.
    try await Task.sleep(nanoseconds: 30_000_000)
    #expect(catalog.agentChanges.count == 1, "the second change waits for the first")
    await gate.open()
    await first.value
    await second.value
    #expect(catalog.agentChanges.count == 2)
    #expect(catalog.agentChanges.map(\.1) == ["auto/gpt-6-sol", nil])
    #expect(catalog.agentChanges.map(\.2) == [nil, "low"])
  }

  @Test("the model list carries what the daemon knows about each model")
  func modelDetailsLoad() async throws {
    let catalog = StubCatalog()
    catalog.models = ["auto/gpt-6-luna", "house/custom"]
    let app = app(catalog: catalog)
    await app.loadModelsIfNeeded()
    #expect(app.models == ["auto/gpt-6-luna", "house/custom"])
    #expect(app.modelDetails["auto/gpt-6-luna"]?.thinkingLevels.contains("xhigh") == true)
    #expect(app.modelDiscoveryError == nil)
  }

  private func waitUntil(
    timeout: TimeInterval = 2,
    _ condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    Issue.record("condition not met within \(timeout)s")
  }
}
