import AppKit
import EagleDesign
import EagleFeatures
import SwiftUI

struct EagleApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @AppStorage("eagle.appearance") private var appearance = "system"

  var body: some Scene {
    // A source run is "Eagle Dev", so the window agrees with the menu and the About panel.
    WindowGroup(DevAppIdentity.currentDisplayName) {
      WorkspaceShellView(onShowGallery: { openSettings in
        GalleryWindowController.shared.show(onShowSettings: openSettings)
      })
      .frame(minWidth: Theme.Metric.windowMinWidth, minHeight: Theme.Metric.windowMinHeight)
      .ignoresSafeArea()
      .background(WindowConfigurator())
      .preferredColorScheme(scheme)
    }
    .defaultSize(width: Theme.Metric.windowWidth, height: Theme.Metric.windowHeight)
    // Immersive: no title bar, traffic lights float over the sidebar.
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
    .commands {
      CommandGroup(replacing: .appSettings) {
        Button("设置…") { NotificationCenter.default.post(name: .eagleToggleSettings, object: nil) }
          .keyboardShortcut(",", modifiers: .command)
      }
      CommandGroup(after: .newItem) {
        Button("模板库") {
          GalleryWindowController.shared.show()
        }
        .keyboardShortcut("g", modifiers: [.command, .shift])

        Divider()

        Button("收起/展开侧栏") {
          NotificationCenter.default.post(name: .eagleToggleSidebar, object: nil)
        }
        .keyboardShortcut("1", modifiers: [.command, .control])

        Button("收起/展开检查器") {
          NotificationCenter.default.post(name: .eagleToggleInspector, object: nil)
        }
        .keyboardShortcut("2", modifiers: [.command, .control])
      }
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    // A source run answers as "Eagle Dev"; an installed bundle keeps its Info.plist name.
    if DevAppIdentity.shouldRename(bundleIdentifier: Bundle.main.bundleIdentifier) {
      DevAppIdentity.keepApplied(version: AppVersion.current().display)
    }
    // A bundle carries its icon in Info.plist; a `swift run` binary has none and would show the
    // generic executable icon in the Dock.
    if Bundle.main.bundleIdentifier == nil { NSApp.applicationIconImage = EagleIcon.image }
    NSApp.activate(ignoringOtherApps: true)
    DeviceApprovalWindowController.shared.observe(DeviceSettingsViewModel.shared)
    guard ProcessInfo.processInfo.environment["EAGLE_DISABLE_WORKERS"] != "1" else { return }
    Task { @MainActor in await DeviceSettingsViewModel.shared.startLocal() }
  }

  /// Closing the last window keeps the independent Superagent usable from the Dock.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  private var terminating = false

  /// App quit owns a bounded shutdown: stop the Superagent processes this App started, then
  /// let the worker daemon close through its recorded ownership. Closing a window never quits.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !terminating else { return .terminateNow }
    terminating = true
    Task { @MainActor in
      await SuperagentDaemonSupervisor.shared.stopOwned()
      if ProcessInfo.processInfo.environment["EAGLE_DISABLE_WORKERS"] != "1" {
        BotsDaemonSupervisor.terminateRecordedDaemon()
      }
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}

/// Lets the whole window be dragged by its background, which is what makes the
/// hidden title bar feel natural.
struct WindowConfigurator: NSViewRepresentable {
  final class Coordinator {
    private var base: CGPoint?
    fileprivate var observers: [NSObjectProtocol] = []

    /// The titlebar re-lays its buttons out on every resize, so the nudge is applied as an
    /// absolute offset from the first position the system chose, never as a repeated delta.
    func nudge(_ window: NSWindow?) {
      guard let window,
        let container = window.standardWindowButton(.closeButton)?.superview
      else { return }
      if base == nil { base = container.frame.origin }
      guard let base else { return }
      container.setFrameOrigin(
        NSPoint(
          x: base.x + Theme.Metric.trafficLightNudgeX,
          y: base.y + Theme.Metric.trafficLightNudgeY
        )
      )
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    let coordinator = context.coordinator
    DispatchQueue.main.async {
      guard let window = view.window else { return }
      window.isMovableByWindowBackground = true
      window.styleMask.insert(.fullSizeContentView)
      window.titlebarAppearsTransparent = true
      window.titleVisibility = .hidden
      window.toolbar = nil
      coordinator.nudge(window)
      for name in [
        NSWindow.didResizeNotification, NSWindow.didBecomeKeyNotification,
        NSWindow.didExitFullScreenNotification,
      ] {
        coordinator.observers.append(
          NotificationCenter.default.addObserver(
            forName: name, object: window, queue: .main
          ) { [weak window] _ in coordinator.nudge(window) }
        )
      }
    }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {}
}

extension EagleApp {
  /// `nil` follows the system; the settings switch stores light or dark.
  fileprivate var scheme: ColorScheme? {
    switch appearance {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }
}
