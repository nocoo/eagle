import Foundation
import Testing

@testable import EagleFeatures

/// A capture's preferences are its own: two runs get different suites, neither can read the
/// other's values, and cleaning one up leaves the other (and the standard defaults) alone.
@Suite("Isolated capture preferences")
struct IsolatedPreferencesTests {
  @Test("two fresh captures own different suites")
  func distinctSuites() {
    let first = IsolatedPreferences(prefix: "EagleDialogSnapshots")
    let second = IsolatedPreferences(prefix: "EagleDialogSnapshots")
    defer {
      first.remove()
      second.remove()
    }
    #expect(first.suiteName != second.suiteName)
    #expect(first.suiteName.hasPrefix("EagleDialogSnapshots."))
    #expect(second.suiteName.hasPrefix("EagleDialogSnapshots."))
  }

  @Test("one capture cannot read another's value, and neither reaches the standard defaults")
  func sentinelStaysInside() {
    let first = IsolatedPreferences(prefix: "EagleDialogSnapshots")
    let second = IsolatedPreferences(prefix: "EagleDialogSnapshots")
    defer {
      first.remove()
      second.remove()
    }
    let key = "eagle.capture.probe"
    first.defaults.set("first", forKey: key)
    second.defaults.set("second", forKey: key)
    #expect(first.defaults.string(forKey: key) == "first")
    #expect(
      second.defaults.string(forKey: key) == "second", "the two suites do not share a domain")
    #expect(
      UserDefaults.standard.string(forKey: key) == nil, "nothing reaches the person's defaults")

    first.remove()
    #expect(second.defaults.string(forKey: key) == "second", "cleanup of one keeps the other")
    #expect(UserDefaults.standard.string(forKey: key) == nil)
  }
}
