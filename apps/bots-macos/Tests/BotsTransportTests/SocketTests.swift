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
      appearance: BotAppearance(shape: .star, tint: .violet)
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
    let first = try await catalog.create(title: "一", label: nil, appearance: .standard)
    let second = try await catalog.create(title: "二", label: nil, appearance: .standard)
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

    let bot = try await catalog.create(title: "分组自测", label: nil, appearance: .standard)
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
    let bot = try await catalog.create(title: "重连", label: nil, appearance: .standard)
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
  func testReadyHeadSelectionAndMergeUseTheOriginalContextSocket() async throws {
    let client = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let bot = try await client.create(title: "历史接力", label: nil, appearance: .standard)
    let shared = UUID().uuidString.lowercased()
    let binding = try await client.bindReplica(botId: bot.id, sharedBotId: shared)
    XCTAssertEqual(binding.sharedBotId, shared)
    XCTAssertEqual(binding.localBotId, bot.id)
    let actualBinding = try await client.loadReplicaBinding(botId: bot.id)
    XCTAssertEqual(actualBinding, binding)
    do {
      try await client.configureSync(
        botId: bot.id, peerDeviceId: UUID().uuidString.lowercased(), direction: .receive)
      XCTFail("this fixture has no device synchronization backend")
    } catch { XCTAssertTrue(error is ClientError) }
    var sockets: [ConversationSocket] = []
    var consumers: [Task<Void, Never>] = []
    defer {
      sockets.forEach { $0.close() }
      consumers.forEach { $0.cancel() }
    }
    func connect(_ contextId: String?) async throws -> (ConversationSocket, EventCollector) {
      let socket = ConversationSocket(
        baseURL: fixture.baseURL, token: fixture.token, botId: bot.id, contextId: contextId)
      let collector = EventCollector()
      sockets.append(socket)
      consumers.append(Task { for await event in socket.events { await collector.append(event) } })
      socket.start()
      _ = try await collector.waitFor {
        if case .snapshot = $0 { return true }
        return false
      }
      return (socket, collector)
    }
    func run(
      _ socket: ConversationSocket, _ collector: EventCollector, _ request: String, _ text: String
    ) async throws {
      try socket.send(
        text: text, requestId: request, whenBusy: .followUp, trace: Identifiers.trace("send"))
      _ = try await collector.waitFor {
        if case .submission(let value) = $0 {
          return value.requestId == request && value.status == .done
        }
        return false
      }
    }
    let (root, rootEvents) = try await connect(nil)
    try await run(root, rootEvents, "native_context_seed", "共同上下文")
    let page = try await client.loadHeads(botId: bot.id, after: 0)
    let seed = try XCTUnwrap(page.items.filter(\.ready).max { $0.entries < $1.entries })
    XCTAssertFalse(seed.head.isEmpty)
    let detail = try await client.loadHead(botId: bot.id, head: seed.head)
    XCTAssertEqual(detail.head, seed.head)
    var tips: [String] = []
    for (contextId, text) in [("native_context_left", "左侧继续"), ("native_context_right", "右侧继续")] {
      let selection = try await client.createContext(
        botId: bot.id, contextId: contextId, head: seed.head, resourceHead: nil)
      XCTAssertEqual(selection.seedHead, seed.head)
      let (socket, events) = try await connect(contextId)
      try await run(socket, events, "r_\(contextId)", text)
      _ = try await client.loadHeads(botId: bot.id, after: page.nextAfter)
      let current = try await client.loadContext(botId: bot.id, contextId: contextId)
      tips.append(try XCTUnwrap(current.tip))
    }
    let preview = try await client.previewMerge(botId: bot.id, heads: tips)
    XCTAssertTrue(preview.conflicts.isEmpty)
    XCTAssertTrue(preview.resources.isEmpty)
    let merged = try await client.mergeHeads(
      botId: bot.id, heads: tips, requestId: "native_merge_001", choices: [], resources: [])
    let same = try await client.mergeHeads(
      botId: bot.id, heads: tips, requestId: "native_merge_001", choices: [], resources: [])
    XCTAssertEqual(merged, same)
    let mergedDetail = try await client.loadHead(botId: bot.id, head: merged.head)
    XCTAssertEqual(mergedDetail.parents, tips)
    _ = try await client.createContext(
      botId: bot.id, contextId: "native_context_merged", head: merged.head, resourceHead: nil)
    let (selected, selectedEvents) = try await connect("native_context_merged")
    let event = try await selectedEvents.waitFor {
      if case .snapshot = $0 { return true }
      return false
    }
    guard case .snapshot(let snapshot) = event else { return XCTFail("expected selected snapshot") }
    XCTAssertEqual(
      snapshot.messages.filter { $0.role == .user }.map(\.text), ["共同上下文", "左侧继续", "右侧继续"])
    try await run(selected, selectedEvents, "native_merged_continue", "合并后继续")
    let rootAgain = try await connect(nil)
    let rootEvent = try await rootAgain.1.waitFor {
      if case .snapshot = $0 { return true }
      return false
    }
    guard case .snapshot(let rootSnapshot) = rootEvent else {
      return XCTFail("expected root snapshot")
    }
    XCTAssertEqual(rootSnapshot.messages.filter { $0.role == .user }.map(\.text), ["共同上下文"])
  }

  func testClosingASocketReleasesTheBotSubscriber() async throws {
    let catalog = CatalogHTTPClient(baseURL: fixture.baseURL, token: fixture.token)
    let bot = try await catalog.create(title: "释放", label: nil, appearance: .standard)
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
