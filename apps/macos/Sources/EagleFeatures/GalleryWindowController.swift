import AppKit
import EagleDesign
import SwiftUI

/// One gallery remembers the workspace that owns its settings action.
@MainActor
public final class GalleryWindowController {
  public static let shared = GalleryWindowController()
  private(set) var window: NSWindow?
  private(set) weak var owner: NSWindow?
  private var settingsAction: () -> Void = {
    NotificationCenter.default.post(name: .eagleToggleSettings, object: nil)
  }

  public init() {}

  public func show(from origin: NSWindow? = nil, onShowSettings: (() -> Void)? = nil) {
    let origin = origin ?? NSApp.keyWindow
    if let window, origin === window {
      window.makeKeyAndOrderFront(nil)
      return
    }
    owner = origin
    settingsAction =
      onShowSettings ?? {
        NotificationCenter.default.post(name: .eagleToggleSettings, object: nil)
      }
    if let window {
      window.makeKeyAndOrderFront(nil)
      return
    }
    let window = NSWindow(
      contentRect: NSRect(
        x: 0, y: 0, width: Theme.Gallery.windowWidth, height: Theme.Gallery.windowHeight),
      styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false
    )
    window.isReleasedWhenClosed = false
    window.title = "Eagle 模板库"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.contentView = NSHostingView(
      rootView: TemplateGallery { [weak self] in
        self?.openSettings()
      })
    window.center()
    self.window = window
    window.makeKeyAndOrderFront(nil)
  }

  func openSettings() {
    window?.orderOut(nil)
    owner?.makeKeyAndOrderFront(nil)
    settingsAction()
  }
}
