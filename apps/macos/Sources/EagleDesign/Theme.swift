import AppKit
import SwiftUI

/// Design tokens. Colours are dynamic: each token carries a light and a dark
/// value, so views never branch on the colour scheme. The accent family is an
/// iPhone 5C candy palette; surfaces stay neutral so the colour pops.
public enum Theme {
  public enum Palette {
    public static let canvas = Color(light: 0xF2F2F7, dark: 0x1B1B1D)
    public static let surface = Color(light: 0xFFFFFF, dark: 0x121214)
    public static let card = Color(light: 0xFFFFFF, dark: 0x1F1F22)
    public static let line = Color(light: 0xE4E4E9, dark: 0x333338)
    public static let textPrimary = Color(light: 0x141416, dark: 0xF5F5F7)
    public static let textSecondary = Color(light: 0x6C6C72, dark: 0xA6A6AE)
    public static let textMuted = Color(light: 0x9A9AA2, dark: 0x75757D)
    public static let taskGuide = textMuted.opacity(0.55)
    public static let accent = Color(light: 0x0B84C4, dark: 0x4FC3F7)
    public static let accentFill = Color(light: 0x2FB457, dark: 0x2FB457)
    public static let accentStrong = Color(light: 0x2FB457, dark: 0x3DD068)
    public static let info = Color(light: 0x0B6FBE, dark: 0x7FC8FF)
    /// Waiting on someone else: a review, a check, a person.
    public static let warning = Color(light: 0xB46A00, dark: 0xF0A93A)
    public static let infoFill = Color(light: 0xE4F4FD, dark: 0x10293C)
    public static let destructive = Color(light: 0xE5372F, dark: 0xFF5F57)
    public static let hover = Color(light: 0x000000, dark: 0xFFFFFF).opacity(0.06)
    public static let selection = Color(light: 0xFFFFFF, dark: 0x2A2A2E)
    /// An assistant's turn: one neutral card, a shade apart from the column behind it. Answers
    /// carry no tint, so the bot's colour stays on its face and its name.
    public static let assistantFill = Color(light: 0xF3F3F6, dark: 0x1D1D20)

    /// iPhone 5C candy tints, in rotation order.
    public static let avatarTints: [Color] = [
      Color(light: 0xFF3B30, dark: 0xFF5F57),
      Color(light: 0x0FA3E0, dark: 0x3BB8EC),
      Color(light: 0x34C759, dark: 0x45D96B),
      Color(light: 0xFF9F0A, dark: 0xFFB340),
      Color(light: 0xAF52DE, dark: 0xC177EF),
      Color(light: 0xFF2D55, dark: 0xFF5F80),
      Color(light: 0x00B4C4, dark: 0x2BD3E3),
      Color(light: 0xFFCC00, dark: 0xFFD84D),
    ]

    public static func avatarTint(_ index: Int) -> Color {
      avatarTints[abs(index) % avatarTints.count]
    }
  }

  public enum Metric {
    public static let windowWidth: CGFloat = 1728
    public static let windowHeight: CGFloat = 1082
    public static let sidebarWidth: CGFloat = 374
    public static let sidebarMinWidth: CGFloat = 300
    public static let sidebarMaxWidth: CGFloat = 560
    public static let inspectorWidth: CGFloat = 319
    public static let inspectorMinWidth: CGFloat = 280
    public static let inspectorMaxWidth: CGFloat = 460

    /// Traffic lights: three 13.5 pt circles from x 16 with a 23 pt pitch, in the window's own
    /// top-left corner. The brand row clears them rather than moving them.
    public static let trafficLightLeading: CGFloat = 16
    public static let trafficLightSize: CGFloat = 13.5
    public static let trafficLightPitch: CGFloat = 23
    /// A hidden-titlebar window lets the system park the buttons about 10 pt in; these nudge them
    /// onto the leading/top grid above so they do not hug the corner.
    public static let trafficLightNudgeX: CGFloat = 7
    /// Downward in the titlebar's own coordinates, so the lights' top edge lands on the same
    /// line as the header control row (both start at `headerTopInset`).
    public static let trafficLightNudgeY: CGFloat = -11.5
    public static let trafficLightsEnd: CGFloat =
      trafficLightLeading + trafficLightPitch * 2 + trafficLightSize
    public static let headerHeight: CGFloat = 72
    /// The tallest control in the header band is the participant card, so the band is its height.
    public static let headerBandHeight: CGFloat = participantHeight
    /// One content inset above every column's header: the card and both side columns start here.
    public static let headerTopInset: CGFloat = contentInset
    /// Content that shares the window's top corner with the traffic lights starts past them.
    public static let trafficLightsClearance: CGFloat = trafficLightsEnd + 8
    /// The reference header control: a 35 pt circle, a 16 pt glyph, a hairline ring and a soft
    /// drop shadow. Sized once here so every header group stays identical.
    public static let headerControlHeight: CGFloat = 35
    public static let roundGlyphRatio: CGFloat = 0.46
    public static let roundShadowRadius: CGFloat = 7
    public static let roundShadowY: CGFloat = 2.5
    public static let roundShadowOpacity: Double = 0.10
    /// Room a header control's shadow needs below its frame; without it the next panel paints
    /// over the shadow and it reads as cut off.
    public static let roundShadowBleed: CGFloat =
      roundShadowRadius + roundShadowY
    /// Gap between header circles, measured from the reference: 9 pt of air between rings.
    public static let headerControlGap: CGFloat = 9
    public static let participantHeight: CGFloat = 40
    public static let participantInset: CGFloat = 15
    public static let participantGap: CGFloat = 10
    public static let participantAvatar: CGFloat = 25
    public static let participantShadowRadius: CGFloat = 9
    public static let participantShadowY: CGFloat = 3
    public static let participantShadowOpacity: Double = 0.12

    public static let contentInset: CGFloat = 20
    /// Rows sit on cards inset from the panel edges; avatars keep the 20 pt line.
    public static let listCardInset: CGFloat = 12
    public static let rowContentInset: CGFloat = contentInset - listCardInset
    /// Every scrolling surface fades over the same distance.
    public static let edgeFadeHeight: CGFloat = 20
    public static let rowHeight: CGFloat = 58
    public static let rowAvatarGap: CGFloat = 11
    public static let sectionHeaderHeight: CGFloat = 24
    public static let sectionGap: CGFloat = 18
    public static let unreadPillHeight: CGFloat = 28
    public static let unreadPillBottom: CGFloat = 16
    public static let unreadBadgeHeight: CGFloat = 18
    public static let unreadBadgeInset: CGFloat = 5
    public static let footerHeight: CGFloat = 54
    public static let footerBottom: CGFloat = 7

    public static let panelInset: CGFloat = 16
    /// Inspector sections: a small glyph, a label, a hairline, then rows. The gap is tighter
    /// than the sidebar's because three sections share one narrow column.
    public static let panelSectionGap: CGFloat = 14
    public static let panelSectionGlyph: CGFloat = 11
    public static let panelSectionGlyphWidth: CGFloat = 15
    public static let panelSectionBodyGap: CGFloat = 6
    /// Glyph-to-label gap inside one section header and one empty state.
    public static let panelSectionRowGap: CGFloat = 6
    public static let panelTaskRowGap: CGFloat = 2
    public static let panelTaskRowHeight: CGFloat = 28
    public static let panelTaskIndent: CGFloat = 16
    public static let panelTaskGuideClearance: CGFloat = 3
    public static let panelTaskGuideRadius: CGFloat = 3
    public static let panelTaskGuideDash: [CGFloat] = [2, 3]
    public static let panelTaskSpinner: CGFloat = 10
    public static let panelEmptyGlyph: CGFloat = 15
    public static let panelEmptyVertical: CGFloat = 8
    /// A peer exchange: an inline collapsed row in the transcript and a read-only dialog with a
    /// two-sided conversation. Rows are signed at the end, so the avatar sits under the last bubble.
    public static let peerFace: CGFloat = 15
    public static let peerChipFace: CGFloat = 20
    public static let peerGutter: CGFloat = 8
    public static let peerGroupGap: CGFloat = 18
    public static let peerMessageGap: CGFloat = 6
    public static let peerLabelGap: CGFloat = 6
    public static let peerBubbleMaxWidth: CGFloat = 560
    public static let peerBubbleRadius: CGFloat = 12
    /// The dialog's conversation column: narrower than the panel, so a 560 pt bubble does not
    /// stretch a line across the window.
    public static let peerDialogColumnWidth: CGFloat = 900
    public static let peerDialogRadius: CGFloat = 18
    public static let peerDialogInset: CGFloat = 22
    public static let peerDialogFooter: CGFloat = 56
    public static let conversationInset: CGFloat = 24
    public static let turnGap: CGFloat = 24
    public static let inspectorRowHeight: CGFloat = 40
    public static let composerHeight: CGFloat = 54
    public static let composerVerticalInset: CGFloat = (composerHeight - hitTarget) / 2
    /// The composer's own horizontal inset, shared by the waiting line so its avatar lines up
    /// with the composer's first control and its text with the field's first character.
    public static let composerInnerInset: CGFloat = 14
    public static let composerBottomInset: CGFloat = 7
    /// The waiting line's band above the composer: always reserved, so work starting or
    /// finishing never moves the transcript.
    public static let waitingBandHeight: CGFloat = 32
    public static let waitingAvatar: CGFloat = 26
    public static let waitingDot: CGFloat = 6
    public static let waitingDotGap: CGFloat = 5
    public static let waitingDotLift: CGFloat = 3.5

    public static let avatarRow: CGFloat = 34
    /// The footer's product mark is a scaled app icon: it takes the macOS icon corner, not none.
    public static let productMarkRadius: CGFloat = 8
    public static let avatarProfile: CGFloat = 55
    public static let avatarInspector: CGFloat = 76
    public static let avatarNote: CGFloat = 18
    public static let iconButton: CGFloat = 32
    public static let hitTarget: CGFloat = 28
    public static let messageActionGlyph: CGFloat = 10

    public static let cardRadius: CGFloat = 12
    public static let controlRadius: CGFloat = 9
    public static let hairline: CGFloat = 1

    public static let collapseDuration: CGFloat = 0.28
    public static let conversationMaxContentWidth: CGFloat = 720

    public static let settingsRailWidth: CGFloat = 190
    public static let settingsRowHeight: CGFloat = 46
    public static let settingsCardRadius: CGFloat = 14
    public static let settingsCardInset: CGFloat = 20
    public static let settingsContentInset: CGFloat = 28
    public static let accountMenuWidth: CGFloat = 226
    public static let accountRowHeight: CGFloat = 38
    public static let galleryInset: CGFloat = 24
    public static let galleryRailWidth: CGFloat = 208
    public static let galleryRadius: CGFloat = 18
    public static let settingsWidth: CGFloat = 1120
    public static let settingsHeight: CGFloat = 820
  }

  public enum TypeScale {
    public static let rowTitle = Font.system(size: 15, weight: .medium)
    public static let rowSubtitle = Font.system(size: 13.5)
    public static let sectionLabel = Font.system(size: 13.5, weight: .medium)
    public static let brand = Font.system(size: 17, weight: .semibold)
    public static let body = Font.system(size: 15)
    public static let bodyEmphasis = Font.system(size: 15, weight: .medium)
    public static let bubble = Font.system(size: 15)
    public static let note = Font.system(size: 13)
    public static let composer = Font.system(size: 15)
    public static let inspectorTitle = Font.system(size: 18, weight: .semibold)
    public static let cardTitle = Font.system(size: 14, weight: .medium)
    public static let mono = Font.system(size: 13, design: .monospaced)
    public static let pill = Font.system(size: 11.5, weight: .medium)
    public static let activity = Font.system(size: 12, weight: .medium)
  }
}

extension Color {
  /// Dynamic colour with separate light and dark sRGB values.
  init(light: UInt32, dark: UInt32) {
    self.init(
      nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(srgb: isDark ? dark : light)
      }
    )
  }
}

extension NSColor {
  fileprivate convenience init(srgb value: UInt32) {
    self.init(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }
}
