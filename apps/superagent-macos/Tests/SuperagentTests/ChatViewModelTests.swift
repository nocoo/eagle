import Foundation
import SuperagentCore
import SuperagentFeatures
import XCTest

actor FakePort: SuperagentChatPort {
  var frames: [SnapshotFrame] = []
  var sent: [PendingInput] = []
  var records: [String: ChatAdmission] = [:]
  var submitError: SuperagentError?
  var eventsError: SuperagentError?
  var historyError: SuperagentError?
  var abortError: SuperagentError?
  var pages: [HistoryPage] = []
  var closed = false
  private var continuation: AsyncThrowingStream<SnapshotFrame, Error>.Continuation?

  func queue(_ frame: SnapshotFrame) {
    frames.append(frame)
    continuation?.yield(frame)
  }
  func failStream() { continuation?.finish(throwing: SuperagentError.unavailable) }

  func events() async throws -> AsyncThrowingStream<SnapshotFrame, Error> {
    if let eventsError { throw eventsError }
    return AsyncThrowingStream { continuation in
      self.continuation = continuation
      for frame in frames { continuation.yield(frame) }
    }
  }
  func state() async throws -> SnapshotFrame {
    guard let last = frames.last else { throw SuperagentError.unavailable }
    return last
  }
  func configure(_ value: ConfigurationChange) async throws -> ModelConfiguration {
    ModelConfiguration(
      baseUrl: value.baseUrl, model: value.model, thinkingLevel: value.thinkingLevel,
      hasApiKey: true)
  }
  func submit(_ input: PendingInput) async throws -> ChatAdmission {
    if let submitError { throw submitError }
    sent.append(input)
    let record = ChatAdmission(id: "s_1", requestId: input.id, status: .queued)
    records[input.id] = record
    return record
  }
  func submission(_ requestId: String) async throws -> ChatAdmission? { records[requestId] }
  func history(before: Int?, limit: Int) async throws -> HistoryPage {
    if let historyError { throw historyError }
    return pages.isEmpty
      ? HistoryPage(messages: [], hasMore: false, coverage: "complete") : pages.removeFirst()
  }
  func abort() async throws { if let abortError { throw abortError } }
  func close() async { closed = true }
}

actor MemoryStore: PendingInputStore {
  var values: [PendingInput] = []
  var failSave = false
  func setFailSave(_ value: Bool) { failSave = value }
  func save(_ input: PendingInput) async throws {
    if failSave { throw SuperagentError.storage }
    if !values.contains(where: { $0.id == input.id }) { values.append(input) }
  }
  func list() async throws -> [PendingInput] { values }
  func remove(_ id: String) async throws { values.removeAll { $0.id == id } }
}

@MainActor
final class ChatViewModelTests: XCTestCase {
  private func frame(
    rev: Int, instance: String = "11111111-1111-4111-8111-111111111111",
    messages: [ChatMessage] = [], pending: [QueuedInput] = [], running: Bool = false,
    hasOlder: Bool = false
  ) -> SnapshotFrame {
    SnapshotFrame(
      instance: instance, rev: rev,
      value: ChatSnapshot(
        messages: messages, running: running,
        window: ChatWindow(
          oldestEntryId: messages.compactMap { Int($0.id.dropFirst(2)) }.first,
          newestEntryId: messages.compactMap { Int($0.id.dropFirst(2)) }.last,
          hasOlder: hasOlder)))
  }

  func testConnectAcceptsSnapshotAndLateFrameAfterCloseIsIgnored() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    await port.queue(
      frame(rev: 2, messages: [ChatMessage(id: "e_1", role: .assistant, text: "hi")]))
    await wait { model.state.messages.count == 1 }
    await model.close()
    await port.queue(
      frame(rev: 3, messages: [ChatMessage(id: "e_2", role: .assistant, text: "late")]))
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(model.state.messages.map(\.id), ["e_1"])
    let closed = await port.closed
    XCTAssertTrue(closed)
  }

  func testSendPersistsBeforeAdmissionAndRemovesAfterConfirmation() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    model.draft = "hello"
    await model.send()
    let sent = await port.sent
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(model.draft, "")
    let remaining = await store.values.count
    XCTAssertEqual(remaining, 0)
  }

  func testRejectedSendKeepsOneDraftAndRetryReusesTheSameRequestId() async throws {
    let port = FakePort()
    let store = MemoryStore()
    await port.setSubmitError(.service(.unconfigured))
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    model.draft = "hello"
    await model.send()
    XCTAssertEqual(model.draft, "hello")
    XCTAssertEqual(model.error, SuperagentError.service(.unconfigured).errorDescription)
    let pending = await store.values
    XCTAssertEqual(pending.count, 1)
    await port.setSubmitError(nil)
    await model.retry()
    let sent = await port.sent
    XCTAssertEqual(sent.map(\.id), [pending[0].id])
    let remaining = await store.values.count
    XCTAssertEqual(remaining, 0)
  }

  func testReconnectQueriesButDoesNotResubmitPreviouslyAdmittedInput() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    model.draft = "first"
    await model.send()
    let id = (await port.sent)[0].id
    await model.close()
    await port.queue(frame(rev: 4))
    await model.connect()
    await model.reconcile()
    let sent = await port.sent
    XCTAssertEqual(sent.count, 1)
    let stored = await store.values.count
    XCTAssertEqual(stored, 0)
  }

  func testConfirmedReconnectRemovesThePendingEntry() async throws {
    let port = FakePort()
    let store = MemoryStore()
    try await store.save(PendingInput(id: "r_confirmed", text: "done already"))
    await port.setRecord(
      ChatAdmission(id: "s_1", requestId: "r_confirmed", status: .done, answer: "yes"))
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    await model.reconcile()
    let remaining = await store.values.count
    XCTAssertEqual(remaining, 0)
    let sent = await port.sent
    XCTAssertEqual(sent.count, 0)
  }

  func testLoadOlderPrependsOnceAndStopsAtTheEnd() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    await port.queue(
      frame(
        rev: 2,
        messages: [ChatMessage(id: "e_10", role: .assistant, text: "new")],
        hasOlder: true))
    await wait { model.state.messages.count == 1 }
    await port.setPages([
      HistoryPage(
        messages: [ChatMessage(id: "e_5", role: .assistant, text: "old")], hasMore: false,
        coverage: "complete")
    ])
    await model.loadOlder()
    XCTAssertEqual(model.state.messages.first?.id, "e_5")
    XCTAssertEqual(model.state.messages.count, 2)
    XCTAssertFalse(model.canLoadOlder)
    await model.loadOlder()
    XCTAssertEqual(model.state.messages.count, 2)
  }

  func testStopReportsUnconfirmedWithoutPretendingItSucceeded() async throws {
    let port = FakePort()
    let store = MemoryStore()
    await port.setAbortError(.service(.cancellationUnconfirmed))
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    await model.stop()
    XCTAssertEqual(model.error, SuperagentError.service(.cancellationUnconfirmed).errorDescription)
    XCTAssertFalse(model.stopping)
  }

  private func wait(_ condition: @escaping @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      if condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("condition did not become true")
  }
}

extension FakePort {
  func setEventsError(_ error: SuperagentError?) { eventsError = error }
  func setHistoryError(_ error: SuperagentError?) { historyError = error }
  func setSubmitError(_ error: SuperagentError?) { submitError = error }
  func setAbortError(_ error: SuperagentError?) { abortError = error }
  func setRecord(_ record: ChatAdmission) { records[record.requestId] = record }
  func setPages(_ pages: [HistoryPage]) { self.pages = pages }
}

@MainActor
final class ChatViewModelFailureTests: XCTestCase {
  private func frame(rev: Int, messages: [ChatMessage] = [], hasOlder: Bool = false)
    -> SnapshotFrame
  {
    SnapshotFrame(
      instance: "33333333-3333-4333-8333-333333333333", rev: rev,
      value: ChatSnapshot(
        messages: messages,
        window: ChatWindow(
          oldestEntryId: messages.compactMap { Int($0.id.dropFirst(2)) }.first,
          newestEntryId: messages.compactMap { Int($0.id.dropFirst(2)) }.last,
          hasOlder: hasOlder)))
  }

  func testConnectFailureIsVisibleDismissibleAndCloseIsIdempotent() async {
    let port = FakePort()
    let store = MemoryStore()
    await port.setEventsError(.unavailable)
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    guard case .failed = model.connection else { return XCTFail("expected failure") }
    XCTAssertNotNil(model.error)
    model.dismissError()
    XCTAssertNil(model.error)
    await model.close()
    await model.close()
    XCTAssertEqual(model.connection, .idle)
  }

  func testStreamFailureMarksTheConnectionFailed() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    await port.failStream()
    try await Task.sleep(for: .milliseconds(30))
    guard case .failed = model.connection else { return XCTFail("expected failure") }
    XCTAssertNotNil(model.error)
  }

  func testLoadOlderFailureKeepsTheCurrentWindowAndRetryIsANoOpWhenEmpty() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    await port.queue(
      frame(
        rev: 2, messages: [ChatMessage(id: "e_10", role: .assistant, text: "new")],
        hasOlder: true))
    try await Task.sleep(for: .milliseconds(30))
    await port.setHistoryError(.timeout)
    await model.loadOlder()
    XCTAssertNotNil(model.error)
    XCTAssertEqual(model.state.messages.first?.id, "e_10")
    XCTAssertEqual(model.state.messages.count, 1)
    await model.retry()
    let sent = await port.sent
    XCTAssertEqual(sent.count, 0)
    XCTAssertTrue(model.select("superagent:main"))
    XCTAssertFalse(model.select("superagent:worker"))
  }

  func testStoreFailurePreventsAnUnrecordedSend() async {
    let port = FakePort()
    let store = MemoryStore()
    await store.setFailSave(true)
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    model.draft = "must be recorded first"
    await model.send()
    XCTAssertEqual(model.draft, "must be recorded first")
    XCTAssertEqual(model.error, SuperagentError.storage.errorDescription)
    let sent = await port.sent
    XCTAssertEqual(sent.count, 0)
  }

  func testStopIgnoresASecondConcurrentRequest() async throws {
    let port = FakePort()
    let store = MemoryStore()
    let model = SuperagentChatViewModel(port: port, store: store)
    await model.connect()
    async let first: Void = model.stop()
    async let second: Void = model.stop()
    _ = await (first, second)
    XCTAssertNil(model.error)
    XCTAssertFalse(model.stopping)
  }
}
