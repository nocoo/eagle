import BotsCore
import EagleDesign

/// One creation form's state. The colour is chosen once, when the dialog opens, so the face
/// the person sees is the face the daemon stores; typing a name or picking a shape never
/// re-rolls it. An explicit tint is always sent: the daemon's ID-hash default belongs to
/// API/CLI creation, not to this form.
public struct BotsCreateDraft: Equatable {
  public var name = ""
  public var label = ""
  public var shape: BotFace.Shape = .blob
  public var tint: Theme.Palette.BotTint

  public init(tint: Theme.Palette.BotTint) {
    self.tint = tint
  }

  /// A new form starts on one of the eight canonical faces. `paper` and `graphite` are not
  /// offered: a new bot is never a blank white face.
  public static func presented() -> Self {
    presented(using: SystemRandomNumberGenerator())
  }

  static func presented(using generator: some RandomNumberGenerator) -> Self {
    var generator = generator
    let palette = Theme.Palette.BotTint.selectable
    let index = Int.random(in: 0..<palette.count, using: &generator)
    return Self(tint: palette[index])
  }

  public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

  public var trimmedLabel: String? {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  public var canCreate: Bool { !trimmedName.isEmpty }

  public var preview: BotFace.Style { BotFace.Style(shape: shape, tint: tint) }

  public func appearance() -> BotCreationAppearance {
    BotCreationAppearance(
      shape: BotAppearance.Shape(rawValue: shape.rawValue) ?? .blob,
      tint: BotAppearance.Tint(rawValue: tint.rawValue) ?? BotAppearance.Tint.green
    )
  }
}
