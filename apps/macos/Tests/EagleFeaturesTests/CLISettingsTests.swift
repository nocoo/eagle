import Foundation
import Testing

@testable import EagleFeatures

/// Answers the `/v1/clients` surface and records what the App asked for.
final class CLITransport: URLProtocol, @unchecked Sendable {
  struct Call: Sendable {
    let method: String
    let path: String
    let bearer: String?
    let body: String?
  }

  nonisolated(unsafe) static var calls: [Call] = []
  nonisolated(unsafe) static var clients: [String] = []
  nonisolated(unsafe) static var issueCount = 0

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    let path = request.url?.path ?? ""
    Self.calls.append(
      Call(
        method: request.httpMethod ?? "GET", path: path,
        bearer: request.value(forHTTPHeaderField: "authorization"),
        body: Self.body(of: request)))
    let (status, body) = answer(method: request.httpMethod ?? "GET", path: path)
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["content-type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  private func answer(method: String, path: String) -> (Int, String) {
    if method == "GET" { return (200, #"{"clients":[\#(Self.clients.joined(separator: ","))]}"#) }
    if method == "POST", path == "/v1/clients" {
      Self.issueCount += 1
      let name = nameInBody(request: request)
      let client = Self.client(id: "c_new_\(Self.issueCount)", name: name)
      Self.clients.append(client)
      return (201, #"{"client":\#(client),"token":"c_new_\#(Self.issueCount).secret"}"#)
    }
    if method == "POST", path.hasSuffix("/revoke") {
      return (
        200,
        #"{"client":{"id":"c_1","name":"本机 CLI","scopes":["read","write"],"createdAt":"2026-11-01T00:00:00.000Z","revokedAt":"2026-11-01T01:00:00.000Z"}}"#
      )
    }
    if method == "DELETE" { return (204, "") }
    return (404, #"{"error":{"kind":"unknown_path","message":"no stub"}}"#)
  }

  /// URLSession hands a URLProtocol the body as a stream, not as `httpBody`.
  nonisolated static func body(of request: URLRequest) -> String? {
    if let data = request.httpBody { return String(decoding: data, as: UTF8.self) }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 { break }
      data.append(buffer, count: read)
    }
    return String(decoding: data, as: UTF8.self)
  }

  private nonisolated func nameInBody(request: URLRequest) -> String {
    guard let body = Self.body(of: request), let data = body.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let name = object["name"] as? String
    else { return "unknown" }
    return name
  }

  nonisolated static func client(id: String, name: String, revoked: Bool = false) -> String {
    let revokedAt = revoked ? #","revokedAt":"2026-11-01T01:00:00.000Z""# : ""
    return
      #"{"id":"\#(id)","name":"\#(name)","scopes":["read","write"],"createdAt":"2026-11-01T00:00:00.000Z"\#(revokedAt)}"#
  }
}

@Suite("CLI settings", .serialized)
@MainActor
struct CLISettingsTests {
  private func fixture(release: Bool = false) throws -> (CLISettingsViewModel, URL, URL, URL) {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-cli-settings-\(UUID().uuidString)", isDirectory: true)
    let home = base.appendingPathComponent("home", isDirectory: true)
    let root = base.appendingPathComponent("bots", isDirectory: true)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data(String(repeating: "t", count: 48).utf8)
      .write(to: root.appendingPathComponent("token"))
    let binary = base.appendingPathComponent("Helpers/eagle-dev", isDirectory: false)
    try FileManager.default.createDirectory(
      at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\n".utf8).write(to: binary)

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CLITransport.self]
    let model = CLISettingsViewModel(
      appVersion: AppVersion(short: "1.2.3", build: "1", isRelease: release),
      botsSettings: BotsSettings(rootPath: root.path, port: "44000"),
      session: URLSession(configuration: configuration),
      home: home,
      binaryURL: binary,
      environment: ["PATH": "/usr/bin:/bin"])
    CLITransport.calls = []
    CLITransport.clients = []
    CLITransport.issueCount = 0
    return (model, home, root, binary)
  }

  @Test("a released App installs `eagle`, every other build keeps its own name")
  func names() throws {
    let (dev, _, _, _) = try fixture()
    #expect(dev.commandName == "eagle-dev")
    let (release, _, _, _) = try fixture(release: true)
    #expect(release.commandName == "eagle")
    #expect(release.linkURL.lastPathComponent == "eagle")
  }

  @Test("enabling links the command, issues one credential and writes a 0600 config")
  func enable() async throws {
    let (model, home, _, binary) = try fixture()
    await model.enable()
    #expect(model.failure == nil)
    #expect(model.installed)

    let link = home.appendingPathComponent(".local/bin/eagle-dev")
    let destination = try FileManager.default.destinationOfSymbolicLink(atPath: link.path)
    #expect(
      URL(fileURLWithPath: destination).resolvingSymlinksInPath().path
        == binary.resolvingSymlinksInPath().path)

    let config = try Data(
      contentsOf: home.appendingPathComponent(".config/eagle/eagle-dev.json"))
    let object = try #require(try JSONSerialization.jsonObject(with: config) as? [String: Any])
    #expect(object["token"] as? String == "c_new_1.secret")
    #expect(object["client"] as? String == "本机 CLI")
    #expect(object["port"] as? String == "44000")
    let attributes = try FileManager.default.attributesOfItem(
      atPath: home.appendingPathComponent(".config/eagle/eagle-dev.json").path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(CLITransport.calls.contains { $0.path == "/v1/clients" && $0.method == "POST" })
  }

  @Test("disabling unlinks, removes the config and revokes this machine's credential")
  func disable() async throws {
    let (model, home, _, _) = try fixture()
    CLITransport.clients = [CLITransport.client(id: "c_1", name: "本机 CLI")]
    await model.enable()
    await model.disable()
    #expect(
      !FileManager.default.fileExists(
        atPath: home.appendingPathComponent(".local/bin/eagle-dev").path))
    #expect(
      !FileManager.default.fileExists(
        atPath: home.appendingPathComponent(".config/eagle/eagle-dev.json").path))
    #expect(CLITransport.calls.contains { $0.path == "/v1/clients/c_1/revoke" })
    #expect(!model.installed)
  }

  @Test("only a revoked credential can be deleted")
  func deleteNeedsRevoked() async throws {
    let (model, _, _, _) = try fixture()
    CLITransport.clients = [
      CLITransport.client(id: "c_live", name: "claude-code"),
      CLITransport.client(id: "c_dead", name: "old-agent", revoked: true),
    ]
    await model.load()
    #expect(model.activeClients.map(\.id) == ["c_live"])
    #expect(model.revokedClients.map(\.id) == ["c_dead"])

    await model.delete("c_live")
    #expect(!CLITransport.calls.contains { $0.method == "DELETE" }, "an active credential stays")

    await model.delete("c_dead")
    #expect(
      CLITransport.calls.contains { $0.method == "DELETE" && $0.path == "/v1/clients/c_dead" })
  }

  @Test("a new credential is answered once and named in lower case")
  func issue() async throws {
    let (model, _, _, _) = try fixture()
    await model.issue(name: "  Claude-Code ", scopes: ["read"])
    #expect(model.issuedToken == "c_new_1.secret")
    let body = try #require(CLITransport.calls.first { $0.method == "POST" }?.body)
    #expect(body.contains("\"claude-code\""))
    model.dismissIssuedToken()
    #expect(model.issuedToken == nil)
  }

  @Test("a source run has no bundled command and says where the PATH line goes")
  func sourceRun() throws {
    let (model, _, _, _) = try fixture()
    let sourceRun = CLISettingsViewModel(
      appVersion: AppVersion(short: "dev", build: "1", isRelease: false),
      botsSettings: BotsSettings(rootPath: "/tmp/root", port: "43117"),
      binaryURL: nil, environment: ["PATH": "/usr/bin:/bin"])
    #expect(!sourceRun.canInstall)
    #expect(sourceRun.pathHint != nil, "~/.local/bin is not on PATH here")
    #expect(model.pathHint != nil)
    #expect(CLISettingsViewModel.bundledCommand(in: URL(fileURLWithPath: "/tmp/none")) == nil)
  }
}
