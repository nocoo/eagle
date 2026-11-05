import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Consolidated presentation tokens")
struct TokenConsolidationTests {
  @Test("manual Bot tints retain their order and light/dark colors")
  func botPalette() throws {
    let names = [
      "paper", "clay", "red", "orange", "yellow", "green", "teal", "sky", "blue", "violet", "pink",
      "graphite",
    ]
    let light: [UInt32] = [
      0xFFFFFF, 0xA9713F, 0xE5484D, 0xF5752B, 0xF5B51B, 0x3DBB6A, 0x2FB7A3, 0x56B4E9,
      0x3B7CF6, 0x8B5CF6, 0xF04FA0, 0x6E6E76,
    ]
    let dark: [UInt32] = [
      0xF4F4F6, 0xB98052, 0xF4646A, 0xFF8C4D, 0xFFC63D, 0x4CD47C, 0x3FD0BC, 0x6FC8F5,
      0x5A94FF, 0xA479FF, 0xFF6FB5, 0x8A8A93,
    ]
    #expect(Theme.Palette.BotTint.allCases.map(\.rawValue) == names)
    for (index, tint) in Theme.Palette.BotTint.allCases.enumerated() {
      try expectColor(Theme.Palette.botTint(tint), light[index], appearance: .aqua)
      try expectColor(Theme.Palette.botTint(tint), dark[index], appearance: .darkAqua)
    }
    try expectColor(Theme.Palette.botEye, 0x2A2A2E, appearance: .aqua)
    try expectColor(Theme.Palette.botEye, 0x1A1A1C, appearance: .darkAqua)
  }

  @Test("overlay tokens retain opacity including the nearly transparent hit surface")
  func overlays() throws {
    let white: [(Color, CGFloat)] = [
      (Theme.Palette.onColor, 1), (Theme.Palette.onColorSecondary, 0.72),
      (Theme.Palette.unreadHighlight, 0.22),
    ]
    let black: [(Color, CGFloat)] = [
      (Theme.Palette.hitSurface, 0.001), (Theme.Palette.modalScrim, 0.32),
      (Theme.Palette.avatarScrim, 0.36), (Theme.Palette.modalShadow, 0.28),
      (Theme.Palette.peerAvatarShadow, 0.22), (Theme.Palette.switchShadow, 0.08),
      (Theme.Palette.accountShadow, 0.10), (Theme.Palette.roundShadow, 0.10),
      (Theme.Palette.participantShadow, 0.12),
    ]
    for appearance in [NSAppearance.Name.aqua, .darkAqua] {
      for (color, alpha) in white {
        try expectColor(color, 0xFFFFFF, alpha: alpha, appearance: appearance)
      }
      for (color, alpha) in black {
        try expectColor(color, 0, alpha: alpha, appearance: appearance)
      }
      #expect(Theme.Palette.clear == Color.clear)
    }
  }

  @Test("typography extraction does not change font sizes, weights or designs")
  func typography() {
    let pairs: [(Font, Font)] = [
      (Theme.TypeScale.noteEmphasis, .system(size: 13, weight: .medium)),
      (Theme.TypeScale.noteStrong, .system(size: 13, weight: .semibold)),
      (Theme.TypeScale.compactBody, .system(size: 12.5)),
      (Theme.TypeScale.compactEmphasis, .system(size: 12.5, weight: .medium)),
      (Theme.TypeScale.compactTitle, .system(size: 12, weight: .semibold)),
      (Theme.TypeScale.fieldLabel, .system(size: 14)),
      (Theme.TypeScale.sectionTitle, .system(size: 15, weight: .semibold)),
      (Theme.TypeScale.cardTitleStrong, .system(size: 14, weight: .semibold)),
      (Theme.TypeScale.sectionLabelStrong, .system(size: 13.5, weight: .semibold)),
      (Theme.TypeScale.settingsTitle, .system(size: 22, weight: .semibold)),
      (Theme.TypeScale.dialogTitle, .system(size: 20, weight: .semibold)),
      (Theme.TypeScale.aboutTitle, .system(size: 44, weight: .semibold)),
      (Theme.TypeScale.galleryTitle, .system(size: 26, weight: .semibold)),
      (Theme.TypeScale.gallerySymbol, .system(size: 24, weight: .medium)),
      (Theme.TypeScale.toolCaption, .system(size: 10.5, weight: .medium)),
      (Theme.TypeScale.localBadge, .system(size: 10, weight: .medium)),
      (Theme.TypeScale.compactBadge, .system(size: 11, weight: .medium)),
      (Theme.TypeScale.monoCaption, .system(size: 11.5, design: .monospaced)),
      (Theme.TypeScale.monoTitle, .system(size: 12, weight: .semibold, design: .monospaced)),
      (
        Theme.TypeScale.toolDetailTitle, .system(size: 12.5, weight: .semibold, design: .monospaced)
      ),
      (Theme.TypeScale.code, .system(size: 12.5, design: .monospaced)),
      (Theme.TypeScale.codeLanguage, .system(size: 11, weight: .medium, design: .monospaced)),
      (Theme.TypeScale.streamingCaret, .system(size: 14, design: .monospaced)),
      (Theme.TypeScale.bodyStrong, .system(size: 15, weight: .bold)),
      (Theme.TypeScale.bodyItalic, .system(size: 15).italic()),
      (Theme.TypeScale.Glyph.compact, .system(size: 12)),
      (Theme.TypeScale.Glyph.action, .system(size: 10, weight: .semibold)),
      (Theme.TypeScale.Glyph.chevron, .system(size: 9, weight: .semibold)),
      (Theme.TypeScale.Glyph.microChevron, .system(size: 8, weight: .semibold)),
      (Theme.TypeScale.Glyph.groupChevron, .system(size: 9, weight: .bold)),
      (Theme.TypeScale.Glyph.unreadChevron, .system(size: 8, weight: .bold)),
      (Theme.TypeScale.Glyph.delivery, .system(size: 7, weight: .bold)),
      (Theme.TypeScale.Glyph.pin, .system(size: 9.5, weight: .semibold)),
      (Theme.TypeScale.Glyph.status, .system(size: 9, weight: .medium)),
      (Theme.TypeScale.Glyph.notice, .system(size: 11)),
      (Theme.TypeScale.Glyph.device, .system(size: 16)),
      (Theme.TypeScale.Glyph.section, .system(size: 11, weight: .semibold)),
      (Theme.TypeScale.Glyph.sectionRegular, .system(size: 11, weight: .medium)),
      (Theme.TypeScale.Glyph.empty, .system(size: 15, weight: .regular)),
    ]
    for (actual, expected) in pairs { #expect(actual == expected) }
    for (level, size) in [(1, 20.0), (2, 17.0), (3, 15.5)] {
      #expect(Theme.TypeScale.markdownHeading(level) == Font.system(size: size, weight: .semibold))
    }
    #expect(Theme.TypeScale.avatarInitial(size: 50) == Font.system(size: 21, weight: .semibold))
    #expect(
      Theme.TypeScale.buttonGlyph(size: 16, circled: true)
        == Font.system(size: 16, weight: .regular))
    #expect(
      Theme.TypeScale.buttonGlyph(size: 16, circled: false)
        == Font.system(size: 16, weight: .medium))
  }
}

private func expectColor(
  _ color: Color, _ hex: UInt32, alpha: CGFloat = 1, appearance: NSAppearance.Name
) throws {
  let appearance = try #require(NSAppearance(named: appearance))
  var resolved: NSColor?
  appearance.performAsCurrentDrawingAppearance { resolved = NSColor(color).usingColorSpace(.sRGB) }
  let actual = try #require(resolved)
  #expect(abs(actual.redComponent - CGFloat((hex >> 16) & 0xFF) / 255) < 0.004)
  #expect(abs(actual.greenComponent - CGFloat((hex >> 8) & 0xFF) / 255) < 0.004)
  #expect(abs(actual.blueComponent - CGFloat(hex & 0xFF) / 255) < 0.004)
  #expect(abs(actual.alphaComponent - alpha) < 0.001)
}
