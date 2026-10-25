import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Design tokens")
struct ThemeTests {
  @Test("layout metrics follow the measured reference grid")
  func metrics() {
    #expect(Theme.Metric.windowWidth == 1728)
    #expect(Theme.Metric.windowHeight == 1082)
    #expect(Theme.Metric.sidebarWidth == 374)
    #expect(Theme.Metric.inspectorWidth == 319)
    #expect(Theme.Metric.contentInset == 20)
    #expect(Theme.Metric.rowHeight == 58)
    #expect(Theme.Metric.avatarRow == 34)
    #expect(Theme.Metric.sectionHeaderHeight == 24)
    #expect(Theme.Metric.sectionGap == 18)
    #expect(Theme.Metric.headerHeight == 72)
    #expect(Theme.Metric.listCardInset == 12)
    #expect(Theme.Metric.rowContentInset + Theme.Metric.listCardInset == Theme.Metric.contentInset)
    #expect(Theme.Metric.headerLeadingInset == Theme.Metric.contentInset)
    #expect(Theme.Metric.edgeFadeHeight == 20)
    #expect(Theme.Metric.toolbarTopInset == 0)
    #expect(Theme.Metric.headerControlHeight == Theme.Metric.avatarRow)
    #expect(Theme.Metric.headerLeadingInset == Theme.Metric.contentInset)
    #expect(Theme.Metric.logoSize == Theme.Metric.avatarRow)
    #expect(Theme.Metric.composerHeight == Theme.Metric.footerHeight)
    #expect(Theme.Metric.composerBottomInset == Theme.Metric.footerBottom)
    #expect(Theme.Metric.toolbarHeight == 32)
    #expect(Theme.Metric.unreadPillHeight == 28)
    #expect(Theme.Metric.inspectorRowHeight == 40)
    #expect(Theme.Metric.composerHeight == 54)
    #expect(Theme.Metric.cardRadius == 12)
    #expect(Theme.Metric.pinnedHeaderHeight == 62)
  }

  @Test("column clamps stay ordered")
  func clamps() {
    #expect(Theme.Metric.sidebarMinWidth < Theme.Metric.sidebarWidth)
    #expect(Theme.Metric.sidebarWidth < Theme.Metric.sidebarMaxWidth)
    #expect(Theme.Metric.inspectorMinWidth < Theme.Metric.inspectorWidth)
    #expect(Theme.Metric.inspectorWidth < Theme.Metric.inspectorMaxWidth)
  }

  @Test("palette keeps the sampled values")
  func palette() {
    expectColor(Theme.Palette.canvas, 0xF2F2F7)
    expectColor(Theme.Palette.surface, 0xFFFFFF)
    expectColor(Theme.Palette.card, 0xFFFFFF)
    expectColor(Theme.Palette.line, 0xE4E4E9)
    expectColor(Theme.Palette.textPrimary, 0x141416)
    expectColor(Theme.Palette.textSecondary, 0x6C6C72)
    expectColor(Theme.Palette.textMuted, 0x9A9AA2)
    expectColor(Theme.Palette.accent, 0x0B84C4)
    expectColor(Theme.Palette.accentFill, 0x2FB457)
    expectColor(Theme.Palette.accentStrong, 0x2FB457)
  }

  @Test("avatar tints wrap and treat negatives by magnitude")
  func avatarTints() {
    #expect(Theme.Palette.avatarTints.count == 8)
    expectColor(Theme.Palette.avatarTint(0), 0xFF3B30)
    expectColor(Theme.Palette.avatarTint(8), 0xFF3B30)
    expectColor(Theme.Palette.avatarTint(7), 0xFFCC00)
    // Negative indices use the magnitude, matching the avatar helper contract.
    expectColor(Theme.Palette.avatarTint(-1), 0x0FA3E0)
  }
}

@Suite("Sidebar data")
struct SidebarDataTests {
  @Test("items keep identity and optional tags")
  func items() {
    let plain = SidebarItem(id: "a", title: "A", subtitle: "b")
    let tagged = SidebarItem(id: "a", title: "A", subtitle: "b")
    #expect(plain == tagged)
    #expect(plain.tag == nil)
    #expect(SidebarItem(id: "a", title: "A", subtitle: "b", tag: "Personal").tag == "Personal")
    let chrome = SidebarItem(
      id: "b", title: "B", subtitle: "c", pinned: true, unread: true)
    #expect(chrome.pinned)
    #expect(chrome.unread)
  }

  @Test("move groups carry id and title")
  func moveGroups() {
    let group = SidebarItemGroup(id: "g1", title: "秘书处")
    #expect(group.id == "g1")
    #expect(group.title == "秘书处")
  }

  @Test("sections carry expansion state")
  func sections() {
    let collapsed = SidebarSection(id: "s", title: "S", count: 3, isExpanded: false, items: [])
    #expect(collapsed.isExpanded == false)
    #expect(collapsed.count == 3)
    #expect(SidebarSection(id: "s", title: "S", items: []).isExpanded)
  }
}

@Suite("Transcript rows")
struct TranscriptTests {
  @Test("every row exposes a stable identifier")
  func identifiers() {
    let rows: [TranscriptEntry] = [
      .assistant(id: "a1", blocks: [.paragraph("x")]),
      .user(id: "u1", text: "y"),
      .note(id: "n1", text: "z", tintIndices: [0]),
      .typing(id: "t1"),
    ]
    #expect(rows.map(\.id) == ["a1", "u1", "n1", "t1"])
    #expect(Set(rows.map(\.id)).count == rows.count)
  }

  @Test("assistant blocks compare by content")
  func blocks() {
    #expect(AssistantTurn.Block.paragraph("x") == .paragraph("x"))
    #expect(AssistantTurn.Block.bullets(["a"]) != .bullets(["b"]))
  }
}

private func expectColor(
  _ color: Color,
  _ hex: UInt32,
  sourceLocation: SourceLocation = #_sourceLocation
) {
  // The tokens carry a light and a dark value; resolve in a fixed light appearance so the
  // assertion does not depend on the machine's current mode.
  let appearance = NSAppearance(named: .aqua) ?? NSAppearance.currentDrawing()
  var resolved: NSColor?
  appearance.performAsCurrentDrawingAppearance {
    resolved = NSColor(color).usingColorSpace(.sRGB)
  }
  guard let actual = resolved else {
    Issue.record("colour is not convertible to sRGB", sourceLocation: sourceLocation)
    return
  }
  let red = CGFloat((hex >> 16) & 0xFF) / 255
  let green = CGFloat((hex >> 8) & 0xFF) / 255
  let blue = CGFloat(hex & 0xFF) / 255
  #expect(abs(actual.redComponent - red) < 0.004, "red", sourceLocation: sourceLocation)
  #expect(abs(actual.greenComponent - green) < 0.004, "green", sourceLocation: sourceLocation)
  #expect(abs(actual.blueComponent - blue) < 0.004, "blue", sourceLocation: sourceLocation)
}
