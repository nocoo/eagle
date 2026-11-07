import BotsCore
import BotsTransport
import CryptoKit
import Foundation
import XCTest

private final class ManagedFileStubProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (Int, [String: String]?, Data))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    do {
      let tuple = try Self.handler?(request) ?? (404, nil, Data())
      let response = HTTPURLResponse(
        url: request.url!, statusCode: tuple.0,
        httpVersion: "HTTP/1.1", headerFields: tuple.1
      )!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: tuple.2)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

final class ManagedFileHTTPTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("bots-http-file-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    ManagedFileStubProtocol.handler = nil
    try? FileManager.default.removeItem(at: root)
  }

  private func client() -> ManagedFileHTTPClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagedFileStubProtocol.self]
    let session = URLSession(configuration: configuration)
    return ManagedFileHTTPClient(
      baseURL: URL(string: "http://127.0.0.1:9")!,
      token: "test-token-0123456789",
      session: session
    )
  }

  private func staged(size: Int = 3) throws -> (StagedFile, URL) {
    let url = root.appendingPathComponent("file.bin")
    let data = Data((0..<size).map { UInt8($0 % 251) })
    try data.write(to: url)
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let file = StagedFile(
      kind: .selected,
      uploadId: "u_0123456789abcdef",
      name: "file.bin",
      mimeType: "application/octet-stream",
      size: Int64(data.count),
      sha256: digest,
      relativePath: "staging/r_http/file.bin"
    )
    return (file, url)
  }

  func testManifestAndContentRetryKeysAndStreamTheFile() async throws {
    let (file, url) = try staged()
    var manifestCalls = 0
    var contentCalls = 0
    ManagedFileStubProtocol.handler = { request in
      if request.url?.path.hasSuffix("/manifest") == true {
        manifestCalls += 1
        XCTAssertEqual(request.httpMethod, "PUT")
        let id = "f_\(String(repeating: "a", count: 64))"
        return (
          201, ["content-type": "application/json"],
          Data(
            "{\"file\":{\"id\":\"\(id)\",\"status\":\"uploading\",\"size\":\(file.size),\"sha256\":\"\(file.sha256)\"}}"
              .utf8)
        )
      }
      contentCalls += 1
      XCTAssertEqual(request.httpMethod, "PUT")
      let id = "f_\(String(repeating: "a", count: 64))"
      return (
        201, ["content-type": "application/json"],
        Data(
          "{\"file\":{\"id\":\"\(id)\",\"status\":\"complete\",\"size\":\(file.size),\"sha256\":\"\(file.sha256)\"}}"
            .utf8)
      )
    }

    let id = try await client().upload(botId: "b_1", file: file, from: url)
    XCTAssertEqual(id, "f_\(String(repeating: "a", count: 64))")
    XCTAssertEqual(manifestCalls, 1)
    XCTAssertEqual(contentCalls, 1)
  }

  func testRedirectAndAuthenticationFailClosed() async throws {
    let (file, url) = try staged()
    ManagedFileStubProtocol.handler = { _ in
      (302, ["location": "http://other.example/secret"], Data())
    }
    do {
      _ = try await client().upload(botId: "b_1", file: file, from: url)
      XCTFail("redirect must fail")
    } catch let error as FileTransportFailure {
      XCTAssertEqual(error, .redirect)
    } catch {
      XCTFail("redirect must classify as FileTransportFailure.redirect")
    }

    ManagedFileStubProtocol.handler = { _ in
      (401, ["content-type": "application/json"], Data())
    }
    do {
      _ = try await client().upload(botId: "b_1", file: file, from: url)
      XCTFail("401 must fail")
    } catch let error as FileTransportFailure {
      XCTAssertEqual(error, .authentication)
    }

    var calls = 0
    ManagedFileStubProtocol.handler = { _ in
      calls += 1
      return (403, ["content-type": "application/json"], Data())
    }
    do {
      _ = try await client().upload(botId: "b_1", file: file, from: url)
      XCTFail("403 must fail")
    } catch let error as FileTransportFailure {
      XCTAssertEqual(error, .authentication)
    }
    XCTAssertEqual(calls, 1, "auth failure does not add a retry")
  }

  private func jsonString(_ value: String?) -> String {
    guard let value else { return "null" }
    return "\"\(value)\""
  }
}
