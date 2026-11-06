import AppKit
import SwiftUI
import Testing

@testable import EagleDesign

@MainActor
@Suite("Conversation transcript focus")
struct ConversationTranscriptFocusTests {
  /// Tapping the clear area behind the transcript (below short content) must bump the same
  /// counter `Composer` observes via `focusRequest`, so the field re-focuses.
  @Test("tapping blank transcript forwards focus to composer")
  func tapBackgroundIncrementsSharedFocusCounter() {
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
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.08))

    guard let scroll = Self.scrollView(in: host), let document = scroll.documentView else {
      Issue.record("Expected NSScrollView with document for transcript")
      return
    }
    scroll.layoutSubtreeIfNeeded()
    document.layoutSubtreeIfNeeded()
    // Short content with min-height document: aim low in the document to hit padding, not the row.
    let docBounds = document.bounds
    let pointInDoc = NSPoint(x: docBounds.midX, y: docBounds.minY + max(24, docBounds.height * 0.08))
    let locInWindow = document.convert(pointInDoc, to: nil)
    Self.postClick(at: locInWindow, in: window)
    RunLoop.main.run(until: Date().addingTimeInterval(0.06))
    #expect(counter.value == 1)
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
