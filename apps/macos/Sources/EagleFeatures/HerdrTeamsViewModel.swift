import Foundation

@MainActor
public final class HerdrTeamsViewModel: ObservableObject {
  @Published public var isExpanded = false
  @Published public private(set) var snapshot: HerdrTeamsSnapshot?
  @Published public private(set) var error: HerdrReadError?
  @Published public private(set) var updatedAt: Date?
  @Published public private(set) var isStale = true
  private var reading = false
  private let read: @MainActor () async throws -> HerdrTeamsSnapshot
  private let wait: @MainActor () async throws -> Void

  public init(
    read: @escaping @MainActor () async throws -> HerdrTeamsSnapshot = {
      try await LocalHerdrClient().read()
    },
    observationWait: @escaping @MainActor () async throws -> Void = {
      try await Task.sleep(for: .seconds(5))
    }
  ) {
    self.read = read
    self.wait = observationWait
  }

  public func refresh() async {
    guard !reading else { return }
    reading = true
    defer { reading = false }
    do {
      let result = try await read()
      try Task.checkCancellation()
      if snapshot != result { snapshot = result }
      error = nil
      isStale = false
      updatedAt = Date()
    } catch is CancellationError {
      return
    } catch {
      self.error = error as? HerdrReadError ?? .unavailable
      isStale = true
    }
  }

  /// The inspector owns this task; disappearing cancels the read and the next tick.
  public func observe() async {
    isStale = true
    defer { isStale = true }
    while !Task.isCancelled {
      await refresh()
      do { try await wait() } catch { return }
    }
  }
}
