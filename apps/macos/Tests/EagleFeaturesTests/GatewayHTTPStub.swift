import Foundation

@testable import EagleFeatures

/// Intercepts catalog HTTP for settings gateway tests without a live daemon.
final class GatewayHTTPStub: URLProtocol {
  private final class Storage: @unchecked Sendable {
    var handler: ((URLRequest) throws -> (Int, Data))?
  }

  private static let storage = Storage()

  static var handler: ((URLRequest) throws -> (Int, Data))? {
    get { storage.handler }
    set { storage.handler = newValue }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    do {
      let (status, data) = try handler(request)
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
      )!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

func gatewayHTTPBody(_ request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
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
  return data
}

@MainActor
func settingsGatewayFixture() throws -> (BotsSettings, URLSession) {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("settings-gateway-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let tokenURL = root.appendingPathComponent("token")
  try "test-token-01234567890123456789012".write(to: tokenURL, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
  let settings = BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"])
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [GatewayHTTPStub.self]
  let session = URLSession(configuration: configuration)
  return (settings, session)
}
