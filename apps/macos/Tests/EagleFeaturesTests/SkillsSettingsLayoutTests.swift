import AppKit
import BotsCore
import Foundation
import ObjectiveC
import SwiftUI
import Testing

@testable import EagleFeatures

/// The 技能 page as a person meets it: the rendered tree carries the scan roots, the skill
/// rows, the search field and the statement that a tick is live for this machine's Bot service.
@Suite("Skills settings layout", .serialized)
@MainActor
struct SkillsSettingsLayoutTests {
  @Test("the page shows the scan roots, a skill row and what the ticks are for")
  func skillsPage() async throws {
    let fixture = try SkillsLayoutFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha-dir", name: "alpha-skill", description: "Runs alpha.", version: "2.0.0")
    let (model, window) = try await fixture.host()
    defer { window.orderOut(nil) }
    let nodes = entries(try #require(window.contentView))
    #expect(nodes.contains { title($0) == "~/.agents/skills" }, "the automatic root is named")
    #expect(nodes.contains { title($0) == "alpha-skill" }, "the skill's name is a column")
    #expect(nodes.contains { title($0) == "2.0.0" }, "the skill's version is a column")
    #expect(
      nodes.compactMap(title).contains { $0.contains("alpha-dir") },
      "the skill's directory is a column")
    #expect(
      nodes.compactMap(title).contains { $0.contains("搜索") },
      "the keyword field is on the page")
    #expect(
      nodes.compactMap(title).contains { $0.contains("这台机器的 Bot 服务") },
      "the page says the ticks are live for this machine's Bot service")
    #expect(
      nodes.compactMap(title).contains { $0.contains("skill_read") },
      "and that a Bot reads the file with skill_read before following it")
    #expect(
      nodes.compactMap(title).contains { $0.contains("还没有连接到任何 Bot") } == false,
      "the old not-connected sentence is gone")
    #expect(model.skills.count == 1)
  }

  @Test("a page with no skills says so instead of showing an empty table")
  func emptyState() async throws {
    let fixture = try SkillsLayoutFixture()
    defer { fixture.cleanUp() }
    let (_, window) = try await fixture.host()
    defer { window.orderOut(nil) }
    let nodes = entries(try #require(window.contentView))
    #expect(
      nodes.compactMap(title).contains { $0.contains("还没有找到技能") },
      "the empty state is written down")
  }

  @Test("the table's header and its rows put their columns in the same places")
  func columnsLineUp() async throws {
    let fixture = try SkillsLayoutFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha-dir", name: "alpha-skill", description: "Runs alpha.", version: "2.0.0")
    let (_, window) = try await fixture.host()
    defer { window.orderOut(nil) }
    let nodes = entries(try #require(window.contentView))
    func column(_ text: String) throws -> CGFloat {
      let node = try #require(nodes.first { title($0) == text }, "no column named \(text)")
      return try #require(frame(node), "\(text) has no frame").origin.x
    }
    let name = try column("名称")
    let version = try column("版本")
    let description = try column("描述")
    let path = try column("目录")
    #expect(name < version)
    #expect(version < description)
    #expect(description < path)
    let rowName = try column("alpha-skill")
    let rowVersion = try column("2.0.0")
    let rowDescription = try column("Runs alpha.")
    let rowPath = try column("~/.agents/skills/alpha-dir")
    #expect(name == rowName, "the name column is one column")
    #expect(version == rowVersion, "the version column is one column")
    #expect(description == rowDescription, "the description column is one column")
    #expect(
      path == rowPath,
      "the path column of the header is where the path column of a row is")
  }

  @Test("a refused push is a ⚠️ note on the page, and the tick stays")
  func pushFailureIsOnThePage() async throws {
    let fixture = try SkillsLayoutFixture()
    defer { fixture.cleanUp() }
    try fixture.writeSkill(
      "alpha-dir", name: "alpha-skill", description: "Runs alpha.", version: "2.0.0")
    let (skills, window) = try await fixture.host(push: { _ in
      throw ClientError("the daemon is not reachable")
    })
    defer { window.orderOut(nil) }
    let skill = try #require(skills.skills.first)
    skills.setSelected(true, for: skill)
    await skills.awaitSkillPush()
    window.contentView?.layoutSubtreeIfNeeded()
    let nodes = entries(try #require(window.contentView))
    #expect(
      nodes.compactMap(title).contains { $0.contains("the daemon is not reachable") },
      "the daemon's own answer is on the page")
    #expect(
      nodes.compactMap(title).contains { $0 == "⚠️" },
      "the note carries the failure marker")
    #expect(skills.isSelected(skill), "a refused push never unticks what the person ticked")
  }

  private func title(_ node: NSObject) -> String? {
    for name in ["AXTitle", "AXDescription", "AXValue"] {
      if let value = attribute(node, name) as? String, !value.isEmpty { return value }
    }
    return nil
  }

  /// The frame an accessibility node reports. SwiftUI's own nodes answer `accessibilityFrame`,
  /// which returns a struct, so the implementation is called directly.
  private func frame(_ node: NSObject) -> NSRect? {
    let selector = NSSelectorFromString("accessibilityFrame")
    guard node.responds(to: selector),
      let method = class_getInstanceMethod(type(of: node), selector)
    else { return nil }
    typealias Getter = @convention(c) (AnyObject, Selector) -> NSRect
    let getter = unsafeBitCast(method_getImplementation(method), to: Getter.self)
    return getter(node, selector)
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXChildren": "accessibilityChildren", "AXValue": "accessibilityValue",
      ][name] ?? name)
    if node.responds(to: selector) { return node.perform(selector)?.takeUnretainedValue() }
    let legacy = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: legacy) else { return nil }
    return node.perform(legacy, with: name)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}

/// A temporary home, its own defaults suite and a hosted settings window on the 技能 page.
@MainActor
private struct SkillsLayoutFixture {
  let home: URL
  let defaults: UserDefaults
  private let suiteName: String

  init() throws {
    suiteName = "eagle.skills.layout.\(UUID().uuidString)"
    defaults = try #require(UserDefaults(suiteName: suiteName))
    home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-skills-layout-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: home.appendingPathComponent(".agents/skills", isDirectory: true),
      withIntermediateDirectories: true)
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

  func host(
    push: @escaping SkillPush = { _ in }
  ) async throws -> (
    SkillsSettingsViewModel, NSWindow
  ) {
    let skills = SkillsSettingsViewModel(
      defaults: defaults, home: home, selection: SkillsSelection(defaults: defaults, push: push))
    let model = SettingsViewModel()
    model.selection = .skills
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: SettingsView(model: model, skills: skills))
    host.frame = NSRect(x: 0, y: 0, width: 960, height: 900)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 960, height: 900),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    // The page scans the folders when it appears; wait for the answer instead of racing it.
    for _ in 0..<100 where skills.skills.isEmpty {
      try? await Task.sleep(for: .milliseconds(10))
    }
    host.layoutSubtreeIfNeeded()
    return (skills, window)
  }

  func cleanUp() {
    defaults.removePersistentDomain(forName: suiteName)
  }
}
