import Foundation

/// A throwaway preferences domain for an offscreen capture. Every instance owns a fresh,
/// UUID-named suite, so a run never inherits another run's values and cannot delete them,
/// and nothing it writes is visible to the standard defaults.
public struct IsolatedPreferences {
  public let suiteName: String
  public let defaults: UserDefaults

  public init(prefix: String = "EagleCapture") {
    suiteName = "\(prefix).\(UUID().uuidString)"
    guard let defaults = UserDefaults(suiteName: suiteName) else {
      fatalError("isolated capture preferences are unavailable")
    }
    self.defaults = defaults
  }

  /// Drops this suite's values; other suites and the standard defaults stay as they were.
  public func remove() {
    defaults.removePersistentDomain(forName: suiteName)
  }
}
