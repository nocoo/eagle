import Darwin
import Foundation

/// The Bot service's saved gateway, read for one purpose: the person's own model account can
/// seed the independent Super Bot instead of being typed twice. The daemon never returns the
/// key over its API, so the App reads the private file the daemon already writes — once. From
/// then on the Super Bot's configuration is its own and this file is not read again unless a
/// person asks for it.
struct BotsGatewayCredential: Equatable {
  let baseUrl: String
  let model: String
  let thinkingLevel: String
  let apiKey: String

  /// A file another account can read, a symlink or anything but a regular 0600 file owned by
  /// this person is refused: an unsafe credential is not inherited.
  static func read(root: URL) -> BotsGatewayCredential? {
    let url = root.appendingPathComponent("gateway.json")
    var entry = stat()
    guard url.path.withCString({ lstat($0, &entry) }) == 0,
      (entry.st_mode & S_IFMT) == S_IFREG, entry.st_uid == getuid(),
      (entry.st_mode & 0o777) == 0o600, entry.st_size > 0, entry.st_size <= 1 << 20
    else { return nil }
    let descriptor = url.path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) }
    guard descriptor >= 0 else { return nil }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    guard let data = try? handle.readToEnd(),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    func text(_ key: String) -> String {
      (object[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    let baseUrl = text("baseUrl")
    let model = text("model")
    let apiKey = text("apiKey")
    guard !baseUrl.isEmpty, !model.isEmpty, !apiKey.isEmpty else { return nil }
    let level = text("thinkingLevel")
    return BotsGatewayCredential(
      baseUrl: baseUrl, model: model, thinkingLevel: level.isEmpty ? "medium" : level,
      apiKey: apiKey)
  }
}
