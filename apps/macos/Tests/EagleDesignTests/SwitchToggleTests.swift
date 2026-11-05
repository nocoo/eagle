import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@Suite("Native switch contract", .serialized)
@MainActor
struct SwitchToggleTests {
  @Test("the shared switch matches native role, value, label and size", arguments: [false, true])
  func nativeSemantics(mini: Bool) async throws {
    try await compareNative(mini: mini, checkbox: false)
  }

  @Test("the checkbox retains its own native role and guarded value")
  func checkboxSemantics() async throws {
    try await compareNative(mini: false, checkbox: true)
  }

  private func compareNative(mini: Bool, checkbox: Bool) async throws {
    let state = SwitchState()
    let (host, window) = makeHost(state, mini: mini, checkbox: checkbox)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    let reference = try await element("reference", in: host)
    let standard = try await element("standard", in: host)
    #expect(
      attribute(standard, "accessibilityRole") as? String == attribute(
        reference, "accessibilityRole") as? String)
    #expect(attribute(standard, "accessibilityValue") as? Int == 0)
    #expect(attribute(standard, "accessibilityLabel") as? String == "Shared switch")
    let expectedFrame = try #require(reference as? any NSAccessibilityElementProtocol)
      .accessibilityFrame()
    let actualFrame = try #require(standard as? any NSAccessibilityElementProtocol)
      .accessibilityFrame()
    #expect(abs(expectedFrame.height - actualFrame.height) < 0.5)
    #expect(abs(expectedFrame.width - actualFrame.width) < 0.5)
    #expect(try invoke(standard, "accessibilityPerformPress"))
    #expect(state.requests == [true])
    #expect(!state.value)
    #expect(attribute(standard, "accessibilityValue") as? Int == 0)
    state.value = true
    _ = try await element("standard", in: host) {
      attribute($0, "accessibilityValue") as? Int == 1
    }
  }

  @Test("disabled switches cannot submit and enabled switches keep guarded bindings")
  func disabled() async throws {
    let state = SwitchState()
    state.disabled = true
    let (host, window) = makeHost(state, mini: false)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    let standard = try await element("standard", in: host)
    #expect(try !invoke(standard, "isAccessibilityEnabled"))
    _ = try invoke(standard, "accessibilityPerformPress")
    #expect(state.requests.isEmpty)
    state.disabled = false
    let enabled = try await element("standard", in: host) {
      try invoke($0, "isAccessibilityEnabled")
    }
    #expect(try invoke(enabled, "accessibilityPerformPress"))
    #expect(state.requests == [true])
    #expect(!state.value, "a request is not a confirmed state transition")
  }

  private func makeHost(
    _ state: SwitchState, mini: Bool, checkbox: Bool = false
  ) -> (NSHostingView<SwitchFixture>, NSWindow) {
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: SwitchFixture(state: state, mini: mini, checkbox: checkbox))
    host.frame = NSRect(x: 0, y: 0, width: 300, height: 160)
    let window = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 300, height: 160),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    return (host, window)
  }

  private func element(
    _ id: String, in host: NSView, where matches: (NSObject) throws -> Bool = { _ in true }
  ) async throws -> NSObject {
    var result: NSObject?
    try await waitUntil {
      host.layoutSubtreeIfNeeded()
      result = entries(host).first { attribute($0, "accessibilityIdentifier") as? String == id }
      return try result.map(matches) ?? false
    }
    return try #require(result)
  }

  private func waitUntil(_ condition: () throws -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while true {
      // Another UI suite can occupy MainActor while this task is suspended.
      if try condition() { return }
      guard ContinuousClock.now < deadline else {
        throw NSError(domain: "SwitchToggleTests", code: 1)
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let selector = NSSelectorFromString(name)
    guard node.responds(to: selector) else { return nil }
    return node.perform(selector)?.takeUnretainedValue()
  }

  private func invoke(_ node: NSObject, _ name: String) throws -> Bool {
    let selector = NSSelectorFromString(name)
    try #require(node.responds(to: selector))
    let implementation = try #require(node.method(for: selector))
    let call = unsafeBitCast(
      implementation, to: (@convention(c) (AnyObject, Selector) -> Bool).self)
    return call(node, selector)
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let node = node as? NSObject else { return [] }
    return [node] + ((attribute(node, "accessibilityChildren") as? [Any]) ?? []).flatMap(entries)
  }
}

@MainActor
private final class SwitchState: ObservableObject {
  @Published var value = false
  @Published var disabled = false
  var requests: [Bool] = []
}

private struct SwitchFixture: View {
  @ObservedObject var state: SwitchState
  let mini: Bool
  let checkbox: Bool

  private var binding: Binding<Bool> {
    Binding(get: { state.value }, set: { state.requests.append($0) })
  }

  var body: some View {
    VStack {
      Group {
        if checkbox {
          Toggle("Reference switch", isOn: binding).toggleStyle(.checkbox)
        } else {
          Toggle("Reference switch", isOn: binding).toggleStyle(.switch)
        }
      }
      .labelsHidden()
      .accessibilityIdentifier("reference")
      Group {
        if checkbox {
          Checkbox(isOn: binding, label: "Shared switch")
        } else {
          SwitchToggle(isOn: binding, label: "Shared switch")
        }
      }
      .labelsHidden()
      .accessibilityIdentifier("standard")
    }
    .controlSize(mini ? .mini : .regular)
    .disabled(state.disabled)
  }
}
