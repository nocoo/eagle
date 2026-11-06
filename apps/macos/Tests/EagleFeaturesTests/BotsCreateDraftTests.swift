import BotsCore
import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Bot creation draft")
struct BotsCreateDraftTests {
  @Test("presenting picks one canonical colour, never a blank one")
  func canonicalDefault() {
    for seed in UInt64(0)..<24 {
      let draft = BotsCreateDraft.presented(using: SeededGenerator(seed: seed))
      #expect(Theme.Palette.BotTint.selectable.contains(draft.tint))
      #expect(draft.tint != .paper, "a new bot is not a white face")
      #expect(draft.tint != .graphite)
      #expect(draft.shape == .blob)
    }
  }

  @Test("every canonical colour can be picked, and only those")
  func everyColourReachable() {
    var seen: Set<Theme.Palette.BotTint> = []
    for seed in UInt64(0)..<512 {
      seen.insert(BotsCreateDraft.presented(using: SeededGenerator(seed: seed)).tint)
    }
    #expect(seen == Set(Theme.Palette.BotTint.selectable))
  }

  @Test("typing and choosing a shape never re-rolls the colour")
  func stableColour() {
    var draft = BotsCreateDraft.presented(using: SeededGenerator(seed: 7))
    let chosen = draft.tint
    draft.name = "研究员"
    draft.shape = .star
    #expect(draft.tint == chosen)
    draft.tint = .violet
    draft.label = "研究"
    #expect(draft.tint == .violet, "a manual choice is kept")
  }

  @Test("the face the preview shows is the face the callback stores")
  func explicitAppearance() {
    var draft = BotsCreateDraft.presented(using: SeededGenerator(seed: 11))
    draft.shape = .hex
    let preview = BotFace.Style(shape: draft.shape, tint: draft.tint)
    let appearance = draft.appearance()
    #expect(appearance.shape.rawValue == preview.shape.rawValue)
    #expect(appearance.tint?.rawValue == preview.tint.rawValue)
  }

  @Test("the name is trimmed, the tag is optional and a blank name cannot create")
  func validation() {
    var draft = BotsCreateDraft.presented(using: SeededGenerator(seed: 1))
    #expect(!draft.canCreate)
    draft.name = "   "
    #expect(!draft.canCreate, "whitespace is not a name")
    draft.name = "  研究员 "
    draft.label = "   "
    #expect(draft.canCreate)
    #expect(draft.trimmedName == "研究员")
    #expect(draft.trimmedLabel == nil, "an empty tag is no tag")
    draft.label = " 研究 "
    #expect(draft.trimmedLabel == "研究")
  }
}

/// A generator whose picks are the test's, not the system's.
private struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
  }

  mutating func next() -> UInt64 {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    return state
  }
}
