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
      .frame(minWidth: 1280, minHeight: 760)
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
      DevAppIdentity.apply(to: NSApp.mainMenu, version: AppVersion.current().display)
    }
    // A bundle carries its icon in Info.plist; a `swift run` binary has none and would show the
    // generic executable icon in the Dock.
    if Bundle.main.bundleIdentifier == nil { NSApp.applicationIconImage = EagleIcon.image }
    NSApp.activate(ignoringOtherApps: true)
    DeviceApprovalWindowController.shared.observe(DeviceSettingsViewModel.shared)
    Task { @MainActor in await DeviceSettingsViewModel.shared.startIfNeeded() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  /// The daemon is a child of the app: quitting the app must not leave it running.
  func applicationWillTerminate(_ notification: Notification) {
    BotsDaemonSupervisor.terminateRecordedDaemon()
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
