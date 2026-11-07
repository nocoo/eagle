import XCTest

@testable import SuperagentCore
@testable import SuperagentFeatures

@MainActor
final class ObservationViewModelTests: XCTestCase {
  private final class StubPort: SuperagentObservationPort, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<ObservationSummary, Error>] = []
    private(set) var calls = 0

    func push(_ result: Result<ObservationSummary, Error>) {
      lock.lock()
      defer { lock.unlock() }
      results.append(result)
    }

    func observation() async throws -> ObservationSummary {
      lock.lock()
      calls += 1
      let next = results.isEmpty ? nil : results.removeFirst()
      lock.unlock()
      switch next {
      case .success(let summary): return summary
      case .failure(let error): throw error
      case nil: return .unconfigured
      }
    }
  }

  private struct Boom: Error {}

  private func ready(visible: Int = 2, unknown: Int = 1) -> ObservationSummary {
    ObservationSummary(
      state: .ready, reachable: true, botsVisible: visible, botsUnknown: unknown,
      lastReadAt: "2026-11-08T07:00:00.000Z", isEmpty: false)
  }

  func testTheSurfaceStartsUnknownRatherThanZero() {
    let model = SuperagentObservationViewModel(port: StubPort())
    XCTAssertEqual(model.phase, .idle)
    XCTAssertEqual(model.summary.state, .unconfigured)
    XCTAssertEqual(model.summary.coverageLine, "未连接 worker 观测")
    XCTAssertTrue(model.summary.isEmpty)
  }

  func testARefreshReportsWhatTheProviderActuallySaw() async {
    let port = StubPort()
    port.push(.success(ready()))
    let model = SuperagentObservationViewModel(port: port)
    await model.refresh()
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(model.summary.botsVisible, 2)
    XCTAssertEqual(model.summary.botsUnknown, 1)
    XCTAssertEqual(model.summary.coverageLine, "可见 2 · 未知 1")
    XCTAssertFalse(model.isReading)
  }

  func testAnUnavailableProviderIsVisibleAsItsReason() async {
    let port = StubPort()
    port.push(
      .success(ObservationSummary(state: .refused, reachable: false, detail: "credential_kind")))
    let model = SuperagentObservationViewModel(port: port)
    await model.refresh()
    XCTAssertEqual(model.phase, .failed)
    XCTAssertEqual(model.summary.state, .refused)
    XCTAssertEqual(model.summary.headline, "观测凭据被拒绝")
  }

  func testAThrowingPortBecomesUnreachableWithoutAFabricatedCount() async {
    let port = StubPort()
    port.push(.failure(Boom()))
    let model = SuperagentObservationViewModel(port: port)
    await model.refresh()
    XCTAssertEqual(model.phase, .failed)
    XCTAssertEqual(model.summary.state, .unreachable)
    XCTAssertTrue(model.summary.isEmpty)
    XCTAssertEqual(model.summary.botsVisible, 0)
  }

  func testALateResultNeverOverwritesANewerRefresh() async {
    let port = StubPort()
    port.push(
      .success(
        ObservationSummary(
          state: .ready, reachable: true, botsVisible: 1, botsUnknown: 0, isEmpty: false)))
    port.push(
      .success(
        ObservationSummary(
          state: .ready, reachable: true, botsVisible: 9, botsUnknown: 0, isEmpty: false)))
    let model = SuperagentObservationViewModel(port: port)
    async let first: Void = model.refresh()
    async let second: Void = model.refresh()
    _ = await (first, second)
    XCTAssertEqual(model.phase, .ready)
    XCTAssertTrue(
      [1, 9].contains(model.summary.botsVisible), "one of the two reads won, never a mix")
    XCTAssertEqual(port.calls, 2)
  }

  func testResetStateIsVisibleAndNotTreatedAsReady() async {
    let port = StubPort()
    port.push(
      .success(ObservationSummary(state: .reset, reachable: true, detail: "cursor_reset")))
    let model = SuperagentObservationViewModel(port: port)
    await model.refresh()
    XCTAssertEqual(model.phase, .failed)
    XCTAssertEqual(model.summary.headline, "观测基线已重置")
    XCTAssertEqual(model.summary.detail, "cursor_reset")
  }
}
