import Foundation

@MainActor
public final class HerdrTeamsViewModel: ObservableObject {
  @Published public var isExpanded = false
  @Published public var expandedTeamIDs: Set<String> = []
  @Published public var showsAllTeams = false
  @Published public private(set) var snapshot: HerdrTeamsSnapshot?
  @Published public private(set) var error: HerdrReadError?
  @Published public private(set) var updatedAt: Date?
  @Published public private(set) var isStale = true
  private var reading = false
  private let read: @MainActor () async throws -> HerdrTeamsSnapshot
  private let wait: @MainActor () async throws -> Void

  public var additionalTeamCount: Int { max(0, (snapshot?.teams.count ?? 0) - 5) }

  public var visibleTeams: [HerdrTeam] {
    let teams = (snapshot?.teams ?? []).enumerated().sorted { lhs, rhs in
      for status in [HerdrAgentStatus.working, .blocked] {
        let left = lhs.element.members.filter { $0.status == status }.count
        let right = rhs.element.members.filter { $0.status == status }.count
        if left != right { return left > right }
      }
      return lhs.offset < rhs.offset
    }.map(\.element)
    return showsAllTeams ? teams : Array(teams.prefix(5))
  }

  public init(
    read: @escaping @MainActor () async throws -> HerdrTeamsSnapshot = LocalHerdrClient().read,
    observationWait: @escaping @MainActor () async throws -> Void = {
      try await Task.sleep(for: .seconds(3))
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
      expandedTeamIDs.formIntersection(result.teams.map(\.id))
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
