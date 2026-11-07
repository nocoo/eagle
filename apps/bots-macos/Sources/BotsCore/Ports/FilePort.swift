import Foundation

public enum StagedFileKind: String, Codable, Sendable {
  case input
  case selected
}

public struct StagedFile: Codable, Sendable, Equatable, Identifiable {
  public var id: String { uploadId }
  public var kind: StagedFileKind
  public var uploadId: String
  public var name: String
  public var mimeType: String
  public var size: Int64
  public var sha256: String
  public var relativePath: String
  public var fileId: String?

  public init(
    kind: StagedFileKind,
    uploadId: String,
    name: String,
    mimeType: String,
    size: Int64,
    sha256: String,
    relativePath: String,
    fileId: String? = nil
  ) {
    self.kind = kind
    self.uploadId = uploadId
    self.name = name
    self.mimeType = mimeType
    self.size = size
    self.sha256 = sha256
    self.relativePath = relativePath
    self.fileId = fileId
  }
}

public struct StagedSend: Codable, Sendable, Equatable {
  public var text: String
  public var files: [StagedFile]

  public init(text: String, files: [StagedFile] = []) {
    self.text = text
    self.files = files
  }
}

public protocol FilePort: AnyObject {
  func stage(
    text: String, selectedFiles: [URL], botId: String, requestId: String
  ) async throws
    -> StagedSend
  func upload(_ file: StagedFile, botId: String) async throws -> String
  func originalText(_ send: StagedSend) async throws -> String
  func selectedURLs(_ send: StagedSend) async throws -> [URL]
  func url(for file: StagedFile) async throws -> URL
}

public protocol ManagedFileUploadPort: AnyObject {
  func upload(botId: String, file: StagedFile, from url: URL) async throws -> String
}

public enum FileTransportFailure: Error, Equatable, Sendable {
  case authentication
  case redirect
  case refused(Int)
  case invalidResponse
}
