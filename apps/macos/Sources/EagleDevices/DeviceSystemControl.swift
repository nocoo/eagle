import Foundation
import OSLog
import ServiceManagement

@MainActor public protocol DeviceControl: AnyObject {
  var socketPath: String? { get }
  var serviceProfile: String? { get }
  func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool) async throws
  func retryStart(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool) async throws
  func call(_ method: String, params: DeviceJSON?) async throws -> DeviceJSON
  func stop() async throws
  func openSystemSettings()
}

extension DeviceControl {
  public var serviceProfile: String? { nil }
  public func retryStart(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    try await start(confirm: confirm)
  }
}

/// Uses the signed bundle's release configuration. No server or runtime path is user input.
@MainActor public final class DeviceSystemControl: DeviceControl {
  private let bundle: URL
  private let configuration: DeviceHostConfiguration?
  private let defaults: UserDefaults
  private var registration: DeviceServiceRegistration?
  private var client: DeviceXPCClient?
  private let log = Logger(subsystem: "ai.hexly.eagle.devices", category: "background")
  public var socketPath: String? { configuration?.socketPath }
  public var serviceProfile: String? { configuration?.profile }
  public init(bundle: URL = Bundle.main.bundleURL, defaults: UserDefaults = .standard) {
    self.bundle = bundle
    self.defaults = defaults
    configuration = try? DeviceHostConfiguration.load(bundle: bundle)
  }
  public func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    guard let configuration else { throw DeviceHostError.invalidConfiguration }
    let startedAt = ContinuousClock.now
    let (requirement, fingerprint) = try await Task.detached { [bundle] in
      let helper = try configuration.helperURL(bundle: bundle)
      let requirement = try DeviceCodeIdentity.requirement(at: helper)
      let fingerprint = try DeviceServiceRegistration.fingerprint(
        appRequirement: DeviceCodeIdentity.requirement(at: bundle), helperRequirement: requirement,
        executable: Data(contentsOf: helper),
        plist: Data(
          contentsOf: bundle.appendingPathComponent(
            "Contents/Library/LaunchAgents/\(configuration.launchAgentPlist)")))
      return (requirement, fingerprint)
    }.value
    if registration == nil {
      registration = DeviceServiceRegistration(
        service: SystemDeviceBackgroundService(
          plistName: configuration.launchAgentPlist, bundle: bundle),
        defaults: defaults, profile: configuration.profile)
    }
    guard let registration else { throw DeviceHostError.unavailable }
    do {
      try await registration.prepare(fingerprint: fingerprint) { [self] in
        client?.invalidate()
        let connection = DeviceXPCClient(
          connection: NSXPCConnection(machServiceName: configuration.machServiceName),
          requiredPeer: requirement, confirm: confirm)
        do {
          let reply = try await connection.call("service.ping", timeoutSeconds: 5)
          guard reply["version"] == .number(1) else { throw DeviceHostError.invalidResponse }
          client = connection
        } catch {
          connection.invalidate()
          client = nil
          throw error
        }
      }
    } catch {
      let diagnostic = error as NSError
      log.error(
        "background startup failed: \(diagnostic.domain, privacy: .public) \(diagnostic.code, privacy: .public)"
      )
      throw error
    }
    let elapsed = startedAt.duration(to: ContinuousClock.now)
    log.info("background helper connected in \(String(describing: elapsed), privacy: .public)")
  }
  public func retryStart(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    registration?.resetRecovery()
    try await start(confirm: confirm)
  }
  public func call(_ method: String, params: DeviceJSON? = nil) async throws -> DeviceJSON {
    guard let client else { throw DeviceHostError.unavailable }
    return try await client.call(method, params: params)
  }
  public func stop() async throws {
    guard let configuration else { throw DeviceHostError.invalidConfiguration }
    if registration == nil {
      registration = DeviceServiceRegistration(
        service: SystemDeviceBackgroundService(
          plistName: configuration.launchAgentPlist, bundle: bundle), defaults: defaults,
        profile: configuration.profile)
    }
    guard let registration else { throw DeviceHostError.unavailable }
    try await registration.stop()
    client?.invalidate()
    client = nil
  }
  public func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}
