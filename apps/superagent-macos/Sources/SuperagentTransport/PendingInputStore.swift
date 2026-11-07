import Darwin
import Foundation
import SuperagentCore

/// The App's own unconfirmed outbox. It lives in the App support directory, never in the
/// service root or a worker's storage, and holds only the text a person typed.
public struct FilePendingInputStore: PendingInputStore {
  private let directory: URL
  private let file: URL
  public init(directory: URL) {
    self.directory = directory
    file = directory.appendingPathComponent("superagent-outbox.json")
  }

  public func save(_ input: PendingInput) async throws {
    var values = try load()
    guard !values.contains(where: { $0.id == input.id }) else { return }
    values.append(input)
    try write(values)
  }
  public func list() async throws -> [PendingInput] { try load() }
  public func remove(_ id: String) async throws {
    let values = try load().filter { $0.id != id }
    try write(values)
  }

  private func load() throws -> [PendingInput] {
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    var status = stat()
    guard file.path.withCString({ lstat($0, &status) }) == 0, (status.st_mode & S_IFMT) == S_IFREG,
      (status.st_mode & 0o777) == 0o600, status.st_size <= 256 * 1024
    else { throw SuperagentError.storage }
    let data = try Data(contentsOf: file)
    do { return try JSONDecoder().decode([PendingInput].self, from: data) } catch {
      throw SuperagentError.storage
    }
  }

  private func write(_ values: [PendingInput]) throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let body = try JSONEncoder().encode(values)
    guard body.count <= 256 * 1024 else { throw SuperagentError.storage }
    let temporary = directory.appendingPathComponent("superagent-outbox.\(UUID().uuidString).tmp")
    try body.write(to: temporary, options: [.atomic, .completeFileProtection])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
    if FileManager.default.fileExists(atPath: file.path) {
      _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary)
    } else {
      try FileManager.default.moveItem(at: temporary, to: file)
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }
}
