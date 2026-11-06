import BotsCore
import BotsTransport
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
      "alpha-folder", name: "alpha-skill", description: "Runs the acceptance.", version: "1.0.0")
    try fixture.writeSkill(
      "beta-folder", name: "beta-skill", description: "Runs the release.", version: "2.0.0")
    let model = fixture.model()
    await model.reload()
    model.keyword = "ALPHA"
    #expect(model.visibleSkills.map(\.name) == ["alpha-skill"])
    model.keyword = "acceptance"
    #expect(model.visibleSkills.map(\.name) == ["alpha-skill"])
    model.keyword = "beta-folder"
    #expect(
      model.visibleSkills.map(\.name) == ["beta-skill"],
      "a word that is only in the directory still finds the skill")
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

  @Test("a skill reached through a linked root keeps its tick when the link goes away")
  func tickSurvivesRemovedEntryPoint() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    let automatic = fixture.home.appendingPathComponent(".agents/skills", isDirectory: true)
    let link = fixture.home.appendingPathComponent("linked", isDirectory: true)
    try FileManager.default.createSymbolicLink(
      atPath: link.path, withDestinationPath: automatic.path)
    let model = fixture.model()
    await model.addRoots([link])
    await model.reload()
    let skill = try #require(model.skills.first)
    #expect(model.skills.count == 1, "the link and the real folder are one skill")
    model.setSelected(true, for: skill)

    await model.removeRoot(link)
    await model.reload()
    #expect(model.skills.count == 1, "the skill is still there through the automatic root")
    let kept = try #require(model.skills.first)
    #expect(model.isSelected(kept), "the tick belongs to the skill, not to the way in")
    #expect(model.selectedCount == 1)
  }

  @Test("two reloads of the same scope publish only the newest answer")
  func overlappingReloads() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let gate = ScanGate()
    let calls = ScanCalls()
    let model = fixture.model(scan: { _ in
      let call = await calls.next()
      await gate.wait()
      return SkillScanResult(
        skills: [
          SkillEntry(
            id: "call-\(call)", name: "call-\(call)", version: "", description: "",
            directory: URL(fileURLWithPath: "/tmp/call-\(call)"))
        ],
        roots: [])
    })
    await gate.arm()
    let first = Task { await model.reload() }
    while await !gate.isWaiting { try await Task.sleep(for: .milliseconds(5)) }
    let second = Task { await model.reload() }
    await second.value
    #expect(model.skills.map(\.name) == ["call-2"], "the newest answer is the one on the page")
    await gate.release()
    await first.value
    #expect(
      model.skills.map(\.name) == ["call-2"],
      "the answer that arrives last is the older one, and it does not publish")
    #expect(await calls.count == 2, "one scan per accepted request, and no rescan")
  }

  @Test("a root that is added while a scan runs is scanned again")
  func rootAddedDuringScan() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    let extra = fixture.home.appendingPathComponent("extra", isDirectory: true)
    try FileManager.default.createDirectory(at: extra, withIntermediateDirectories: true)
    try fixture.writeSkill(
      in: extra, "extra-skill", name: "extra-skill", description: "Runs extra.", version: "2.0.0")

    let gate = ScanGate()
    let model = fixture.model(scan: { roots in
      await gate.wait()
      return SkillScanner.scan(roots: roots)
    })
    await gate.arm()
    let scanning = Task { await model.reload() }
    while await !gate.isWaiting { try await Task.sleep(for: .milliseconds(5)) }
    let adding = Task { await model.addRoots([extra]) }
    while model.rootRows.count < 2 { try await Task.sleep(for: .milliseconds(5)) }
    await gate.release()
    await adding.value
    await scanning.value
    #expect(
      model.skills.map(\.name).sorted() == ["alpha-skill", "extra-skill"],
      "the scan that was running answered the old scope, so the new scope is scanned again")
  }

  @Test("a root that is removed while a scan runs is not published")
  func rootRemovedDuringScan() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let extra = fixture.home.appendingPathComponent("extra", isDirectory: true)
    try FileManager.default.createDirectory(at: extra, withIntermediateDirectories: true)
    try fixture.writeSkill(
      in: extra, "extra-skill", name: "extra-skill", description: "Runs extra.", version: "2.0.0")

    let gate = ScanGate()
    let model = fixture.model(scan: { roots in
      await gate.wait()
      return SkillScanner.scan(roots: roots)
    })
    await model.addRoots([extra])
    await model.reload()
    #expect(model.skills.map(\.name) == ["extra-skill"])

    await gate.arm()
    let scanning = Task { await model.reload() }
    while await !gate.isWaiting { try await Task.sleep(for: .milliseconds(5)) }
    let removing = Task { await model.removeRoot(extra) }
    while model.rootRows.count > 1 { try await Task.sleep(for: .milliseconds(5)) }
    await gate.release()
    await removing.value
    await scanning.value
    #expect(model.rootRows.count == 1)
    #expect(
      model.skills.isEmpty,
      "the scan that was running answered the old scope, so the new scope is scanned again")
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

  func model(
    scan: @escaping @Sendable ([URL]) async -> SkillScanResult = { SkillScanner.scan(roots: $0) },
    push: @escaping SkillPush = { _ in }
  ) -> SkillsSettingsViewModel {
    SkillsSettingsViewModel(
      defaults: defaults, home: home, scan: scan, selection: selection(push: push))
  }

  /// The App-scoped selection this fixture's pages share; a test that wants one queue for two
  /// pages hands the same value to both.
  func selection(push: @escaping SkillPush = { _ in }) -> SkillsSelection {
    SkillsSelection(defaults: defaults, push: push)
  }

  func writeSkill(_ folder: String, name: String, description: String, version: String) throws {
    try writeSkill(
      in: home.appendingPathComponent(".agents/skills"), folder, name: name,
      description: description, version: version)
  }

  func writeSkill(
    in root: URL, _ folder: String, name: String, description: String, version: String
  ) throws {
    let directory = root.appendingPathComponent(folder, isDirectory: true)
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

/// Holds a scan until the test lets it go, so the order of two scans can be pinned down.
private actor ScanGate {
  private var armed = false
  private var pending: [CheckedContinuation<Void, Never>] = []

  func arm() { armed = true }

  func wait() async {
    guard armed else { return }
    armed = false
    await withCheckedContinuation { continuation in
      pending.append(continuation)
    }
  }

  func release() {
    for continuation in pending { continuation.resume() }
    pending = []
  }

  var isWaiting: Bool { !pending.isEmpty }
}

/// Counts how many scans were asked for.
private actor ScanCalls {
  private var calls = 0

  func next() -> Int {
    calls += 1
    return calls
  }

  var count: Int { calls }
}

/// What a page's push actually sent, and what it should answer: a recorder the tests own, so
/// the page's own wording is the only thing under test.
private actor SkillPushRecorder {
  private(set) var pushes: [[SelectedSkill]] = []
  var failure: String?

  func push(_ skills: [SelectedSkill]) async throws {
    if let failure { throw ClientError(failure) }
    pushes.append(skills)
  }

  func fail(_ message: String?) { failure = message }

  var last: [SelectedSkill]? { pushes.last }
}

@Suite("Skills settings pushes its ticks", .serialized)
@MainActor
struct SkillsSettingsPushTests {
  @Test("ticking and unticking push the whole selection, in the order the page lists it")
  func ticksArePushed() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    try fixture.writeSkill("beta", name: "beta-skill", description: "Runs beta.", version: "2.0.0")
    let recorder = SkillPushRecorder()
    let model = fixture.model(push: { try await recorder.push($0) })
    await model.reload()
    await model.awaitSkillPush()
    #expect(await recorder.last == [], "an untouched page clears what the daemon had")

    let beta = try #require(model.skills.first { $0.name == "beta-skill" })
    let alpha = try #require(model.skills.first { $0.name == "alpha-skill" })
    model.setSelected(true, for: beta)
    await model.awaitSkillPush()
    #expect(
      await recorder.last == [
        SelectedSkill(
          name: "beta-skill", version: "2.0.0", description: "Runs beta.",
          path: "~/.agents/skills/beta")
      ])

    model.setSelected(true, for: alpha)
    await model.awaitSkillPush()
    #expect(
      await recorder.last?.map(\.name) == ["alpha-skill", "beta-skill"],
      "the daemon receives the page's own order")

    model.setSelected(false, for: alpha)
    await model.awaitSkillPush()
    #expect(await recorder.last?.map(\.name) == ["beta-skill"])
    model.setSelected(false, for: beta)
    await model.awaitSkillPush()
    #expect(await recorder.last == [], "unticking everything is a value, not silence")
  }

  @Test("adding a root pushes what the new scan found, including a skill outside the home")
  func rootChangesArePushed() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    let extra = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-skills-push-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: extra) }
    try FileManager.default.createDirectory(at: extra, withIntermediateDirectories: true)
    try fixture.writeSkill(
      in: extra, "gamma", name: "gamma-skill", description: "Runs gamma.", version: "3.0.0")
    let recorder = SkillPushRecorder()
    let model = fixture.model(push: { try await recorder.push($0) })

    await model.addRoots([extra])
    await model.awaitSkillPush()
    let gamma = try #require(model.skills.first { $0.name == "gamma-skill" })
    #expect(gamma.directory.standardizedFileURL == extra.appendingPathComponent("gamma"))

    model.setSelected(true, for: gamma)
    await model.awaitSkillPush()
    #expect(
      await recorder.last == [
        SelectedSkill(
          name: "gamma-skill", version: "3.0.0", description: "Runs gamma.",
          path: extra.appendingPathComponent("gamma").standardizedFileURL.path)
      ],
      "a path outside the home stays absolute, because the daemon has to reach it")

    await model.removeRoot(extra)
    await model.awaitSkillPush()
    #expect(
      await recorder.last == [],
      "a skill the scan no longer finds is not pushed as if it still existed")
  }

  @Test("a failed push keeps the tick, says so on the page, and the next visit tries again")
  func failureIsReportedAndRetried() async throws {
    let fixture = try SkillsFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha", name: "alpha-skill", description: "Runs alpha.", version: "1.0.0")
    let recorder = SkillPushRecorder()
    await recorder.fail("the daemon is not reachable")
    let model = fixture.model(push: { try await recorder.push($0) })
    await model.reload()
    let alpha = try #require(model.skills.first)
    model.setSelected(true, for: alpha)
    await model.awaitSkillPush()
    #expect(model.isSelected(alpha), "the local tick survives a failed push")
    #expect(model.selectedPaths == [alpha.id])
    let note = try #require(model.pushNote)
    #expect(note.contains("the daemon is not reachable"), "the page carries the daemon's words")
    #expect(fixture.model(push: { _ in }).selectedPaths == [alpha.id], "and it is stored locally")

    await recorder.fail(nil)
    await model.reload()
    await model.awaitSkillPush()
    #expect(model.pushNote == nil, "a successful push clears the note")
    #expect(await recorder.last?.map(\.name) == ["alpha-skill"])
  }
}
