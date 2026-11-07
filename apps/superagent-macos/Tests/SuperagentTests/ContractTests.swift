import Foundation
import SuperagentCore
import SuperagentTransport
import XCTest

final class ContractTests: XCTestCase {
  private var fixtures: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("fixtures/superagent-protocol")
  }
  private func data(_ name: String) throws -> Data {
    try Data(contentsOf: fixtures.appendingPathComponent(name))
  }
  private struct Vector: Decodable {
    var token: String
    var clientNonce: String
    var serverNonce: String
    var endpoint: String
    var rootBinding: String
    var instance: String
    var serverProof: String
    var clientProof: String
  }
  private struct Result<Value: Decodable>: Decodable {
    var type: String
    var id: String
    var value: Value
  }

  func testSharedAuthenticationVectorBindsEndpointAndBothNonces() throws {
    let vector = try JSONDecoder().decode(Vector.self, from: data("auth-vector.json"))
    XCTAssertEqual(
      IdentityProof.server(
        token: vector.token, clientNonce: vector.clientNonce,
        serverNonce: vector.serverNonce, endpoint: vector.endpoint, rootBinding: vector.rootBinding,
        instance: vector.instance), vector.serverProof)
    XCTAssertEqual(
      IdentityProof.client(
        token: vector.token, clientNonce: vector.clientNonce,
        serverNonce: vector.serverNonce, instance: vector.instance), vector.clientProof)
  }

  func testNormativeSnapshotsAndResultsDecodeWithoutWorkerTypes() throws {
    let decoder = JSONDecoder()
    let snapshot = try decoder.decode(SnapshotFrame.self, from: data("snapshot.server.json"))
    XCTAssertEqual(snapshot.value.messages.map(\.text), ["Hello Super Bot", "Hello"])
    XCTAssertEqual(snapshot.value.window.oldestEntryId, 10)
    let failure = try decoder.decode(SnapshotFrame.self, from: data("failure.server.json"))
    XCTAssertEqual(failure.value.failure?.code, .modelAuthentication)
    XCTAssertEqual(
      try decoder.decode(ServiceHealth.self, from: data("health.server.json")).failure?.code,
      .storageFailed)
    for (name, status) in [
      ("queued", ChatAdmission.Status.queued), ("done", .done), ("unanswered", .unanswered),
    ] {
      XCTAssertEqual(
        try decoder.decode(Result<ChatAdmission>.self, from: data("\(name).server.json")).value
          .status, status)
    }
    let partial = try decoder.decode(
      Result<HistoryPage>.self, from: data("history.partial.server.json"))
    XCTAssertEqual(partial.value.coverage, "partial")
    XCTAssertFalse(partial.value.hasMore)
    let state = try decoder.decode(Result<SnapshotFrame>.self, from: data("state.server.json"))
    XCTAssertEqual(state.value, snapshot)
  }

  func testReducerReplacesCurrentWindowRejectsStaleRevisionAndInvalidatesHistoryOnReconnect() throws
  {
    let frame = try JSONDecoder().decode(SnapshotFrame.self, from: data("snapshot.server.json"))
    var state = ChatState()
    XCTAssertTrue(try state.accept(frame))
    XCTAssertEqual(state.messages.count, 2)
    XCTAssertFalse(try state.accept(frame))
    try state.prepend(
      HistoryPage(
        messages: [ChatMessage(id: "e_5", role: .user, text: "older")], hasMore: false,
        coverage: "complete"), expectedBefore: 10)
    XCTAssertEqual(state.messages.map(\.id), ["e_5", "e_10", "e_12"])
    state.reconnect()
    XCTAssertTrue(try state.accept(frame))
    XCTAssertEqual(state.messages.map(\.id), ["e_10", "e_12"])
    var newer = frame
    newer.rev = 2
    newer.value.window.oldestEntryId = 12
    newer.value.messages.removeFirst()
    XCTAssertTrue(try state.accept(newer))
    XCTAssertEqual(state.messages.map(\.id), ["e_12"])
    try state.prepend(
      HistoryPage(
        messages: [ChatMessage(id: "e_5", role: .user, text: "stale")], hasMore: false,
        coverage: "complete"), expectedBefore: 10)
    XCTAssertEqual(state.messages.map(\.id), ["e_12"])
  }
}
