import AppKit
import SwiftUI
import Testing

/// A dialog hosted offscreen in a borderless window, with the accessibility tree flattened.
@MainActor
struct DialogFixture {
  let host: NSHostingView<AnyView>
  let window: NSWindow

  init(_ view: some View) throws {
    try self.init(view, size: nil)
  }

  init(_ view: some View, size: CGSize) throws {
    try self.init(view, size: Optional(size))
  }

  private init(_ view: some View, size: CGSize?) throws {
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let frame = size ?? hostSize(view)
    host = NSHostingView(rootView: AnyView(view))
    host.frame = NSRect(origin: .zero, size: frame)
    window = NSWindow(
      contentRect: NSRect(x: -10_000, y: -10_000, width: frame.width, height: frame.height),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
  }

  var focusedTextField: Bool? {
    let fields = nodes.filter { role($0) == "AXTextField" }
    return fields.first.flatMap { attribute($0, "AXFocused") as? Bool }
  }

  var textFieldEnabled: Bool? {
    let fields = nodes.filter { role($0) == "AXTextField" }
    guard let field = fields.first else { return nil }
    return attribute(field, "AXEnabled") as? Bool
  }

  /// The AppKit text fields SwiftUI actually created, so a test can ask whether the native
  /// control honours the shell's disabled state instead of trusting the SwiftUI tree.
  var editableTextFields: [NSTextField] {
    nativeViews(host).compactMap { $0 as? NSTextField }.filter(\.isEditable)
  }

  func text(of label: String) -> String? {
    guard let node = nodes.first(where: { title($0) == label }) else { return nil }
    return title(node)
  }

  /// The accessibility press a person's click becomes; a disabled control refuses it.
  func press(_ label: String) throws {
    let node = try #require(
      nodes.first { role($0) == "AXButton" && title($0) == label },
      "no control named \(label)")
    let selector = NSSelectorFromString("accessibilityPerformPress")
    guard node.responds(to: selector), let method = node.method(for: selector) else { return }
    typealias Press = @convention(c) (AnyObject, Selector) -> Bool
    _ = unsafeBitCast(method, to: Press.self)(node, selector)
  }

  func close() {
    window.orderOut(nil)
    window.contentView = nil
  }

  var nodes: [NSObject] {
    entries(host)
  }

  func role(_ node: NSObject) -> String? {
    if let role = attribute(node, "AXRole") as? NSAccessibility.Role { return role.rawValue }
    return attribute(node, "AXRole") as? String
  }

  func title(_ node: NSObject) -> String? {
    for name in ["AXTitle", "AXDescription", "AXValue"] {
      if let value = attribute(node, name) as? String, !value.isEmpty { return value }
    }
    return nil
  }

  func frame(_ node: NSObject) -> NSRect? {
    let selector = NSSelectorFromString("accessibilityFrame")
    guard node.responds(to: selector),
      let method = class_getInstanceMethod(type(of: node), selector)
    else { return nil }
    typealias Getter = @convention(c) (AnyObject, Selector) -> NSRect
    let getter = unsafeBitCast(method_getImplementation(method), to: Getter.self)
    let rect = getter(node, selector)
    return rect.isEmpty ? nil : rect
  }

  func attributeValue(_ node: NSObject, _ name: String) -> Any? {
    attribute(node, name)
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXChildren": "accessibilityChildren", "AXValue": "accessibilityValue",
        "AXRole": "accessibilityRole", "AXIdentifier": "accessibilityIdentifier",
        "AXFocused": "isAccessibilityFocused", "AXEnabled": "isAccessibilityEnabled",
      ][name] ?? name)
    if node.responds(to: selector) { return node.perform(selector)?.takeUnretainedValue() }
    let legacy = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: legacy) else { return nil }
    return node.perform(legacy, with: name)?.takeUnretainedValue()
  }

  private func nativeViews(_ view: NSView) -> [NSView] {
    [view] + view.subviews.flatMap(nativeViews)
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element] + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}

@MainActor
private func hostSize(_ view: some View) -> CGSize {
  NSHostingView(rootView: AnyView(view)).fittingSize
}
