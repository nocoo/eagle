import Foundation
import SuperagentCore
import SuperagentFeatures
import SuperagentTransport
import XCTest

@MainActor
final class SettingsAndStoreTests: XCTestCase {
  private final class Service: SuperagentServicePort {
    var configuration: ModelConfiguration?
    var configured: ConfigurationChange?
    func health() async throws -> ServiceHealth { throw SuperagentError.unavailable }
    func events() async throws -> AsyncThrowingStream<SnapshotFrame, Error> {
      throw SuperagentError.unavailable
    }
    func state() async throws -> SnapshotFrame {
      SnapshotFrame(
        instance: "11111111-1111-4111-8111-111111111111", rev: 1,
        value: ChatSnapshot(configuration: configuration))
    }
    func configure(_ value: ConfigurationChange) async throws -> ModelConfiguration {
      configured = value
      let key = value.apiKey ?? (configuration?.hasApiKey == true ? "kept" : "")
      configuration = ModelConfiguration(
        baseUrl: value.baseUrl, model: value.model, thinkingLevel: value.thinkingLevel,
        hasApiKey: !key.isEmpty)
      return configuration!
    }
    func submit(_ input: PendingInput) async throws -> ChatAdmission {
      throw SuperagentError.unavailable
    }
    func submission(_ requestId: String) async throws -> ChatAdmission? { nil }
    func history(before: Int?, limit: Int) async throws -> HistoryPage {
      HistoryPage(messages: [], hasMore: false, coverage: "complete")
    }
    func abort() async throws {}
    func close() async {}
  }

  func testSettingsLoadHidesTheKeyAndBlankSaveKeepsIt() async throws {
    let service = Service()
    service.configuration = ModelConfiguration(
      baseUrl: "http://127.0.0.1:1/v1", model: "m", thinkingLevel: "high", hasApiKey: true)
    let model = SuperagentSettingsViewModel(port: service)
    await model.load()
    XCTAssertEqual(model.baseUrl, "http://127.0.0.1:1/v1")
    XCTAssertTrue(model.hasApiKey)
    XCTAssertEqual(model.apiKey, "")
    await model.save()
    XCTAssertNil(service.configured?.apiKey)
    XCTAssertTrue(model.hasApiKey)
    XCTAssertEqual(model.notice, "已保存")
  }

  func testExplicitClearRemovesTheKeyAndFailureIsVisible() async throws {
    let service = Service()
    service.configuration = ModelConfiguration(
      baseUrl: "http://127.0.0.1:1/v1", model: "m", thinkingLevel: "high", hasApiKey: true)
    let model = SuperagentSettingsViewModel(port: service)
    await model.load()
    await model.clearKey()
    XCTAssertEqual(service.configured?.apiKey, "")
    XCTAssertFalse(model.hasApiKey)
    XCTAssertEqual(model.notice, "已清除密钥")
  }

  func testOutboxPersistsPrivatelyAndRefusesCorruption() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "outbox-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = FilePendingInputStore(directory: directory)
    let initially = try await store.list()
    XCTAssertEqual(initially, [])
    let first = PendingInput(id: "r_first_01", text: "hello")
    try await store.save(first)
    try await store.save(first)
    let saved = try await store.list()
    XCTAssertEqual(saved, [first])
    let file = directory.appendingPathComponent("superagent-outbox.json")
    let mode =
      try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
    XCTAssertEqual(mode, 0o600)
    try await store.remove(first.id)
    let cleared = try await store.list()
    XCTAssertEqual(cleared, [])
    try Data("broken".utf8).write(to: file)
    do {
      _ = try await store.list()
      XCTFail("corrupt outbox must fail closed")
    } catch { XCTAssertEqual(error as? SuperagentError, .storage) }
  }
}

final class OutboxConcurrencyTests: XCTestCase {
  func testTwoWindowStoresNeverLoseEachOthersPendingInput() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "outbox-race-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = FilePendingInputStore(directory: directory)
    let second = FilePendingInputStore(directory: directory)
    async let a: Void = first.save(PendingInput(id: "r_window_a1", text: "from A"))
    async let b: Void = second.save(PendingInput(id: "r_window_b1", text: "from B"))
    _ = try await (a, b)
    let saved = try await second.list()
    XCTAssertEqual(Set(saved.map(\.id)), ["r_window_a1", "r_window_b1"])
  }

  func testAWindowRemovalCannotEraseAnotherWindowsNewEntry() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "outbox-race2-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = FilePendingInputStore(directory: directory)
    let second = FilePendingInputStore(directory: directory)
    try await first.save(PendingInput(id: "r_remove_01", text: "old"))
    async let removal: Void = first.remove("r_remove_01")
    async let addition: Void = second.save(PendingInput(id: "r_keep_0001", text: "new"))
    _ = try await (removal, addition)
    let saved = try await second.list()
    XCTAssertEqual(saved.map(\.id), ["r_keep_0001"])
  }
}
