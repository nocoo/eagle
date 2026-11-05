import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Selection menu recipes")
struct SelectionMenuStyleTests {
  @Test("consolidation preserves the seven existing menu presentations")
  func recipes() {
    typealias Style = SelectionMenu<EmptyView>.Style
    let recipes: [(Style, CGFloat?, CGFloat, CGFloat, Font, Font, Color)] = [
      (
        .surface, 32, 14, 6, Theme.TypeScale.noteEmphasis, Theme.TypeScale.Glyph.chevron,
        Theme.Palette.textSecondary
      ),
      (
        .standard, 32, 14, 6, Theme.TypeScale.noteEmphasis, Theme.TypeScale.Glyph.chevron,
        Theme.Palette.textSecondary
      ),
      (.provider, 32, 12, 6, Theme.TypeScale.note, Theme.TypeScale.note, Theme.Palette.textPrimary),
      (
        .compact, 26, 12, 6, Theme.TypeScale.compactEmphasis, Theme.TypeScale.Glyph.chevron,
        Theme.Palette.textSecondary
      ),
      (
        .action, 30, 14, 6, Theme.TypeScale.noteEmphasis, Theme.TypeScale.noteEmphasis,
        Theme.Palette.textPrimary
      ),
      (
        .inline, nil, 0, 4, Theme.TypeScale.pill, Theme.TypeScale.Glyph.microChevron,
        Theme.Palette.textMuted
      ),
      (.policy, nil, 0, 6, Theme.TypeScale.note, Theme.TypeScale.note, Theme.Palette.textPrimary),
    ]
    #expect(recipes.count == Style.allCases.count)
    for (style, height, inset, gap, text, glyph, color) in recipes {
      #expect(style.height == height)
      #expect(style.inset == inset)
      #expect(style.gap == gap)
      #expect(style.textFont == text)
      #expect(style.glyphFont == glyph)
      #expect(style.glyphColor == color)
    }
  }

  @Test("field and action extraction preserves the existing dimensions and focus paint")
  func forms() {
    #expect(Theme.Form.actionHeight == 30)
    #expect(Theme.Form.actionRadius == 8)
    #expect(Theme.Form.fieldHeight == 34)
    #expect(Theme.Form.fieldInset == 11)
    #expect(Theme.Form.fieldPlaceholderInset == 12)
    #expect(Theme.Form.textAreaMinHeight == 88)
    #expect(Theme.Form.rowVerticalInset == 16)
    #expect(Theme.Palette.fieldFocus == Theme.Palette.accent.opacity(0.65))
  }
}
