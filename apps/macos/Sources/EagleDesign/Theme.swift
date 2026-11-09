import AppKit
import SwiftUI

/// Design tokens. Colours are dynamic: each token carries a light and a dark
/// value, so views never branch on the colour scheme. The accent family is an
/// iPhone 5C candy palette; surfaces stay neutral so the colour pops.
public enum Theme {
  public enum Palette {
    public static let canvas = Color(light: 0xF3F3F3, dark: 0x1B1B1D)
    public static let surface = Color(light: 0xFCFCFC, dark: 0x121214)
    public static let card = Color(light: 0xFFFFFF, dark: 0x1F1F22)
    public static let line = Color(light: 0xE3E3E3, dark: 0x333338)
    public static let textPrimary = Color(light: 0x141416, dark: 0xF5F5F7)
    public static let textSecondary = Color(light: 0x62626B, dark: 0xBDBDC6)
    public static let textMuted = Color(light: 0x6E6E76, dark: 0xAAAAB4)
    public static let taskGuide = textMuted.opacity(0.55)
    public static let disclosure = textSecondary.opacity(0.75)
    public static let clear = Color.clear
    public static let onColor = Color.white
    public static let onColorSecondary = Color.white.opacity(0.9)
    public static let unreadHighlight = Color.white.opacity(0.22)
    public static let modalScrim = Color.black.opacity(0.32)
    public static let avatarScrim = Color.black.opacity(0.36)
    public static let modalShadow = Color.black.opacity(0.28)
    public static let peerAvatarShadow = Color.black.opacity(0.22)
    public static let accountShadow = Color.black.opacity(0.10)
    public static let roundShadow = Color.black.opacity(Metric.roundShadowOpacity)
    public static let participantShadow = Color.black.opacity(Metric.participantShadowOpacity)
    public static let accent = family(.blue).ink
    public static let fieldFocus = accent
    public static let inlineEditFocus = accent
    public static let unreadFill = family(.blue).solid
    public static let unreadShadow = accent.opacity(0.28)
    public static let productFallback = family(.green).identity
    public static let disabledAction = textMuted.opacity(0.4)
    public static let quietCaret = accent.opacity(0.12)
    public static let pickerOutline = textPrimary.opacity(0.6)
    public static let gallerySelection = accentFill.opacity(0.09)
    public static let usageBar = accentStrong
    public static let updateFill = accentStrong.opacity(0.10)
    public static let hoveredControlBorder = line.opacity(1.4)

    public static func softTint(_ tint: Color) -> Color { tint.opacity(0.12) }
    public static func activityShadow(_ tint: Color, active: Bool) -> Color {
      tint.opacity(active ? 0.1 : 0)
    }
    public static let accentFill = family(.green).solid
    public static let accentStrong = family(.green).ink
    public static let info = Color(light: 0x17649B, dark: 0x92D4F5)
    /// Waiting on someone else: a review, a check, a person.
    public static let warning = Color(light: 0x8A5500, dark: 0xF0BA60)
    public static let infoFill = Color(light: 0xE4F4FD, dark: 0x10293C)
    public static let destructive = Color(light: 0xB4232D, dark: 0xFF8F89)
    public static let hover = Color(light: 0x000000, dark: 0xFFFFFF).opacity(0.06)
    public static let selection = Color(light: 0xE5E5E7, dark: 0x2A2A2E)
    /// An assistant's turn: one neutral card, a shade apart from the column behind it. Answers
    /// carry no tint, so the bot's colour stays on its face and its name.
    public static let assistantFill = Color(light: 0xF0F0F0, dark: 0x1D1D20)

    public enum BotTint: String, CaseIterable, Hashable, Sendable {
      case paper, clay, red, orange, yellow, green, teal, sky, blue, violet, pink, graphite

      public static let selectable: [Self] = [
        .red, .orange, .yellow, .green, .teal, .blue, .violet, .pink,
      ]
    }

    public struct IdentityColors: Sendable {
      public let identity: Color
      public let solid: Color
      public let soft: Color
      public let ink: Color
      public var onSolid: Color { Palette.onColor }
      public var onSoft: Color { Palette.darkInk }
    }

    public static let darkInk = Color(light: 0x1C1C1E, dark: 0x1C1C1E)
    public static let neutralFace = Color(light: 0xE2E2E8, dark: 0xBDBDC6)
    public static let neutralColors = IdentityColors(
      identity: neutralFace,
      solid: Color(light: 0x41414A, dark: 0x494952),
      soft: Color(light: 0xEEEEF3, dark: 0xD6D6DF),
      ink: textSecondary)

    private static let families: [IdentityColors] = [
      IdentityColors(
        identity: Color(light: 0xFF5A54, dark: 0xFF746E),
        solid: Color(light: 0xB93438, dark: 0xB63A40),
        soft: Color(light: 0xFFE9E6, dark: 0xF3CBC8),
        ink: Color(light: 0xB82D34, dark: 0xFF9A94)),
      IdentityColors(
        identity: Color(light: 0xFF9D50, dark: 0xFFB46B),
        solid: Color(light: 0x995015, dark: 0x9C531D),
        soft: Color(light: 0xFFF0DF, dark: 0xF2D8B9),
        ink: Color(light: 0x974914, dark: 0xFFBE88)),
      IdentityColors(
        identity: Color(light: 0xF7D451, dark: 0xFFE276),
        solid: Color(light: 0x776000, dark: 0x7C6410),
        soft: Color(light: 0xFFF8CE, dark: 0xF1E4AA),
        ink: Color(light: 0x735B00, dark: 0xF5DB72)),
      IdentityColors(
        identity: Color(light: 0x65C97A, dark: 0x81D993),
        solid: Color(light: 0x23733E, dark: 0x287744),
        soft: Color(light: 0xE7F5E9, dark: 0xC5E6CD),
        ink: Color(light: 0x256E39, dark: 0x91DDA0)),
      IdentityColors(
        identity: Color(light: 0x48C4B5, dark: 0x6FD8CA),
        solid: Color(light: 0x146F66, dark: 0x1B746A),
        soft: Color(light: 0xDDF5EF, dark: 0xBEE5DB),
        ink: Color(light: 0x126D63, dark: 0x83DBCF)),
      IdentityColors(
        identity: Color(light: 0x4BB5EB, dark: 0x78CBF2),
        solid: Color(light: 0x17649B, dark: 0x236A9E),
        soft: Color(light: 0xE5F3FD, dark: 0xC7E4F6),
        ink: Color(light: 0x17639B, dark: 0x92D4F5)),
      IdentityColors(
        identity: Color(light: 0xAB8BE8, dark: 0xC1A5F1),
        solid: Color(light: 0x6942A6, dark: 0x7150AE),
        soft: Color(light: 0xF1EAFB, dark: 0xDBCCEF),
        ink: Color(light: 0x6B42AA, dark: 0xCEB2FA)),
      IdentityColors(
        identity: Color(light: 0xF17CB2, dark: 0xF79AC5),
        solid: Color(light: 0xA03771, dark: 0xA84279),
        soft: Color(light: 0xFCE7F1, dark: 0xF1C9DE),
        ink: Color(light: 0xA13671, dark: 0xF8B2D3)),
    ]

    public static func family(_ tint: BotTint) -> IdentityColors {
      switch tint {
      case .red: families[0]
      case .orange, .clay: families[1]
      case .yellow: families[2]
      case .green: families[3]
      case .teal: families[4]
      case .blue, .sky: families[5]
      case .violet: families[6]
      case .pink: families[7]
      case .paper, .graphite: neutralColors
      }
    }

    public static let avatarTints = BotTint.selectable.map { family($0).identity }

    public static func avatarTint(_ index: Int) -> Color {
      avatarTints[(index % avatarTints.count + avatarTints.count) % avatarTints.count]
    }

    public static func botTint(_ tint: BotTint) -> Color {
      switch tint {
      case .paper: Color(light: 0xFFFFFF, dark: 0xF4F4F6)
      case .graphite: neutralColors.solid
      default: family(tint).identity
      }
    }

    public static func faceInk(_ tint: BotTint) -> Color {
      tint == .graphite ? onColor : darkInk
    }
  }

  public enum Layout {
    public static let minimumGap: CGFloat = 2
    public static let microGap: CGFloat = 2
    public static let captionGap: CGFloat = 4
    public static let detailGap: CGFloat = 4
    public static let labelGap: CGFloat = 6
    public static let rowGap: CGFloat = 8
    public static let controlGap: CGFloat = 8
    public static let sectionGap: CGFloat = 12
    public static let controlInset: CGFloat = 14
    public static let sectionInset: CGFloat = 16
    public static let groupGap: CGFloat = 20
    public static let pageInset: CGFloat = 24
    public static let pageBottomInset: CGFloat = 32
    public static let glyphSlot: CGFloat = 20
    public static let statusDot: CGFloat = 6
    public static let statusMarker: CGFloat = 8
    public static let disclosureSlot: CGFloat = 10
    public static let selectionRadius: CGFloat = 8
    public static let badgeRadius: CGFloat = 4
    public static let badgeInset: CGFloat = 4
    public static let badgeVerticalInset: CGFloat = 2
    public static let compactRowHeight: CGFloat = 32
  }

  public enum Chat {
    public static let userLeadingSpace: CGFloat = 64
    public static let assistantTrailingSpace: CGFloat = 32
    public static let actionGap: CGFloat = 8
    public static let bubbleHorizontalInset: CGFloat = 16
    public static let userVerticalInset: CGFloat = 8
    public static let userRadius: CGFloat = 16
    public static let assistantVerticalInset: CGFloat = 12
    public static let assistantRadius: CGFloat = 20
    public static let bubbleMaxWidth: CGFloat = 600
    public static let copyGutterWidth: CGFloat = Metric.hitTarget + Layout.rowGap
    public static let rowMaxWidth: CGFloat = bubbleMaxWidth + copyGutterWidth
    public static let laneMaxWidth: CGFloat = 960
    public static let blockGap: CGFloat = 10
    public static let headingLineSpacing: CGFloat = 4
    public static let bodyLineSpacing: CGFloat = 4
    public static let listLineSpacing: CGFloat = 4
    public static let listGap: CGFloat = 6
    public static let bulletGap: CGFloat = 8
    public static let bulletWidth: CGFloat = 8
    public static let quoteRuleWidth: CGFloat = 3
    public static let quoteRuleRadius: CGFloat = 1.5
    public static let codeInset: CGFloat = 12
    public static let codeVerticalInset: CGFloat = 8
    public static let codeHeaderInset: CGFloat = 8
    public static let codeRadius: CGFloat = 10
    public static let tableColumnGap: CGFloat = 18
    public static let tableRowGap: CGFloat = 6
    public static let tableVerticalInset: CGFloat = 2
    public static let composerRadius: CGFloat = Metric.composerHeight / 2
    public static let composerLines = 1...3
    public static let placeholderTurn: Double = 82
    public static let placeholderRise: CGFloat = 5
    public static let placeholderPerspective: CGFloat = 0.35
    public static let transcriptTopClearance: CGFloat = 8
    public static let transcriptBottomInset: CGFloat = 12
    public static let messageEntryScale: CGFloat = 0.985
  }

  public enum Tool {
    public static let detailGap: CGFloat = 8
    public static let rowVerticalInset: CGFloat = 4
    public static let rowRadius: CGFloat = 8
    public static let glyphSlot: CGFloat = 14
    public static let spinnerSize: CGFloat = 12
    public static let spinnerStroke: CGFloat = 1.5
    public static let detailSpinnerSize: CGFloat = 10
    public static let detailSpinnerStroke: CGFloat = 1.4
    public static let inputMaxHeight: CGFloat = 160
    public static let outputMaxHeight: CGFloat = 220
    public static let dialogInputMaxHeight: CGFloat = 170
    public static let dialogOutputMaxHeight: CGFloat = 240
    public static let headerVerticalInset: CGFloat = 12
    public static let dialogMinWidth: CGFloat = 620
    public static let dialogWidth: CGFloat = 680
    public static let dialogMinHeight: CGFloat = 420
    public static let dialogHeight: CGFloat = 520
  }

  public enum Card {
    public static let headerHeight: CGFloat = 40
    public static let optionGlyphSlot: CGFloat = 18
    public static let revealButton: CGFloat = 22
    public static let fieldHeight: CGFloat = 32
    public static let actionInset: CGFloat = 16
  }

  public enum Primitive {
    public static let smallRadius: CGFloat = 8
    public static let chevronGap: CGFloat = 8
    public static let edgeFadeDefault: CGFloat = 26
    public static let avatarBlobRatio: CGFloat = 0.34
    public static let avatarBadgeRatio: CGFloat = 0.28
    public static let avatarBadgeStrokeRatio: CGFloat = 0.05
    public static let avatarBadgeOffsetRatio: CGFloat = 0.04
    public static let plainGlyphRatio: CGFloat = 0.55
    public static let hoverContentOpacity: Double = 0.82
    public static let activityStroke: CGFloat = 1.5
    public static let activityShadowRadius: CGFloat = 8
    public static let activityShadowY: CGFloat = 2
    public static let activityPopoverWidth: CGFloat = 320
    public static let peerChipVerticalInset: CGFloat = 8
    public static let peerChipShadowRadius: CGFloat = 12
    public static let peerChipShadowY: CGFloat = 4
    public static let peerExchangeVerticalInset: CGFloat = 4
    public static let arcStart: CGFloat = 0.12
    public static let arcEnd: CGFloat = 0.78
  }

  public enum Page {
    public static let toolNameWidth: CGFloat = 132
    public static let providerAddressWidth: CGFloat = 240
    public static let providerModelWidth: CGFloat = 220
    public static let machinePromptMaxHeight: CGFloat = 150
    public static let usageChartHeight: CGFloat = 56
    public static let usageEmptyHeight: CGFloat = 2
    public static let usageMinimumHeight: CGFloat = 3
    public static let usageBarRadius: CGFloat = 2
    public static let productIcon: CGFloat = 64
    public static let deviceGlyphWidth: CGFloat = 12
    public static let deviceGlyphHeight: CGFloat = 20
    public static let deviceRowTextGap: CGFloat = 4
    public static let deviceDisclosureHeight: CGFloat = 44
    public static let emptyMaxWidth: CGFloat = 360
    public static let setupBannerVerticalInset: CGFloat = 8
    public static let deviceIconSlot: CGFloat = 16
    /// A settings table's columns: the checkbox, the name, the version and the path keep a
    /// width, and the description takes the room that is left.
    public static let tableCheckboxWidth: CGFloat = 24
    public static let tableNameWidth: CGFloat = 140
    public static let tableVersionWidth: CGFloat = 72
    public static let tablePathWidth: CGFloat = 220
  }

  public enum Dialog {
    /// A bot dialog is one compact card: wide enough for five shapes and eight chips on a
    /// row, and no taller than its own content.
    public static let botWidth: CGFloat = 460
    public static let compactHeaderHeight: CGFloat = 44
    public static let footerHeight: CGFloat = 48
    public static let approvalMinWidth: CGFloat = 560
    public static let approvalWidth: CGFloat = 640
    public static let approvalMaxWidth: CGFloat = 760
    public static let approvalMinHeight: CGFloat = 260
    public static let approvalContentHeight: CGFloat = 420
    public static let approvalWindowHeight: CGFloat = 620
    public static let outerClearance: CGFloat = 24
    /// Every modal surface — settings, a bot's face, a peer transcript, a tool run — is one
    /// card with the same radius, hairline and shadow.
    public static let radius: CGFloat = 18
    public static let shadowRadius: CGFloat = 40
    public static let shadowY: CGFloat = 18
    public static let backdropBlur: CGFloat = 2
    public static let peerOverlayTrailing: CGFloat = 46
    public static let peerTranscriptClearance: CGFloat = 22
    public static let peerOverlayVertical: CGFloat = 28
    public static let accountShadowRadius: CGFloat = 18
    public static let accountShadowY: CGFloat = 6
  }

  public enum Picker {
    public static let previewFace: CGFloat = 132
    public static let gridFace: CGFloat = 52
    public static let swatchSize: CGFloat = 32
    public static let outlineWidth: CGFloat = 2
    public static let shapeColumns = 5
    public static let tintColumns = 8
  }

  public enum Gallery {
    public static let minWidth: CGFloat = 960
    public static let minHeight: CGFloat = 640
    public static let windowWidth: CGFloat = 1180
    public static let windowHeight: CGFloat = 900
    public static let navigationTop: CGFloat = 40
    public static let controlsWidth: CGFloat = 320
    public static let previewHeight: CGFloat = 620
    public static let swatchHeight: CGFloat = 44
    public static let activeMarker: CGFloat = 5
    public static let sectionMarkerWidth: CGFloat = 4
    public static let sectionMarkerHeight: CGFloat = 18
    public static let sectionMarkerRadius: CGFloat = 2
    public static let identityLabelWidth: CGFloat = 72
    public static let paletteColumns = 5
  }

  public enum Sidebar {
    public static let headerGap: CGFloat = 6
    public static let listBottomInset: CGFloat = 8
    public static let blockGap: CGFloat = 2
    public static let blockVerticalInset: CGFloat = 2
    public static let groupContentGap: CGFloat = 6
    public static let disclosureGap: CGFloat = 4
    public static let disclosureWidth: CGFloat = 12
    public static let disclosureAngle: Double = 90
    public static let expandedDisclosureOpacity: Double = 0.8
    public static let collapsedDisclosureOpacity: Double = 0.5
    public static let rowTextGap: CGFloat = 4
    public static let rowMetaGap: CGFloat = 8
    public static let unreadDot: CGFloat = 8
    public static let unreadContentGap: CGFloat = 8
    public static let unreadHighlightSize: CGFloat = 18
    public static let unreadHorizontalInset: CGFloat = 12
    public static let unreadShadowRadius: CGFloat = 10
    public static let unreadShadowY: CGFloat = 3
  }

  public enum Inspector {
    public static let contentTopInset: CGFloat = 16
    public static let contentBottomInset: CGFloat = 20
    public static let identityGap: CGFloat = 8
    public static let nameGap: CGFloat = 4
    public static let labelGap: CGFloat = 4
    public static let identityTopInset: CGFloat = 8
    public static let identityBottomInset: CGFloat = 12
    public static let busyAvatarRise: CGFloat = 3
    public static let nameInset: CGFloat = 8
    public static let nameHeight: CGFloat = 32
    public static let nameRadius: CGFloat = 8
    public static let nameMaxWidth: CGFloat = 220
    public static let labelInset: CGFloat = 8
    public static let labelHeight: CGFloat = 24
    public static let labelRadius: CGFloat = 6
    public static let labelMaxWidth: CGFloat = 150
    public static let tabsGap: CGFloat = 12
    public static let tabsBottomInset: CGFloat = 6
  }

  public enum Motion {
    public static let hover = Animation.easeOut(duration: 0.12)
    public static let rowSelection = Animation.easeOut(duration: 0.14)
    public static let selection = Animation.easeOut(duration: 0.16)
    public static let sectionExpansion = Animation.easeInOut(duration: 0.18)
    public static let disclosure = Animation.snappy(duration: 0.22)
    public static let inspectorTab = Animation.easeOut(duration: 0.18)
    public static let columns = Animation.snappy(duration: Metric.collapseDuration)
    public static let waiting = Animation.easeOut(duration: 0.18)
    public static let copyFeedback = Animation.easeOut(duration: 0.15)
    /// How long a copy button says it copied before it asks to be pressed again.
    public static let copyFeedbackDuration: Duration = .seconds(2)
    public static let placeholderReduced = Animation.easeInOut(duration: 0.16)
    public static let placeholder = Animation.easeInOut(duration: 0.26)
    public static let caretInterval: TimeInterval = 0.62
    public static let frameInterval: TimeInterval = 1.0 / 30.0
    public static let faceRise: CGFloat = 1.5
    public static let faceScale: Double = 0.055
    public static let faceSway: Double = 5
    public static let facePeriod: TimeInterval = 2.2
    public static let waitingWordLift: CGFloat = 8
    public static let waitingCycle: TimeInterval = 3.4
    public static let waitingWordEnd: TimeInterval = 1.9
    public static let waitingCrossEnd: TimeInterval = 2.1
    public static let waitingDotsEnd: TimeInterval = 3.2
    public static let waitingCrossDuration: TimeInterval = 0.2
    public static let waitingDotPeriod: TimeInterval = 1.4
    public static let waitingDotPhase: Double = 0.7
    public static let waitingDotCount = 3
    public static let waitingLabelGap: CGFloat = 8
    public static let participantPeriod: TimeInterval = 2.8
    public static let participantTrail: CGFloat = 0.62
    public static let participantPeak: CGFloat = 0.88
    public static let stopEntryScale: CGFloat = 0.7
    public static let participant = Animation.spring(response: 0.38, dampingFraction: 0.82)
    public static let accountHover = Animation.easeOut(duration: 0.1)
    public static let overlayEntryScale: CGFloat = 0.995
    public static let modal = Animation.easeOut(duration: 0.18)
    public static let spinner = Animation.linear(duration: 0.9).repeatForever(autoreverses: false)
    /// A settings toast rises, reads, and leaves without moving the page under it.
    public static let toast = Animation.easeOut(duration: 0.2)
    public static let toastDwell: TimeInterval = 3
  }

  public enum Form {
    public static let navigationRowHeight: CGFloat = 32
    public static let controlGap: CGFloat = 6
    public static let controlInset: CGFloat = 14
    public static let compactControlInset: CGFloat = 12
    public static let inlineChoiceGap: CGFloat = 4
    public static let selectorHeight: CGFloat = 32
    public static let compactSelectorHeight: CGFloat = 26
    public static let actionHeight: CGFloat = 32
    public static let actionRadius: CGFloat = 8
    public static let fieldHeight: CGFloat = 36
    public static let fieldWidth: CGFloat = 300
    public static let fieldInset: CGFloat = 12
    public static let fieldPlaceholderInset: CGFloat = 12
    public static let sectionContentGap: CGFloat = 12
    public static let headingDetailGap: CGFloat = 4
    public static let rowContentGap: CGFloat = 16
    public static let rowDetailGap: CGFloat = 4
    public static let rowVerticalInset: CGFloat = 12
    public static let noteInset: CGFloat = 12
    /// The face a settings row draws beside a bot's name, smaller than a sidebar row.
    public static let entityFace: CGFloat = 24
    public static let noteMarkerGap: CGFloat = 8
    public static let textAreaMinHeight: CGFloat = 88
    public static let textAreaPlaceholderInset: CGFloat = 6
    public static let textAreaEditorHorizontalInset: CGFloat = 3
    public static let textAreaEditorVerticalInset: CGFloat = 2
    public static let textAreaOuterInset: CGFloat = 4
  }

  public enum Metric {
    public static let windowWidth: CGFloat = 1728
    public static let windowMinWidth: CGFloat = 1280
    public static let windowMinHeight: CGFloat = 760
    public static let windowHeight: CGFloat = 1082
    public static let sidebarWidth: CGFloat = 320
    public static let sidebarMinWidth: CGFloat = 280
    public static let sidebarMaxWidth: CGFloat = 440
    public static let inspectorWidth: CGFloat = 300
    public static let inspectorMinWidth: CGFloat = 280
    public static let inspectorMaxWidth: CGFloat = 400
    public static let conversationMinWidth: CGFloat = 560

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
    public static let headerControlHeight: CGFloat = 36
    public static let roundGlyphRatio: CGFloat = 0.46
    public static let roundShadowRadius: CGFloat = 7
    public static let roundShadowY: CGFloat = 2.5
    public static let roundShadowOpacity: Double = 0.10
    /// Room a header control's shadow needs below its frame; without it the next panel paints
    /// over the shadow and it reads as cut off.
    public static let roundShadowBleed: CGFloat =
      roundShadowRadius + roundShadowY
    /// A toast floats over the page, so its shadow is softer than a header control's.
    public static let toastShadowRadius: CGFloat = 14
    public static let toastShadowY: CGFloat = 5
    /// Gap between header circles, measured from the reference: 9 pt of air between rings.
    public static let headerControlGap: CGFloat = 8
    public static let participantHeight: CGFloat = 40
    public static let participantInset: CGFloat = 16
    public static let participantGap: CGFloat = 10
    public static let participantAvatar: CGFloat = 24
    public static let participantShadowRadius: CGFloat = 9
    public static let participantShadowY: CGFloat = 3
    public static let participantShadowOpacity: Double = 0.12

    public static let contentInset: CGFloat = 20
    /// Rows sit on cards inset from the panel edges; avatars keep the 20 pt line.
    public static let listCardInset: CGFloat = 12
    public static let rowContentInset: CGFloat = contentInset - listCardInset
    /// Every scrolling surface fades over the same distance.
    public static let edgeFadeHeight: CGFloat = 20
    public static let rowHeight: CGFloat = 60
    public static let rowAvatarGap: CGFloat = 12
    public static let sectionHeaderHeight: CGFloat = 24
    public static let sectionGap: CGFloat = 20
    public static let unreadPillHeight: CGFloat = 28
    public static let unreadPillBottom: CGFloat = 16
    public static let unreadBadgeHeight: CGFloat = 18
    public static let unreadBadgeInset: CGFloat = 4
    public static let footerHeight: CGFloat = 56
    public static let footerBottom: CGFloat = 8

    public static let panelInset: CGFloat = 16
    /// Inspector sections: a small glyph, a label, a hairline, then rows. The gap is tighter
    /// than the sidebar's because three sections share one narrow column.
    public static let panelSectionGap: CGFloat = 14
    public static let panelSectionGlyph: CGFloat = 11
    public static let panelSectionGlyphWidth: CGFloat = 16
    public static let panelSectionBodyGap: CGFloat = 6
    /// Glyph-to-label gap inside one section header and one empty state.
    public static let panelSectionRowGap: CGFloat = 6
    public static let panelTaskRowGap: CGFloat = 2
    public static let panelTaskRowHeight: CGFloat = 28
    public static let panelTaskIndent: CGFloat = 16
    public static let panelTaskGuideClearance: CGFloat = 4
    public static let panelTaskGuideRadius: CGFloat = 3
    public static let panelTaskGuideDash: [CGFloat] = [2, 3]
    public static let panelTaskSpinner: CGFloat = 10
    public static let panelEmptyGlyph: CGFloat = 15
    public static let panelEmptyVertical: CGFloat = 8
    /// A peer exchange: an inline collapsed row in the transcript and a read-only dialog with a
    /// two-sided conversation. Rows are signed at the end, so the avatar sits under the last bubble.
    public static let peerFace: CGFloat = 16
    public static let peerChipFace: CGFloat = 20
    public static let peerGutter: CGFloat = 8
    public static let peerGroupGap: CGFloat = 20
    public static let peerMessageGap: CGFloat = 6
    public static let peerLabelGap: CGFloat = 6
    public static let peerBubbleMaxWidth: CGFloat = 560
    public static let peerBubbleRadius: CGFloat = 12
    /// The dialog's conversation column: narrower than the panel, so a 560 pt bubble does not
    /// stretch a line across the window.
    public static let peerDialogColumnWidth: CGFloat = 900
    public static let peerDialogInset: CGFloat = 24
    public static let peerDialogFooter: CGFloat = 56
    public static let conversationInset: CGFloat = 16
    public static let turnGap: CGFloat = 16
    public static let inspectorRowHeight: CGFloat = 40
    public static let composerHeight: CGFloat = 56
    public static let composerVerticalInset: CGFloat = (composerHeight - hitTarget) / 2
    /// The composer's own horizontal inset, shared by the waiting line so its avatar lines up
    /// with the composer's first control and its text with the field's first character.
    public static let composerInnerInset: CGFloat = 14
    public static let composerBottomInset: CGFloat = 8
    /// The waiting line's band above the composer: always reserved, so work starting or
    /// finishing never moves the transcript.
    public static let waitingBandHeight: CGFloat = 32
    public static let waitingAvatar: CGFloat = 24
    public static let waitingDot: CGFloat = 6
    public static let waitingDotGap: CGFloat = 4
    public static let waitingDotLift: CGFloat = 3.5

    public static let avatarRow: CGFloat = 36
    /// The footer's product mark is a scaled app icon: it takes the macOS icon corner, not none.
    public static let productMarkRadius: CGFloat = 8
    public static let avatarProfile: CGFloat = 56
    public static let avatarInspector: CGFloat = 64
    public static let avatarNote: CGFloat = 18
    public static let iconButton: CGFloat = 32
    public static let spinnerSize: CGFloat = 12
    public static let spinnerStroke: CGFloat = 1.6
    public static let compactGlyph: CGFloat = 12
    public static let hitTarget: CGFloat = 28
    public static let messageActionGlyph: CGFloat = 10

    public static let cardRadius: CGFloat = 12
    public static let controlRadius: CGFloat = 8
    public static let hairline: CGFloat = 1
    public static let resizeHitWidth: CGFloat = 11
    public static let resizeOverhang: CGFloat = (resizeHitWidth - hairline) / 2
    public static func resizeLineInset(pixelLength: CGFloat, inverted: Bool) -> CGFloat {
      resizeOverhang + (inverted ? hairline - pixelLength : 0)
    }

    public static let collapseDuration: CGFloat = 0.28

    public static let settingsRailWidth: CGFloat = 176
    public static let settingsCardRadius: CGFloat = 16
    public static let settingsCardInset: CGFloat = 20
    public static let settingsContentInset: CGFloat = 24
    public static let accountMenuWidth: CGFloat = 226
    public static let accountRowHeight: CGFloat = 40
    public static let galleryInset: CGFloat = 24
    public static let galleryRailWidth: CGFloat = 208
    public static let galleryRadius: CGFloat = 18
    public static let settingsWidth: CGFloat = 960
    public static let settingsHeight: CGFloat = 688

    public static func columnWidths(
      available: CGFloat, sidebar: CGFloat, inspector: CGFloat,
      showsSidebar: Bool, showsInspector: Bool
    ) -> (sidebar: CGFloat, inspector: CGFloat) {
      let budget = max(0, available - conversationMinWidth)
      let rightMinimum = showsInspector ? inspectorMinWidth : 0
      let left =
        showsSidebar
        ? min(max(sidebar, sidebarMinWidth), min(sidebarMaxWidth, max(0, budget - rightMinimum)))
        : 0
      let right =
        showsInspector
        ? min(max(inspector, inspectorMinWidth), min(inspectorMaxWidth, max(0, budget - left))) : 0
      return (left, right)
    }

    public static func settingsSize(in available: CGSize) -> CGSize {
      CGSize(
        width: min(settingsWidth, max(0, available.width - Dialog.outerClearance * 2)),
        height: min(settingsHeight, max(0, available.height - Dialog.outerClearance * 2)))
    }
  }

  public enum TypeScale {
    public static let sectionTracking: CGFloat = 0.2
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
    public static let noteEmphasis = Font.system(size: 13, weight: .medium)
    public static let noteStrong = Font.system(size: 13, weight: .semibold)
    public static let compactBody = Font.system(size: 12.5)
    public static let compactEmphasis = Font.system(size: 12.5, weight: .medium)
    public static let compactTitle = Font.system(size: 12, weight: .semibold)
    public static let fieldLabel = Font.system(size: 14)
    public static let sectionTitle = Font.system(size: 15, weight: .semibold)
    public static let cardTitleStrong = Font.system(size: 14, weight: .semibold)
    public static let sectionLabelStrong = Font.system(size: 13.5, weight: .semibold)
    public static let settingsTitle = Font.system(size: 22, weight: .semibold)
    public static let dialogTitle = Font.system(size: 20, weight: .semibold)
    public static let aboutTitle = Font.system(size: 44, weight: .semibold)
    public static let galleryTitle = Font.system(size: 26, weight: .semibold)
    public static let gallerySymbol = Font.system(size: 24, weight: .medium)
    public static let toolCaption = Font.system(size: 10.5, weight: .medium)
    public static let localBadge = Font.system(size: 10, weight: .medium)
    public static let compactBadge = Font.system(size: 11, weight: .medium)
    public static let monoCaption = Font.system(size: 11.5, design: .monospaced)
    public static let monoTitle = Font.system(size: 12, weight: .semibold, design: .monospaced)
    public static let toolDetailTitle = Font.system(
      size: 12.5, weight: .semibold, design: .monospaced)
    public static let code = Font.system(size: 12.5, design: .monospaced)
    public static let codeLanguage = Font.system(size: 11, weight: .medium, design: .monospaced)
    public static let streamingCaret = Font.system(size: 14, design: .monospaced)
    public static let bodyStrong = Font.system(size: 15, weight: .bold)
    public static let bodyItalic = Font.system(size: 15).italic()

    public enum Glyph {
      public static let compact = Font.system(size: 12)
      public static let action = Font.system(size: 10, weight: .semibold)
      public static let chevron = Font.system(size: 9, weight: .semibold)
      public static let microChevron = Font.system(size: 8, weight: .semibold)
      public static let groupChevron = Font.system(size: 9, weight: .bold)
      public static let unreadChevron = Font.system(size: 8, weight: .bold)
      public static let delivery = Font.system(size: 7, weight: .bold)
      public static let pin = Font.system(size: 9.5, weight: .semibold)
      public static let status = Font.system(size: 9, weight: .medium)
      public static let notice = Font.system(size: 11)
      public static let device = Font.system(size: 16)
      public static let section = Font.system(size: Metric.panelSectionGlyph, weight: .semibold)
      public static let sectionRegular = Font.system(
        size: Metric.panelSectionGlyph, weight: .medium)
      public static let empty = Font.system(size: Metric.panelEmptyGlyph, weight: .regular)
    }

    public static func avatarInitial(size: CGFloat) -> Font {
      .system(size: size * 0.42, weight: .semibold)
    }

    public static func buttonGlyph(size: CGFloat, circled: Bool) -> Font {
      .system(size: size, weight: circled ? .regular : .medium)
    }

    public static func markdownHeading(_ level: Int) -> Font {
      let size: CGFloat
      switch level {
      case 1: size = 20
      case 2: size = 17
      default: size = 15.5
      }
      return .system(size: size, weight: .semibold)
    }
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
