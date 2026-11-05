import AppKit
import Combine
import EagleDesign
import SwiftUI

/// The App owns one confirmation window even when no workspace window remains.
@MainActor
public final class DeviceApprovalWindowController: NSObject, NSWindowDelegate {
  public static let shared = DeviceApprovalWindowController()
  private(set) var window: NSWindow?
  private var model: DeviceSettingsViewModel?
  private var requestId: String?
  private var observation: AnyCancellable?

  public func observe(_ model: DeviceSettingsViewModel) {
    guard self.model !== model else { return }
    stopObserving()
    self.model = model
    observation = model.$pendingApproval.sink { [weak self] request in
      // Published delivers before the property changes. Present after that mutation finishes.
      Task { @MainActor [weak self] in self?.present(request?.id) }
    }
  }

  func stopObserving() {
    observation = nil
    dismiss()
    model = nil
  }

  private func present(_ id: String?) {
    guard let model, model.pendingApproval?.id == id else { return }
    guard let id else {
      dismiss()
      return
    }
    if requestId == id, let window {
      window.makeKeyAndOrderFront(nil)
      return
    }
    dismiss()
    let window = NSWindow(
      contentRect: NSRect(
        x: 0, y: 0, width: Theme.Dialog.approvalWidth, height: Theme.Dialog.approvalWindowHeight),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.title = "确认设备操作"
    window.identifier = NSUserInterfaceItemIdentifier("eagle.devices.approval")
    window.contentView = NSHostingView(rootView: DeviceApprovalView(model: model).id(id))
    window.delegate = self
    self.window = window
    requestId = id
    window.center()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  private func dismiss() {
    let previous = window
    let previousId = requestId
    window = nil
    requestId = nil
    previous?.delegate = nil
    previous?.close()
    previous?.contentView = nil
    if let previousId { model?.respondToApproval(false, requestId: previousId) }
  }

  public func windowWillClose(_ notification: Notification) {
    guard let closing = notification.object as? NSWindow, closing === window else { return }
    let id = requestId
    window = nil
    requestId = nil
    closing.contentView = nil
    if let id { model?.respondToApproval(false, requestId: id) }
  }
}
