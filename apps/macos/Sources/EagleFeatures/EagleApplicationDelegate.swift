import AppKit
import EagleDesign
import Foundation

@MainActor public final class EagleApplicationDelegate: NSObject, NSApplicationDelegate {
  private let supervisor: BotsDaemonSupervisor
  private let devices: DeviceSettingsViewModel?
  private let reply: @MainActor () -> Void
  private var quitting = false
  private var replied = false

  public override convenience init() {
    self.init(
      composition: .live, reply: { NSApplication.shared.reply(toApplicationShouldTerminate: true) }
    )
  }

  public convenience init(composition: BotsComposition, reply: @escaping @MainActor () -> Void) {
    self.init(supervisor: composition.supervisor, devices: composition.devices, reply: reply)
  }

  public init(
    supervisor: BotsDaemonSupervisor, devices: DeviceSettingsViewModel? = nil,
    reply: @escaping @MainActor () -> Void
  ) {
    self.supervisor = supervisor
    self.devices = devices
    self.reply = reply
    super.init()
  }

  public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if replied { return .terminateNow }
    guard !quitting else { return .terminateLater }
    quitting = true
    Task {
      await supervisor.prepareForApplicationQuit()
      guard !replied else { return }
      replied = true
      reply()
    }
    return .terminateLater
  }

  public func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    // A swift-run binary has no bundle icon, so keep the development Dock icon explicit.
    if Bundle.main.bundleIdentifier == nil { NSApp.applicationIconImage = EagleIcon.image }
    NSApp.activate(ignoringOtherApps: true)
    guard let devices else { return }
    DeviceApprovalWindowController.shared.observe(devices)
    Task { @MainActor in await devices.startIfNeeded() }
  }

  public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  /// The daemon is a child of the app: quitting the app must not leave it running.
  public func applicationWillTerminate(_ notification: Notification) {
    supervisor.terminateOwnedDaemonFallback()
  }
}
