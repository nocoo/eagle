import Darwin
import Foundation

/// One skill a scan found: the directory that holds it and what its `SKILL.md` says about it.
public struct SkillEntry: Identifiable, Hashable, Sendable {
  /// The path the skill really lives at, with every link resolved: the one identity two
  /// ways in to the same skill share.
  public let id: String
  public let name: String
  /// The version the front matter states, wherever it states it; empty when it states none.
  public let version: String
  public let description: String
  public let directory: URL

  public init(
    id: String, name: String, version: String, description: String, directory: URL
  ) {
    self.id = id
    self.name = name
    self.version = version
    self.description = description
    self.directory = directory
  }
}

/// What one scan root answered. A root that cannot be read says so on its own row; it never
/// fails the whole scan.
public enum SkillRootStatus: Hashable, Sendable {
  /// The root has not been scanned yet.
  case pending
  /// The root was read and holds this many skills.
  case scanned(count: Int)
  /// There is no such folder.
  case missing
  /// The folder is there but could not be read.
  case unreadable(String)
}

/// One scan root and what came of it.
public struct SkillRootReport: Identifiable, Hashable, Sendable {
  public let id: String
  public let url: URL
  public let status: SkillRootStatus

  public init(id: String, url: URL, status: SkillRootStatus) {
    self.id = id
    self.url = url
    self.status = status
  }
}

/// The answer of one scan: the skills it found and what happened to each root.
public struct SkillScanResult: Hashable, Sendable {
  public let skills: [SkillEntry]
  public let roots: [SkillRootReport]

  public init(skills: [SkillEntry], roots: [SkillRootReport]) {
    self.skills = skills
    self.roots = roots
  }
}

/// Reads the skill folders a person points the App at.
///
/// A skill is an immediate child directory of a root that carries a `SKILL.md`. The file's
/// leading front matter says what the skill is: `name`, `description`, `version`, and a
/// `version` that is a direct child of a `metadata` mapping. Every other key is ignored, and a
/// file without front matter is still a skill: it is named after its folder.
///
/// A folder that is really the same folder — reached through a link, or through two roots —
/// is one skill with one row, and the row keeps the path the skill really lives at.
public enum SkillScanner: Sendable {
  /// The manifest every skill directory carries.
  public static let manifestName = "SKILL.md"
  /// The most of a manifest the scan reads: the front matter lives at the head of the file.
  public static let manifestReadLimit = 64 * 1024

  /// Scans every root in order. A skill that two roots share is one row, and the rows are
  /// ordered by name (case-insensitively) and then by path.
  ///
  /// `beforeManifestRead` runs between the check that a manifest is a regular file and the
  /// read of that manifest. It is a seam for the tests: a file that is swapped for a pipe in
  /// that window must still not be read.
  public static func scan(
    roots: [URL], beforeManifestRead: (@Sendable () -> Void)? = nil
  ) -> SkillScanResult {
    var skills: [SkillEntry] = []
    var identities = Set<Data>()
    var paths = Set<String>()
    var reports: [SkillRootReport] = []
    for root in roots {
      reports.append(
        scanRoot(
          root, into: &skills, identities: &identities, paths: &paths,
          beforeManifestRead: beforeManifestRead))
    }
    skills.sort { left, right in
      let byName = left.name.lowercased().compare(right.name.lowercased())
      if byName != .orderedSame { return byName == .orderedAscending }
      return left.id < right.id
    }
    return SkillScanResult(skills: skills, roots: reports)
  }

  private static func scanRoot(
    _ root: URL,
    into skills: inout [SkillEntry],
    identities: inout Set<Data>,
    paths: inout Set<String>,
    beforeManifestRead: (@Sendable () -> Void)?
  ) -> SkillRootReport {
    let identifier = root.standardizedFileURL.path
    let resolved = root.resolvingSymlinksInPath()
    let attributes: [FileAttributeKey: Any]
    do {
      attributes = try FileManager.default.attributesOfItem(atPath: resolved.path)
    } catch {
      return SkillRootReport(id: identifier, url: root, status: status(of: error))
    }
    guard let type = attributes[.type] as? FileAttributeType, type == .typeDirectory else {
      return SkillRootReport(id: identifier, url: root, status: .unreadable("这不是一个文件夹"))
    }
    let children: [String]
    do {
      children = try FileManager.default.contentsOfDirectory(atPath: resolved.path)
    } catch {
      return SkillRootReport(id: identifier, url: root, status: status(of: error))
    }
    var count = 0
    for child in children {
      let candidate = resolved.appendingPathComponent(child, isDirectory: true)
      let directory = candidate.resolvingSymlinksInPath()
      // Only a folder is a skill, and a folder may be reached through a link.
      guard
        let attributes = try? FileManager.default.attributesOfItem(atPath: directory.path),
        let type = attributes[.type] as? FileAttributeType, type == .typeDirectory
      else { continue }
      let identity = filesystemIdentity(of: directory)
      // The same folder under two roots, or under two links, is one skill.
      if let identity, !identities.insert(identity).inserted { continue }
      guard paths.insert(directory.path).inserted else { continue }
      beforeManifestRead?()
      let manifest = readManifest(at: directory.appendingPathComponent(manifestName))
      guard case .frontMatter(let block) = manifest else { continue }
      let front = SkillFrontMatter.parse(block)
      skills.append(
        SkillEntry(
          id: directory.path,
          name: front.name ?? directory.lastPathComponent,
          version: front.version ?? "",
          description: front.description ?? "",
          directory: directory
        )
      )
      count += 1
    }
    return SkillRootReport(id: identifier, url: root, status: .scanned(count: count))
  }

  /// What a filesystem path is, as the disk itself sees it. Two paths to one file answer the
  /// same identity, even when they differ in case.
  private static func filesystemIdentity(of url: URL) -> Data? {
    guard
      let values = try? url.resourceValues(forKeys: [.fileResourceIdentifierKey]),
      let identifier = values.fileResourceIdentifier as? Data
    else { return nil }
    return identifier
  }

  /// What a manifest turned out to be.
  private enum Manifest {
    /// It is not a regular file, or it could not be opened: it is not a manifest.
    case notAFile
    /// The front matter of the manifest, empty when the manifest has none.
    case frontMatter(String)
  }

  /// The front matter of a manifest, and nothing else.
  ///
  /// A file that is not a regular file — a pipe, a device — is never read, and the check and
  /// the read use one descriptor, so a file that is swapped in between cannot be read
  /// either. Only the head of the manifest is read, and the front matter is decided on those
  /// bytes: a character that the cut split in half can only be in the body, so it does not
  /// take the front matter with it.
  private static func readManifest(at url: URL) -> Manifest {
    let resolved = url.resolvingSymlinksInPath()
    let descriptor = open(resolved.path, O_RDONLY | O_NONBLOCK)
    guard descriptor >= 0 else { return .notAFile }
    defer { close(descriptor) }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
      information.st_mode & UInt16(S_IFMT) == UInt16(S_IFREG)
    else { return .notAFile }
    let bytes = readBytes(descriptor, limit: manifestReadLimit)
    guard let block = frontMatter(in: bytes) else { return .frontMatter("") }
    return .frontMatter(block)
  }

  /// At most `limit` bytes from a descriptor that is already open.
  private static func readBytes(_ descriptor: Int32, limit: Int) -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 16 * 1024)
    while data.count < limit {
      let wanted = min(buffer.count, limit - data.count)
      let count = Darwin.read(descriptor, &buffer, wanted)
      if count > 0 {
        data.append(buffer, count: count)
        continue
      }
      if count == 0 { break }
      if errno == EINTR { continue }
      break
    }
    return data
  }

  /// The front matter in a prefix of a manifest's bytes: the block between the two `---`
  /// delimiters. The block is decided on the bytes, so a character that the prefix cut in
  /// half — which can only be in the body — does not take the front matter with it.
  private static func frontMatter(in bytes: Data) -> String? {
    let lines = bytes.split(separator: 0x0A, omittingEmptySubsequences: false)
    guard let first = lines.first, isDelimiter(Data(first)) else { return nil }
    guard let end = lines.indices.dropFirst().first(where: { isDelimiter(Data(lines[$0])) })
    else { return nil }
    var decoded: [String] = []
    for line in lines[1..<end] {
      var content = Data(line)
      if content.last == 0x0D { content.removeLast() }
      guard let text = String(data: content, encoding: .utf8) else { return nil }
      decoded.append(text)
    }
    return decoded.joined(separator: "\n")
  }

  /// A delimiter is a `---` in the first column: one inside a block is part of the block.
  private static func isDelimiter(_ line: Data) -> Bool {
    var content = line
    if content.last == 0x0D { content.removeLast() }
    while content.last == 0x20 || content.last == 0x09 { content.removeLast() }
    return content == Data("---".utf8)
  }

  /// What an error means for a scan root: a folder that is not there is missing, and
  /// anything else — a folder the process may not read, for one — is unreadable.
  private static func status(of error: Error) -> SkillRootStatus {
    let code = (error as NSError).code
    if code == CocoaError.Code.fileNoSuchFile.rawValue
      || code == CocoaError.Code.fileReadNoSuchFile.rawValue
    {
      return .missing
    }
    return .unreadable("无法读取：\(error.localizedDescription)")
  }
}

/// The front matter of a `SKILL.md`, read without a YAML library: only the keys the
/// page shows are taken, and the scalars that really occur are understood.
///
/// The text is the block itself: what lies between the two `---` delimiters of the
/// manifest. A manifest without a closing delimiter has no front matter at all.
struct SkillFrontMatter: Equatable {
  var name: String?
  var description: String?
  var version: String?

  static func parse(_ text: String) -> SkillFrontMatter {
    var front = SkillFrontMatter()
    var reader = YamlReader(
      lines: text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init))
    let mapping = reader.parseMapping(indent: 0)
    front.name = mapping.scalar("name")
    front.description = mapping.scalar("description")
    front.version = mapping.scalar("version")
    // A version inside the metadata block counts, but only when it is a direct child of it.
    if let metadata = mapping.mapping("metadata") {
      front.version = front.version ?? metadata.scalar("version")
    }
    return front
  }
}

/// A small reader for the front matter of a manifest.
///
/// It reads the mapping at the top level and one level of nesting under it, and it reads the
/// scalars that really occur in a skill manifest:
///
/// - A plain scalar, a single quoted scalar (a doubled quote is one quote) and a double
///   quoted scalar.
/// - The six block forms: `|`, `|-`, `|+`, `>`, `>-` and `>+`. A literal block keeps its
///   lines, a folded block joins the lines of a paragraph with a space, a blank line keeps a
///   line break of its own, and a line that is more indented than the block keeps the break
///   around it.
/// - The escapes a double quoted value may hold: `\n`, `\t`, `\r`, `\"`, `\\`, and the code
///   points `\x`, `\u` and `\U`.
///
/// A comment that follows a value — after any number of spaces or one tab — is dropped, and a
/// `#` inside quotes is part of the value.
/// A value the reader cannot read is no value at all: the cell stays empty and the skill is
/// named after its folder. Every other key, and every sequence, is ignored.
struct YamlReader {
  /// One value of a mapping.
  enum Value: Equatable {
    case scalar(String)
    case mapping([String: Value])
    /// A sequence or anything this reader does not model: it is ignored, and it never
    /// leaks a value into the mapping around it.
    case other
  }

  /// How a block scalar ends.
  enum Block: Equatable {
    case literal(Chomp)
    case folded(Chomp)

    var isFolded: Bool {
      if case .folded = self { return true }
      return false
    }

    var keepsEveryNewline: Bool {
      switch self {
      case .literal(.keep), .folded(.keep): return true
      default: return false
      }
    }
  }

  /// What happens to the newline at the end of a block scalar.
  enum Chomp: Equatable {
    /// One newline is kept.
    case clip
    /// No newline is kept.
    case strip
    /// Every newline is kept.
    case keep
  }

  private struct Line {
    let raw: String
    let indent: Int
    let content: String
  }

  private let lines: [Line]
  private var index = 0

  init(lines: [String]) {
    self.lines = lines.map { raw in
      Line(
        raw: raw,
        indent: raw.prefix { $0 == " " }.count,
        content: raw.trimmingCharacters(in: .whitespaces)
      )
    }
  }

  /// The mapping that starts at this level. A key with a nested mapping under it keeps that
  /// mapping; a key with a sequence under it keeps nothing.
  mutating func parseMapping(indent: Int) -> [String: Value] {
    var result: [String: Value] = [:]
    while index < lines.count {
      let line = lines[index]
      if line.content.isEmpty || line.content.hasPrefix("#") {
        index += 1
        continue
      }
      if line.indent < indent { break }
      if line.indent > indent {
        index += 1
        continue
      }
      if line.content.hasPrefix("- ") || line.content == "-" {
        skipSequence(indent: indent)
        continue
      }
      guard let separator = keySeparator(in: line.content) else {
        index += 1
        continue
      }
      let key = String(line.content[..<separator]).trimmingCharacters(in: .whitespaces)
      let raw = String(line.content[line.content.index(after: separator)...])
      index += 1
      // The comment is taken off before the value is looked at, so a comment after a block
      // marker does not turn the marker into the value.
      let value = YamlReader.splitValue(raw)
      if let quote = value.quote {
        guard let text = YamlReader.quoted(value.text, quote: quote) else { continue }
        result[key] = .scalar(text)
      } else if value.text.isEmpty {
        result[key] = nestedValue(indent: line.indent)
      } else if let block = blockStyle(value.text) {
        result[key] = .scalar(blockValue(collectBlock(indent: line.indent), block))
      } else if value.text.hasPrefix("|") || value.text.hasPrefix(">") {
        // A block marker this reader does not know: there is no value at all.
        continue
      } else {
        result[key] = .scalar(value.text)
      }
    }
    return result
  }

  /// The colon that ends a key: the first one that is followed by a space or by the end of
  /// the line, so a value may hold colons of its own.
  private func keySeparator(in content: String) -> String.Index? {
    var position = content.startIndex
    while position < content.endIndex {
      if content[position] == ":" {
        let next = content.index(after: position)
        if next == content.endIndex || content[next] == " " { return position }
      }
      position = content.index(after: position)
    }
    return nil
  }

  /// The value of a key without its comment, and the quote it was written in. A comment
  /// starts at a hash that follows a space or a tab, however many of them there are.
  private static func splitValue(_ raw: String) -> (text: String, quote: Character?) {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard let first = trimmed.first else { return ("", nil) }
    if first == "\"" || first == "'" {
      guard let end = closingQuote(trimmed, quote: first) else { return (trimmed, first) }
      return (String(trimmed[...end]), first)
    }
    // A value that starts with a hash is a comment, so the value is empty.
    if first == "#" { return ("", nil) }
    var search = trimmed.startIndex
    while let hash = trimmed[search...].firstIndex(of: "#") {
      if let previous = trimmed[..<hash].last, previous == " " || previous == "\t" {
        return (trimTrailingWhitespace(String(trimmed[..<hash])), nil)
      }
      search = trimmed.index(after: hash)
    }
    return (trimmed, nil)
  }

  /// The text without the spaces and tabs at its end.
  private static func trimTrailingWhitespace(_ text: String) -> String {
    guard let last = text.lastIndex(where: { $0 != " " && $0 != "\t" }) else { return "" }
    return String(text[...last])
  }

  /// Where a quoted value ends, or nothing when the quote is never closed.
  private static func closingQuote(_ raw: String, quote: Character) -> String.Index? {
    var position = raw.index(after: raw.startIndex)
    while position < raw.endIndex {
      let character = raw[position]
      if character == quote {
        if quote == "'" {
          let next = raw.index(after: position)
          if next < raw.endIndex, raw[next] == "'" {
            position = raw.index(after: next)
            continue
          }
        }
        return position
      }
      if quote == "\"", character == "\\" {
        let next = raw.index(after: position)
        guard next < raw.endIndex else { return nil }
        position = raw.index(after: next)
        continue
      }
      position = raw.index(after: position)
    }
    return nil
  }

  /// The block indicator of a value: `|`, `>` and their chomping forms.
  private func blockStyle(_ rest: String) -> Block? {
    switch rest {
    case "|": return .literal(.clip)
    case "|-": return .literal(.strip)
    case "|+": return .literal(.keep)
    case ">": return .folded(.clip)
    case ">-": return .folded(.strip)
    case ">+": return .folded(.keep)
    default: return nil
    }
  }

  /// The value of a key that carries its content on the lines below it.
  private mutating func nestedValue(indent: Int) -> Value {
    var childIndent = -1
    var end = index
    while end < lines.count {
      let line = lines[end]
      // A comment line says nothing about the indentation of the block below it.
      if line.content.isEmpty || line.content.hasPrefix("#") {
        end += 1
        continue
      }
      if line.indent <= indent { break }
      if childIndent < 0 { childIndent = line.indent }
      end += 1
    }
    guard childIndent > 0 else { return .scalar("") }
    let first = lines[index..<end].first { !$0.content.isEmpty && !$0.content.hasPrefix("#") }
    if let first, first.content.hasPrefix("- ") || first.content == "-" {
      index = end
      return .other
    }
    return .mapping(parseMapping(indent: childIndent))
  }

  /// The lines of a sequence at this level: they are not values this reader models.
  private mutating func skipSequence(indent: Int) {
    while index < lines.count {
      let line = lines[index]
      if line.content.isEmpty {
        index += 1
        continue
      }
      if line.indent >= indent, line.content.hasPrefix("- ") || line.content == "-" {
        index += 1
        continue
      }
      break
    }
  }

  /// The lines of a block scalar: everything below the key that is more indented than it.
  private mutating func collectBlock(indent: Int) -> [String] {
    var content: [String] = []
    while index < lines.count {
      let line = lines[index]
      if line.content.isEmpty {
        content.append("")
        index += 1
        continue
      }
      if line.indent <= indent { break }
      content.append(line.raw)
      index += 1
    }
    return content
  }

  /// A block scalar as its text: a literal keeps its lines, a folded joins them with spaces,
  /// and the chomping decides what happens to the newline at the end.
  private func blockValue(_ raw: [String], _ block: Block) -> String {
    var body = raw
    var trailing = 0
    while let last = body.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
      body.removeLast()
      trailing += 1
    }
    let base =
      body.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
      .map { $0.prefix { $0 == " " }.count }
      .min() ?? 0
    let lines = body.map { line -> String in
      guard line.count >= base else { return line.trimmingCharacters(in: .whitespaces) }
      return String(line.dropFirst(base))
    }
    guard !lines.isEmpty else {
      // A block with no content is empty; one that keeps its newlines keeps the blank ones.
      return block.keepsEveryNewline ? String(repeating: "\n", count: trailing) : ""
    }
    let text = block.isFolded ? folded(lines) : lines.joined(separator: "\n")
    switch block {
    case .literal(let chomp), .folded(let chomp):
      switch chomp {
      case .strip: return text
      case .keep: return text + String(repeating: "\n", count: trailing + 1)
      case .clip: return text + "\n"
      }
    }
  }

  /// A folded block: the lines of a paragraph join with a space, a blank line keeps a line
  /// break of its own, and a line that is more indented than the block keeps the break
  /// around it.
  private func folded(_ lines: [String]) -> String {
    var result = ""
    var wroteAny = false
    var lastWasMoreIndented = false
    var blanks = 0
    for line in lines {
      if line.isEmpty {
        blanks += 1
        continue
      }
      // The lines are already de-indented, so a line that still carries spaces is more
      // indented than the block.
      let moreIndented = line.prefix { $0 == " " }.count > 0
      if wroteAny {
        if blanks > 0 {
          // A deeper line kept its break before the blank, and the blank keeps its own.
          if lastWasMoreIndented { result += "\n" }
          result += String(repeating: "\n", count: blanks)
        } else if lastWasMoreIndented || moreIndented {
          result += "\n"
        } else {
          result += " "
        }
      }
      result += line
      wroteAny = true
      lastWasMoreIndented = moreIndented
      blanks = 0
    }
    return result
  }

  /// A quoted scalar: the closing quote ends the value, and the escapes YAML defines are
  /// decoded. A value that is never closed, or that holds an escape this reader does not
  /// know, is no value at all.
  private static func quoted(_ raw: String, quote: Character) -> String? {
    var result = ""
    var position = raw.index(after: raw.startIndex)
    while position < raw.endIndex {
      let character = raw[position]
      if character == quote {
        if quote == "'" {
          let next = raw.index(after: position)
          if next < raw.endIndex, raw[next] == "'" {
            result.append("'")
            position = raw.index(after: next)
            continue
          }
        }
        return result
      }
      if quote == "\"", character == "\\" {
        guard let escaped = escape(raw, at: position) else { return nil }
        result += escaped.text
        position = escaped.next
        continue
      }
      result.append(character)
      position = raw.index(after: position)
    }
    return nil
  }

  /// One escape of a double quoted value.
  private static func escape(
    _ raw: String, at position: String.Index
  ) -> (text: String, next: String.Index)? {
    let next = raw.index(after: position)
    guard next < raw.endIndex else { return nil }
    switch raw[next] {
    case "n": return ("\n", raw.index(after: next))
    case "t": return ("\t", raw.index(after: next))
    case "r": return ("\r", raw.index(after: next))
    case "\"": return ("\"", raw.index(after: next))
    case "\\": return ("\\", raw.index(after: next))
    case "x": return codePoint(raw, after: next, digits: 2)
    case "u": return codePoint(raw, after: next, digits: 4)
    case "U": return codePoint(raw, after: next, digits: 8)
    default: return nil
    }
  }

  /// A code point written as hex digits.
  private static func codePoint(
    _ raw: String, after position: String.Index, digits: Int
  ) -> (text: String, next: String.Index)? {
    let start = raw.index(after: position)
    guard let end = raw.index(start, offsetBy: digits, limitedBy: raw.endIndex), end > start
    else { return nil }
    guard let value = UInt32(String(raw[start..<end]), radix: 16),
      let scalar = Unicode.Scalar(value)
    else { return nil }
    return (String(Character(scalar)), end)
  }
}

extension Dictionary where Key == String, Value == YamlReader.Value {
  /// The value of a key, when it is a scalar that holds something.
  func scalar(_ key: String) -> String? {
    guard case .scalar(let value) = self[key], !value.isEmpty else { return nil }
    return value
  }

  /// The mapping of a key, when it has one.
  func mapping(_ key: String) -> [String: YamlReader.Value]? {
    guard case .mapping(let value) = self[key] else { return nil }
    return value
  }
}
