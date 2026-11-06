import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

/// The inspector's model and think-level rows are one 28 pt band. The inline menu used to
/// offer only the height of its own text, so the trailing chevron was a sliver to aim at.
/// The inline shell now fills the row it sits in: the title, the gap and the chevron are
/// one target, and the target stays invisible.
@Suite("Inline menu hit area", .serialized)
@MainActor
struct SelectionMenuHitAreaTests {
  @Test("the inline menu fills the row it sits in")
  func fillsTheRow() throws {
    let host = NSHostingView(
      rootView: SelectionMenu("auto/gpt-6-luna", style: .inline) { EmptyView() })
    let height = host.fittingSize.height
    #expect(
      abs(height - Theme.Metric.panelTaskRowHeight) < 0.5,
      "the inline target is \(height) pt tall, the row is \(Theme.Metric.panelTaskRowHeight) pt")
  }

  @Test("the trailing chevron sits inside the filled band")
  func arrowInsideTheBand() throws {
    let section = InspectorSections.model(
      choices: [
        InspectorChoiceRow(
          id: "model", label: "模型", value: "auto/gpt-6-luna", selected: "auto/gpt-6-luna",
          choices: [.init(id: "auto/gpt-6-luna", title: "auto/gpt-6-luna")])
      ],
      usage: [])
    let (host, window) = makeHost(InspectorSectionView(section: section[0]))
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }
    let chevron = try #require(
      entries(host).first { (attribute($0, "AXIdentifier") as? String) == "chevron.down" })
    let frame = try #require(chevron as? any NSAccessibilityElementProtocol).accessibilityFrame()
    let rowLabel = try #require(
      entries(host).first { (attribute($0, "AXRole") as? String) == "AXStaticText" })
    let rowFrame = try #require(rowLabel as? any NSAccessibilityElementProtocol)
      .accessibilityFrame()
    #expect(frame.height < Theme.Metric.panelTaskRowHeight / 2, "the chevron stays a small glyph")
    #expect(
      abs(frame.midY - rowFrame.midY) < 1,
      "the chevron shares the row's middle, so the band above and below it belongs to it")
    let panel = try #require(
      entries(host).first { (attribute($0, "AXRole") as? String) == "AXGroup" })
    let panelFrame = try #require(panel as? any NSAccessibilityElementProtocol)
      .accessibilityFrame()
    #expect(frame.maxX <= panelFrame.maxX, "the arrow stays inside the panel")
    #expect(
      panelFrame.maxX - frame.maxX >= Theme.Layout.labelGap,
      "the inline inset keeps room at the trailing edge, and that room is part of the target")
  }

  @Test("the filled band stays invisible: no capsule, no border")
  func paintsNoCapsule() throws {
    let renderer = ImageRenderer(
      content: SelectionMenu("auto/gpt-6-luna", style: .inline) { EmptyView() }
        .frame(width: 140, height: Theme.Metric.panelTaskRowHeight))
    renderer.scale = 1
    let image = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    #expect(image.pixelsWide == 140)
    #expect(image.pixelsHigh == Int(Theme.Metric.panelTaskRowHeight))
    // The band's corners belong to the target but carry no paint.
    for point in [(1, 1), (138, 1), (1, 26), (138, 26)] {
      let color = try #require(image.colorAt(x: point.0, y: point.1))
      #expect(
        color.alphaComponent < 0.1,
        "the inline menu paints a capsule at \(point): \(color)")
    }
  }

  private func makeHost<Content: View>(_ root: Content) -> (NSHostingView<Content>, NSWindow) {
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.perform(
      NSSelectorFromString("accessibilitySetValue:forAttribute:"),
      with: NSNumber(value: true), with: "AXEnhancedUserInterface")
    let host = NSHostingView(rootView: root)
    host.frame = NSRect(x: 0, y: 0, width: 300, height: 120)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = host
    window.orderFront(nil)
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    return (host, window)
  }

  private func attribute(_ node: NSObject, _ name: String) -> Any? {
    let modern = NSSelectorFromString(
      [
        "AXTitle": "accessibilityTitle", "AXDescription": "accessibilityLabel",
        "AXChildren": "accessibilityChildren", "AXRole": "accessibilityRole",
        "AXIdentifier": "accessibilityIdentifier",
      ][name] ?? name)
    if node.responds(to: modern) { return node.perform(modern)?.takeUnretainedValue() }
    let selector = NSSelectorFromString("accessibilityAttributeValue:")
    guard node.responds(to: selector) else { return nil }
    return node.perform(selector, with: name)?.takeUnretainedValue()
  }

  private func entries(_ node: Any) -> [NSObject] {
    guard let element = node as? NSObject else { return [] }
    return [element]
      + ((attribute(element, "AXChildren") as? [Any]) ?? []).flatMap(entries)
  }
}
