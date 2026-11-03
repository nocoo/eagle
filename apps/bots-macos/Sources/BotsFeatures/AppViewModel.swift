import BotsCore
import Foundation
import SwiftUI

/// The window's state: the catalog, the selection, and the conversation that follows it.
/// Creating a bot goes to the daemon over HTTP; the catalog then arrives absolute on the
/// socket (PROTOCOL I7).
@MainActor
public final class AppViewModel: ObservableObject {
  @Published public private(set) var bots: [BotSummary] = []
  /// The sidebar groups in the daemon's display order; a bot's `groupId` is its membership.
  @Published public private(set) var groups: [BotGroup] = []
  @Published public private(set) var selection: String?
  @Published public private(set) var error: String?
  @Published public private(set) var isLoading = false
  @Published public var newBotTitle = ""
  @Published public var showingSettings = false

  public let conversation: ConversationViewModel
  /// The bot's exchanges with other bots, folded into one row by the transcript.
  @Published public private(set) var exchanges: [PeerExchangeSummary] = []
  private let catalog: CatalogPort
  /// The read side of an exchange; nil in a test that never opens one.
  private let peers: PeerPort?
  /// The trigger detail and switch; nil in a test that never opens the surface.
  private let triggers: TriggerPort?
  /// The daemon's secrets; nil in a test that never answers a card.
  private let secrets: SecretPort?
  private var outbox: OutboxStore

  public init(
    catalog: CatalogPort,
    conversation: ConversationViewModel,
    outbox: OutboxStore,
    triggers: TriggerPort? = nil,
    peers: PeerPort? = nil,
    secrets: SecretPort? = nil
  ) {
    self.catalog = catalog
    self.conversation = conversation
    self.triggers = triggers
    self.peers = peers
    self.secrets = secrets
    self.outbox = outbox
    conversation.onCatalog = { [weak self] catalog in
      self?.apply(catalog)
    }
  }

  public var selectedBot: BotSummary? {
    guard let selection else { return nil }
    return bots.first { $0.id == selection }
  }

  public var draftCount: Int { conversation.draft.count }

  public func start() async {
    await refresh()
    if selection == nil, let first = bots.first {
      select(first.id)
    }
  }

  /// The exchanges this bot takes part in. A failure leaves the last list rather than
  /// claiming there are none: an unreachable daemon is not an empty conversation.
  public func loadExchanges() async {
    guard let peers, let selection else {
      if !exchanges.isEmpty { exchanges = [] }
      return
    }
    guard let loaded = try? await peers.list(botId: selection) else { return }
    if loaded != exchanges { exchanges = loaded }
  }

  /// One exchange's round trip, read when a person opens the row.
  public func peerDetail(_ exchangeId: String) async -> PeerExchangeDetail? {
    guard let peers, let selection else { return nil }
    return try? await peers.detail(botId: selection, exchangeId: exchangeId)
  }

  public func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      apply(try await catalog.load())
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func createBot() async {
    await createBot(title: newBotTitle)
    if !newBotTitle.isEmpty { newBotTitle = "" }
  }

  public func createBot(title rawTitle: String) async {
    await createBot(title: rawTitle, label: nil, appearance: .standard)
  }

  /// A bot is its name, an optional label and a face; everything else is the daemon's.
  public func createBot(
    title rawTitle: String,
    label: String?,
    appearance: BotAppearance
  ) async {
    var title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    if title.isEmpty { title = "新 Bot" }
    let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    isLoading = true
    defer { isLoading = false }
    do {
      let created = try await catalog.create(
        title: title,
        label: trimmedLabel?.isEmpty == true ? nil : trimmedLabel,
        appearance: appearance
      )
      if rawTitle == newBotTitle { newBotTitle = "" }
      await reload()
      select(created.id)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func rename(_ bot: BotSummary, to title: String) async {
    await update(bot, title: title)
  }

  /// Edits the name, the label (an empty string clears it) or the face; nil leaves a field
  /// alone. The catalog reload is what the sidebar and inspector rebuild from.
  public func update(
    _ bot: BotSummary,
    title: String? = nil,
    label: String? = nil,
    appearance: BotAppearance? = nil
  ) async {
    let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, trimmedTitle?.isEmpty != false { return }
    let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      _ = try await catalog.update(
        id: bot.id,
        title: trimmedTitle,
        label: trimmedLabel,
        appearance: appearance
      )
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func delete(_ bot: BotSummary) async {
    do {
      if selection == bot.id { conversation.disconnect() }
      try await catalog.delete(id: bot.id)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  // MARK: - Groups

  /// A group is only a name and a place in the sidebar; the daemon chooses its id.
  public func createGroup(title rawTitle: String) async {
    let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    do {
      _ = try await catalog.createGroup(title: title)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func renameGroup(_ id: String, to rawTitle: String) async {
    let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    do {
      _ = try await catalog.renameGroup(id: id, title: title)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// A refused delete (a group that still holds a bot) leaves the group where it is and
  /// puts the daemon's reason in `error`.
  public func deleteGroup(_ id: String) async {
    do {
      try await catalog.deleteGroup(id: id)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func reorderGroups(_ ids: [String]) async {
    do {
      groups = try await catalog.reorderGroups(ids: ids)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// The gateway's models, loaded once for the per-bot picker.
  @Published public private(set) var models: [String] = []

  public func loadModelsIfNeeded() async {
    guard models.isEmpty else { return }
    models = (try? await catalog.loadModels()) ?? []
  }

  /// The selected bot's own model and reasoning level.
  public func setAgent(model: String?, thinkingLevel: String?) async {
    guard let botId = selection else { return }
    do {
      _ = try await catalog.setAgent(id: botId, model: model, thinkingLevel: thinkingLevel)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// Runs one parked task of the selected bot again.
  public func retryTask(_ taskId: String) async {
    guard let botId = selection else { return }
    do {
      try await catalog.retryTask(bot: botId, task: taskId)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// Stops one live task of the selected bot.
  public func stopTask(_ taskId: String) async {
    guard let botId = selection else { return }
    do {
      try await catalog.abortTask(bot: botId, task: taskId)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  /// Files a bot; a nil group unfiles it. The group's own order is never touched.
  public func moveBot(_ id: String, toGroup groupId: String?) async {
    do {
      _ = try await catalog.moveBot(id: id, groupId: groupId)
      await reload()
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  public func select(_ botId: String) {
    if selection != botId, !exchanges.isEmpty { exchanges = [] }
    selection = botId
    conversation.select(botId: botId)
  }

  public func pendingOutbox(for botId: String) -> [OutboxEntry] {
    (try? outbox.entries(for: botId)) ?? []
  }

  public func dismissError() {
    error = nil
  }

  private func keepSelectionValid() {
    if let selection, !bots.contains(where: { $0.id == selection }) {
      self.selection = nil
      conversation.disconnect()
    }
    if selection == nil, let first = bots.first {
      select(first.id)
    }
  }

  private func describe(_ error: Error) -> String {
    if let client = error as? ClientError { return client.message }
    return error.localizedDescription
  }

  private func apply(_ catalog: BotCatalog) {
    bots = catalog.bots
    groups = catalog.groups
    keepSelectionValid()
  }

  /// A write is followed by a read: the daemon owns the ids, the order and the memberships.
  private func reload() async {
    do {
      apply(try await catalog.load())
    } catch {
      self.error = describe(error)
    }
  }
}

extension AppViewModel {
  /// One trigger's read-only detail for the inspector.
  public func triggerDetail(botId: String, triggerId: String) async throws -> TriggerDetail? {
    guard let triggers else { return nil }
    return try await triggers.list(botId: botId).first { $0.id == triggerId }
  }

  /// The person's only mutation. The daemon republishes the list, so the row follows.
  public func setTriggerEnabled(
    botId: String, triggerId: String, enabled: Bool
  ) async throws -> TriggerDetail? {
    guard let triggers else { return nil }
    return try await triggers.setEnabled(botId: botId, triggerId: triggerId, enabled: enabled)
  }

  /// Answers a secret card: the value crosses the wire once and the daemon keeps it out of
  /// the transcript.
  public func answerSecret(botId: String, answer: SecretAnswer) async throws {
    guard let secrets else { throw ClientError("这个客户端不能保存密码") }
    try await secrets.answerSecret(
      botId: botId,
      entryId: answer.entryId,
      callIndex: answer.callIndex,
      key: answer.key,
      value: answer.value,
      scope: answer.scope,
      ttlMinutes: answer.ttlMinutes,
      skipped: answer.skipped
    )
  }
}
