import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Readable identity colors")
@MainActor
struct IdentityPaletteTests {
  @Test("all eight families have readable opaque pairs in both appearances")
  func identityPairs() throws {
    #expect(
      Theme.Palette.BotTint.selectable.map(\.rawValue) == [
        "red", "orange", "yellow", "green", "teal", "blue", "violet", "pink",
      ])
    for tint in Theme.Palette.BotTint.selectable {
      let colors = Theme.Palette.family(tint)
      for appearance in [NSAppearance.Name.aqua, .darkAqua] {
        #expect(try contrast(colors.onSolid, colors.solid, appearance) >= 4.5)
        #expect(try contrast(colors.onSoft, colors.soft, appearance) >= 4.5)
        #expect(try contrast(Theme.Palette.darkInk, colors.identity, appearance) >= 4.5)
        for background in [Theme.Palette.canvas, Theme.Palette.surface, Theme.Palette.card] {
          #expect(try contrast(colors.ink, background, appearance) >= 4.5)
        }
      }
      let peer = PeerRef(id: "b_fixture", title: "Name", face: .init(shape: .blob, tint: tint))
      #expect(peer.colors.ink == colors.ink)
    }
    #expect(PeerRef(id: "unknown", title: "Unknown").colors.ink == Theme.Palette.textSecondary)
  }

  @Test("primary spacing and shared control boxes follow the four-point grid")
  func grid() {
    let primary: [CGFloat] = [
      Theme.Layout.captionGap, Theme.Layout.rowGap, Theme.Layout.controlGap,
      Theme.Layout.sectionGap, Theme.Layout.sectionInset, Theme.Layout.groupGap,
      Theme.Chat.userVerticalInset, Theme.Chat.assistantVerticalInset, Theme.Chat.bulletGap,
      Theme.Sidebar.rowTextGap, Theme.Sidebar.rowMetaGap, Theme.Inspector.nameGap,
      Theme.Metric.rowHeight, Theme.Metric.avatarRow, Theme.Metric.headerControlHeight,
      Theme.Metric.composerHeight, Theme.Metric.footerHeight, Theme.Metric.participantAvatar,
      Theme.Form.actionHeight, Theme.Form.fieldHeight, Theme.Form.fieldInset,
      Theme.Dialog.nameFieldHeight, Theme.Picker.swatchSize,
    ]
    for value in primary { #expect(value.truncatingRemainder(dividingBy: 4) == 0) }
    for value in [Theme.Layout.minimumGap, Theme.Layout.microGap, Theme.Layout.labelGap] {
      #expect(value.truncatingRemainder(dividingBy: 2) == 0)
    }
  }

  @Test("resize lines align to physical pixels without shrinking their hit region")
  func resizePixels() {
    for pixel: CGFloat in [1, 0.5] {
      for inverted in [false, true] {
        let inset = Theme.Metric.resizeLineInset(pixelLength: pixel, inverted: inverted)
        #expect(inset.truncatingRemainder(dividingBy: pixel) == 0)
        #expect(inset >= Theme.Metric.resizeOverhang)
        #expect(inset + pixel <= Theme.Metric.resizeOverhang + Theme.Metric.hairline)
      }
    }
    #expect(Theme.Metric.resizeHitWidth == 11)
  }

  @Test("actual filled actions and the send glyph consume the correct color roles")
  func actionConsumers() throws {
    let settings = SettingsActionButton("Save", prominent: true) {}
    let card = CardActionButton("Submit") {}
    let composer = Composer(placeholder: "Message", text: .constant("Ready"), onSend: {})
    for appearance in [NSAppearance.Name.aqua, .darkAqua] {
      #expect(try contrast(settings.textColor, settings.fillColor, appearance) >= 4.5)
      #expect(try contrast(card.textColor, card.fillColor, appearance) >= 4.5)
      #expect(try contrast(composer.sendTint, Theme.Palette.card, appearance) >= 3)
    }
  }

  @Test("selected previews and gray tags use readable text roles")
  func selectedText() throws {
    let row = ConversationRow(
      item: SidebarItem(id: "fixture", title: "Name", subtitle: "Preview"), selected: true)
    let tag = Tag("Project")
    for appearance in [NSAppearance.Name.aqua, .darkAqua] {
      #expect(try contrast(row.subtitleColor, Theme.Palette.selection, appearance) >= 4.5)
      #expect(try contrast(tag.textColor, Theme.Palette.line, appearance) >= 4.5)
      #expect(try contrast(Theme.Palette.onColor, Theme.Palette.unreadFill, appearance) >= 4.5)
    }
  }

  @Test("colored actions and secondary text meet normal-text contrast")
  func readableRoles() throws {
    for appearance in [NSAppearance.Name.aqua, .darkAqua] {
      #expect(try contrast(Theme.Palette.onColor, Theme.Palette.accentFill, appearance) >= 4.5)
      #expect(
        try contrast(Theme.Palette.onColorSecondary, Theme.Palette.accentFill, appearance) >= 4.5)
      for background in [Theme.Palette.canvas, Theme.Palette.surface, Theme.Palette.card] {
        #expect(try contrast(Theme.Palette.textMuted, background, appearance) >= 4.5)
        #expect(try contrast(Theme.Palette.fieldFocus, background, appearance) >= 3)
        #expect(try contrast(Theme.Palette.inlineEditFocus, background, appearance) >= 3)
      }
    }
  }
}

@MainActor
private func contrast(
  _ foreground: Color, _ background: Color, _ name: NSAppearance.Name
) throws -> Double {
  let appearance = try #require(NSAppearance(named: name))
  func resolve(_ color: Color) throws -> NSColor {
    var resolved: NSColor?
    appearance.performAsCurrentDrawingAppearance {
      resolved = NSColor(color).usingColorSpace(.sRGB)
    }
    return try #require(resolved)
  }
  func luminance(_ channels: [CGFloat]) -> Double {
    let linear = channels.map {
      let value = Double($0)
      return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  let fg = try resolve(foreground)
  let bg = try resolve(background)
  #expect(abs(bg.alphaComponent - 1) < 0.001)
  let front = [fg.redComponent, fg.greenComponent, fg.blueComponent]
  let back = [bg.redComponent, bg.greenComponent, bg.blueComponent]
  let blended = zip(front, back).map { $0 * fg.alphaComponent + $1 * (1 - fg.alphaComponent) }
  let first = luminance(blended)
  let second = luminance(back)
  return (max(first, second) + 0.05) / (min(first, second) + 0.05)
}
