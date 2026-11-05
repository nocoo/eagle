import EagleDesign
import Foundation

public enum UpdateState: Hashable, Sendable {
  case idle
  case checking
  case current(String)
  /// A newer published build exists; the person downloads it from the release page.
  case available(latest: String, release: URL?)
  /// A development build has nothing published to compare with, so it is the newest by
  /// definition: it shows its own version rather than a newer one.
  case development(String)
  /// Nothing to ask: no published version is reachable from this build.
  case unavailable
}

/// One row of the 用量 page's 消耗最多 card: the bot that spent, or the 其他 row that carries
/// what the bots a person deleted have already spent.
public struct UsageBotRow: Identifiable, Sendable, Equatable {
  public var id: String
  public var title: String
  public var detail: String
  public var value: String
  /// The face the catalog draws for a bot that still exists; nil for the 其他 row, and for
  /// every row while the catalog has not answered.
  public var face: BotFace.Style?
  public var aggregate: Bool

  public init(
    id: String,
    title: String,
    detail: String,
    value: String,
    face: BotFace.Style? = nil,
    aggregate: Bool = false
  ) {
    self.id = id
    self.title = title
    self.detail = detail
    self.value = value
    self.face = face
    self.aggregate = aggregate
  }
}
