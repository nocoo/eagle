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

  @Test("a directory without SKILL.md is not a skill")
  func withoutManifest() throws {
    let root = try temporaryRoot()
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("notes", isDirectory: true), withIntermediateDirectories: true
    )
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
      result.skills.first?.id == root.appendingPathComponent("alpha").standardizedFileURL.path)
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
      allowed-tools: Read, Write
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
