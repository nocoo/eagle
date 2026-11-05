import AppKit
import EagleDesign
import Foundation
import SwiftUI
import Testing

@testable import EagleFeatures

/// The window's own footer: the product mark and the gear open settings directly. The account
/// menu is a library component now — the gallery still shows it, the shell never presents it.
@Suite("Sidebar footer", .serialized)
@MainActor
struct SidebarFooterTests {
  /// The footer carries the two settings entries and nothing else. SwiftUI publishes a hosted
  /// button's press action only to a live accessibility client, so this suite asserts the
  /// labels the click path is wired to; the click itself is checked in the running App.
  @Test("the gear and the product mark are settings entries, not an account menu")
  func settingsEntries() async throws {
    let nodes = try host(
      SidebarPanel(
        sections: [], selection: nil, onSelect: { _ in },
        onSettings: {}, productVersion: "0.19.0"))
    #expect(nodes.contains { title($0) == "设置" }, "the gear is a settings entry")
    #expect(nodes.contains { title($0) == "eagle 0.19.0，打开设置" }, "so is the product mark")
    #expect(
      !nodes.contains { title($0)?.contains("退出登录") == true },
      "the footer presents no account menu")
  }

  @Test("the account menu stays a component: the gallery can still draw it")
  func menuStaysInTheLibrary() async throws {
    let rows = AccountMenuViewModel().rows
    let nodes = try host(AccountMenu(rows: rows, onSelect: { _ in }))
    #expect(nodes.contains { title($0) == "设置" })
    #expect(nodes.contains { title($0) == "退出登录" })
  }

  private func host(_ view: some View) throws -> [NSObject] {
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(x: 0, y: 0, width: Theme.Metric.sidebarWidth, height: 700)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: Theme.Metric.sidebarWidth, height: 700),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    Self.hosted.append(window)
    return entries(try #require(window.contentView))
  }

  /// The hosted windows outlive the call, so their accessibility tree stays readable.
  private static var hosted: [NSWindow] = []

  private func title(_ node: NSObject) -> String? {
    for name in ["AXTitle", "AXDescription", "AXValue"] {
      if let value = attribute(node, name) as? String, !value.isEmpty { return value }
    }
    return nil
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXChildren": "accessibilityChildren", "AXValue": "accessibilityValue",
      ][name] ?? name)
    if node.responds(to: selector) { return node.perform(selector)?.takeUnretainedValue() }
    let legacy = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: legacy) else { return nil }
    return node.perform(legacy, with: name)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
