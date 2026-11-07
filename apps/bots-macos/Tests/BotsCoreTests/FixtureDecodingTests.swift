import BotsCore
import BotsTransport
import XCTest

/// Rows 55-58, 60: every committed fixture decodes, and the reducer folds the transcript
/// the way the daemon's own fold does.
final class FixtureDecodingTests: XCTestCase {
  static var fixtures: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("fixtures/bots-protocol", isDirectory: true)
  }

  private static let serverFixtures = [
    "welcome.server.json",
    "snapshot.server.json",
    "snapshot-files.server.json",
    "snapshot-files.server.json",
    "snapshot.streaming.server.json",
    "snapshot.unavailable.server.json",
    "append.server.json",
    "append-files.server.json",
    "append.streaming.server.json",
    "append.finalize.server.json",
    "append.tool.server.json",
    "append.tool-result.server.json",
    "snapshot.tools.server.json",
    "delta.server.json",
    "history.server.json",
    "history-files.server.json",
    "history-files.server.json",
    "status.server.json",
    "submission.server.json",
    "submission.connection.server.json",
    "bots.server.json",
    "agent.server.json",
    "triggers.server.json",
    "error.server.json",
    "error-rejected.server.json",
    "version-mismatch.server.json",
    "pong.server.json",
  ]

  func testEveryServerFixtureDecodes() throws {
    for name in Self.serverFixtures {
      let url = Self.fixtures.appendingPathComponent(name)
      let data = try Data(contentsOf: url)
      XCTAssertNoThrow(try Wire.decode(data), "\(name) must decode")
    }
  }

  func testMessageFilesDecodeForAnyRoleAndIgnoreUnknownRefFields() throws {
    let data = try Data(
      contentsOf: Self.fixtures.appendingPathComponent("append-files.server.json")
    )
    let decoded = try Wire.decode(data)
    guard case .append(let message, _) = decoded.event else {
      return XCTFail("expected an append")
    }
    XCTAssertEqual(message.files?.count, 1)
    XCTAssertEqual(message.files?.first?.name, "report.pdf")

    let toolData = try JSONSerialization.data(withJSONObject: [
      "id": "e_tool",
      "role": "tool",
      "state": "complete",
      "createdAt": "2026-11-07T00:00:00Z",
      "blocks": [
        ["type": "toolResult", "callId": "c1", "name": "read", "text": "ok", "isError": false]
      ],
      "files": [
        [
          "id": "f_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "name": "result.txt",
          "mimeType": "text/plain",
          "size": 42,
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "path": "/must-not-be-decoded",
        ]
      ],
    ])
    let tool = try JSONDecoder().decode(Message.self, from: toolData)
    XCTAssertEqual(tool.files?.first?.name, "result.txt")
    XCTAssertFalse(tool.files?.first?.id.isEmpty == true)
  }

  func testFilesAreAdditiveInSendAndWelcomeWithoutDroppingOldFrames() throws {
    let fileId = "f_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    let sent = try Wire.send(
      requestId: "r_attach_0001",
      text: "请读取附件",
      whenBusy: .followUp,
      trace: "tr_attach_0001",
      fileIds: [fileId]
    )
    let encoded = try JSONSerialization.jsonObject(with: sent) as? [String: Any]
    XCTAssertEqual(encoded?["fileIds"] as? [String], [fileId])

    let oldWelcome = try JSONSerialization.data(withJSONObject: [
      "type": "welcome",
      "protocolVersion": 1,
      "server": ["version": "0.1.0", "instance": "i_test", "pid": 1],
      "capabilities": [
        "agent": false, "tools": true, "tasks": false, "entries": false,
        "usage": false, "peers": false, "triggers": true,
      ],
      "bots": [],
    ])
    let oldDecoded = try Wire.decode(oldWelcome)
    XCTAssertFalse(oldDecoded.supportsFiles)

    let newWelcome = try JSONSerialization.data(withJSONObject: [
      "type": "welcome",
      "protocolVersion": 1,
      "server": ["version": "0.1.0", "instance": "i_test", "pid": 1],
      "capabilities": [
        "agent": false, "tools": true, "tasks": false, "entries": false,
        "usage": false, "peers": false, "triggers": true, "files": true,
      ],
      "bots": [],
    ])
    let newDecoded = try Wire.decode(newWelcome)
    XCTAssertTrue(newDecoded.supportsFiles)
  }

  func testTheAgentFixtureReachesTheConversation() throws {
    let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("agent.server.json"))
    let decoded = try Wire.decode(data)
    XCTAssertEqual(decoded.type, "agent")
    XCTAssertEqual(decoded.rev, 45)
    guard case .agent(let agent) = decoded.event else {
      return XCTFail("a configuration update must reach the current conversation")
    }
    XCTAssertEqual(agent.model.modelId, "faux-1")
    XCTAssertEqual(agent.thinkingLevel, "high")
    XCTAssertEqual(agent.instructions, "Keep the conversation intact.")
  }

  func testTheSnapshotCarriesItsTranscript() throws {
    let data = try Data(
      contentsOf: Self.fixtures.appendingPathComponent("snapshot.server.json")
    )
    let decoded = try Wire.decode(data)
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.botId, "b_0190a1b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b")
    XCTAssertEqual(snapshot.messages.map(\.role), [.user, .assistant])
    XCTAssertEqual(snapshot.messages.first?.requestId, "r_0190a1b4-5061-7c72-8d3e-4f5061728394")
    XCTAssertEqual(snapshot.messages.last?.text, "巴黎。")
    XCTAssertEqual(snapshot.running, false)
    XCTAssertEqual(decoded.rev, 42)
  }

  func testTheToolSnapshotCarriesCallsAndTheirResults() throws {
    let data = try Data(
      contentsOf: Self.fixtures.appendingPathComponent("snapshot.tools.server.json")
    )
    let decoded = try Wire.decode(data)
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.messages.map(\.role), [.user, .assistant, .tool, .assistant])
    let call = snapshot.messages[1].blocks[1]
    guard case .toolCall(let callId, let name, let args) = call else {
      return XCTFail("the assistant carries its tool call")
    }
    XCTAssertEqual(name, "list_files")
    XCTAssertEqual(args["path"], .string("."))
    XCTAssertEqual(args["limit"], .number(50))
    let result = snapshot.messages[2].blocks[0]
    guard
      case .toolResult(let resultCallId, let resultName, let text, let isError, let durationMs) =
        result
    else {
      return XCTFail("the tool row carries its result")
    }
    XCTAssertEqual(resultCallId, callId)
    XCTAssertEqual(resultName, name)
    XCTAssertEqual(text, "README.md\nsrc/\nsrc/index.ts")
    XCTAssertFalse(isError)
    XCTAssertEqual(durationMs, 21)
  }

  func testTheStreamingSnapshotNamesItsAttempt() throws {
    let data = try Data(
      contentsOf: Self.fixtures.appendingPathComponent("snapshot.streaming.server.json")
    )
    let decoded = try Wire.decode(data)
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.streaming, "p_a2")
    XCTAssertTrue(snapshot.running)
    XCTAssertEqual(snapshot.messages.last?.state, .streaming)
  }

  func testTheUnavailableSnapshotIsEmptyAndReasoned() throws {
    let data = try Data(
      contentsOf: Self.fixtures.appendingPathComponent("snapshot.unavailable.server.json")
    )
    let decoded = try Wire.decode(data)
    guard case .snapshot(let snapshot) = decoded.event else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertTrue(snapshot.messages.isEmpty)
    XCTAssertTrue(snapshot.pending.isEmpty)
    XCTAssertEqual(snapshot.unavailable?.reason, .storageFailed)
    XCTAssertEqual(snapshot.streaming, nil)
  }

  func testADeltaKeepsEveryChangeInOrder() throws {
    let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("delta.server.json"))
    let decoded = try Wire.decode(data)
    guard case .delta(let messageId, let changes) = decoded.event else {
      return XCTFail("expected a delta")
    }
    XCTAssertEqual(messageId, "p_a2")
    XCTAssertEqual(changes.count, 3)
    guard case .text(0, let appended) = changes[0] else {
      return XCTFail("the first change is a text append")
    }
    XCTAssertEqual(appended, "首都")
    guard case .block(0, let block) = changes[1] else {
      return XCTFail("the second change is a block")
    }
    XCTAssertEqual(block, .text("巴黎是法国的首都"))
    guard case .message(let message) = changes[2] else {
      return XCTFail("the third change is a message")
    }
    XCTAssertEqual(message.state, .streaming)
  }

  func testTheConnectionScopedSubmissionHasNoRevision() throws {
    let data = try Data(
      contentsOf: Self.fixtures.appendingPathComponent("submission.connection.server.json")
    )
    let decoded = try Wire.decode(data)
    guard case .submission(let record) = decoded.event else {
      return XCTFail("expected a submission")
    }
    XCTAssertEqual(decoded.rev, nil, "a reply carries no revision, so it is not a gap")
    XCTAssertEqual(record.requestId, "r_0190a1b4-5061-7c72-8d3e-4f5061728394")
  }

  func testRefusedAndRuntimeErrorsDifferOnlyInDisposition() throws {
    let rejected = try Wire.decode(
      Data(contentsOf: Self.fixtures.appendingPathComponent("error-rejected.server.json"))
    )
    guard case .error(_, let disposition, _, let failure, _) = rejected.event else {
      return XCTFail("expected an error")
    }
    XCTAssertEqual(disposition, .notAdmitted)
    XCTAssertEqual(failure, "f_91c2")

    let runtime = try Wire.decode(
      Data(contentsOf: Self.fixtures.appendingPathComponent("error.server.json"))
    )
    guard case .error(_, let runtimeDisposition, _, _, _) = runtime.event else {
      return XCTFail("expected an error")
    }
    XCTAssertEqual(runtimeDisposition, .runtime)
  }

  func testTheAppearanceSetsMatchTheContract() {
    // The picker and the daemon share closed sets; a shape the client cannot decode makes
    // the whole catalog unreadable, so the counts and ids are asserted together.
    XCTAssertEqual(BotAppearance.Shape.allCases.count, 10)
    XCTAssertEqual(
      Set(BotAppearance.Shape.allCases.map(\.rawValue)),
      ["blob", "pebble", "squircle", "star", "cloud", "shield", "drop", "hex", "heart", "flower"]
    )
    XCTAssertEqual(BotAppearance.Tint.allCases.count, 12)
    for shape in BotAppearance.Shape.allCases {
      let json = """
        {"id":"b_1","title":"一","createdAt":"x","updatedAt":"x",
         "model":{"provider":"p","modelId":"m"},"state":"idle",
         "appearance":{"shape":"\(shape.rawValue)","tint":"green"}}
        """
      let bot = try? JSONDecoder().decode(BotSummary.self, from: Data(json.utf8))
      XCTAssertEqual(bot?.face.shape, shape, "\(shape.rawValue) must decode")
    }
  }

  func testACommandCarriesItsTraceAndIdentity() throws {
    let hello = try Wire.decodeEnvelopeForTests(Wire.hello())
    XCTAssertEqual(hello["type"] as? String, "hello")
    XCTAssertEqual(hello["protocolVersion"] as? Int, 1)

    let requestId = Identifiers.request()
    let send = try Wire.decodeEnvelopeForTests(
      Wire.send(requestId: requestId, text: "hi", whenBusy: .followUp, trace: "tr_test_1")
    )
    XCTAssertEqual(send["type"] as? String, "send")
    XCTAssertEqual(send["requestId"] as? String, requestId)
    XCTAssertEqual(send["trace"] as? String, "tr_test_1")

    for command in [
      try Wire.abort(trace: "tr_test_2"),
      try Wire.recover(trace: "tr_test_3"),
      try Wire.resync(trace: "tr_test_4"),
      try Wire.history(before: "e_7", limit: 50, trace: "tr_test_5"),
    ] {
      let object = try Wire.decodeEnvelopeForTests(command)
      XCTAssertNotNil(object["trace"] as? String)
    }
  }
}

extension Wire {
  static func decodeEnvelopeForTests(_ data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ClientError("not an object")
    }
    return object
  }
}
