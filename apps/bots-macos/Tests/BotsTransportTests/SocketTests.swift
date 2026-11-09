import BotsCore
import BotsTransport
import XCTest

/// Row 61: the client speaks the real daemon — handshake, subscribe, create, chat and
/// close — with the production adapter behind it and only the model network stubbed.
final class SocketTests: XCTestCase {
  private var fixture: BotsDaemonFixture!

  override func setUp() async throws {
    fixture = try await BotsDaemonFixture.start()
  }

  override func tearDown() async throws {
    fixture?.stop()
    fixture = nil
  }

  func testCreateBotAndChat() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let before = try await catalog.load()
    XCTAssertEqual(before.bots.count, 0, "a fresh daemon has an empty catalog")
    XCTAssertEqual(before.groups, [], "and no groups")

    let created = try await catalog.create(
      title: "客户端自测",
      label: "自测",
      appearance: BotCreationAppearance(shape: .star, tint: .violet)
    )
    XCTAssertEqual(created.title, "客户端自测")
    XCTAssertEqual(created.label, "自测", "the daemon stores the label")
    XCTAssertEqual(created.face.shape, .star, "and the chosen face")
    XCTAssertEqual(created.face.tint, .violet)
    XCTAssertTrue(created.id.hasPrefix("b_"))
    let listed = try await catalog.load()
    XCTAssertEqual(listed.bots.map(\.id), [created.id])

    let socket = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: created.id
    )
    let collector = EventCollector()
    let consumer = Task {
      for await event in socket.events {
        await collector.append(event)
      }
    }
    defer {
      socket.close()
      consumer.cancel()
    }
    socket.start()

    _ = try await collector.waitFor { event in
      if case .snapshot(let value) = event { return value.botId == created.id }
      return false
    }
    try socket.send(
      text: "你好，客户端",
      requestId: Identifiers.request(),
      whenBusy: .followUp,
      trace: Identifiers.trace("send")
    )
    let first = try await collector.waitFor { event in
      if case .append(let message, _) = event { return message.role == .user }
      return false
    }
    guard case .append(let userMessage, _) = first else {
      return XCTFail("expected the user entry")
    }
    XCTAssertEqual(userMessage.text, "你好，客户端")

    let answer = try await collector.waitFor { event in
      if case .append(let message, _) = event {
        return message.role == .assistant && message.state == .complete
      }
      return false
    }
    guard case .append(let assistant, _) = answer else {
      return XCTFail("expected the answer")
    }
    XCTAssertEqual(assistant.text, "这是本地模型的示例回答。")

    let settled = try await collector.waitFor { event in
      if case .submission(let record) = event { return record.status == .done }
      return false
    }
    guard case .submission(let record) = settled else {
      return XCTFail("expected the settlement")
    }
    XCTAssertEqual(record.answerEntryId, assistant.id)

    // The transcript can be rebuilt from a fresh subscription: one question, one answer.
    let again = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: created.id
    )
    let secondCollector = EventCollector()
    let secondConsumer = Task {
      for await event in again.events {
        await secondCollector.append(event)
      }
    }
    defer {
      again.close()
      secondConsumer.cancel()
    }
    again.start()
    let snapshotEvent = try await secondCollector.waitFor { event in
      if case .snapshot(let value) = event { return value.messages.count == 2 }
      return false
    }
    guard case .snapshot(let snapshot) = snapshotEvent else {
      return XCTFail("expected the snapshot")
    }
    XCTAssertEqual(snapshot.messages.map(\.role), [.user, .assistant])
    XCTAssertEqual(snapshot.messages.last?.text, "这是本地模型的示例回答。")
    XCTAssertEqual(snapshot.streaming, nil)
  }

  func testCatalogIsAbsoluteAndSurvivesAReconnect() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let first = try await catalog.create(title: "一", label: nil, appearance: .init())
    let second = try await catalog.create(title: "二", label: nil, appearance: .init())
    let created = try await catalog.load()
    XCTAssertEqual(Set(created.bots.map(\.id)), [first.id, second.id])

    let renamed = try await catalog.rename(id: first.id, title: "一号")
    XCTAssertEqual(renamed.title, "一号")

    try await catalog.delete(id: second.id)
    let remaining = try await catalog.load()
    XCTAssertEqual(remaining.bots.map(\.id), [first.id])
  }

  /// The group endpoints against the production daemon: order, membership and the refusal
  /// that keeps an occupied group from being emptied by a delete.
  func testGroupsTravelWithTheCatalog() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let work = try await catalog.createGroup(title: "  工作  ")
    XCTAssertEqual(work.title, "工作", "the daemon trims the title")
    let research = try await catalog.createGroup(title: "研究")
    let first = try await catalog.load()
    XCTAssertEqual(first.groups.map(\.id), [work.id, research.id])

    let renamed = try await catalog.renameGroup(id: research.id, title: "学习")
    XCTAssertEqual(renamed.title, "学习")

    let reordered = try await catalog.reorderGroups(ids: [research.id, work.id])
    XCTAssertEqual(reordered.map(\.id), [research.id, work.id], "the daemon answers the order")

    let bot = try await catalog.create(title: "分组自测", label: nil, appearance: .init())
    let filed = try await catalog.moveBot(id: bot.id, groupId: work.id)
    XCTAssertEqual(filed.groupId, work.id, "the bot records its membership")

    do {
      try await catalog.deleteGroup(id: work.id)
      XCTFail("a group that still holds a bot is refused")
    } catch {
      XCTAssertEqual((error as? ClientError)?.message, "the group still holds bots")
    }

    let unfiled = try await catalog.moveBot(id: bot.id, groupId: nil)
    XCTAssertNil(unfiled.groupId, "null unfiles the bot")
    try await catalog.deleteGroup(id: work.id)
    let last = try await catalog.load()
    XCTAssertEqual(last.groups.map(\.id), [research.id])
  }
}

extension SocketTests {
  func testASocketReconnectsAndRebuildsTheTranscript() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let bot = try await catalog.create(title: "重连", label: nil, appearance: .init())
    let first = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: bot.id
    )
    let collector = EventCollector()
    let consumer = Task {
      for await event in first.events { await collector.append(event) }
    }
    first.start()
    _ = try await collector.waitFor { event in
      if case .connection(.ready) = event { return true }
      return false
    }
    // `ready` is the handshake, not the subscription: a send before the first snapshot is
    // refused with "the connection has no subscription" on a run where the two race.
    _ = try await collector.waitFor { event in
      if case .snapshot = event { return true }
      return false
    }
    try first.send(
      text: "第一轮",
      requestId: Identifiers.request(),
      whenBusy: .followUp,
      trace: Identifiers.trace("send")
    )
    _ = try await collector.waitFor { event in
      if case .submission(let record) = event { return record.status == .done }
      return false
    }
    first.close()
    consumer.cancel()

    // A second socket starts from a snapshot, not from the frames the first one saw.
    let again = ConversationSocket(
      baseURL: fixture.baseURL,
      token: fixture.token,
      botId: bot.id
    )
    let renewed = EventCollector()
    let secondConsumer = Task {
      for await event in again.events { await renewed.append(event) }
    }
    defer {
      again.close()
      secondConsumer.cancel()
    }
    again.start()
    let snapshotEvent = try await renewed.waitFor { event in
      if case .snapshot(let value) = event { return value.messages.count == 2 }
      return false
    }
    guard case .snapshot(let snapshot) = snapshotEvent else {
      return XCTFail("expected a snapshot")
    }
    XCTAssertEqual(snapshot.messages.map(\.role), [.user, .assistant])
  }
}

extension SocketTests {
  func testClosingASocketReleasesTheBotSubscriber() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let bot = try await catalog.create(title: "释放", label: nil, appearance: .init())
    // More cycles than the eight-subscriber cap: every closed socket must give its slot
    // back, or the ninth subscription would be refused.
    for index in 0..<9 {
      let socket = ConversationSocket(
        baseURL: fixture.baseURL,
        token: fixture.token,
        botId: bot.id
      )
      let collector = EventCollector()
      let consumer = Task {
        for await event in socket.events { await collector.append(event) }
      }
      socket.start()
      let snapshot = try await collector.waitFor { event in
        if case .snapshot = event { return true }
        return false
      }
      XCTAssertNotNil(snapshot, "subscription \(index + 1) is accepted")
      socket.close()
      consumer.cancel()
      try await Task.sleep(nanoseconds: 80_000_000)
    }
  }
}
