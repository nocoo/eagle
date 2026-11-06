import AppKit
import SwiftUI

/// Hides the window's traffic lights while a modal card owns the window chrome, and gives
/// them back when that card leaves.
public struct TrafficLights: NSViewRepresentable {
  private let hidden: Bool

  public init(hidden: Bool) {
    self.hidden = hidden
  }

  public func makeCoordinator() -> Coordinator { Coordinator() }

  public func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async {
      context.coordinator.window = view.window
      Self.apply(hidden, to: view.window)
    }
    return view
  }

  public func updateNSView(_ view: NSView, context: Context) {
    DispatchQueue.main.async {
      context.coordinator.window = view.window
      Self.apply(hidden, to: view.window)
    }
  }

  public static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
    DispatchQueue.main.async {
      apply(false, to: coordinator.window)
      coordinator.window = nil
    }
  }

  public final class Coordinator {
    fileprivate weak var window: NSWindow?
  }

  private static func apply(_ hidden: Bool, to window: NSWindow?) {
    guard let window else { return }
    for button: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
      window.standardWindowButton(button)?.isHidden = hidden
    }
  }
}
