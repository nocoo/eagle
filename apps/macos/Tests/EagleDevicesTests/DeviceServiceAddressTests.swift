import Foundation
import Testing

@testable import EagleDevices

@Suite("Device service address")
struct DeviceServiceAddressTests {
  @Test(
    "a bare HTTPS origin is accepted and normalized",
    arguments: [
      ("https://devices.example.com", "https://devices.example.com"),
      ("https://DEVICES.example.com:443/", "https://devices.example.com"),
      ("  https://devices.example.com:8443  ", "https://devices.example.com:8443"),
      ("http://127.0.0.1:17053", "http://127.0.0.1:17053"),
      ("http://localhost:8080", "http://localhost:8080"),
    ])
  func accepts(argument: (String, String)) {
    #expect(DeviceServiceAddress.normalize(argument.0) == argument.1)
  }

  @Test(
    "anything but an origin is refused",
    arguments: [
      "", "   ", "devices.example.com", "ftp://devices.example.com",
      "http://devices.example.com", "https://devices.example.com/path",
      "https://devices.example.com?x=1", "https://devices.example.com#frag",
      "https://user:secret@devices.example.com",
    ])
  func refuses(value: String) {
    #expect(DeviceServiceAddress.normalize(value) == nil)
  }

  @Test("only the person's choice is stored, and a bad value clears it")
  func storesChoice() throws {
    let defaults = try #require(UserDefaults(suiteName: "ai.hexly.eagle.tests.address"))
    defer { defaults.removePersistentDomain(forName: "ai.hexly.eagle.tests.address") }
    #expect(DeviceServiceAddress.saved(defaults) == nil)
    #expect(
      DeviceServiceAddress.save("https://Devices.Example.com:443/", defaults: defaults) != nil)
    #expect(DeviceServiceAddress.saved(defaults) == "https://devices.example.com")
    #expect(DeviceServiceAddress.save("not-an-origin", defaults: defaults) == nil)
    #expect(DeviceServiceAddress.saved(defaults) == nil)
  }

  @Test(
    "invalid profiles have no address store", arguments: ["", String(repeating: "x", count: 81)])
  func invalidProfile(profile: String) {
    #expect(DeviceServiceAddress.save("https://refused.example.com", profile: profile) == nil)
    #expect(DeviceServiceAddress.saved(profile: profile) == nil)
  }

  @Test("system control exposes only its validated bundle profile without starting a helper")
  @MainActor func boundProfile() throws {
    let bundle = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: bundle) }
    #expect(DeviceSystemControl(bundle: bundle).serviceProfile == nil)
    let resources = bundle.appendingPathComponent("Contents/Resources")
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    for profile in ["address-owned-" + UUID().uuidString, "", String(repeating: "x", count: 81)] {
      let config = DeviceHostConfiguration(
        version: 1, profile: profile, baseUrl: "",
        machServiceName: "ai.hexly.eagle.devices.test",
        launchAgentPlist: "ai.hexly.eagle.devices.test.plist")
      try JSONEncoder().encode(config).write(
        to: resources.appendingPathComponent("DeviceHost.json"))
      #expect(
        DeviceSystemControl(bundle: bundle).serviceProfile
          == (profile.hasPrefix("address-owned-") ? profile : nil))
    }
  }

  @Test("a configuration with no origin is unconfigured, not invalid")
  func unconfiguredBundle() throws {
    var config = DeviceHostConfiguration(
      version: 1, profile: "device-release", baseUrl: "",
      machServiceName: "ai.hexly.eagle.devices",
      launchAgentPlist: "ai.hexly.eagle.devices.plist")
    #expect(!config.isConfigured)
    try config.validate()
    config.baseUrl = "https://devices.example.com"
    #expect(config.isConfigured)
    #expect(config.serviceOrigin == "https://devices.example.com")
    try config.validate()
  }
}
