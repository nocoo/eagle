import Foundation

struct HerdrAgentMetadata: Equatable, Sendable {
  var model: String?
  var reasoningEffort: String?
  var contextWindow: Int?
}

actor CodexSessionMetadataReader {
  private let root: URL
  private var paths: [String: [URL]] = [:]
  private var nextScan = Date.distantPast
  private var cache: [String: Cached] = [:]
  private let readLimit: UInt64 = 8 * 1024 * 1024

  init(root: URL) {
    self.root = root.resolvingSymlinksInPath()
  }

  func read(sessionID: String) -> HerdrAgentMetadata {
    guard let id = UUID(uuidString: sessionID)?.uuidString.lowercased(), !Task.isCancelled else {
      return HerdrAgentMetadata()
    }
    if Date() >= nextScan { discover() }
    guard let matches = paths[id], matches.count == 1, let file = matches.first else {
      return HerdrAgentMetadata()
    }
    do {
      guard file.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else {
        return HerdrAgentMetadata()
      }
      let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
        let size = (attributes[.size] as? NSNumber)?.uint64Value,
        let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value,
        let modified = attributes[.modificationDate] as? Date
      else { return HerdrAgentMetadata() }
      let previous = cache[id]
      if let previous, previous.file == file, previous.inode == inode,
        previous.size == size, previous.modified == modified
      {
        return previous.state.metadata
      }

      let handle = try FileHandle(forReadingFrom: file)
      defer { try? handle.close() }
      let header = try handle.read(upToCount: 64 * 1024) ?? Data()
      guard let end = header.firstIndex(of: 10),
        let event = Self.decode(Data(header[..<end])), event.type == "session_meta",
        event.payload.id?.lowercased() == id
      else {
        cache[id] = nil
        return HerdrAgentMetadata()
      }

      // shortcut: metadata outside the last 8 MiB is unknown until a later turn records it.
      // Keep reads bounded; add a metadata index only if larger turns require it.
      var start = size > readLimit ? size - readLimit : 0
      var skipsFirstLine = start > 0
      var state = TurnState()
      if let previous, previous.file == file, previous.inode == inode, size > previous.size,
        size - previous.offset <= readLimit
      {
        start = previous.offset
        skipsFirstLine = false
        state = previous.state
      }
      try Task.checkCancellation()
      try handle.seek(toOffset: start)
      let bytes = try handle.read(upToCount: Int(size - start)) ?? Data()
      var offset = start
      if let end = bytes.lastIndex(of: 10) {
        offset += UInt64(end + 1)
        let text = String(decoding: bytes[...end], as: UTF8.self)
        for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false)
          .enumerated()
        {
          if skipsFirstLine && index == 0 { continue }
          guard
            line.contains("\"turn_context\"") || line.contains("\"task_started\"")
              || line.contains("\"model_context_window\""),
            let event = Self.decode(Data(line.utf8))
          else { continue }
          let payload = event.payload
          let turn = Self.clean(payload.turnId)
          let matches = turn != nil && turn == state.turnId
          if event.type == "turn_context" {
            state.metadata = HerdrAgentMetadata(
              model: Self.clean(payload.model),
              reasoningEffort: Self.clean(
                payload.effort ?? payload.reasoningEffort
                  ?? payload.collaborationMode?.settings?.reasoningEffort),
              contextWindow: Self.positive(payload.modelContextWindow)
                ?? (matches ? state.metadata.contextWindow : nil))
            state.turnId = turn
          } else if event.type == "event_msg", payload.type == "task_started" {
            if !matches { state.metadata = HerdrAgentMetadata() }
            state.turnId = turn
            state.metadata.contextWindow = Self.positive(payload.modelContextWindow)
          } else if event.type == "event_msg", payload.type == "token_count", matches,
            let window = Self.positive(
              payload.modelContextWindow ?? payload.info?.modelContextWindow)
          {
            state.metadata.contextWindow = window
          }
        }
      }
      cache[id] = Cached(
        file: file, size: size, inode: inode, modified: modified, offset: offset, state: state
      )
      return state.metadata
    } catch {
      cache[id] = nil
      return HerdrAgentMetadata()
    }
  }

  private func discover() {
    nextScan = Date().addingTimeInterval(30)
    paths = [:]
    guard
      let files = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
        options: [.skipsHiddenFiles, .skipsPackageDescendants])
    else { return }
    var visited = 0
    for case let file as URL in files {
      visited += 1
      guard visited <= 10_000, !Task.isCancelled else {
        paths = [:]
        return
      }
      guard file.pathExtension == "jsonl", file.lastPathComponent.hasPrefix("rollout-"),
        let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
        values.isRegularFile == true, values.isSymbolicLink != true,
        let id = UUID(uuidString: String(file.deletingPathExtension().lastPathComponent.suffix(36)))
      else { continue }
      paths[id.uuidString.lowercased(), default: []].append(file)
    }
  }

  private static func clean(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
      value.count <= 128, value.rangeOfCharacter(from: .controlCharacters) == nil
    else { return nil }
    return value
  }

  private static func positive(_ value: Int?) -> Int? { value.flatMap { $0 > 0 ? $0 : nil } }

  private static func decode(_ data: Data) -> Event? {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try? decoder.decode(Event.self, from: data)
  }

  private struct TurnState {
    var turnId: String?
    var metadata = HerdrAgentMetadata()
  }

  private struct Cached {
    let file: URL
    let size: UInt64
    let inode: UInt64
    let modified: Date
    let offset: UInt64
    let state: TurnState
  }

  private struct Event: Decodable {
    let type: String
    let payload: Payload
    struct Payload: Decodable {
      let id: String?
      let turnId: String?
      let type: String?
      let model: String?
      let effort: String?
      let reasoningEffort: String?
      let modelContextWindow: Int?
      let info: Info?
      let collaborationMode: Collaboration?

      enum CodingKeys: String, CodingKey {
        case id, turnId, type, model, effort, reasoningEffort, modelContextWindow, info,
          collaborationMode
      }

      // An invalid optional field must not hide the current turn's model change.
      init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        id = try? container?.decode(String.self, forKey: .id)
        turnId = try? container?.decode(String.self, forKey: .turnId)
        type = try? container?.decode(String.self, forKey: .type)
        model = try? container?.decode(String.self, forKey: .model)
        effort = try? container?.decode(String.self, forKey: .effort)
        reasoningEffort = try? container?.decode(String.self, forKey: .reasoningEffort)
        modelContextWindow = try? container?.decode(Int.self, forKey: .modelContextWindow)
        info = try? container?.decode(Info.self, forKey: .info)
        collaborationMode = try? container?.decode(Collaboration.self, forKey: .collaborationMode)
      }
    }
    struct Info: Decodable { let modelContextWindow: Int? }
    struct Collaboration: Decodable {
      let settings: Settings?
      struct Settings: Decodable { let reasoningEffort: String? }
    }
  }
}
