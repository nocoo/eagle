import Foundation

/// One skill a scan found: the directory that holds it and what its `SKILL.md` says about it.
public struct SkillEntry: Identifiable, Hashable, Sendable {
  /// The absolute path of the skill directory: the one identity two scan roots share.
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
/// `version` inside a `metadata` block. Every other key is ignored, and a file without front
/// matter is still a skill: it is named after its folder.
public enum SkillScanner: Sendable {
  /// The manifest every skill directory carries.
  public static let manifestName = "SKILL.md"

  /// Scans every root in order. A skill that two roots share is one row, and the rows are
  /// ordered by name (case-insensitively) and then by path.
  public static func scan(roots: [URL]) -> SkillScanResult {
    var skills: [SkillEntry] = []
    var seen = Set<String>()
    var reports: [SkillRootReport] = []
    for root in roots {
      let report = scanRoot(root, into: &skills, seen: &seen)
      reports.append(report)
    }
    skills.sort { left, right in
      let byName = left.name.lowercased().compare(right.name.lowercased())
      if byName != .orderedSame { return byName == .orderedAscending }
      return left.id < right.id
    }
    return SkillScanResult(skills: skills, roots: reports)
  }

  private static func scanRoot(
    _ root: URL, into skills: inout [SkillEntry], seen: inout Set<String>
  ) -> SkillRootReport {
    let identifier = root.standardizedFileURL.path
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: identifier, isDirectory: &isDirectory) else {
      return SkillRootReport(id: identifier, url: root, status: .missing)
    }
    guard isDirectory.boolValue else {
      return SkillRootReport(id: identifier, url: root, status: .unreadable("这不是一个文件夹"))
    }
    let children: [String]
    do {
      children = try FileManager.default.contentsOfDirectory(atPath: identifier)
    } catch {
      return SkillRootReport(
        id: identifier, url: root, status: .unreadable("无法读取：\(error.localizedDescription)"))
    }
    var count = 0
    for child in children {
      let directory = root.appendingPathComponent(child, isDirectory: true)
      var childIsDirectory: ObjCBool = false
      guard
        FileManager.default.fileExists(atPath: directory.path, isDirectory: &childIsDirectory),
        childIsDirectory.boolValue
      else { continue }
      let manifest = directory.appendingPathComponent(manifestName, isDirectory: false)
      guard let text = try? String(contentsOf: manifest, encoding: .utf8) else { continue }
      let path = directory.standardizedFileURL.path
      // The same directory under two roots is one skill, not two.
      guard seen.insert(path).inserted else { continue }
      let front = SkillFrontMatter.parse(text)
      skills.append(
        SkillEntry(
          id: path,
          name: front.name ?? child,
          version: front.version ?? "",
          description: front.description ?? "",
          directory: directory
        )
      )
      count += 1
    }
    return SkillRootReport(id: identifier, url: root, status: .scanned(count: count))
  }
}

/// The leading front matter of a `SKILL.md`, read without a YAML library: only the keys the
/// page shows are taken, and a value may be quoted.
struct SkillFrontMatter: Equatable {
  var name: String?
  var description: String?
  var version: String?

  static func parse(_ text: String) -> SkillFrontMatter {
    var front = SkillFrontMatter()
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
    guard let first = lines.first, first.trimmingCharacters(in: .whitespaces) == "---" else {
      return front
    }
    var index = 1
    var insideMetadata = false
    while index < lines.count {
      let line = lines[index]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed == "---" { break }
      index += 1
      if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
      let indent = line.prefix { $0 == " " }.count
      guard let separator = line.firstIndex(of: ":") else { continue }
      let key = String(line[line.startIndex..<separator]).trimmingCharacters(in: .whitespaces)
      let raw = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
      if indent == 0 {
        insideMetadata = key == "metadata" && raw.isEmpty
        guard !insideMetadata else { continue }
        switch key {
        case "name": front.name = SkillFrontMatter.value(raw)
        case "description": front.description = SkillFrontMatter.value(raw)
        case "version": front.version = SkillFrontMatter.value(raw)
        default: break
        }
        continue
      }
      guard insideMetadata, key == "version", front.version == nil else { continue }
      front.version = SkillFrontMatter.value(raw)
    }
    return front
  }

  /// A YAML scalar as this page reads it: unquoted, or wrapped in one kind of quote.
  static func value(_ raw: String) -> String? {
    guard !raw.isEmpty else { return nil }
    if raw.count >= 2, raw.hasPrefix("\""), raw.hasSuffix("\"") {
      let inner = raw.dropFirst().dropLast()
      return inner.replacingOccurrences(of: "\\\"", with: "\"")
        .replacingOccurrences(of: "\\\\", with: "\\")
    }
    if raw.count >= 2, raw.hasPrefix("'"), raw.hasSuffix("'") {
      return raw.dropFirst().dropLast().replacingOccurrences(of: "''", with: "'")
    }
    return raw
  }
}
