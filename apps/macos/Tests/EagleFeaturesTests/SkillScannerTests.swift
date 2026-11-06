import Darwin
import Foundation
import Testing

@testable import EagleFeatures

/// The filesystem scan behind the 技能 page: a skill is an immediate child directory of a
/// scan root that carries a `SKILL.md`, and the file's leading front matter says what the
/// skill is. The scan reads the disk and nothing else, so it is proved here on real folders.
@Suite("Skill scanner")
struct SkillScannerTests {
  @Test("a skill's front matter gives its name, description and version")
  func frontMatter() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: Runs the alpha acceptance.
      version: 1.2.3
      ---

      # Alpha
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.count == 1)
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha-skill")
    #expect(skill.description == "Runs the alpha acceptance.")
    #expect(skill.version == "1.2.3")
    #expect(skill.directory.lastPathComponent == "alpha")
  }

  @Test("a version that lives in metadata counts as the version")
  func metadataVersion() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      metadata:
        version: "1.1.3"
      description: Reads a version from the metadata block.
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.version == "1.1.3")
    #expect(result.skills.first?.name == "alpha-skill")
  }

  @Test("a version under metadata is only read when it is a direct child")
  func nestedMetadataVersionIsIgnored() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      metadata:
        author:
          version: "9.9.9"
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.version.isEmpty == true)
  }

  @Test("a skill without front matter falls back to its directory name")
  func missingFrontMatter() throws {
    let root = try temporaryRoot()
    try writeSkill(root, "alpha", "# Alpha\n\nNo front matter here.\n")
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha")
    #expect(skill.description.isEmpty)
    #expect(skill.version.isEmpty)
  }

  @Test("front matter without a closing delimiter is no front matter at all")
  func unclosedFrontMatter() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: The body of the file goes on and on.

      # Alpha
      """)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha", "without a closing delimiter the folder names the skill")
    #expect(skill.description.isEmpty)
  }

  @Test("a directory without SKILL.md is not a skill")
  func withoutManifest() throws {
    let root = try temporaryRoot()
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("notes", isDirectory: true),
      withIntermediateDirectories: true)
    try writeSkill(root, "alpha", "---\nname: alpha\n---\n")
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.map(\.name) == ["alpha"])
    #expect(result.roots.first?.status == .scanned(count: 1))
  }

  @Test("an empty folder holds no skill and says so")
  func emptyDirectory() throws {
    let root = try temporaryRoot()
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.isEmpty)
    #expect(result.roots.first?.status == .scanned(count: 0))
  }

  @Test("the same folder under two roots is one row")
  func duplicatePath() throws {
    let root = try temporaryRoot()
    try writeSkill(root, "alpha", "---\nname: alpha\n---\n")
    let result = SkillScanner.scan(roots: [root, root])
    #expect(result.skills.count == 1)
    #expect(
      result.skills.first?.id == root.appendingPathComponent("alpha").resolvingSymlinksInPath().path
    )
  }

  @Test("a skill reached through a linked root is the same skill")
  func linkedRoot() throws {
    let base = try temporaryRoot()
    let real = base.appendingPathComponent("real", isDirectory: true)
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    try writeSkill(real, "alpha", "---\nname: alpha-skill\n---\n")
    let link = base.appendingPathComponent("link", isDirectory: true)
    try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: real.path)
    let result = SkillScanner.scan(roots: [real, link])
    #expect(result.skills.count == 1, "one skill, one row")
    #expect(
      result.skills.first?.id
        == real.appendingPathComponent("alpha").resolvingSymlinksInPath().path,
      "the row keeps the path the skill really lives at")
  }

  @Test("two children that link to one directory are one skill")
  func linkedChildren() throws {
    let base = try temporaryRoot()
    let real = base.appendingPathComponent("real", isDirectory: true)
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    try writeSkill(real, "alpha", "---\nname: alpha-skill\n---\n")
    let root = base.appendingPathComponent("root", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    for name in ["first", "second"] {
      try FileManager.default.createSymbolicLink(
        atPath: root.appendingPathComponent(name).path,
        withDestinationPath: real.appendingPathComponent("alpha").path)
    }
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.count == 1)
    #expect(result.skills.first?.name == "alpha-skill")
    #expect(
      result.skills.first?.id == real.appendingPathComponent("alpha").resolvingSymlinksInPath().path
    )
  }

  @Test("skills are ordered by name, case-insensitively, then by path")
  func ordering() throws {
    let root = try temporaryRoot()
    try writeSkill(root, "zeta", "---\nname: Beta\n---\n")
    try writeSkill(root, "alpha", "---\nname: alpha\n---\n")
    try writeSkill(root, "beta", "---\nname: alpha\n---\n")
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.map(\.name) == ["alpha", "alpha", "Beta"])
    #expect(result.skills[0].directory.lastPathComponent == "alpha")
    #expect(result.skills[1].directory.lastPathComponent == "beta")
  }

  @Test("a missing root says so on its own row and never fails the scan")
  func missingRoot() throws {
    let root = try temporaryRoot()
    let missing = root.appendingPathComponent("nowhere", isDirectory: true)
    let result = SkillScanner.scan(roots: [missing])
    #expect(result.skills.isEmpty)
    #expect(result.roots.count == 1)
    #expect(result.roots.first?.status == .missing)
  }

  @Test("a root that is not a folder says so instead of failing the scan")
  func unreadableRoot() throws {
    let root = try temporaryRoot()
    let file = root.appendingPathComponent("plain.txt")
    try "not a folder".write(to: file, atomically: true, encoding: .utf8)
    let result = SkillScanner.scan(roots: [file])
    #expect(result.skills.isEmpty)
    #expect(result.roots.count == 1)
    guard case .unreadable = try #require(result.roots.first?.status) else {
      Issue.record("a root that is not a folder is unreadable")
      return
    }
  }

  @Test("a root the process may not read is unreadable, not missing")
  func permissionDeniedRoot() throws {
    let base = try temporaryRoot()
    let locked = base.appendingPathComponent("locked", isDirectory: true)
    let skills = locked.appendingPathComponent("skills", isDirectory: true)
    try FileManager.default.createDirectory(at: skills, withIntermediateDirectories: true)
    #expect(chmod(locked.path, 0o000) == 0)
    defer { chmod(locked.path, 0o700) }
    let result = SkillScanner.scan(roots: [skills])
    let status = try #require(result.roots.first?.status)
    if geteuid() == 0 {
      // root may read anything: the folder is read, and it is never called missing.
      #expect(status == .scanned(count: 0))
    } else {
      guard case .unreadable = status else {
        Issue.record("a folder the process may not read is unreadable, not missing")
        return
      }
    }
  }

  @Test("CRLF line endings and quoted values are read as written")
  func crlfAndQuotes() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      "---\r\nname: \"alpha-skill\"\r\ndescription: 'Quoted description.'\r\nversion: \"2.0.0\"\r\n---\r\n"
    )
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha-skill")
    #expect(skill.description == "Quoted description.")
    #expect(skill.version == "2.0.0")
  }

  @Test("a comment after a value is not part of the value")
  func trailingComment() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      version: "1.2" # a note about the version
      description: Runs alpha. # and a note about that
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.version == "1.2")
    #expect(skill.description == "Runs alpha.")
  }

  @Test("a double quoted value decodes the escapes YAML defines")
  func doubleQuotedEscapes() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      #"""
      ---
      name: "alpha-skill"
      description: "first\nsecond\ttabbed \"quoted\" back\\slash"
      ---
      """#)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.description == "first\nsecond\ttabbed \"quoted\" back\\slash")
  }

  @Test("a single quoted value keeps its doubled quote")
  func singleQuotedValue() throws {
    let root = try temporaryRoot()
    try writeSkill(root, "alpha", "---\ndescription: 'it''s here'\n---\n")
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description == "it's here")
  }

  @Test("a literal block keeps its lines")
  func literalBlock() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: |
        first line
        second line
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description == "first line\nsecond line\n")
  }

  @Test("a literal block that is stripped has no trailing newline")
  func literalBlockStripped() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: |-
        first line
        second line
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description == "first line\nsecond line")
  }

  @Test("a folded block joins its lines with spaces")
  func foldedBlock() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: >-
        Create the demo videos using the accepted
        Teams CLI template, with English materials
        and narration.
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(
      result.skills.first?.description
        == "Create the demo videos using the accepted Teams CLI template, with English materials and narration."
    )
  }

  @Test("a folded block that is not stripped keeps one newline")
  func foldedBlockKeepsNewline() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: >
        first line
        second line
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description == "first line second line\n")
  }

  @Test("a delimiter inside a block does not end the front matter")
  func delimiterInsideBlock() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: |
        first line
        ---
        last line
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.description == "first line\n---\nlast line\n")
  }

  @Test("a skill without a description has an empty one")
  func emptyDescription() throws {
    let root = try temporaryRoot()
    try writeSkill(root, "alpha", "---\nname: alpha\n---\n")
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description.isEmpty == true)
  }

  @Test("a front matter key nobody asked for is ignored")
  func unknownKeysAreIgnored() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      license: MIT
      allowed-tools:
        - Read
        - Write
      metadata:
        version: "0.9"
        author: someone
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha-skill")
    #expect(skill.version == "0.9")
  }

  @Test("a manifest that is not a regular file is skipped instead of blocking the scan")
  func fifoManifestDoesNotBlock() async throws {
    let root = try temporaryRoot()
    let directory = root.appendingPathComponent("alpha", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let manifest = directory.appendingPathComponent("SKILL.md")
    #expect(mkfifo(manifest.path, 0o644) == 0)
    let done = ScanCompletion()
    let scan = Task.detached {
      let result = SkillScanner.scan(roots: [root])
      await done.mark()
      return result
    }
    for _ in 0..<40 {
      if await done.isDone { break }
      try? await Task.sleep(for: .milliseconds(50))
    }
    #expect(await done.isDone, "the scan does not wait on a manifest that is not a file")
    guard await done.isDone else { return }
    let result = await scan.value
    #expect(result.skills.isEmpty)
  }

  @Test("a manifest larger than the read limit still gives its front matter")
  func largeManifest() throws {
    let root = try temporaryRoot()
    let body = String(repeating: "filler line\n", count: 20_000)
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: Runs alpha.
      ---

      \(body)
      """)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha-skill")
    #expect(skill.description == "Runs alpha.")
  }

  @Test("a root that may be entered but not listed is unreadable")
  func unreadableDirectory() throws {
    let base = try temporaryRoot()
    let closed = base.appendingPathComponent("closed", isDirectory: true)
    try FileManager.default.createDirectory(at: closed, withIntermediateDirectories: true)
    #expect(chmod(closed.path, 0o111) == 0)
    defer { chmod(closed.path, 0o700) }
    let result = SkillScanner.scan(roots: [closed])
    let status = try #require(result.roots.first?.status)
    if geteuid() == 0 {
      #expect(status == .scanned(count: 0))
    } else {
      guard case .unreadable = status else {
        Issue.record("a folder that may not be listed is unreadable")
        return
      }
    }
  }

  @Test("a front matter that is not tidy is read as far as it can be")
  func untidyFrontMatter() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      - Read
      - Write
      this line is not a mapping
      description: |
        first line

        third line
      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    let skill = try #require(result.skills.first)
    #expect(skill.name == "alpha-skill")
    #expect(skill.description == "first line\n\nthird line\n")
  }

  @Test("a block that keeps every newline keeps them all")
  func keptBlock() throws {
    let root = try temporaryRoot()
    try writeSkill(
      root, "alpha",
      """
      ---
      name: alpha-skill
      description: |+
        first line


      ---
      """)
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description == "first line\n\n\n")
  }

  @Test("an empty block is an empty description")
  func emptyBlock() throws {
    let root = try temporaryRoot()
    try writeSkill(root, "alpha", "---\nname: alpha-skill\ndescription: |\n---\n")
    let result = SkillScanner.scan(roots: [root])
    #expect(result.skills.first?.description.isEmpty == true)
  }

  private func temporaryRoot() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-skill-scan-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func writeSkill(_ root: URL, _ folder: String, _ text: String) throws {
    let directory = root.appendingPathComponent(folder, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try text.write(
      to: directory.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
  }
}

/// Says whether a scan finished, so a test can give it a deadline.
private actor ScanCompletion {
  private var done = false

  func mark() { done = true }

  var isDone: Bool { done }
}
