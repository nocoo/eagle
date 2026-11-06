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
  public static func scan(roots: [URL]) -> SkillScanResult {
    var skills: [SkillEntry] = []
    var identities = Set<Data>()
    var paths = Set<String>()
    var reports: [SkillRootReport] = []
    for root in roots {
      reports.append(scanRoot(root, into: &skills, identities: &identities, paths: &paths))
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
    paths: inout Set<String>
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
      guard let text = readManifest(at: directory.appendingPathComponent(manifestName)) else {
        continue
      }
      let front = SkillFrontMatter.parse(text)
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

  /// The head of a manifest, and nothing else. A file that is not a regular file — a pipe, a
  /// device — is never opened, because opening one would wait for a writer that may never
  /// come.
  private static func readManifest(at url: URL) -> String? {
    let resolved = url.resolvingSymlinksInPath()
    guard
      let attributes = try? FileManager.default.attributesOfItem(atPath: resolved.path),
      let type = attributes[.type] as? FileAttributeType, type == .typeRegular,
      let handle = try? FileHandle(forReadingFrom: resolved)
    else { return nil }
    defer { try? handle.close() }
    guard let data = try? handle.read(upToCount: manifestReadLimit), !data.isEmpty else {
      return nil
    }
    return String(data: data, encoding: .utf8)
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

/// The leading front matter of a `SKILL.md`, read without a YAML library: only the keys the
/// page shows are taken, and the scalars that really occur are understood.
struct SkillFrontMatter: Equatable {
  var name: String?
  var description: String?
  var version: String?

  static func parse(_ text: String) -> SkillFrontMatter {
    var front = SkillFrontMatter()
    let lines =
      text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
    // The front matter is the block between two column-0 delimiters. Without a closing one
    // there is no front matter at all.
    guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
      let end = lines.indices.dropFirst().first(where: { isDelimiter(lines[$0]) })
    else { return front }
    var reader = YamlReader(lines: Array(lines[1..<end]))
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

  /// A delimiter is a `---` in the first column: one inside a block is part of the block.
  private static func isDelimiter(_ line: String) -> Bool {
    guard !line.hasPrefix(" "), !line.hasPrefix("\t") else { return false }
    return line.trimmingCharacters(in: .whitespaces) == "---"
  }
}

/// A small reader for the front matter of a manifest: the mapping at the top level, one
/// level of nesting under it, and the scalars YAML really uses.
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
      let rest = String(line.content[line.content.index(after: separator)...])
        .trimmingCharacters(in: .whitespaces)
      index += 1
      if let block = blockStyle(rest) {
        result[key] = .scalar(blockValue(collectBlock(indent: line.indent), block))
      } else if rest.isEmpty {
        result[key] = nestedValue(indent: line.indent)
      } else {
        result[key] = .scalar(scalar(rest))
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
      if line.content.isEmpty {
        end += 1
        continue
      }
      if line.indent <= indent { break }
      if childIndent < 0 { childIndent = line.indent }
      end += 1
    }
    guard childIndent > 0 else { return .scalar("") }
    let first = lines[index..<end].first { !$0.content.isEmpty }
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
    let text = block.isFolded ? folded(lines) : lines.joined(separator: "\n")
    switch block {
    case .literal(let chomp), .folded(let chomp):
      switch chomp {
      case .strip: return text
      case .keep: return text + String(repeating: "\n", count: trailing + 1)
      case .clip: return text.isEmpty ? "" : text + "\n"
      }
    }
  }

  /// A folded block: the lines of a paragraph join with a space, and a blank line starts a
  /// new one.
  private func folded(_ lines: [String]) -> String {
    var result = ""
    var afterBreak = false
    for (offset, line) in lines.enumerated() {
      if line.isEmpty {
        result += "\n"
        afterBreak = true
        continue
      }
      if offset > 0, !afterBreak { result += " " }
      result += line
      afterBreak = false
    }
    return result
  }

  /// A scalar as YAML reads it: plain, single quoted or double quoted.
  private func scalar(_ raw: String) -> String {
    if raw.hasPrefix("\"") { return YamlReader.quoted(raw, quote: "\"") }
    if raw.hasPrefix("'") { return YamlReader.quoted(raw, quote: "'") }
    var text = raw
    if let comment = text.range(of: " #") { text = String(text[..<comment.lowerBound]) }
    return text.trimmingCharacters(in: .whitespaces)
  }

  /// A quoted scalar: the closing quote ends the value, and the escapes YAML defines are
  /// decoded.
  private static func quoted(_ raw: String, quote: Character) -> String {
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
        break
      }
      if quote == "\"", character == "\\" {
        let next = raw.index(after: position)
        guard next < raw.endIndex else { break }
        switch raw[next] {
        case "n": result.append("\n")
        case "t": result.append("\t")
        case "r": result.append("\r")
        case "\"": result.append("\"")
        case "\\": result.append("\\")
        default: result.append(raw[next])
        }
        position = raw.index(after: next)
        continue
      }
      result.append(character)
      position = raw.index(after: position)
    }
    return result
  }
}

extension Dictionary where Key == String, Value == YamlReader.Value {
  /// The value of a key, when it is a scalar.
  func scalar(_ key: String) -> String? {
    guard case .scalar(let value) = self[key] else { return nil }
    return value
  }

  /// The mapping of a key, when it has one.
  func mapping(_ key: String) -> [String: YamlReader.Value]? {
    guard case .mapping(let value) = self[key] else { return nil }
    return value
  }
}
