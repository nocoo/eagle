import Foundation
import Testing

@testable import EagleFeatures

/// The 技能 page's state: which folders are scanned, which skills are ticked, and what the
/// list shows for the filter and the keyword. Nothing here talks to a Bot: the page only
/// remembers what a person chose on this machine.
@Suite("Skills settings view model", .serialized)
@MainActor
struct SkillsSettingsViewModelTests {
  @Test("the automatic root comes first and cannot be removed")
  func defaultRoot() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let model = fixture.model()
    #expect(model.scanRoots.count == 1)
    #expect(model.scanRoots.first == fixture.home.appendingPathComponent(".agents/skills"))
    #expect(model.rootRows.first?.displayPath == "~/.agents/skills")
    #expect(model.rootRows.first?.removable == false)
    #expect(model.customRoots.isEmpty)
  }

  @Test("a custom root is kept once and survives a new model")
  func customRootsPersist() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let custom = fixture.home.appendingPathComponent("extra", isDirectory: true)
    try FileManager.default.createDirectory(at: custom, withIntermediateDirectories: true)
    let model = fixture.model()
    await model.addRoots([custom])
    await model.addRoots([custom])
    #expect(model.customRoots.count == 1)
    #expect(model.rootRows.count == 2)
    #expect(model.rootRows.last?.removable == true)
    #expect(model.rootRows.last?.displayPath == "~/extra")

    let again = fixture.model()
    #expect(again.customRoots == [custom])
    await again.removeRoot(custom)
    #expect(again.customRoots.isEmpty)
    #expect(again.rootRows.count == 1)
  }

  @Test("the automatic root is never added a second time as a custom root")
  func defaultRootIsNotDuplicated() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let model = fixture.model()
    await model.addRoots([fixture.home.appendingPathComponent(".agents/skills")])
    #expect(model.customRoots.isEmpty)
    #expect(model.scanRoots.count == 1)
  }

  @Test("nothing is selected until a person ticks a skill, and the tick is remembered")
  func selectionPersists() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    let model = fixture.model()
    await model.reload()
    let skill = try #require(model.skills.first)
    #expect(model.selectedPaths.isEmpty)
    #expect(model.selectedCount == 0)
    model.setSelected(true, for: skill)
    #expect(model.isSelected(skill))
    #expect(model.selectedCount == 1)

    let again = fixture.model()
    #expect(again.selectedPaths == [skill.id])
    model.setSelected(false, for: skill)
    #expect(model.isSelected(skill) == false)
    #expect(model.selectedCount == 0)
    let unticked = fixture.model()
    #expect(unticked.selectedPaths.isEmpty, "an unticked skill is not remembered")
  }

  @Test("a folder outside the home directory keeps its absolute path")
  func rootOutsideHome() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let outside = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-skills-outside-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    let model = fixture.model()
    await model.addRoots([outside])
    #expect(model.rootRows.last?.displayPath == outside.standardizedFileURL.path)
    #expect(model.rootRows.last?.removable == true)
  }

  @Test("the filter narrows the list to ticked or unticked skills")
  func filterStates() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    try fixture.writeSkill("beta", name: "beta-skill", description: "Runs beta.", version: "2.0.0")
    let model = fixture.model()
    await model.reload()
    let alpha = try #require(model.skills.first { $0.name == "alpha-skill" })
    model.setSelected(true, for: alpha)
    #expect(model.visibleSkills.count == 2)
    model.filter = .selected
    #expect(model.visibleSkills.map(\.name) == ["alpha-skill"])
    model.filter = .unselected
    #expect(model.visibleSkills.map(\.name) == ["beta-skill"])
    model.filter = .all
    #expect(model.visibleSkills.count == 2)
  }

  @Test("the keyword looks at the name, the description and the directory")
  func keywordSearch() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs the acceptance.", version: "1.0.0")
    try fixture.writeSkill(
      "beta", name: "beta-skill", description: "Runs the release.", version: "2.0.0")
    let model = fixture.model()
    await model.reload()
    model.keyword = "ALPHA"
    #expect(model.visibleSkills.map(\.name) == ["alpha-skill"])
    model.keyword = "acceptance"
    #expect(model.visibleSkills.map(\.name) == ["alpha-skill"])
    model.keyword = "beta"
    #expect(model.visibleSkills.map(\.name) == ["beta-skill"])
    model.keyword = "nothing here"
    #expect(model.visibleSkills.isEmpty)
    model.keyword = "   "
    #expect(model.visibleSkills.count == 2)
  }

  @Test("a reload keeps the selection and reports honest counts")
  func reloadKeepsSelection() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    try fixture.writeSkill("beta", name: "beta-skill", description: "Runs beta.", version: "2.0.0")
    let model = fixture.model()
    await model.reload()
    let alpha = try #require(model.skills.first { $0.name == "alpha-skill" })
    model.setSelected(true, for: alpha)
    #expect(model.totalCount == 2)
    #expect(model.selectedCount == 1)
    #expect(model.visibleCount == 2)

    await model.reload()
    #expect(model.isSelected(alpha), "a rescan does not forget what was ticked")
    #expect(model.totalCount == 2)
    #expect(model.selectedCount == 1)
    model.keyword = "beta"
    #expect(model.visibleCount == 1)
  }

  @Test("a root that cannot be read is reported on its own row")
  func rootFailuresAreReported() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    // The automatic folder is gone: the page says so instead of pretending it holds nothing.
    try FileManager.default.removeItem(
      at: fixture.home.appendingPathComponent(".agents/skills", isDirectory: true))
    let model = fixture.model()
    await model.reload()
    let row = try #require(model.rootRows.first)
    #expect(row.status == .missing)
    #expect(row.detail == "找不到这个文件夹")
  }
}

/// A temporary home with its own defaults suite: the page's own state, never the machine's.
@MainActor
private struct SkillsFixture {
  let home: URL
  let defaults: UserDefaults
  private let suiteName: String

  init() throws {
    suiteName = "eagle.skills.tests.\(UUID().uuidString)"
    defaults = try #require(UserDefaults(suiteName: suiteName))
    home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-skills-vm-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: home.appendingPathComponent(".agents/skills", isDirectory: true),
      withIntermediateDirectories: true)
  }

  func model() -> SkillsSettingsViewModel {
    SkillsSettingsViewModel(defaults: defaults, home: home)
  }

  func writeSkill(_ folder: String, name: String, description: String, version: String) throws {
    let directory = home.appendingPathComponent(".agents/skills/\(folder)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let text = """
      ---
      name: \(name)
      description: \(description)
      version: \(version)
      ---
      """
    try text.write(
      to: directory.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
  }

  func cleanUp() {
    defaults.removePersistentDomain(forName: suiteName)
  }
}
