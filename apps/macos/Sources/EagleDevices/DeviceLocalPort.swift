import Darwin
import Foundation

/// The helper may read the shared socket, but management never travels through it.
public struct DeviceLocalPort: Sendable {
  public let path: String
  public init(path: String) { self.path = path }

  public func call(_ method: String, params: DeviceJSON? = nil) async throws -> DeviceJSON {
    try await Task.detached {
      try Self.callBlocking(path: path, method: method, params: params)
    }.value
  }

  private static func callBlocking(
    path: String, method: String, params: DeviceJSON?
  ) throws -> DeviceJSON {
    var info = stat()
    guard path.hasPrefix("/"), path.utf8.count < 104, lstat(path, &info) == 0,
      info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid(), info.st_mode & 0o077 == 0
    else { throw DeviceHostError.unavailable }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw DeviceHostError.unavailable }
    defer { Darwin.close(fd) }
    var timeout = timeval(tv_sec: 15, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSignal: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { storage in
      storage.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) })
    }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else { throw DeviceHostError.unavailable }
    let id = UUID().uuidString.lowercased()
    var request: [String: DeviceJSON] = [
      "version": .number(2), "requestId": .string(id), "method": .string(method),
    ]
    if let params { request["params"] = params }
    var data = try JSONEncoder().encode(DeviceJSON.object(request))
    guard data.count <= 524288 else { throw DeviceHostError.invalidConfiguration }
    data.append(10)
    try data.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let sent = Darwin.write(fd, buffer.baseAddress?.advanced(by: offset), buffer.count - offset)
        guard sent > 0 else { throw DeviceHostError.unavailable }
        offset += sent
      }
    }
    var response = Data()
    var chunk = [UInt8](repeating: 0, count: 8192)
    while response.count <= 524288 {
      let count = Darwin.read(fd, &chunk, chunk.count)
      guard count > 0 else { throw DeviceHostError.unavailable }
      response.append(contentsOf: chunk.prefix(count))
      if let end = response.firstIndex(of: 10) {
        guard end <= 524288 else { throw DeviceHostError.invalidResponse }
        let value = try JSONDecoder().decode(DeviceJSON.self, from: response.prefix(upTo: end))
        guard value["version"] == .number(2), value["requestId"]?.string == id else {
          throw DeviceHostError.invalidResponse
        }
        if let error = value["error"]?.string { throw DevicePortError(error) }
        guard let result = value["result"] else { throw DeviceHostError.invalidResponse }
        return result
      }
    }
    throw DeviceHostError.invalidResponse
  }
}
