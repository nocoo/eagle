import BotsCore
import BotsTransport
import Foundation

/// A terminal record kept after its outbox entry is removed, so a settlement is never
/// lost when the app closes before the client has stored it (PROTOCOL.md, client duties 2).
public struct SettledRequest: Codable, Sendable, Equatable, Identifiable {
  public var botId: String
  /// The submission the record belongs to: ranking is keyed on it (`I14`).
  public var submissionId: String
  public var requestId: String
  public var status: SubmissionStatus
  public var reason: String?
  public var entryId: String?
  public var answerEntryId: String?
  public var settledAt: String

  public var id: String { requestId }

  public init(
    botId: String,
    record: Submission,
    at: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.botId = botId
    submissionId = record.id
    requestId = record.requestId
    status = record.status
    reason = record.reason
    entryId = record.entryId
    answerEntryId = record.answerEntryId
    settledAt = at
  }
}

/// The client's persisted outbox (docs/bots/PROTOCOL.md, "Client duties"): a send is stored
/// before its frame is written, only a terminal record or `not_admitted` removes it, and a
/// terminal record is stored in the same atomic write that removes its entry.
public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
  public var botId: String
  public var requestId: String
  public var text: String
  public var whenBusy: BusyMode
  public var createdAt: String

  public var id: String { requestId }

  public init(
    botId: String,
    requestId: String,
    text: String,
    whenBusy: BusyMode = .followUp,
    createdAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.botId = botId
    self.requestId = requestId
    self.text = text
    self.whenBusy = whenBusy
    self.createdAt = createdAt
  }
}

private struct OutboxDocument: Codable {
  var entries: [OutboxEntry]
  var settled: [SettledRequest]
  /// Requests the daemon refused: they are never replayed, even if their entry could not
  /// be removed in the same write.
  var refused: [String]

  init(entries: [OutboxEntry] = [], settled: [SettledRequest] = [], refused: [String] = []) {
    self.entries = entries
    self.settled = settled
    self.refused = refused
  }

  private enum CodingKeys: String, CodingKey { case entries, settled, refused }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    entries = try container.decode([OutboxEntry].self, forKey: .entries)
    settled = try container.decodeIfPresent([SettledRequest].self, forKey: .settled) ?? []
    refused = try container.decodeIfPresent([String].self, forKey: .refused) ?? []
  }
}

public final class OutboxStore {
  /// Every window has its own view model, so writes re-read the file under one lock
  /// before merging: two windows must not overwrite each other's entries.
  private static let lock = NSLock()
  /// Terminal records are kept for the last this many requests.
  private static let settledLimit = 200

  private let directory: URL
  private let fileURL: URL
  /// Refusals are also written here when the support directory cannot be written, so a
  /// process restart still cannot replay a refused message.
  private let refusalFallback: URL
  private var cache: [OutboxEntry] = []
  private var settled: [SettledRequest] = []
  private var refused: [String] = []

  public init(directory: URL = AppPaths.supportDirectory) {
    self.directory = directory
    self.fileURL = directory.appendingPathComponent("outbox.json")
    self.refusalFallback = FileManager.default.temporaryDirectory
      .appendingPathComponent("ai.hexly.bots-refused", isDirectory: true)
    if let document = try? Self.read(fileURL) {
      cache = document.entries
      settled = document.settled
    }
  }

  /// Reads always come from the file: another window may have written since this one
  /// started, and an unreadable outbox is never reported as empty. Entries the daemon
  /// refused are never returned for replay.
  public func entries(for botId: String) throws -> [OutboxEntry] {
    let document = try reload()
    let refused = Set(document.refused).union(fallbackRefusals())
    return document.entries.filter { $0.botId == botId && !refused.contains($0.requestId) }
  }

  public func all() throws -> [OutboxEntry] { try reload().entries }

  public func settledRequests() throws -> [SettledRequest] { try reload().settled }

  public func refusedRequests() throws -> [String] {
    try Set(reload().refused).union(fallbackRefusals()).sorted()
  }

  public func add(_ entry: OutboxEntry) throws {
    try mutate { entries, settled, refused in
      var next = entries
      next.removeAll { $0.requestId == entry.requestId }
      next.append(entry)
      return (next, settled, refused)
    }
  }

  /// The durable tombstone of a refused command: the entry is removed and the request id is
  /// remembered in one atomic write, so a later reconciliation (even in a new process)
  /// cannot replay it.
  public func refuse(requestId: String) throws {
    do {
      try mutate { entries, settled, refused in
        var next = entries
        next.removeAll { $0.requestId == requestId }
        var ids = refused.filter { $0 != requestId }
        ids.append(requestId)
        if ids.count > Self.settledLimit { ids.removeFirst(ids.count - Self.settledLimit) }
        return (next, settled, ids)
      }
      try? removeFallbackRefusal(requestId)
    } catch {
      // The support directory is not writable right now: the tombstone still has to
      // survive a restart, so it goes to a user-private temporary directory.
      try writeFallbackRefusal(requestId)
    }
  }

  private func fallbackRefusals() -> Set<String> {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: refusalFallback.path)) ?? []
    return Set(names)
  }

  private func writeFallbackRefusal(_ requestId: String) throws {
    do {
      try FileManager.default.createDirectory(
        at: refusalFallback,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      try Data().write(to: refusalFallback.appendingPathComponent(requestId), options: .atomic)
    } catch {
      throw ClientError("the refusal could not be recorded")
    }
  }

  private func removeFallbackRefusal(_ requestId: String) throws {
    try? FileManager.default.removeItem(at: refusalFallback.appendingPathComponent(requestId))
  }

  /// A refused command is not a settlement: its entry goes away and the text becomes a
  /// draft, so nothing is recorded for it.
  public func remove(requestId: String) throws {
    try mutate { entries, settled, refused in
      var next = entries
      next.removeAll { $0.requestId == requestId }
      return (next, settled, refused)
    }
  }

  /// Removes the entry only after its terminal record is in the same atomic write.
  public func settle(_ record: Submission, botId: String) throws {
    try mutate { entries, settled, refused in
      var next = entries
      next.removeAll { $0.requestId == record.requestId }
      var records = settled.filter { $0.requestId != record.requestId }
      records.append(SettledRequest(botId: botId, record: record))
      if records.count > Self.settledLimit {
        records.removeFirst(records.count - Self.settledLimit)
      }
      return (next, records, refused)
    }
  }

  private func reload() throws -> OutboxDocument {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    let document = try Self.read(fileURL)
    cache = document.entries
    settled = document.settled
    refused = document.refused
    return document
  }

  /// Read-modify-write under the process lock. A read or decode failure fails the
  /// mutation and leaves the file untouched.
  private func mutate(
    _ change: ([OutboxEntry], [SettledRequest], [String]) -> (
      [OutboxEntry], [SettledRequest], [String]
    )
  ) throws {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    let document = try Self.read(fileURL)
    let (entries, settled, refused) = change(
      document.entries,
      document.settled,
      document.refused
    )
    self.cache = entries
    self.settled = settled
    self.refused = refused
    try persist()
  }

  private static func read(_ url: URL) throws -> OutboxDocument {
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch let error as NSError where error.code == NSFileReadNoSuchFileError {
      return OutboxDocument(entries: [], settled: [])
    } catch {
      throw ClientError("the outbox file is unreadable")
    }
    if let document = try? JSONDecoder().decode(OutboxDocument.self, from: data) {
      return document
    }
    // The file used to be a bare array; both shapes are accepted.
    if let entries = try? JSONDecoder().decode([OutboxEntry].self, from: data) {
      return OutboxDocument(entries: entries, settled: [])
    }
    throw ClientError("the outbox file is unreadable")
  }

  private func persist() throws {
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let data = try JSONEncoder().encode(
      OutboxDocument(entries: cache, settled: settled, refused: refused)
    )
    try data.write(to: fileURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
  }
}
