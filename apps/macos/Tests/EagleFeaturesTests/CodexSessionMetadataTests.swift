import Foundation
import Testing

@testable import EagleFeatures

@Suite("Herdr member model metadata")
struct CodexSessionMetadataTests {
  @Test("the exact session supplies model, effort and recorded context capacity")
  func recordedMetadata() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(fixture.header + fixture.turn + fixture.window)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    let expected = HerdrAgentMetadata(
      model: "gpt-6-astra", reasoningEffort: "max", contextWindow: 257_400)
    #expect(await reader.read(sessionID: fixture.id) == expected)
    #expect(await reader.read(sessionID: fixture.id) == expected)
    #expect(await reader.read(sessionID: UUID().uuidString) == HerdrAgentMetadata())
    #expect(await reader.read(sessionID: "../../outside") == HerdrAgentMetadata())
  }

  @Test("appends, partial records and model changes do not mix settings from different turns")
  func changingSession() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(fixture.header + fixture.turn + fixture.window)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    _ = await reader.read(sessionID: fixture.id)
    let next =
      #"{"type":"turn_context","payload":{"turn_id":"turn-2","model":"gpt-6.1-sol","reasoning_effort":"xhigh"}}"#
    try fixture.append(next)
    #expect(await reader.read(sessionID: fixture.id).model == "gpt-6-astra")
    try fixture.append("\n")
    #expect(
      await reader.read(sessionID: fixture.id)
        == HerdrAgentMetadata(model: "gpt-6.1-sol", reasoningEffort: "xhigh"))
    try fixture.append(fixture.window.replacingOccurrences(of: "turn-1", with: "turn-2"))
    #expect(await reader.read(sessionID: fixture.id).contextWindow == 257_400)
    try fixture.append(#"{"type":"turn_context","payload":{"model":"another-model"}}"# + "\n")
    #expect(
      await reader.read(sessionID: fixture.id) == HerdrAgentMetadata(model: "another-model"))
  }

  @Test("turn boundaries never mix models with another turn's context window")
  func turnBoundaries() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    let startA =
      #"{"type":"event_msg","payload":{"type":"task_started","turn_id":"a","model_context_window":100000}}"#
      + "\n"
    let contextA =
      #"{"type":"turn_context","payload":{"turn_id":"a","model":"model-a","effort":"high"}}"# + "\n"
    let startB =
      #"{"type":"event_msg","payload":{"type":"task_started","turn_id":"b","model_context_window":200000}}"#
      + "\n"
    let contextB =
      #"{"type":"turn_context","payload":{"turn_id":"b","model":"model-b","effort":"xhigh"}}"#
      + "\n"
    try fixture.write(fixture.header + startA)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata(contextWindow: 100_000))
    try fixture.append(contextA)
    #expect(
      await reader.read(sessionID: fixture.id)
        == HerdrAgentMetadata(model: "model-a", reasoningEffort: "high", contextWindow: 100_000))
    try fixture.append(startB)
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata(contextWindow: 200_000))
    try fixture.append(contextB)
    #expect(
      await reader.read(sessionID: fixture.id)
        == HerdrAgentMetadata(model: "model-b", reasoningEffort: "xhigh", contextWindow: 200_000))
    try fixture.append(
      #"{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":300000}}}"#
        + "\n")
    #expect(
      await reader.read(sessionID: fixture.id)
        == HerdrAgentMetadata(model: "model-b", reasoningEffort: "xhigh", contextWindow: 200_000))
    try fixture.append(
      #"{"type":"event_msg","payload":{"type":"task_started","turn_id":"c"}}"# + "\n")
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata())
  }

  @Test("turn identities are not normalized into another turn")
  func distinctTurnIDs() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    let start =
      #"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-a ","model_context_window":100000}}"#
      + "\n"
    let context =
      #"{"type":"turn_context","payload":{"turn_id":"turn-a","model":"model-b"}}"# + "\n"
    try fixture.write(fixture.header + start)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    _ = await reader.read(sessionID: fixture.id)
    try fixture.append(context)
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata(model: "model-b"))
  }

  @Test("a large transcript is bounded while recent metadata beyond a small tail remains readable")
  func largeTranscript() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(
      fixture.header + String(repeating: "unrelated output\n", count: 700_000)
        + fixture.turn + String(repeating: "unrelated output\n", count: 350_000)
        + fixture.window)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    #expect(
      await reader.read(sessionID: fixture.id)
        == HerdrAgentMetadata(
          model: "gpt-6-astra", reasoningEffort: "max", contextWindow: 257_400))
  }

  @Test("malformed optional fields cannot leave a previous model displayed")
  func malformedNewTurn() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(fixture.header + fixture.turn + fixture.window)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    _ = await reader.read(sessionID: fixture.id)
    try fixture.append(
      #"{"type":"turn_context","payload":{"model":"new-model","effort":42,"model_context_window":true}}"#
        + "\n")
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata(model: "new-model"))
  }

  @Test("an in-place rewrite of the same length refreshes cached settings")
  func sameLengthRewrite() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    let original = fixture.header + fixture.turn + fixture.window
    try fixture.write(original)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    _ = await reader.read(sessionID: fixture.id)
    let rewritten = original.replacingOccurrences(of: "gpt-6-astra", with: "gpt-6-other")
    #expect(rewritten.utf8.count == original.utf8.count)
    let handle = try FileHandle(forWritingTo: fixture.file)
    try handle.write(contentsOf: Data(rewritten.utf8))
    try handle.close()
    try FileManager.default.setAttributes(
      [.modificationDate: Date().addingTimeInterval(2)], ofItemAtPath: fixture.file.path)
    #expect(await reader.read(sessionID: fixture.id).model == "gpt-6-other")
  }

  @Test("a replay gap and a replaced symlink never retain stale settings")
  func replayGapAndSymlink() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(fixture.header + fixture.turn + fixture.window)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    _ = await reader.read(sessionID: fixture.id)
    try fixture.append(
      #"{"type":"turn_context","payload":{"model":"changed-during-gap"}}"# + "\n"
        + String(repeating: "unrelated output\n", count: 600_000) + fixture.window)
    #expect(
      await reader.read(sessionID: fixture.id) == HerdrAgentMetadata(contextWindow: 257_400))
    let other = try MetadataLogFixture()
    defer { other.remove() }
    try other.write(other.header + other.turn)
    try FileManager.default.removeItem(at: fixture.file)
    try FileManager.default.createSymbolicLink(at: fixture.file, withDestinationURL: other.file)
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata())
  }

  @Test("foreign, ambiguous, deleted and replaced logs never reuse another occupant's metadata")
  func identityAndReplacement() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(fixture.header + fixture.turn)
    let reader = CodexSessionMetadataReader(root: fixture.root)
    #expect(await reader.read(sessionID: fixture.id).model == "gpt-6-astra")
    try fixture.write(
      fixture.header + #"{"type":"turn_context","payload":{"model":"replacement"}}"# + "\n")
    #expect(await reader.read(sessionID: fixture.id).model == "replacement")
    try fixture.write(
      fixture.header.replacingOccurrences(of: fixture.id, with: UUID().uuidString)
        + fixture.turn)
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata())
    try fixture.write(fixture.header + fixture.turn)
    let duplicate = fixture.root.appendingPathComponent("rollout-duplicate-\(fixture.id).jsonl")
    try FileManager.default.copyItem(at: fixture.file, to: duplicate)
    #expect(
      await CodexSessionMetadataReader(root: fixture.root).read(sessionID: fixture.id)
        == HerdrAgentMetadata())
    try FileManager.default.removeItem(at: fixture.file)
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata())
  }

  @Test("missing or malformed metadata stays unknown and collaboration settings remain supported")
  func incompleteMetadata() async throws {
    let fixture = try MetadataLogFixture()
    defer { fixture.remove() }
    try fixture.write(
      fixture.header + "not-json\n"
        + #"{"type":"turn_context","payload":{"turn_id":"turn-3","model":"recorded","collaboration_mode":{"settings":{"reasoning_effort":"high"}}}}"#
        + "\n"
        + #"{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":-1}}}"#
        + "\n")
    let reader = CodexSessionMetadataReader(root: fixture.root)
    #expect(
      await reader.read(sessionID: fixture.id)
        == HerdrAgentMetadata(model: "recorded", reasoningEffort: "high"))
    try fixture.append(
      #"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3","model_context_window":1000000}}"#
        + "\n")
    #expect(await reader.read(sessionID: fixture.id).contextWindow == 1_000_000)
    try fixture.append(#"{"type":"turn_context","payload":{"model":"","effort":""}}"# + "\n")
    #expect(await reader.read(sessionID: fixture.id) == HerdrAgentMetadata())
  }
}

struct MetadataLogFixture {
  let root: URL
  let id = "11111111-1111-4111-8111-111111111111"
  var file: URL { root.appendingPathComponent("2026/11/02/rollout-test-\(id).jsonl") }
  var header: String { #"{"type":"session_meta","payload":{"id":""# + id + #""}}"# + "\n" }
  let turn =
    #"{"type":"turn_context","payload":{"turn_id":"turn-1","model":"gpt-6-astra","effort":"max"}}"#
    + "\n"
  let window =
    #"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1","model_context_window":257400}}"#
    + "\n"

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
  }

  func write(_ text: String) throws { try Data(text.utf8).write(to: file, options: .atomic) }
  func append(_ text: String) throws {
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(text.utf8))
  }
  func remove() { try? FileManager.default.removeItem(at: root) }
}
