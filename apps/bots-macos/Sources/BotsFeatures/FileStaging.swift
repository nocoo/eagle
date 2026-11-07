import BotsCore
import CryptoKit
import Darwin
import Foundation

public final class DiskFilePort: FilePort {
  public static let maxFileBytes: Int64 = 52_428_800
  public static let maxSendScalars = 8_000
  public static let maxFiles = 16

  private let directory: URL
  private weak var uploader: ManagedFileUploadPort?

  public init(directory: URL, uploader: ManagedFileUploadPort) {
    self.directory = directory
    self.uploader = uploader
  }

  public func stage(
    text: String,
    selectedFiles: [URL],
    botId: String,
    requestId: String
  ) async throws -> StagedSend {
    try await Task.detached {
      try Self.stageSync(
        text: text, selectedFiles: selectedFiles, botId: botId,
        requestId: requestId, directory: self.directory
      )
    }.value
  }

  public func upload(_ file: StagedFile, botId: String) async throws -> String {
    guard let uploader else { throw ClientError("这个客户端不能上传文件") }
    let url = try await self.url(for: file)
    let metadata = try Self.metadataAt(url)
    guard metadata.size == file.size, metadata.sha256 == file.sha256 else {
      throw ClientError("附件快照已改变，消息没有发出")
    }
    return try await uploader.upload(botId: botId, file: file, from: url)
  }

  public func originalText(_ send: StagedSend) async throws -> String {
    guard let input = send.files.first(where: { $0.kind == .input }) else { return send.text }
    let url = try await self.url(for: input)
    guard let value = String(data: try Data(contentsOf: url), encoding: .utf8) else {
      throw ClientError("原文快照不可读")
    }
    return value
  }

  public func selectedURLs(_ send: StagedSend) async throws -> [URL] {
    try await send.files.filter { $0.kind == .selected }.asyncMap { try await self.url(for: $0) }
  }

  public func url(for file: StagedFile) async throws -> URL {
    let candidate = try Self.resolve(directory: directory, relativePath: file.relativePath)
    let fd = open(candidate.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw ClientError("附件快照不可读") }
    defer { close(fd) }
    var statValue = stat()
    guard fstat(fd, &statValue) == 0, (statValue.st_mode & mode_t(S_IFMT)) == S_IFREG else {
      throw ClientError("附件快照不可读")
    }
    return candidate
  }

  private static func stageSync(
    text: String,
    selectedFiles: [URL],
    botId: String,
    requestId: String,
    directory: URL
  ) throws -> StagedSend {
    let needsInput = text.unicodeScalars.count > Self.maxSendScalars
    let count = selectedFiles.count + (needsInput ? 1 : 0)
    guard count <= Self.maxFiles else { throw ClientError("附件最多只能选择 16 个") }

    try ensurePrivateDirectory(directory)
    try ensurePrivateDirectory(directory.appendingPathComponent("staging"))

    var staged: [StagedFile] = []
    if needsInput {
      let byteCount = text.utf8.count
      guard Int64(byteCount) <= Self.maxFileBytes else {
        throw ClientError("附件不能超过 50 MiB")
      }
      let data = Data(text.utf8)
      staged.append(
        try stageData(
          data,
          kind: .input,
          name: "input.md",
          mimeType: "text/markdown",
          botId: botId,
          requestId: requestId,
          index: 0,
          directory: directory
        )
      )
    }
    for (offset, source) in selectedFiles.enumerated() {
      staged.append(
        try stageSource(
          source,
          botId: botId,
          requestId: requestId,
          index: offset + (needsInput ? 1 : 0),
          directory: directory
        )
      )
    }
    return StagedSend(
      text: needsInput ? "The full message is attached as input.md." : text,
      files: staged
    )
  }

  private static func stageData(
    _ data: Data,
    kind: StagedFileKind,
    name: String,
    mimeType: String,
    botId: String,
    requestId: String,
    index: Int,
    directory: URL
  ) throws -> StagedFile {
    guard Int64(data.count) <= Self.maxFileBytes else { throw ClientError("附件不能超过 50 MiB") }
    var file = try metadataFile(
      kind: kind,
      name: name,
      mimeType: mimeType,
      botId: botId,
      requestId: requestId,
      index: index,
      directory: directory
    )
    let target = try resolve(directory: directory, relativePath: file.relativePath)
    try ensurePrivateDirectory(target.deletingLastPathComponent())

    let temp = target.deletingLastPathComponent()
      .appendingPathComponent(".\(file.uploadId).\(UUID().uuidString).tmp")
    let tempFd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard tempFd >= 0 else { throw ClientError("附件快照不能创建") }
    var tempOk = false
    defer {
      close(tempFd)
      if !tempOk { try? FileManager.default.removeItem(at: temp) }
    }
    var offset = 0
    try data.withUnsafeBytes { raw in
      let bytes = raw.bindMemory(to: UInt8.self)
      while offset < bytes.count {
        let written = Darwin.write(
          tempFd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if written > 0 {
          offset += written
        } else if errno == EINTR {
          continue
        } else {
          throw ClientError("附件快照写入失败")
        }
      }
    }
    guard fsync(tempFd) == 0 else { throw ClientError("附件快照写入失败") }

    let metadata = try metadataAt(temp)
    file.size = metadata.size
    file.sha256 = metadata.sha256

    if FileManager.default.fileExists(atPath: target.path) {
      let existing = try metadataAtTarget(target)
      guard existing.size == metadata.size, existing.sha256 == metadata.sha256 else {
        throw ClientError("同一待发请求的附件快照冲突")
      }
      tempOk = true
      try? FileManager.default.removeItem(at: temp)
      return file
    }

    if link(temp.path, target.path) != 0 {
      if errno == EEXIST {
        let existing = try metadataAtTarget(target)
        guard existing.size == metadata.size, existing.sha256 == metadata.sha256 else {
          throw ClientError("同一待发请求的附件快照冲突")
        }
        tempOk = true
        try? FileManager.default.removeItem(at: temp)
        return file
      }
      throw ClientError("附件快照写入失败")
    }
    tempOk = true
    try? FileManager.default.removeItem(at: temp)
    return file
  }

  private static func stageSource(
    _ source: URL,
    botId: String,
    requestId: String,
    index: Int,
    directory: URL
  ) throws -> StagedFile {
    var lstatBefore = stat()
    guard lstat(source.path, &lstatBefore) == 0,
      (lstatBefore.st_mode & mode_t(S_IFMT)) == S_IFREG
    else { throw ClientError("附件必须是普通文件") }

    let fd = open(source.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw ClientError("附件不可读") }
    defer { close(fd) }

    var fstatBefore = stat()
    guard fstat(fd, &fstatBefore) == 0, (fstatBefore.st_mode & mode_t(S_IFMT)) == S_IFREG else {
      throw ClientError("附件必须是普通文件")
    }
    guard fstatBefore.st_size >= 0, fstatBefore.st_size <= Self.maxFileBytes else {
      throw ClientError("附件不能超过 50 MiB")
    }

    let name = source.lastPathComponent
    guard Data(name.utf8).count <= 255 else { throw ClientError("附件名称太长") }
    var file = try metadataFile(
      kind: .selected,
      name: name,
      mimeType: Self.mimeType(for: source.pathExtension),
      botId: botId,
      requestId: requestId,
      index: index,
      directory: directory
    )
    let target = try resolve(directory: directory, relativePath: file.relativePath)
    try ensurePrivateDirectory(target.deletingLastPathComponent())

    let temp = target.deletingLastPathComponent()
      .appendingPathComponent(".\(file.uploadId).\(UUID().uuidString).tmp")
    let tempFd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard tempFd >= 0 else { throw ClientError("附件快照不能创建") }
    var tempOk = false
    defer {
      close(tempFd)
      if !tempOk { try? FileManager.default.removeItem(at: temp) }
    }

    var hasher = SHA256()
    var copied: Int64 = 0
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let readCount = Darwin.read(fd, &buffer, buffer.count)
      if readCount > 0 {
        copied += Int64(readCount)
        guard copied <= Self.maxFileBytes else { throw ClientError("附件不能超过 50 MiB") }
        let data = Data(bytes: buffer, count: readCount)
        hasher.update(data: data)
        var offset = 0
        try data.withUnsafeBytes { raw in
          let bytes = raw.bindMemory(to: UInt8.self)
          while offset < bytes.count {
            let written = Darwin.write(
              tempFd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if written > 0 {
              offset += written
            } else if errno == EINTR {
              continue
            } else {
              throw ClientError("附件快照写入失败")
            }
          }
        }
      } else if readCount == 0 {
        break
      } else if errno == EINTR {
        continue
      } else {
        throw ClientError("附件不可读")
      }
    }
    guard fsync(tempFd) == 0 else { throw ClientError("附件快照写入失败") }

    var fstatAfter = stat()
    guard fstat(fd, &fstatAfter) == 0, (fstatAfter.st_mode & mode_t(S_IFMT)) == S_IFREG else {
      throw ClientError("附件快照源在拷贝时改变")
    }
    var lstatAfter = stat()
    guard lstat(source.path, &lstatAfter) == 0,
      (lstatAfter.st_mode & mode_t(S_IFMT)) == S_IFREG,
      lstatBefore.st_dev == lstatAfter.st_dev,
      lstatBefore.st_ino == lstatAfter.st_ino,
      lstatBefore.st_size == lstatAfter.st_size,
      lstatBefore.st_mtimespec.tv_sec == lstatAfter.st_mtimespec.tv_sec,
      lstatBefore.st_mtimespec.tv_nsec == lstatAfter.st_mtimespec.tv_nsec,
      fstatBefore.st_dev == fstatAfter.st_dev,
      fstatBefore.st_ino == fstatAfter.st_ino,
      fstatBefore.st_size == fstatAfter.st_size,
      fstatBefore.st_mtimespec.tv_sec == fstatAfter.st_mtimespec.tv_sec,
      fstatBefore.st_mtimespec.tv_nsec == fstatAfter.st_mtimespec.tv_nsec,
      fstatAfter.st_size == copied
    else { throw ClientError("附件在拷贝时改变") }

    file.size = copied
    file.sha256 = Self.hex(hasher.finalize())

    if FileManager.default.fileExists(atPath: target.path) {
      let existing = try metadataAtTarget(target)
      guard existing.size == file.size, existing.sha256 == file.sha256 else {
        throw ClientError("同一待发请求的附件快照冲突")
      }
      tempOk = true
      try? FileManager.default.removeItem(at: temp)
      return file
    }

    if link(temp.path, target.path) != 0 {
      if errno == EEXIST {
        let existing = try metadataAtTarget(target)
        guard existing.size == file.size, existing.sha256 == file.sha256 else {
          throw ClientError("同一待发请求的附件快照冲突")
        }
        tempOk = true
        try? FileManager.default.removeItem(at: temp)
        return file
      }
      throw ClientError("附件快照写入失败")
    }
    tempOk = true
    try? FileManager.default.removeItem(at: temp)
    return file
  }

  private static func metadataFile(
    kind: StagedFileKind,
    name: String,
    mimeType: String,
    botId: String,
    requestId: String,
    index: Int,
    directory: URL
  ) throws -> StagedFile {
    let digest = SHA256.hash(data: Data("\(botId)\u{0}\(requestId)\u{0}\(index)".utf8))
    let suffix = hex(digest)
    let uploadId = "u_\(suffix.prefix(40))"
    let relative = "staging/\(requestId)/\(uploadId)/content\(kind == .input ? ".md" : "")"
    _ = directory
    return StagedFile(
      kind: kind,
      uploadId: uploadId,
      name: name,
      mimeType: mimeType,
      size: 0,
      sha256: "",
      relativePath: relative
    )
  }

  private static func resolve(directory: URL, relativePath: String) throws -> URL {
    guard !relativePath.hasPrefix("/"), !relativePath.components(separatedBy: "/").contains("..")
    else {
      throw ClientError("附件快照路径无效")
    }
    return directory.appendingPathComponent(relativePath).standardizedFileURL
  }

  private static func ensurePrivateDirectory(_ url: URL) throws {
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
      var lstatValue = stat()
      guard lstat(url.path, &lstatValue) == 0,
        (lstatValue.st_mode & mode_t(S_IFMT)) == S_IFDIR
      else { throw ClientError("附件快照目录无效") }
    } else {
      try FileManager.default.createDirectory(
        at: url,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    }
    var lstatValue = stat()
    guard lstat(url.path, &lstatValue) == 0, (lstatValue.st_mode & mode_t(S_IFMT)) == S_IFDIR else {
      throw ClientError("附件快照目录无效")
    }
    chmod(url.path, 0o700)
  }

  private static func metadataAt(_ url: URL) throws -> (size: Int64, sha256: String) {
    let fd = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw ClientError("附件快照不可读") }
    defer { close(fd) }
    var statValue = stat()
    guard fstat(fd, &statValue) == 0, (statValue.st_mode & mode_t(S_IFMT)) == S_IFREG else {
      throw ClientError("附件快照不可读")
    }
    var hasher = SHA256()
    var size: Int64 = 0
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let readCount = Darwin.read(fd, &buffer, buffer.count)
      if readCount > 0 {
        size += Int64(readCount)
        let data = Data(bytes: buffer, count: readCount)
        hasher.update(data: data)
      } else if readCount == 0 {
        break
      } else if errno == EINTR {
        continue
      } else {
        throw ClientError("附件快照不可读")
      }
    }
    guard size == statValue.st_size else { throw ClientError("附件快照不可读") }
    return (size, hex(hasher.finalize()))
  }

  private static func metadataAtTarget(_ url: URL) throws -> (size: Int64, sha256: String) {
    var lstatValue = stat()
    guard lstat(url.path, &lstatValue) == 0, (lstatValue.st_mode & mode_t(S_IFMT)) == S_IFREG else {
      throw ClientError("附件快照不可读")
    }
    return try metadataAt(url)
  }

  private static func mimeType(for pathExtension: String) -> String {
    switch pathExtension.lowercased() {
    case "txt", "log", "csv": return "text/plain"
    case "md", "markdown": return "text/markdown"
    case "json": return "application/json"
    case "pdf": return "application/pdf"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    default: return "application/octet-stream"
    }
  }

  private static func hex(_ digest: SHA256.Digest) -> String {
    digest.map { String(format: "%02x", $0) }.joined()
  }
}

extension Array {
  fileprivate func asyncMap<T>(_ transform: (Element) async throws -> T) async rethrows -> [T] {
    var result: [T] = []
    result.reserveCapacity(count)
    for element in self { result.append(try await transform(element)) }
    return result
  }
}
