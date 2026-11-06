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

  @Test("every thinking level offers its Chinese label but keeps the raw level as its id")
  func levelTitlesAreChinese() throws {
    let presenter = BotsPresenter()
    let rows = presenter.agentChoices(
      for: bot("b_1"),
      agent: AgentView(
        model: ModelRef(provider: "magpie", modelId: "auto/gpt-6-luna"),
        thinkingLevel: "max",
        instructions: ""
      ),
      models: ["auto/gpt-6-luna"],
      detail: nil
    )
    let thinking = try #require(rows.first { $0.id == "thinking" })
    #expect(
      thinking.choices.map(\.id) == ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "the wire still sends the level the model knows"
    )
    #expect(
      thinking.choices.map(\.title) == ["关闭", "极低", "低", "中", "高", "极高", "最高"],
      "the menu speaks the inspector's language"
    )
    #expect(thinking.selected == "max")
    #expect(thinking.value == "最高")
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
    #expect(app.agentEdit == nil, "nothing is saving once the refusal lands")
    #expect(
      app.agentError(botId: "b_1", field: "thinking")?.contains("does not support") == true
    )
    #expect(app.agentError(botId: "b_1", field: "model") == nil, "the other row is untouched")
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

  @Test("a discovery failure keeps the ids and is retried, then cleared")
  func discoveryRetries() async throws {
    let catalog = StubCatalog()
    catalog.models = ["auto/gpt-6-luna"]
    catalog.modelDiscoveryError = "the gateway could not be asked for its models"
    let app = app(catalog: catalog)
    await app.loadModelsIfNeeded()
    #expect(app.models == ["auto/gpt-6-luna"], "the ids the daemon knew stay offered")
    #expect(app.modelDiscoveryError != nil, "and the failure is visible")

    // The next visit asks again rather than trusting the preserved list for ever.
    catalog.models = ["auto/gpt-6-luna", "auto/gpt-6-sol"]
    catalog.modelDiscoveryError = nil
    await app.loadModelsIfNeeded()
    #expect(app.models == ["auto/gpt-6-luna", "auto/gpt-6-sol"])
    #expect(app.modelDiscoveryError == nil, "a good answer clears the failure")
  }

  @Test("a refusal stays on its row, whatever the person looks at next")
  func refusalStaysOnItsRow() async throws {
    let catalog = StubCatalog()
    catalog.bots = [bot("b_1"), bot("b_2")]
    catalog.agentError = ClientError("auto/gpt-6-luna does not support the minimal thinking level")
    let app = app(catalog: catalog)
    await app.refresh()
    app.select("b_1")
    await app.setAgent(model: nil, thinkingLevel: "minimal")
    #expect(app.agentError(botId: "b_1", field: "thinking")?.contains("does not support") == true)

    // The person moves to the other bot and changes its model: that succeeds, and must not
    // erase the first bot's refusal.
    app.select("b_2")
    catalog.agentError = nil
    await app.setAgent(model: "auto/gpt-6-sol", thinkingLevel: nil)
    #expect(app.agentError(botId: "b_2", field: "model") == nil)
    #expect(
      app.agentError(botId: "b_1", field: "thinking")?.contains("does not support") == true,
      "coming back to b_1 still shows what happened there"
    )

    // That row's own next success clears it.
    app.select("b_1")
    await app.setAgent(model: nil, thinkingLevel: "low")
    #expect(app.agentError(botId: "b_1", field: "thinking") == nil)
  }

  @Test("selecting a bot retries a failed model discovery")
  func selectionRetriesDiscovery() async throws {
    let catalog = StubCatalog()
    catalog.bots = [bot("b_1"), bot("b_2")]
    catalog.models = ["auto/gpt-6-luna"]
    catalog.modelDiscoveryError = "the gateway could not be asked for its models"
    let app = app(catalog: catalog)
    await app.loadModelsIfNeeded()
    #expect(app.modelDiscoveryError != nil)

    // The person does something ordinary: they open another bot.
    catalog.models = ["auto/gpt-6-luna", "auto/gpt-6-sol"]
    catalog.modelDiscoveryError = nil
    app.select("b_2")
    try await waitUntil { app.modelDiscoveryError == nil }
    #expect(app.models == ["auto/gpt-6-luna", "auto/gpt-6-sol"], "the menu recovered")
  }

  @Test("a save the conversation refused still shows the model the catalog kept")
  func savedButNotApplied() async throws {
    let catalog = StubCatalog()
    catalog.bots = [bot("b_1")]
    catalog.agentError = ClientError(
      "the bot now records auto/gpt-6-sol at high, but the running conversation did not take it"
    )
    // The catalog takes the pair even though the conversation refused it.
    catalog.applyOnAgentError = true
    let app = app(catalog: catalog)
    await app.refresh()
    app.select("b_1")
    await app.setAgent(model: "auto/gpt-6-sol", thinkingLevel: "high")
    #expect(app.selectedBot?.model.modelId == "auto/gpt-6-sol", "the row shows the saved model")
    #expect(app.agentError(botId: "b_1", field: "model")?.contains("did not take it") == true)
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
