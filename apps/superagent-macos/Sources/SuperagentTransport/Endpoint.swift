import Darwin
import Foundation
import SuperagentCore

public struct SuperagentEndpoint: Sendable, Equatable {
  public let root: URL
  public let port: Int
  public let tokenOverride: String?
  public init(root: URL, port: Int, tokenOverride: String? = nil) throws {
    guard root.isFileURL, (1...65535).contains(port) else {
      throw SuperagentError.protocolViolation
    }
    self.root = root.standardizedFileURL
    self.port = port
    self.tokenOverride = tokenOverride
  }
  public var address: String { "127.0.0.1:\(port)" }
  public var socketURL: URL { URL(string: "ws://\(address)/v1/chat")! }
  public var healthURL: URL { URL(string: "http://\(address)/v1/health")! }
  public static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment, home: String? = nil,
    release: Bool = false
  ) throws -> SuperagentEndpoint {
    let home = home ?? environment["HOME"] ?? NSHomeDirectory()
    var path =
      environment["SUPERAGENT_ROOT"] ?? home + "/.local/share/"
      + (release ? "eagle-superagent" : "eagle-superagent-dev")
    if path.hasPrefix("~/") { path = home + String(path.dropFirst()) }
    guard (path as NSString).isAbsolutePath,
      let port = Int(environment["SUPERAGENT_PORT"] ?? (release ? "43128" : "43127"))
    else { throw SuperagentError.protocolViolation }
    return try SuperagentEndpoint(
      root: URL(fileURLWithPath: path), port: port, tokenOverride: environment["SUPERAGENT_TOKEN"])
  }
}

public enum SuperagentCredentials {
  public static func read(_ endpoint: SuperagentEndpoint) throws -> String {
    var rootInfo = stat()
    let root = endpoint.root.resolvingSymlinksInPath()
    guard root.path.withCString({ lstat($0, &rootInfo) }) == 0,
      (rootInfo.st_mode & S_IFMT) == S_IFDIR, rootInfo.st_uid == getuid(),
      (rootInfo.st_mode & 0o777) == 0o700
    else { throw SuperagentError.credential }
    if let explicit = endpoint.tokenOverride {
      guard IdentityProof.validHex(explicit, length: 64) else { throw SuperagentError.credential }
      return explicit
    }
    let descriptor = root.appendingPathComponent("token").path.withCString {
      open($0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    }
    guard descriptor >= 0 else { throw SuperagentError.credential }
    let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? file.close() }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
      info.st_uid == getuid(), (info.st_mode & 0o777) == 0o600,
      info.st_size >= 64, info.st_size <= 256,
      let data = try? file.read(upToCount: 257), data.count <= 256,
      let text = String(data: data, encoding: .utf8)
    else { throw SuperagentError.credential }
    let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard IdentityProof.validHex(token, length: 64) else { throw SuperagentError.credential }
    return token
  }
}
