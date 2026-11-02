import Foundation
import Testing

@testable import EagleFeatures

@Suite("Herdr inspector observation", .serialized)
@MainActor
struct HerdrTeamsViewModelTests {
  @Test("a failed refresh keeps the last observation, marks it stale, and can recover")
  func failedRefresh() async throws {
    let initial = try await LocalHerdrClient { arguments in
      Data(
        (arguments == ["session", "list", "--json"] ? herdrSessionFixture : herdrSnapshotFixture)
          .utf8)
    }.read()
    let recovered = HerdrTeamsSnapshot(teams: [], sessionCount: 1)
    var reads = 0
    let model = HerdrTeamsViewModel {
      reads += 1
      if reads == 2 { throw HerdrReadError.timeout }
      return reads == 1 ? initial : recovered
    }
    await model.refresh()
    let observed = try #require(model.updatedAt)
    #expect(model.snapshot == initial)
    #expect(!model.isStale && model.error == nil)
    await model.refresh()
    #expect(model.snapshot == initial)
    #expect(model.updatedAt == observed)
    #expect(model.isStale && model.error == .timeout)
    await model.refresh()
    #expect(model.snapshot == recovered)
    #expect(!model.isStale && model.error == nil)
  }

  @Test("a missing Herdr installation is not reported as zero teams")
  func notInstalled() async {
    let model = HerdrTeamsViewModel { throw HerdrReadError.notInstalled }
    await model.refresh()
    #expect(model.snapshot == nil && model.updatedAt == nil)
    #expect(model.error == .notInstalled && model.isStale)
  }

  @Test("manual refresh during a read does not launch another command")
  func overlappingRead() async {
    var reads = 0
    var release: CheckedContinuation<HerdrTeamsSnapshot, Never>?
    let model = HerdrTeamsViewModel {
      reads += 1
      return await withCheckedContinuation { release = $0 }
    }
    let first = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    await model.refresh()
    #expect(reads == 1)
    release?.resume(returning: HerdrTeamsSnapshot(teams: [], sessionCount: 1))
    await first.value
    #expect(model.snapshot?.sessionCount == 1)
  }

  @Test("a late reply from a cancelled observation cannot publish live state")
  func cancelledRefresh() async {
    var release: CheckedContinuation<HerdrTeamsSnapshot, Never>?
    let model = HerdrTeamsViewModel {
      await withCheckedContinuation { release = $0 }
    }
    let reading = Task { await model.refresh() }
    while release == nil { await Task.yield() }
    reading.cancel()
    release?.resume(returning: HerdrTeamsSnapshot(teams: [], sessionCount: 1))
    await reading.value
    #expect(model.snapshot == nil && model.updatedAt == nil)
    #expect(model.isStale && model.error == nil)
  }

  @Test("the visible inspector refreshes each tick and cancellation stops polling")
  func observationLifecycle() async {
    let clock = HerdrObservationClock()
    var reads = 0
    let model = HerdrTeamsViewModel(
      read: {
        reads += 1
        return HerdrTeamsSnapshot(teams: [], sessionCount: reads)
      }, observationWait: { try await clock.wait() })
    let observing = Task { await model.observe() }
    while clock.waiter == nil { await Task.yield() }
    #expect(reads == 1)
    clock.advance()
    while reads < 2 || clock.waiter == nil { await Task.yield() }
    #expect(reads == 2 && model.snapshot?.sessionCount == 2)
    observing.cancel()
    await observing.value
    #expect(clock.waiter == nil)
    #expect(reads == 2 && model.isStale)
  }
}

@MainActor private final class HerdrObservationClock {
  var waiter: CheckedContinuation<Void, any Error>?

  func wait() async throws {
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      try await withCheckedThrowingContinuation { waiter = $0 }
    } onCancel: {
      Task { @MainActor in
        let waiting = self.waiter
        self.waiter = nil
        waiting?.resume(throwing: CancellationError())
      }
    }
  }

  func advance() {
    let waiting = waiter
    waiter = nil
    waiting?.resume()
  }
}
