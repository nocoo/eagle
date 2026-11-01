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
