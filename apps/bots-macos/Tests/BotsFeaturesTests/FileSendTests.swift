import BotsCore
import BotsFeatures
import Foundation
import XCTest

@MainActor
final class FileSendTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-file-send-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testOldDaemonAndFilesOnlyDoNotPretendAttachmentSendWorks() async throws {
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: OutboxStore(directory: directory), filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: false))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))

    model.draft = String(repeating: "界", count: 8_001)
    model.send()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(file.stageCalls, 0)
    XCTAssertEqual(fake.sent.count, 0)
    XCTAssertEqual(model.draft, String(repeating: "界", count: 8_001))

    model.draft = "正常文本"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertEqual(fake.sent.first?.text, "正常文本")
  }

  func testLongTextStagesAndPersistsBeforeUploadAndSend() async throws {
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    let exact = "  " + String(repeating: "界😀\r\n", count: 2_500) + "  "
    model.draft = exact
    model.send()

    try await waitUntil { (try? outbox.entries(for: "b_1").first) != nil }
    let entry = try XCTUnwrap(try outbox.entries(for: "b_1").first)
    XCTAssertEqual(entry.files.count, 1)
    XCTAssertEqual(entry.files.first?.kind, .input)
    let restored = try await file.originalText(StagedSend(text: entry.text, files: entry.files))
    XCTAssertEqual(restored, exact)
    XCTAssertEqual(entry.whenBusy, .followUp)
    try await waitUntil { fake.sent.count == 1 }
    XCTAssertEqual(fake.sent.first?.fileIds, [entry.files.first?.fileId].compactMap { $0 })
  }

  func testStagingTaskIsHeldAndCanceledAcrossBotAndCompositionChanges() async throws {
    let fake = FakeFileConversation()
    let file = BlockingStageFilePort()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = String(repeating: "准备中😀", count: 1_000)
    model.selectFiles([URL(fileURLWithPath: "/tmp/a.bin")])
    model.send()
    try await waitUntil { file.stageStarted == 1 }

    model.writeDraft("B草稿")
    model.selectFiles([])
    model.select(botId: "b_2")
    model.writeDraft("B的新草稿")
    model.selectFiles([URL(fileURLWithPath: "/tmp/b.bin")])

    file.releaseStage()
    try await Task.sleep(for: .milliseconds(40))
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0)
    XCTAssertEqual(fake.sent.count, 0)
    XCTAssertEqual(model.draft, "B的新草稿")
    XCTAssertEqual(model.selectedFiles.map(\.lastPathComponent), ["b.bin"])
  }

  func testDoubleSendOfOneCompositionStartsOneStagingAndOneRequest() async throws {
    let fake = FakeFileConversation()
    let file = BlockingStageFilePort()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = String(repeating: "重复😀", count: 5_000)
    model.send()
    model.send()
    try await waitUntil { file.stageStarted == 1 }
    file.releaseStage()
    try await waitUntil { (try? outbox.entries(for: "b_1").count) == 1 }
    XCTAssertEqual(file.stageStarted, 1)
    XCTAssertEqual(Set(try outbox.entries(for: "b_1").map(\.requestId)).count, 1)
  }

  func testDraftRevisionIsCapturedAndNotComparedAsTrimmedEquivalentText() async throws {
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: OutboxStore(directory: directory), filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = "first\r\n"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    model.draft = "second"

    fake.emit(
      .error(
        kind: .invalidCommand, disposition: .notAdmitted, message: "refused",
        failure: "f_1", requestId: try XCTUnwrap(fake.sent.last?.requestId)))
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(model.draft, "second\n\nfirst\r\n")
  }

  func testSwitchingBotCancelsUploadAndKeepsTheSameRequestAndOutbox() async throws {
    let fake = FakeFileConversation()
    let file = BlockingFilePort()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = "发送附件"
    model.selectFiles([URL(fileURLWithPath: "/tmp/fixture.txt")])
    model.send()
    try await waitUntil { (try? outbox.entries(for: "b_1").first) != nil }
    let entry = try XCTUnwrap(try outbox.entries(for: "b_1").first)
    try await waitUntil { file.uploadCalls == 1 }

    model.select(botId: "b_2")
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_2")))
    XCTAssertTrue(file.lastTaskWasCancelled)
    XCTAssertEqual(try outbox.entries(for: "b_1").first?.requestId, entry.requestId)
    XCTAssertEqual(fake.sent.count, 0)
  }

  func testNotAdmittedKeepsRecoverableRecordAndRestoresOnlyItsBot() async throws {
    let outbox = OutboxStore(directory: directory)
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = " first"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    fake.emit(
      .error(
        kind: .invalidCommand, disposition: .notAdmitted, message: "refused",
        failure: "f_1", requestId: requestId))
    try await waitUntil { model.draft == " first" }

    XCTAssertEqual(model.draft, " first")
    XCTAssertEqual(try outbox.refusedRequests().filter { $0 == requestId }.count, 1)
    XCTAssertNotNil(try outbox.entry(requestId: requestId))

    let reopened = ConversationViewModel(
      botId: "b_1", conversation: FakeFileConversation(),
      outbox: outbox, filePort: file)
    reopened.select(botId: "b_1")
    try await waitUntil { reopened.draft == " first" }
    XCTAssertEqual(reopened.draft, " first")
  }

  func testMoreThan200RecoverableRefusalsAndManualRetryKeepTheirIds() throws {
    let outbox = OutboxStore(directory: directory)
    for index in 0..<220 {
      let requestId = "r_refused_\(String(format: "%03d", index))"
      try outbox.add(OutboxEntry(botId: "b_1", requestId: requestId, text: "草稿\(index)"))
      try outbox.refuse(requestId: requestId)
    }

    XCTAssertEqual(try outbox.refusedRequests().count, 220)
    XCTAssertEqual(try outbox.entry(requestId: "r_refused_000")?.text, "草稿0")
    XCTAssertEqual(try outbox.entry(requestId: "r_refused_219")?.text, "草稿219")

    let reopened = OutboxStore(directory: directory)
    try reopened.unrefuse(requestId: "r_refused_219")
    XCTAssertFalse(try reopened.refusedRequests().contains("r_refused_219"))
    XCTAssertEqual(try reopened.entry(requestId: "r_refused_219")?.text, "草稿219")

    let third = OutboxStore(directory: directory)
    XCTAssertFalse(try third.refusedRequests().contains("r_refused_219"))
    XCTAssertEqual(try third.entry(requestId: "r_refused_219")?.text, "草稿219")
  }

  func testNotAdmittedPersistsTombstoneBeforeSnapshotRecoveryAndKeepsOtherBotDraft() async throws {
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    file.corruptOriginal = true
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = "保持原稿"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    model.select(botId: "b_2")
    model.draft = "另一 Bot 草稿"
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_2")))
    fake.emit(
      .error(
        kind: .invalidCommand, disposition: .notAdmitted, message: "refused",
        failure: "f_not_admitted", requestId: requestId))
    try await Task.sleep(for: .milliseconds(30))

    XCTAssertTrue(try outbox.refusedRequests().contains(requestId))
    XCTAssertNotNil(try outbox.entry(requestId: requestId))
    XCTAssertEqual(model.draft, "另一 Bot 草稿")
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0)
  }

  func testMissingFilePortAndCorruptSnapshotDoNotClearOriginalDraft() async throws {
    let fake = FakeFileConversation()
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake,
      outbox: OutboxStore(directory: directory), filePort: nil
    )
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    let exact = "  " + String(repeating: "原稿😀\r\n", count: 2_500) + "  "
    model.draft = exact
    model.send()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(model.draft, exact)
    XCTAssertEqual(fake.sent.count, 0)
  }

  func testCorruptSnapshotNotAdmittedKeepsDraftAndOutbox() async throws {
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    file.corruptOriginal = true
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = "  " + String(repeating: "保持原稿😀\r\n", count: 2_500) + "  "
    model.send()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(fake.sent.count, 0)
    XCTAssertEqual(model.draft, "  " + String(repeating: "保持原稿😀\r\n", count: 2_500) + "  ")
    XCTAssertEqual(try outbox.entries(for: "b_1").count, 0)
  }

  func testOutboxBareArrayAndNonFileEntriesMigrateWithoutRollback() throws {
    let file = directory.appendingPathComponent("outbox.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try
      "[{\"botId\":\"b_1\",\"requestId\":\"r_old_1\",\"text\":\"旧文本\",\"whenBusy\":\"followUp\",\"createdAt\":\"x\"}]"
      .write(to: file, atomically: true, encoding: .utf8)

    let reopened = OutboxStore(directory: directory)
    XCTAssertEqual(try reopened.entries(for: "b_1").map(\.requestId), ["r_old_1"])
    try reopened.add(
      OutboxEntry(
        botId: "b_1",
        requestId: "r_v3_1",
        text: "附件占位",
        files: [
          StagedFile(
            kind: .input,
            uploadId: "u_v3_1",
            name: "input.md",
            mimeType: "text/markdown",
            size: 3,
            sha256: String(repeating: "a", count: 64),
            relativePath: "staging/r_v3_1/u_v3_1/content.md"
          )
        ]
      )
    )
    let data = try Data(contentsOf: file)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["version"] as? Int, 3)
    XCTAssertEqual((json["entries"] as? [[String: Any]])?.count, 2)
  }

  func testOutboxV3RejectsMissingOrNullFilesAndV2MayMigrate() throws {
    let file = directory.appendingPathComponent("outbox.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    try
      "{\"version\":2,\"entries\":[{\"botId\":\"b_1\",\"requestId\":\"r_v2\",\"text\":\"旧文本\",\"whenBusy\":\"followUp\",\"createdAt\":\"x\"}],\"settled\":[],\"refused\":[]}"
      .write(to: file, atomically: true, encoding: .utf8)
    XCTAssertEqual(
      try OutboxStore(directory: directory).entries(for: "b_1").map(\.requestId), ["r_v2"])

    for invalid in [
      "{\"version\":3,\"entries\":[{\"botId\":\"b_1\",\"requestId\":\"r_v3\",\"text\":\"占位文本\",\"whenBusy\":\"followUp\",\"createdAt\":\"x\",\"uploadPaused\":false}],\"settled\":[],\"refused\":[]}",
      "{\"version\":3,\"entries\":[{\"botId\":\"b_1\",\"requestId\":\"r_v3\",\"text\":\"占位文本\",\"whenBusy\":\"followUp\",\"createdAt\":\"x\",\"files\":null,\"uploadPaused\":false}],\"settled\":[],\"refused\":[]}",
    ] {
      try invalid.write(to: file, atomically: true, encoding: .utf8)
      XCTAssertThrowsError(try OutboxStore(directory: directory).all())
    }
  }

  func testUnknownAndDisconnectKeepTheOriginalRequestIdAndEntry() async throws {
    let fake = FakeFileConversation()
    let file = FakeFilePort()
    let outbox = OutboxStore(directory: directory)
    let model = ConversationViewModel(
      botId: "b_1", conversation: fake, outbox: outbox, filePort: file)
    model.select(botId: "b_1")
    fake.emit(.capabilities(sendFiles: true))
    fake.emit(.connection(.ready))
    fake.emit(.snapshot(ConversationSnapshot(botId: "b_1")))
    try await waitUntil { model.connection == .ready && model.hasSnapshot }

    model.draft = "unknown"
    model.send()
    try await waitUntil { fake.sent.count == 1 }
    let requestId = try XCTUnwrap(fake.sent.last?.requestId)
    fake.emit(
      .error(
        kind: .internalError, disposition: .unknown, message: "unknown",
        failure: "f_2", requestId: requestId))
    fake.emit(.connection(.reconnecting(attempt: 1)))
    XCTAssertEqual(try outbox.entries(for: "b_1").first?.requestId, requestId)
    XCTAssertFalse(try outbox.refusedRequests().contains(requestId))
  }

  private func waitUntil(
    _ condition: @escaping () -> Bool,
    timeout: TimeInterval = 2
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("condition not met")
  }
}

private final class FakeFilePort: FilePort {
  var stageCalls = 0
  var corruptOriginal = false
  var originals: [String: String] = [:]
  var uploadCalls = 0

  func stage(
    text: String, selectedFiles: [URL], botId: String, requestId: String
  ) async throws
    -> StagedSend
  {
    stageCalls += 1
    let count = text.unicodeScalars.count > 8_000
    var files: [StagedFile] = []
    if count {
      files.append(
        StagedFile(
          kind: .input, uploadId: "u_\(requestId)", name: "input.md",
          mimeType: "text/markdown", size: Int64(Data(text.utf8).count),
          sha256: String(repeating: "a", count: 64),
          relativePath: "staging/\(requestId)/input.md"))
    }
    for (index, url) in selectedFiles.enumerated() {
      files.append(
        StagedFile(
          kind: .selected, uploadId: "u_\(requestId)_\(index)", name: url.lastPathComponent,
          mimeType: "application/octet-stream", size: 0, sha256: String(repeating: "b", count: 64),
          relativePath: "staging/\(requestId)/\(index).bin"))
    }
    let staged = StagedSend(
      text: count ? "The full message is attached as input.md." : text, files: files)
    if count { originals[staged.files.first?.uploadId ?? requestId] = text }
    return staged
  }

  func upload(_ file: StagedFile, botId: String) async throws -> String {
    uploadCalls += 1
    return "f_\(String(repeating: "c", count: 64))"
  }

  func originalText(_ send: StagedSend) async throws -> String {
    if corruptOriginal { throw ClientError("原文快照内容已改变") }
    if send.files.contains(where: { $0.kind == .input }) {
      let key = send.files.first(where: { $0.kind == .input })?.uploadId
      if let key, let exact = originals[key] { return exact }
      return String(repeating: "界😀\r\n", count: 1_500)
    }
    return send.text
  }

  func selectedURLs(_ send: StagedSend) async throws -> [URL] {
    send.files.filter { $0.kind == .selected }
      .map { URL(fileURLWithPath: "/tmp/\($0.name)") }
  }

  func url(for file: StagedFile) async throws -> URL {
    URL(fileURLWithPath: "/tmp/\(file.name)")
  }
}

private final class BlockingStageFilePort: FilePort {
  var stageStarted = 0
  private var gate: CheckedContinuation<StagedSend, Error>?

  func stage(
    text: String, selectedFiles: [URL], botId: String, requestId: String
  ) async throws -> StagedSend {
    stageStarted += 1
    return try await withCheckedThrowingContinuation { continuation in
      gate = continuation
    }
  }

  func releaseStage() {
    gate?.resume(returning: StagedSend(text: "", files: []))
    gate = nil
  }

  func upload(_ file: StagedFile, botId: String) async throws -> String {
    "f_\(String(repeating: "c", count: 64))"
  }

  func originalText(_ send: StagedSend) async throws -> String { send.text }
  func selectedURLs(_ send: StagedSend) async throws -> [URL] { [] }
  func url(for file: StagedFile) async throws -> URL { URL(fileURLWithPath: "/tmp/file") }
}

private final class BlockingFilePort: FilePort {
  var uploadCalls = 0
  var lastTaskWasCancelled = false

  func stage(
    text: String, selectedFiles: [URL], botId: String, requestId: String
  ) async throws -> StagedSend {
    .init(
      text: text,
      files: selectedFiles.enumerated().map { index, url in
        StagedFile(
          kind: .selected, uploadId: "u_\(requestId)_\(index)", name: url.lastPathComponent,
          mimeType: "application/octet-stream", size: 0,
          sha256: String(repeating: "b", count: 64), relativePath: "staging/\(requestId)/\(index)")
      })
  }

  func upload(_ file: StagedFile, botId: String) async throws -> String {
    uploadCalls += 1
    do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch {
      lastTaskWasCancelled = true
      throw CancellationError()
    }
    return "f_\(String(repeating: "d", count: 64))"
  }

  func originalText(_ send: StagedSend) async throws -> String { send.text }
  func selectedURLs(_ send: StagedSend) async throws -> [URL] { [] }
  func url(for file: StagedFile) async throws -> URL { URL(fileURLWithPath: "/tmp/\(file.name)") }
}

private final class FakeFileConversation: ConversationPort, FileConversationPort {
  struct Sent {
    let text: String
    let requestId: String
    let fileIds: [String]?
  }
  var sent: [Sent] = []
  private var continuation: AsyncStream<ConversationEvent>.Continuation?

  func open(botId: String) -> AsyncStream<ConversationEvent> {
    AsyncStream { continuation in
      self.continuation = continuation
    }
  }
  func emit(_ event: ConversationEvent) { continuation?.yield(event) }
  func send(_ text: String, whenBusy: BusyMode, context: CommandContext, botId: String) async throws
  {
    sent.append(Sent(text: text, requestId: context.requestId ?? "", fileIds: nil))
  }
  func send(
    _ text: String, whenBusy: BusyMode, context: CommandContext, botId: String, fileIds: [String]
  ) async throws {
    sent.append(Sent(text: text, requestId: context.requestId ?? "", fileIds: fileIds))
  }
  func answer(
    entryId: String, chosen: [String], skipped: Bool, context: CommandContext, botId: String
  ) async throws {}
  func abort(context: CommandContext, botId: String) async throws {}
  func recover(context: CommandContext, botId: String) async throws {}
  func resync(context: CommandContext, botId: String) async throws {}
  func loadHistory(before messageId: String, context: CommandContext, botId: String) async throws {}
  func close() {
    continuation?.finish()
    continuation = nil
  }
}
