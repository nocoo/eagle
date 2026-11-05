import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Design tokens")
struct ThemeTests {
  @Test("reference composition leaves room for reading and short-window settings")
  func compositionDefaults() {
    #expect(Theme.Metric.sidebarWidth == 320)
    #expect(Theme.Metric.inspectorWidth == 300)
    #expect(Theme.Metric.settingsWidth == 960)
    #expect(Theme.Metric.settingsHeight <= 760 - 48)
  }

  @Test("viewport allocation protects reading width across visibility and drag extremes")
  func viewportBounds() {
    for available: CGFloat in [1280, 1728] {
      for visibleSidebar in [false, true] {
        for visibleInspector in [false, true] {
          for desired in [(320.0, 300.0), (440.0, 400.0), (9999.0, 9999.0)] {
            let widths = Theme.Metric.columnWidths(
              available: available, sidebar: desired.0, inspector: desired.1,
              showsSidebar: visibleSidebar, showsInspector: visibleInspector)
            #expect(
              available - widths.sidebar - widths.inspector >= Theme.Metric.conversationMinWidth)
            #expect(
              visibleSidebar ? widths.sidebar >= Theme.Metric.sidebarMinWidth : widths.sidebar == 0)
            #expect(
              visibleInspector
                ? widths.inspector >= Theme.Metric.inspectorMinWidth : widths.inspector == 0)
            #expect(widths.sidebar <= Theme.Metric.sidebarMaxWidth)
            #expect(widths.inspector <= Theme.Metric.inspectorMaxWidth)
          }
        }
      }
    }
  }

  @Test("settings bounds respect the available host instead of an inner minimum")
  func settingsBounds() {
    for available in [
      CGSize(width: 1280, height: 760), CGSize(width: 1280, height: 800),
      CGSize(width: 1280, height: 1410), CGSize(width: 1728, height: 1082),
      CGSize(width: 480, height: 400),
    ] {
      let size = Theme.Metric.settingsSize(in: available)
      #expect(size.width <= available.width - Theme.Dialog.outerClearance * 2)
      #expect(size.height <= available.height - Theme.Dialog.outerClearance * 2)
      #expect(size.width <= 960)
      #expect(size.height <= 700)
    }
  }

  @Test("shared spacing maintains native window clearances")
  func metrics() {
    #expect(Theme.Metric.windowWidth == 1728)
    #expect(Theme.Metric.windowHeight == 1082)
    #expect(Theme.Metric.sidebarWidth == 320)
    #expect(Theme.Metric.inspectorWidth == 300)
    #expect(Theme.Metric.contentInset == 20)
    #expect(Theme.Metric.rowHeight == 60)
    #expect(Theme.Metric.avatarRow == 36)
    #expect(Theme.Metric.sectionHeaderHeight == 24)
    #expect(Theme.Metric.sectionGap == 20)
    #expect(Theme.Metric.headerHeight == 72)
    #expect(Theme.Metric.headerBandHeight == Theme.Metric.participantHeight)
    #expect(Theme.Metric.headerTopInset == 20)
    #expect(Theme.Metric.participantHeight == 40)
    #expect(Theme.Metric.participantAvatar == 24)
    #expect(
      Theme.Metric.headerTopInset + Theme.Metric.headerBandHeight <= Theme.Metric.headerHeight)
    #expect(Theme.Metric.trafficLightsEnd == 75.5)
    #expect(Theme.Metric.trafficLightsClearance > Theme.Metric.trafficLightsEnd)
    #expect(Theme.Metric.listCardInset == 12)
    #expect(Theme.Metric.rowContentInset + Theme.Metric.listCardInset == Theme.Metric.contentInset)
    #expect(Theme.Metric.edgeFadeHeight == 20)
    #expect(Theme.Metric.headerControlHeight == 36)
    #expect(Theme.Metric.headerControlHeight * Theme.Metric.roundGlyphRatio < 17)
    #expect(Theme.Metric.composerHeight == Theme.Metric.footerHeight)
    #expect(Theme.Metric.composerBottomInset == Theme.Metric.footerBottom)
    #expect(Theme.Metric.unreadPillHeight == 28)
    #expect(Theme.Metric.inspectorRowHeight == 40)
    #expect(Theme.Metric.composerHeight == 56)
    #expect(Theme.Metric.cardRadius == 12)
    #expect(Theme.Metric.resizeHitWidth == 11)
    #expect(Theme.Metric.resizeOverhang == 5)
    #expect(Theme.Sidebar.rowTextGap == 4)
    #expect(Theme.Sidebar.rowMetaGap == 8)
    #expect(Theme.Sidebar.unreadDot == 8)
    #expect(Theme.Inspector.nameMaxWidth == 220)
    #expect(Theme.Inspector.labelMaxWidth == 150)
    #expect(Theme.Inspector.busyAvatarRise == 3)
    #expect(Theme.Inspector.tabsGap == 12)
    #expect(Theme.Motion.hover == Animation.easeOut(duration: 0.12))
    #expect(Theme.Motion.sectionExpansion == Animation.easeInOut(duration: 0.18))
    #expect(Theme.Motion.columns == Animation.snappy(duration: 0.28))
  }

  @Test("column clamps stay ordered")
  func clamps() {
    #expect(Theme.Metric.sidebarMinWidth < Theme.Metric.sidebarWidth)
    #expect(Theme.Metric.sidebarWidth < Theme.Metric.sidebarMaxWidth)
    #expect(Theme.Metric.inspectorMinWidth < Theme.Metric.inspectorWidth)
    #expect(Theme.Metric.inspectorWidth < Theme.Metric.inspectorMaxWidth)
  }

  @Test("neutral and semantic roles use the current token definitions")
  func palette() {
    expectColor(Theme.Palette.canvas, 0xF3F3F3)
    expectColor(Theme.Palette.surface, 0xFCFCFC)
    expectColor(Theme.Palette.card, 0xFFFFFF)
    expectColor(Theme.Palette.line, 0xE3E3E3)
    expectColor(Theme.Palette.textPrimary, 0x141416)
    expectColor(Theme.Palette.textSecondary, 0x62626B)
    expectColor(Theme.Palette.textMuted, 0x6E6E76)
    expectColor(Theme.Palette.accent, 0x17639B)
    expectColor(Theme.Palette.accentFill, 0x23733E)
    expectColor(Theme.Palette.accentStrong, 0x256E39)
  }

  @Test("indexed fixture tints wrap safely including the minimum integer")
  func avatarTints() {
    #expect(Theme.Palette.avatarTints.count == 8)
    expectColor(Theme.Palette.avatarTint(0), 0xFF5A54)
    expectColor(Theme.Palette.avatarTint(8), 0xFF5A54)
    expectColor(Theme.Palette.avatarTint(7), 0xF17CB2)
    expectColor(Theme.Palette.avatarTint(-1), 0xF17CB2)
    expectColor(Theme.Palette.avatarTint(Int.min), 0xFF5A54)
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
    let collapsed = SidebarSection(
      id: "s", title: "S", isExpanded: false,
      items: [SidebarItem(id: "unread", title: "Unread", subtitle: "Message", unread: true)])
    #expect(collapsed.isExpanded == false)
    #expect(collapsed.unreadCount == 1)
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
    ]
    #expect(rows.map(\.id) == ["a1", "u1", "n1"])
    #expect(Set(rows.map(\.id)).count == rows.count)
  }

  @Test("assistant blocks compare by content")
  func blocks() {
    #expect(AssistantBlock.paragraph("x") == .paragraph("x"))
    #expect(AssistantBlock.bullets(["a"]) != .bullets(["b"]))
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
