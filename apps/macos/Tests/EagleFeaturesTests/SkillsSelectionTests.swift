import BotsCore
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

/// What the daemon would have received, in the order the pushes reached it.
///
/// A push is recorded when it starts and when it finishes, and a slow one is held so that a
/// second push issued while it is in flight would visibly overlap it: that overlap is what a
/// second queue looks like from the daemon's side.
private actor SkillPushTimeline {
  private(set) var events: [String] = []
  private(set) var last: [SelectedSkill] = []
  private var running = 0
  private(set) var overlapped = false

  func push(_ skills: [SelectedSkill]) async throws {
    if running > 0 { overlapped = true }
    running += 1
    let label = skills.map(\.name).joined(separator: "+")
    events.append("start:\(label)")
    // The first selection is the slow one: a queue that is not shared lets the newer one
    // overtake it and leave the daemon holding the older value.
    try await Task.sleep(for: .milliseconds(skills.contains { $0.name == "beta-skill" } ? 20 : 200))
    running -= 1
    events.append("finish:\(label)")
    last = skills
  }
}

/// A push that always answers with the daemon's own refusal.
private actor PushFailure {
  func push(_ skills: [SelectedSkill]) async throws {
    throw ClientError("the daemon is not reachable")
  }
}

/// A temporary home and defaults suite for the shared selection, never the machine's own.
@MainActor
private struct SelectionFixture {
  let home: URL
  let defaults: UserDefaults
  private let suiteName: String

  init() throws {
    suiteName = "eagle.skills.selection.tests.\(UUID().uuidString)"
    defaults = try #require(UserDefaults(suiteName: suiteName))
    home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-skills-selection-\(UUID().uuidString)", isDirectory: true)
    let root = home.appendingPathComponent(".agents/skills", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try writeSkill(in: root, "alpha", name: "alpha-skill", description: "Runs alpha.")
    try writeSkill(in: root, "beta", name: "beta-skill", description: "Runs beta.")
  }

  func writeSkill(in root: URL, _ folder: String, name: String, description: String) throws {
    let directory = root.appendingPathComponent(folder, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let text = """
      ---
      name: \(name)
      description: \(description)
      version: 1.0.0
      ---
      """
    try text.write(
      to: directory.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
  }

  func page(_ selection: SkillsSelection) -> SkillsSettingsViewModel {
    SkillsSettingsViewModel(defaults: defaults, home: home, selection: selection)
  }

  func cleanUp() {
    defaults.removePersistentDomain(forName: suiteName)
    try? FileManager.default.removeItem(at: home)
  }
}

/// The ticks and the queue are App-scoped on purpose: one settings window is a view of the
/// selection, and two windows that tick at the same moment must still reach the daemon in
/// the order the person made them (docs/bots/PROTOCOL.md, "Gateway settings").
@Suite("Skills selection is shared by every settings view", .serialized)
@MainActor
struct SkillsSelectionTests {
  @Test("two windows tick at the same moment, and one queue keeps the order")
  func twoViewsKeepOneOrder() async throws {
    let fixture = try SelectionFixture()
    defer { fixture.cleanUp() }
    let timeline = SkillPushTimeline()
    let selection = SkillsSelection(
      defaults: fixture.defaults, push: { try await timeline.push($0) })
    let first = fixture.page(selection)
    let second = fixture.page(selection)
    await first.reload()
    await second.reload()
    await selection.awaitPush()

    let alpha = try #require(first.skills.first { $0.name == "alpha-skill" })
    let beta = try #require(second.skills.first { $0.name == "beta-skill" })
    first.setSelected(true, for: alpha)
    second.setSelected(true, for: beta)
    await selection.awaitPush()

    #expect(
      await timeline.overlapped == false,
      "the second push waits for the first, even though another window made it")
    #expect(
      Array(await timeline.events.suffix(4)) == [
        "start:alpha-skill", "finish:alpha-skill", "start:alpha-skill+beta-skill",
        "finish:alpha-skill+beta-skill",
      ])
    #expect(
      await timeline.last.map(\.name) == ["alpha-skill", "beta-skill"],
      "the daemon ends with the newest selection, not the slowest push")
  }

  @Test("closing and reopening the page keeps the tick, the queue and its order")
  func closeAndReopenKeepsTheQueue() async throws {
    let fixture = try SelectionFixture()
    defer { fixture.cleanUp() }
    let timeline = SkillPushTimeline()
    let selection = SkillsSelection(
      defaults: fixture.defaults, push: { try await timeline.push($0) })
    let closing = fixture.page(selection)
    await closing.reload()
    await selection.awaitPush()
    let alpha = try #require(closing.skills.first { $0.name == "alpha-skill" })
    closing.setSelected(true, for: alpha)

    // The window goes away while the slow push is still in flight; a fresh page opens on the
    // same App-scoped selection, which is what a reopened 技能 page is.
    let reopened = fixture.page(selection)
    await reopened.reload()
    let beta = try #require(reopened.skills.first { $0.name == "beta-skill" })
    reopened.setSelected(true, for: beta)
    await selection.awaitPush()

    #expect(await timeline.overlapped == false, "reopening the page starts no second queue")
    #expect(
      await timeline.last.map(\.name) == ["alpha-skill", "beta-skill"],
      "the daemon ends with both ticks, in the page's order")
    #expect(reopened.isSelected(alpha), "the reopened page shows the tick from before")

    let restart = SkillsSelection(defaults: fixture.defaults, push: { _ in })
    #expect(
      restart.selectedPaths == [alpha.id, beta.id],
      "the machine keeps the ticks across a launch")
  }

  @Test("a page is only a view: a second page reads the same ticks and note")
  func pagesReadTheSameState() async throws {
    let fixture = try SelectionFixture()
    defer { fixture.cleanUp() }
    let selection = SkillsSelection(defaults: fixture.defaults, push: { _ in })
    let first = fixture.page(selection)
    await first.reload()
    let alpha = try #require(first.skills.first { $0.name == "alpha-skill" })
    first.setSelected(true, for: alpha)
    await selection.awaitPush()

    let second = fixture.page(selection)
    await second.reload()
    #expect(second.isSelected(alpha))
    #expect(second.selectedSkills.map(\.name) == ["alpha-skill"])
    #expect(second.pushNote == nil)
  }

  @Test("a refusal is part of the shared state, so every page says it")
  func refusalIsShared() async throws {
    let fixture = try SelectionFixture()
    defer { fixture.cleanUp() }
    let failure = PushFailure()
    let selection = SkillsSelection(
      defaults: fixture.defaults,
      push: { skills in
        try await failure.push(skills)
      })
    let first = fixture.page(selection)
    await first.reload()
    let alpha = try #require(first.skills.first { $0.name == "alpha-skill" })
    first.setSelected(true, for: alpha)
    await selection.awaitPush()
    #expect(first.pushNote?.contains("the daemon is not reachable") == true)

    let second = fixture.page(selection)
    #expect(
      second.pushNote?.contains("the daemon is not reachable") == true,
      "the reopened page says what the daemon answered")
    #expect(second.isSelected(alpha), "and the tick is still there to be sent again")
  }
}
