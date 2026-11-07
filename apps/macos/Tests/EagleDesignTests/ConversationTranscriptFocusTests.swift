import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Conversation transcript focus")
struct ConversationTranscriptFocusTests {
  /// Increments the same counter passed to `Composer.focusRequest` when the person taps the
  /// padded transcript background (not the bubble). This only asserts the shared binding is
  /// driven by the tap path; it does not read `firstResponder` on the `TextField`.
  @Test("tapping blank transcript forwards focus to composer")
  func tapBackgroundIncrementsSharedFocusCounter() async throws {
    final class Counter {
      var value = 0
    }
    let counter = Counter()
    let binding = Binding(
      get: { counter.value },
      set: { counter.value = $0 }
    )
    let prepared: [String: [RenderedMarkdownBlock]] = [:]
    let entries: [TranscriptEntry] = [.user(id: "u1", text: "Hi")]
    let root = TranscriptScrollColumn(focusRequestCounter: binding) {
      ForEach(entries) { entry in
        TranscriptEntryRow(
          entry: entry,
          preparedMarkdown: prepared,
          onOpenPeerExchange: nil,
          onAnswerCard: nil,
          onAnswerSecret: nil
        )
        .id(entry.id)
      }
    }
    .frame(width: 520, height: 640)

    let host = NSHostingView(rootView: root)
    host.frame = NSRect(x: 0, y: 0, width: 520, height: 640)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    window.makeKeyAndOrderFront(nil)
    defer {
      window.contentView = nil
    }

    try await Self.waitUntil {
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      return Self.scrollView(in: host)?.documentView != nil
    }

    let scroll = try #require(Self.scrollView(in: host))
    let document = try #require(scroll.documentView)
    scroll.layoutSubtreeIfNeeded()
    document.layoutSubtreeIfNeeded()
    // Short content with min-height document: aim low to hit padding, not the row.
    let docBounds = document.bounds
    let paddingY = max(24, docBounds.height * 0.08)
    let pointInDoc = NSPoint(x: docBounds.midX, y: docBounds.minY + paddingY)
    let locInWindow = document.convert(pointInDoc, to: nil)
    Self.postClick(at: locInWindow, in: window)

    try await Self.waitUntil { counter.value == 1 }
  }

  private static func waitUntil(_ condition: @escaping () throws -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while true {
      if try condition() { return }
      guard ContinuousClock.now < deadline else {
        throw NSError(domain: "ConversationTranscriptFocusTests", code: 1)
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  private static func postClick(at locationInWindow: NSPoint, in window: NSWindow) {
    let t = ProcessInfo.processInfo.systemUptime
    let down = NSEvent.mouseEvent(
      with: .leftMouseDown,
      location: locationInWindow,
      modifierFlags: [],
      timestamp: t,
      windowNumber: window.windowNumber,
      context: nil,
      eventNumber: 1,
      clickCount: 1,
      pressure: 1
    )!
    let up = NSEvent.mouseEvent(
      with: .leftMouseUp,
      location: locationInWindow,
      modifierFlags: [],
      timestamp: t,
      windowNumber: window.windowNumber,
      context: nil,
      eventNumber: 1,
      clickCount: 1,
      pressure: 0
    )!
    window.sendEvent(down)
    window.sendEvent(up)
  }

  private static func scrollView(in view: NSView) -> NSScrollView? {
    if let found = view as? NSScrollView { return found }
    for child in view.subviews {
      if let found = scrollView(in: child) { return found }
    }
    return nil
  }
}
