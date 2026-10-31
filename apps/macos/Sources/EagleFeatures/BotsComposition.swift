import CryptoKit
import EagleDevices
import Foundation

/// One app instance owns its daemon, client files and trusted helper control.
@MainActor public final class BotsComposition {
  public static let live = BotsComposition()
  public let settings: BotsSettings
  public let devices: DeviceSettingsViewModel
  public let supervisor: BotsDaemonSupervisor

  public init(
    settings: BotsSettings = BotsSettings(), defaults: UserDefaults? = nil,
    control: (any DeviceControl)? = nil, bundle: URL = Bundle.main.bundleURL,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.settings = settings
    let suite = SHA256.hash(data: Data(settings.rootPath.utf8)).map { String(format: "%02x", $0) }
      .joined()
    let ownedDefaults =
      defaults
      ?? (settings.isIsolated
        ? UserDefaults(suiteName: "ai.hexly.eagle.bots.\(suite)") ?? .standard : .standard)
    let devices = DeviceSettingsViewModel(
      control: control ?? DeviceSystemControl(bundle: bundle, defaults: ownedDefaults),
      defaults: ownedDefaults)
    self.devices = devices
    supervisor = BotsDaemonSupervisor(
      settings: settings, bundle: bundle, environment: environment, defaults: ownedDefaults,
      publishSync: { [devices] port, digest in
        try await devices.publishSyncEndpoints(port: port, expectedSelfDigest: digest)
      })
  }
}
