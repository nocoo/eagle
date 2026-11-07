import Combine
import Foundation
import SuperagentCore

public enum SuperagentConnection: Equatable, Sendable {
  case idle
  case connecting
  case ready
  case failed(String)
}

@MainActor
public final class SuperagentChatViewModel: ObservableObject {
  @Published public var draft = ""
  @Published public private(set) var state = ChatState()
  @Published public private(set) var connection: SuperagentConnection = .idle
  @Published public private(set) var error: String?
  @Published public private(set) var stopping = false
  @Published public private(set) var loadingOlder = false
  /// Sends whose durable admission was never confirmed. They keep their request identity
  /// until an explicit retry settles them.
  @Published public private(set) var unconfirmed: [PendingInput] = []
  /// One send at a time: a second tap while the first admission is unresolved must not
  /// mint a second identity for the same text.
  @Published public private(set) var sending = false

  private let port: SuperagentChatPort
  private let store: PendingInputStore
  private var generation = 0
  private var reader: Task<Void, Never>?

  public init(port: SuperagentChatPort, store: PendingInputStore) {
    self.port = port
    self.store = store
  }

  public var canLoadOlder: Bool {
    state.hasMore && state.nextBefore != nil && !loadingOlder
  }
  public var isRunning: Bool { state.snapshot.running }
  public var modelReady: Bool { state.snapshot.modelReady }
  public var pending: [QueuedInput] { state.snapshot.pending }
  public var failure: ServiceFailure? { state.snapshot.failure }

  public func connect() async {
    generation += 1
    let current = generation
    connection = .connecting
    error = nil
    state.reconnect()
    reader?.cancel()
    let stream: AsyncThrowingStream<SnapshotFrame, Error>
    do { stream = try await port.events() } catch {
      connection = .failed(message(error))
      self.error = message(error)
      return
    }
    guard generation == current else { return }
    connection = .ready
    let accept = { [weak self] (frame: SnapshotFrame) in
      guard let self, self.generation == current else { return }
      do { try self.state.accept(frame) } catch { self.error = self.message(error) }
    }
    reader = Task { [weak self] in
      do {
        for try await frame in stream {
          if Task.isCancelled { return }
          await MainActor.run { accept(frame) }
        }
      } catch {
        await MainActor.run {
          guard let self, self.generation == current else { return }
          self.connection = .failed(self.message(error))
          self.error = self.message(error)
        }
      }
    }
    await reconcile()
    await refreshUnconfirmed()
  }

  public func send() async {
    guard !sending else { return }
    if !unconfirmed.isEmpty {
      await retry()
      return
    }
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    let pending = PendingInput(text: text)
    sending = true
    defer { sending = false }
    do { try await store.save(pending) } catch {
      self.error = message(error)
      return
    }
    do {
      _ = try await port.submit(pending)
      try? await store.remove(pending.id)
      if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
    } catch {
      self.error = message(error)
    }
    await refreshUnconfirmed()
  }

  public func retry() async {
    guard let pending = try? await store.list(), !pending.isEmpty else {
      await refreshUnconfirmed()
      return
    }
    for input in pending {
      do {
        _ = try await port.submit(input)
        try? await store.remove(input.id)
      } catch {
        self.error = message(error)
        await refreshUnconfirmed()
        return
      }
    }
    if draft.trimmingCharacters(in: .whitespacesAndNewlines) == pending.first?.text,
      pending.count == 1
    {
      draft = ""
    }
    await refreshUnconfirmed()
  }

  private func refreshUnconfirmed() async {
    unconfirmed = (try? await store.list()) ?? []
  }

  public func reconcile() async {
    guard let pending = try? await store.list() else { return }
    for input in pending {
      guard (try? await port.submission(input.id)) != nil else { continue }
      try? await store.remove(input.id)
      if draft.trimmingCharacters(in: .whitespacesAndNewlines) == input.text {
        draft = ""
      }
    }
    await refreshUnconfirmed()
  }

  public func loadOlder() async {
    guard canLoadOlder, let before = state.nextBefore else { return }
    loadingOlder = true
    defer { loadingOlder = false }
    do {
      let page = try await port.history(before: before, limit: 100)
      try state.prepend(page, expectedBefore: before)
    } catch {
      self.error = message(error)
    }
  }

  public func stop() async {
    guard !stopping else { return }
    stopping = true
    defer { stopping = false }
    do { try await port.abort() } catch { self.error = message(error) }
  }

  public func dismissError() { error = nil }
  public func select(_ id: String) -> Bool { id == "superagent:main" }

  public func close() async {
    generation += 1
    reader?.cancel()
    reader = nil
    await port.close()
    connection = .idle
  }

  private func message(_ error: Error) -> String {
    (error as? SuperagentError)?.errorDescription ?? SuperagentError.unavailable.errorDescription
      ?? "Super Bot 服务不可用。"
  }
}
