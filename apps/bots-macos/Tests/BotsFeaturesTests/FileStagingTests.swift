import BotsCore
import BotsFeatures
import Darwin
import Foundation
import XCTest

final class FileStagingTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-stage-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func testLongTextIsExactPrivateInputAndShortTextStaysInline() async throws {
    let port = DiskFilePort(directory: root, uploader: RefusingUploader())
    let exact = "  \r\n" + String(repeating: "😀界", count: 4_001) + "\r\n  "
    let requestId = "r_stage_long_0001"
    let staged = try await port.stage(
      text: exact, selectedFiles: [], botId: "b_1", requestId: requestId)

    XCTAssertEqual(staged.files.count, 1)
    XCTAssertEqual(staged.files[0].kind, .input)
    XCTAssertEqual(staged.files[0].name, "input.md")
    XCTAssertNotEqual(staged.text, exact)
    let original = try await port.originalText(staged)
    XCTAssertEqual(original, exact)
    XCTAssertFalse(staged.files[0].relativePath.contains("/tmp"))
    let path = try await port.url(for: staged.files[0])
    XCTAssertEqual(try Data(contentsOf: path), Data(exact.utf8))
    XCTAssertEqual(
      (try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber)?
        .intValue,
      0o600
    )

    let short = "  keep\r\nemoji 😀  "
    let shortStage = try await port.stage(
      text: short, selectedFiles: [], botId: "b_1", requestId: "r_stage_short_001"
    )
    XCTAssertEqual(shortStage.text, short)
  }

  func testSelectedFilesAreImmutableSnapshotsAndZeroByteIsAllowed() async throws {
    let source = root.appendingPathComponent("source.bin")
    try Data([1, 2, 3]).write(to: source)
    let port = DiskFilePort(directory: root, uploader: RefusingUploader())
    let staged = try await port.stage(
      text: "read it", selectedFiles: [source], botId: "b_1", requestId: "r_stage_file_0001")
    try Data([9, 9, 9, 9]).write(to: source)

    let urls = try await port.selectedURLs(staged)
    XCTAssertEqual(urls.count, 1)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(urls.first)), Data([1, 2, 3]))

    let empty = root.appendingPathComponent("empty.bin")
    try Data().write(to: empty)
    let emptyStage = try await port.stage(
      text: "", selectedFiles: [empty], botId: "b_1", requestId: "r_stage_empty_001")
    XCTAssertEqual(emptyStage.files.first?.size, 0)
  }

  func testSelectedFileLimitIsInclusiveAndSourceIsNotCapturedInTheRecord() async throws {
    let source = root.appendingPathComponent("large.bin")
    try Data().write(to: source)
    let handle = try FileHandle(forWritingTo: source)
    try handle.truncate(atOffset: 52_428_800)
    try handle.close()
    let port = DiskFilePort(directory: root, uploader: RefusingUploader())
    let atLimit = try await port.stage(
      text: "large", selectedFiles: [source], botId: "b_1", requestId: "r_stage_limit_001")
    XCTAssertEqual(atLimit.files.first?.size, 52_428_800)

    try FileManager.default.removeItem(at: source)
    try Data().write(to: source)
    let over = try FileHandle(forWritingTo: source)
    try over.truncate(atOffset: 52_428_801)
    try over.close()
    do {
      _ = try await port.stage(
        text: "too large", selectedFiles: [source], botId: "b_1", requestId: "r_stage_limit_002")
      XCTFail("one byte over 50 MiB must be refused")
    } catch let error as ClientError {
      XCTAssertEqual(error.message, "附件不能超过 50 MiB")
    }
  }

  func testOriginalTextRejectsMissingTruncatedAndHashChangedSnapshots() async throws {
    let port = DiskFilePort(directory: root, uploader: RefusingUploader())
    let exact = String(repeating: "原稿😀\r\n", count: 2_500)
    let staged = try await port.stage(
      text: exact, selectedFiles: [], botId: "b_1", requestId: "r_integrity_0001")
    let path = try await port.url(for: try XCTUnwrap(staged.files.first))

    try Data().write(to: path)
    do {
      _ = try await port.originalText(staged)
      XCTFail("truncated snapshot must fail")
    } catch let error as ClientError {
      XCTAssertTrue(error.message.contains("快照") || error.message.contains("附件"))
    }

    try Data(exact.utf8).write(to: path)
    try Data(String(repeating: "X", count: exact.utf8.count).utf8).write(to: path)
    do {
      _ = try await port.originalText(staged)
      XCTFail("same-size hash mismatch must fail")
    } catch let error as ClientError {
      XCTAssertFalse(error.message.isEmpty)
    }

    try FileManager.default.removeItem(at: path)
    do {
      _ = try await port.originalText(staged)
      XCTFail("missing snapshot must fail")
    } catch let error as ClientError {
      XCTAssertFalse(error.message.isEmpty)
    }
  }

  func testDirectorySyncFailureDoesNotPublishTheStagingSnapshot() async throws {
    let source = root.appendingPathComponent("sync.bin")
    try Data([1, 2, 3]).write(to: source)
    let port = DiskFilePort(
      directory: root,
      uploader: RefusingUploader(),
      syncDirectory: { _ in throw ClientError("directory fsync failed") }
    )
    do {
      _ = try await port.stage(
        text: "read", selectedFiles: [source], botId: "b_1", requestId: "r_sync_fail_0001")
      XCTFail("directory sync failure must reject staging")
    } catch let error as ClientError {
      XCTAssertEqual(error.message, "directory fsync failed")
    }
  }

  func testSourceReplacementAtOpenAndBeforeFinalLstatIsRejected() async throws {
    let source = root.appendingPathComponent("barrier.bin")
    try Data([1, 2, 3, 4]).write(to: source)

    let replaceBeforeOpen = DiskFilePort(
      directory: root,
      uploader: RefusingUploader(),
      beforeOpen: {
        try? FileManager.default.removeItem(at: source)
        try? Data([9, 9, 9, 9]).write(to: source)
      }
    )
    do {
      _ = try await replaceBeforeOpen.stage(
        text: "read", selectedFiles: [source], botId: "b_1", requestId: "r_barrier_open")
      XCTFail("source replacement before open must not publish")
    } catch let error as ClientError {
      XCTAssertFalse(error.message.isEmpty)
    }

    try Data([1, 2, 3, 4]).write(to: source)
    let replaceBeforeFinalLstat = DiskFilePort(
      directory: root,
      uploader: RefusingUploader(),
      beforeFinalLstat: {
        try? FileManager.default.removeItem(at: source)
        try? Data([8, 8, 8, 8]).write(to: source)
      }
    )
    do {
      _ = try await replaceBeforeFinalLstat.stage(
        text: "read", selectedFiles: [source], botId: "b_1", requestId: "r_barrier_final")
      XCTFail("source replacement after copy must not publish")
    } catch let error as ClientError {
      XCTAssertFalse(error.message.isEmpty)
    }
  }

  func testRepeatedRequestIdDoesNotOverwriteADifferentSnapshot() async throws {
    let source = root.appendingPathComponent("repeat.bin")
    try Data([1, 2, 3]).write(to: source)
    let port = DiskFilePort(directory: root, uploader: RefusingUploader())
    _ = try await port.stage(
      text: "read", selectedFiles: [source], botId: "b_1", requestId: "r_repeat_0001")
    try Data([9, 9, 9, 9]).write(to: source)
    do {
      _ = try await port.stage(
        text: "read", selectedFiles: [source], botId: "b_1", requestId: "r_repeat_0001")
      XCTFail("same request ID must not replace the first snapshot")
    } catch let error as ClientError {
      XCTAssertTrue(error.message.contains("冲突") || error.message.contains("改变"))
    }
  }

  func testSymlinkAndFIFOAreRefused() async throws {
    let port = DiskFilePort(directory: root, uploader: RefusingUploader())
    let target = root.appendingPathComponent("real.bin")
    try Data([1]).write(to: target)
    let symlink = root.appendingPathComponent("link.bin")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: target)
    do {
      _ = try await port.stage(
        text: "read", selectedFiles: [symlink], botId: "b_1", requestId: "r_symlink_0001")
      XCTFail("symlinks must be refused")
    } catch let error as ClientError {
      XCTAssertFalse(error.message.isEmpty)
    }

    let fifo = root.appendingPathComponent("fifo.bin")
    XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
    do {
      _ = try await port.stage(
        text: "read", selectedFiles: [fifo], botId: "b_1", requestId: "r_fifo_0001")
      XCTFail("FIFOs must be refused")
    } catch let error as ClientError {
      XCTAssertFalse(error.message.isEmpty)
    }
  }
}

private final class RefusingUploader: ManagedFileUploadPort {
  func upload(botId: String, file: StagedFile, from url: URL) async throws -> String {
    throw ClientError("not used")
  }
}
