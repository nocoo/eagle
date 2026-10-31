import EagleDevices
import Foundation
import Security

@main struct EagleDeviceHelper {
  @MainActor static func main() {
    do {
      var bundle = Bundle.main.executableURL?.deletingLastPathComponent()
      while let current = bundle, current.path != "/", current.pathExtension != "app" {
        bundle = current.deletingLastPathComponent()
      }
      guard let bundle, bundle.pathExtension == "app",
        let identifier = Bundle(url: bundle)?.bundleIdentifier,
        ["ai.hexly.eagle.macos", "ai.hexly.eagle.macos.device-candidate"].contains(identifier)
      else { throw DeviceHostError.invalidConfiguration }
      let requirement = try DeviceCodeIdentity.applicationRequirement(at: bundle)
      var config = try DeviceHostConfiguration.load(bundle: bundle)
      // A published App ships no relay: the person's own choice in Settings wins, and an
      // unconfigured Mac parks here instead of contacting anything.
      if let chosen = DeviceServiceAddress.saved(profile: config.profile) {
        config.baseUrl = chosen
      }
      let runtime = bundle.appendingPathComponent("Contents/Resources/DeviceRuntime")
      let vault = DeviceFileVault()
      let identity = try DeviceIdentity.loadOrCreate(profile: config.profile, vault: vault)
      let host = DeviceServiceHost(
        identity: identity, configuration: config,
        node: runtime.appendingPathComponent("node"),
        entry: runtime.appendingPathComponent(
          "agent/node_modules/@nocoo/eagle-agent/dist/agent/device-service.js"), vault: vault)
      let listener = NSXPCListener(machServiceName: config.machServiceName)
      let delegate = DeviceXPCServer(host: host, requiredPeer: requirement)
      listener.delegate = delegate
      if config.isConfigured { try host.start() }
      listener.resume()
      withExtendedLifetime((host, listener, delegate)) { RunLoop.main.run() }
    } catch {
      // No payload, credential or arbitrary child output reaches a process log; a build can ask
      // for the failure's domain and code only, which names no path and carries no secret.
      if ProcessInfo.processInfo.environment["EAGLE_DEVICE_HELPER_DIAGNOSTICS"] == "1" {
        let failure = error as NSError
        FileHandle.standardError.write(
          Data("helper_failed \(failure.domain) \(failure.code)\n".utf8))
      }
      exit(78)
    }
  }
}
