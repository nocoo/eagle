import XCTest

@testable import SuperagentCore
@testable import SuperagentTransport

final class ObservationMappingTests: XCTestCase {
  private func reply(_ provider: [String: Any], snapshot: Any? = nil) throws -> ObservationReply {
    let body: [String: Any] = ["provider": provider, "snapshot": snapshot ?? NSNull()]
    let data = try JSONSerialization.data(withJSONObject: body)
    return try JSONDecoder().decode(ObservationReply.self, from: data)
  }

  func testAReadySnapshotCountsVisibleAndUnknownBotsFromTheStoresThemselves() throws {
    let snapshot: [String: Any] = [
      "bots": [
        ["botId": "b_a", "store": ["state": "available"]],
        ["botId": "b_b", "store": ["state": "session_missing"]],
        ["botId": "b_c", "store": ["state": "schema_unsupported"]],
      ]
    ]
    let summary = ObservationSummary(
      reply: try reply(
        [
          "state": "ready", "reachable": true, "unavailable": 0,
          "lastReadAt": "2026-11-08T07:00:00Z",
        ],
        snapshot: snapshot))
    XCTAssertEqual(summary.state, .ready)
    XCTAssertEqual(summary.botsVisible, 1)
    XCTAssertEqual(summary.botsUnknown, 2)
    XCTAssertFalse(summary.isEmpty)
  }

  func testAnEmptySnapshotStaysUnknownRatherThanReadyWithZero() throws {
    let summary = ObservationSummary(
      reply: try reply(["state": "ready", "reachable": true, "unavailable": 0]))
    XCTAssertTrue(summary.isEmpty)
    XCTAssertEqual(summary.coverageLine, "尚未读取")
    XCTAssertEqual(summary.botsVisible, 0)
  }

  func testAnUnknownProviderStateDegradesToFailureInsteadOfTrust() throws {
    let summary = ObservationSummary(
      reply: try reply(["state": "something-new", "reachable": false, "unavailable": 0]))
    XCTAssertEqual(summary.state, .failure)
    XCTAssertEqual(summary.headline, "观测失败")
  }
}
