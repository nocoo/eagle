import Darwin
import Foundation
import Testing

private final class VersionTestBundle {}

@Suite("CLI version")
struct VersionTests {
  @Test("the installed CLI finds its app version when invoked through PATH")
  func versionThroughPath() throws {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-version-\(UUID().uuidString)", isDirectory: true)
    let helper = home.appendingPathComponent("Eagle.app/Contents/Helpers/eagle")
    let bin = home.appendingPathComponent("bin", isDirectory: true)
    try FileManager.default.createDirectory(
      at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }

    let source = Bundle(for: VersionTestBundle.self).bundleURL
      .deletingLastPathComponent().appendingPathComponent("eagle-cli")
    try FileManager.default.copyItem(at: source, to: helper)
    let plist = try PropertyListSerialization.data(
      fromPropertyList: ["CFBundleShortVersionString": "9.8.7"], format: .xml, options: 0)
    try plist.write(to: home.appendingPathComponent("Eagle.app/Contents/Info.plist"))
    try FileManager.default.createSymbolicLink(
      at: bin.appendingPathComponent("eagle"), withDestinationURL: helper)

    let listener = socket(AF_INET, SOCK_STREAM, 0)
    try #require(listener >= 0)
    defer { close(listener) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    try #require(bound == 0)
    try #require(listen(listener, 1) == 0)
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        getsockname(listener, $0, &length)
      }
    }
    try #require(named == 0)
    let port = UInt16(bigEndian: address.sin_port)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["eagle", "--version"]
    process.currentDirectoryURL = home
    process.environment = ["PATH": bin.path, "HOME": home.path, "EAGLE_PORT": String(port)]
    let output = Pipe()
    process.standardOutput = output
    try process.run()
    defer {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
    }
    var ready = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
    try #require(poll(&ready, 1, 10_000) == 1)
    let client = accept(listener, nil, nil)
    try #require(client >= 0)
    defer { close(client) }
    var noSignal: Int32 = 1
    try #require(
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        == 0)
    let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
    var request: [UInt8] = []
    while !String(decoding: request, as: UTF8.self).contains("\r\n") {
      let now = DispatchTime.now().uptimeNanoseconds
      try #require(now < deadline && request.count < 4096)
      ready = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
      let remaining = Int32((deadline - now + 999_999) / 1_000_000)
      try #require(poll(&ready, 1, remaining) == 1)
      var part = [UInt8](repeating: 0, count: 4096 - request.count)
      let count = read(client, &part, part.count)
      try #require(count > 0)
      request.append(contentsOf: part.prefix(count))
    }
    #expect(String(decoding: request, as: UTF8.self).hasPrefix("GET /v1/health "))
    let body = #"{"version":"1"}"#
    let response =
      "HTTP/1.1 200 OK\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
    let sent = response.withCString { write(client, $0, response.utf8.count) }
    #expect(sent == response.utf8.count)
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
    #expect(text.contains("eagle 9.8.7"))
    #expect(text.contains("daemon 1"))
  }
}
