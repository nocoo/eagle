import BotsCore
import CryptoKit
import Foundation

public final class ManagedFileHTTPClient: @unchecked Sendable {
  private struct ManagedFilePayload: Decodable {
    let file: ManagedFileWire
  }

  private struct ManagedFileWire: Decodable {
    let id: String
    let botId: String?
    let uploadId: String?
    let name: String?
    let mimeType: String?
    let status: String
    let size: Int64
    let sha256: String
  }

  private let baseURL: URL
  private let token: String
  private let session: URLSession
  private let redirectDelegate: ManagedFileRedirectDelegate

  public init(
    baseURL: URL,
    token: String,
    session: URLSession? = nil
  ) {
    self.baseURL = baseURL
    self.token = token
    let redirectDelegate = ManagedFileRedirectDelegate()
    self.redirectDelegate = redirectDelegate
    if let session {
      let configuration = session.configuration
      configuration.protocolClasses = session.configuration.protocolClasses
      self.session = URLSession(
        configuration: configuration,
        delegate: redirectDelegate,
        delegateQueue: nil
      )
    } else {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      self.session = URLSession(
        configuration: configuration,
        delegate: redirectDelegate,
        delegateQueue: nil
      )
    }
  }

  public func upload(botId: String, file: StagedFile, from url: URL) async throws -> String {
    redirectDelegate.reset()
    let metadata = try Self.metadata(at: url)
    guard metadata.size == file.size,
      metadata.sha256 == file.sha256,
      file.size <= 52_428_800
    else { throw FileTransportFailure.invalidResponse }

    let manifestPath = "/v1/bots/\(botId)/files/\(file.uploadId)/manifest"
    let manifestResponse = try await request(
      path: manifestPath,
      method: "PUT",
      body: try JSONEncoder().encode(
        ManifestBody(
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256
        ))
    )
    guard manifestResponse.status == 200 || manifestResponse.status == 201 else {
      throw statusFailure(manifestResponse.status)
    }
    let manifestFile = try JSONDecoder().decode(
      ManagedFilePayload.self, from: manifestResponse.data
    ).file
    guard manifestFile.size == file.size,
      manifestFile.sha256 == file.sha256,
      Self.validFileId(manifestFile.id)
    else { throw FileTransportFailure.invalidResponse }

    if manifestFile.status == "complete" {
      guard manifestFile.botId == botId,
        manifestFile.uploadId == file.uploadId,
        manifestFile.name == file.name,
        manifestFile.mimeType == file.mimeType
      else { throw FileTransportFailure.invalidResponse }
      return manifestFile.id
    }
    guard manifestFile.status == "uploading"
    else { throw FileTransportFailure.invalidResponse }

    let contentPath = "/v1/bots/\(botId)/files/\(file.uploadId)/content"
    let contentResponse = try await uploadFile(
      path: contentPath, from: url, mimeType: file.mimeType)
    guard contentResponse.status == 200 || contentResponse.status == 201 else {
      throw statusFailure(contentResponse.status)
    }
    let contentFile = try JSONDecoder().decode(ManagedFilePayload.self, from: contentResponse.data)
      .file
    guard contentFile.status == "complete",
      contentFile.id == manifestFile.id,
      contentFile.botId == botId,
      contentFile.uploadId == file.uploadId,
      contentFile.name == file.name,
      contentFile.mimeType == file.mimeType,
      contentFile.size == file.size,
      contentFile.sha256 == file.sha256
    else { throw FileTransportFailure.invalidResponse }
    return contentFile.id
  }

  private func request(
    path: String, method: String, body: Data
  ) async throws
    -> (status: Int, data: Data)
  {
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      if redirectDelegate.redirected { throw FileTransportFailure.redirect }
      throw error
    }
    guard let http = response as? HTTPURLResponse else {
      throw FileTransportFailure.invalidResponse
    }
    return (http.statusCode, data)
  }

  private func uploadFile(
    path: String, from url: URL, mimeType: String
  ) async throws
    -> (status: Int, data: Data)
  {
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = "PUT"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.upload(for: request, fromFile: url)
    } catch {
      if redirectDelegate.redirected { throw FileTransportFailure.redirect }
      throw error
    }
    guard let http = response as? HTTPURLResponse else {
      throw FileTransportFailure.invalidResponse
    }
    return (http.statusCode, data)
  }

  private func statusFailure(_ status: Int) -> FileTransportFailure {
    if (300..<400).contains(status) { return .redirect }
    if status == 401 || status == 403 { return .authentication }
    return .refused(status)
  }

  private struct ManifestBody: Encodable {
    let name: String
    let mimeType: String
    let size: Int64
    let sha256: String
  }

  private static func validFileId(_ id: String) -> Bool {
    guard id.count == 66, id.hasPrefix("f_") else { return false }
    return id.dropFirst(2).allSatisfy { $0.isHexDigit }
  }

  private static func metadata(at url: URL) throws -> (size: Int64, sha256: String) {
    let handle: FileHandle
    do { handle = try FileHandle(forReadingFrom: url) } catch {
      throw FileTransportFailure.invalidResponse
    }
    defer { try? handle.close() }
    var hasher = SHA256()
    var size: Int64 = 0
    while true {
      let chunk = try handle.read(upToCount: 64 * 1024) ?? Data()
      if chunk.isEmpty { break }
      size += Int64(chunk.count)
      hasher.update(data: chunk)
    }
    let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return (size, digest)
  }
}

private final class ManagedFileRedirectDelegate: NSObject, URLSessionTaskDelegate,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var wasRedirected = false

  var redirected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return wasRedirected
  }

  func reset() {
    lock.lock()
    wasRedirected = false
    lock.unlock()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    lock.lock()
    wasRedirected = true
    lock.unlock()
    completionHandler(nil)
  }
}
