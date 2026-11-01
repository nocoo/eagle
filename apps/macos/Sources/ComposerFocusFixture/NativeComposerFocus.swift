import AppKit
import EagleDesign
import SwiftUI

@MainActor
private enum ComposerFocusTiming {
  static var ci: Bool { ProcessInfo.processInfo.environment["CI"] == "1" }
  /// AppKit activation and SwiftUI autofocus can lag on a shared CI desktop.
  static var readinessTimeout: TimeInterval { ci ? 15 : 4 }
  static var idleSettle: TimeInterval { 0.35 }
}

@MainActor
private enum ComposerFocusTrace {
  static var completedChecks = 0
  private static let startedAt = ProcessInfo.processInfo.systemUptime

  static func mark(_ event: String) {
    let start = startedAt
    let elapsed = String(format: "%.3f", ProcessInfo.processInfo.systemUptime - start)
    let line = "[native-focus +\(elapsed)s checks=\(completedChecks)] \(event)\n"
    FileHandle.standardError.write(Data(line.utf8))
  }
}

@main
private enum ComposerFocusMain {
  @MainActor static func main() {
    let arguments = CommandLine.arguments
    if arguments.count == 2, arguments[1] == "--cursor-position" {
      guard let point = CGEvent(source: nil)?.location else { exit(1) }
      let data = try! JSONSerialization.data(withJSONObject: ["x": point.x, "y": point.y])
      FileHandle.standardOutput.write(data + Data("\n".utf8))
      return
    }
    if arguments.count == 4, arguments[1] == "--restore-cursor",
      let x = Double(arguments[2]), let y = Double(arguments[3]), x.isFinite, y.isFinite
    {
      exit(CGWarpMouseCursorPosition(CGPoint(x: x, y: y)) == .success ? 0 : 1)
    }
    guard arguments.count == 1 else { exit(2) }
    ComposerFocusTrace.mark("startup.enter")
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = ComposerFocusDelegate()
    app.delegate = delegate
    ComposerFocusTrace.mark("application.run.enter")
    app.run()
    ComposerFocusTrace.mark("application.run.return")
    withExtendedLifetime(delegate) {}
  }
}

@MainActor
private final class ComposerFocusDelegate: NSObject, NSApplicationDelegate {
  private var checks: [[String: Any]] = []
  private var editingStates: [[String: Any]] = []
  private var windows: [ComposerFocusWindow] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    ComposerFocusTrace.mark("application.didFinishLaunching")
    NSApp.activate(ignoringOtherApps: true)
    ComposerFocusTrace.mark("application.activate.return")
    Task { @MainActor in
      ComposerFocusTrace.mark("conversation.enter")
      await conversation()
      ComposerFocusTrace.mark("conversation.return")
      ComposerFocusTrace.mark("editing.enter")
      await editing()
      ComposerFocusTrace.mark("editing.return")
      ComposerFocusTrace.mark("transcript.enter")
      await transcript()
      ComposerFocusTrace.mark("transcript.return")
      for fixture in windows { fixture.close() }
      let passed = checks.allSatisfy { $0["passed"] as? Bool == true }
      let result: [String: Any] = [
        "complete": true, "checks": checks, "editingStates": editingStates,
      ]
      let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
      ComposerFocusTrace.mark("report.write.enter")
      FileHandle.standardOutput.write(data + Data("\n".utf8))
      ComposerFocusTrace.mark("report.write.return passed=\(passed)")
      exit(passed ? 0 : 1)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  private func check(_ name: String, _ passed: Bool) {
    checks.append(["name": name, "passed": passed])
    ComposerFocusTrace.completedChecks = checks.count
    ComposerFocusTrace.mark("check passed=\(passed) \(name)")
  }

  private func state(_ name: String, _ fixture: ComposerFocusWindow) {
    editingStates.append([
      "step": name, "draft": fixture.model.draft, "sends": fixture.model.sends,
      "inserts": fixture.model.inserts, "attachments": fixture.model.attachments,
      "composerFocus": fixture.hasComposerFocus, "keyWindow": fixture.window.isKeyWindow,
      "appActive": NSApp.isActive, "windowNumber": fixture.window.windowNumber,
      "keyWindowNumber": NSApp.keyWindow?.windowNumber ?? -1,
      "responder": fixture.window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil",
    ])
  }

  private func conversation() async {
    let fixture = ComposerFocusWindow(conversation: true)
    windows.append(fixture)
    await fixture.settle { NSApp.isActive && fixture.window.isKeyWindow }
    check("conversation owns a key window", NSApp.isActive && fixture.window.isKeyWindow)
    await fixture.settle { fixture.hasComposerFocus }
    check("new conversation focuses its native input", fixture.hasComposerFocus)
    fixture.key("a", code: 0)
    await fixture.settle()
    check("typing after entry reaches the draft", fixture.model.draft == "a")

    fixture.focusOther()
    fixture.model.entries = [.streamingAssistant(id: "reply", blocks: [.paragraph("Partial")])]
    fixture.model.running = true
    await fixture.settle()
    check("streaming and running state preserve another input's focus", fixture.otherHasFocus)
    fixture.model.entries = [.assistant(id: "reply", blocks: [.paragraph("Complete")])]
    fixture.model.running = false
    await fixture.settle()
    check("terminal state preserves another input's focus", fixture.otherHasFocus)

    fixture.model.draft = ""
    fixture.model.conversationID = "second"
    await fixture.settle { fixture.hasComposerFocus }
    check("switching conversation focuses the new input", fixture.hasComposerFocus)
    fixture.key("b", code: 11)
    await fixture.settle()
    check("typing after switching reaches the new draft", fixture.model.draft == "b")
  }

  private func editing() async {
    let fixture = ComposerFocusWindow(conversation: false)
    windows.append(fixture)
    fixture.model.draft = "alpha beta"
    await fixture.settle { NSApp.isActive && fixture.window.isKeyWindow }
    check("composer owns a key window", NSApp.isActive && fixture.window.isKeyWindow)
    await fixture.settle()
    check("a reusable composer leaves existing focus alone by default", fixture.otherHasFocus)
    for (name, point) in [
      ("top", NSPoint(x: 180, y: 2)), ("bottom", NSPoint(x: 180, y: 52)),
      ("left", NSPoint(x: 2, y: 27)), ("right", NSPoint(x: 358, y: 27)),
    ] {
      fixture.focusOther()
      await fixture.settle()
      fixture.click(point)
      await fixture.settle { fixture.hasComposerFocus }
      check("\(name) padding focuses the native input", fixture.hasComposerFocus)
      check(
        "\(name) padding leaves draft and actions unchanged",
        fixture.model.draft == "alpha beta" && fixture.model.sends == 0
          && fixture.model.attachments == 0)
    }
    fixture.click(NSPoint(x: 100, y: 27), count: 2)
    await fixture.settle()
    guard let editor = fixture.window.firstResponder as? NSTextView else {
      check("text click activates the native editor", false)
      return
    }
    check("text click activates the native editor", fixture.hasComposerFocus)
    let selection = editor.selectedRange()
    check("native double click selects text", selection.length > 0)
    state("selected", fixture)
    fixture.model.running = true
    await fixture.settle()
    check("refresh preserves the native selection", editor.selectedRange() == selection)
    state("refreshed", fixture)
    editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
    fixture.key("\r", code: 36, modifiers: .shift)
    await fixture.settle()
    state("shiftReturn", fixture)
    check(
      "Shift Return preserves native field submission",
      fixture.model.draft == "alpha beta" && fixture.model.sends == 1)
    let beforeReturn = fixture.model.sends
    fixture.key("\r", code: 36)
    await fixture.settle()
    state("return", fixture)
    check("Return sends once", fixture.model.sends == beforeReturn + 1)
    let beforeCommandReturn = fixture.model.sends
    fixture.key("\r", code: 36, modifiers: .command)
    await fixture.settle()
    state("commandReturn", fixture)
    check(
      "Command Return inserts once",
      fixture.model.inserts == 1 && fixture.model.sends == beforeCommandReturn)
    fixture.click(NSPoint(x: 28, y: 27))
    await fixture.settle()
    state("attachment", fixture)
    check(
      "attachment click invokes only its action",
      fixture.model.attachments == 1 && fixture.model.sends == beforeCommandReturn)
    fixture.click(NSPoint(x: 332, y: 27))
    await fixture.settle()
    state("send", fixture)
    check("send click invokes its action once", fixture.model.sends == beforeCommandReturn + 1)
  }

  private func transcript() async {
    let fixture = ComposerFocusWindow(conversation: true)
    windows.append(fixture)
    await fixture.settle { NSApp.isActive && fixture.window.isKeyWindow }
    check("transcript owns a key window", NSApp.isActive && fixture.window.isKeyWindow)
    await fixture.settle()
    guard let scroll = fixture.descendants.compactMap({ $0 as? NSScrollView }).first else {
      check("transcript has a native scroll viewport", false)
      return
    }
    let viewport = fixture.host.convert(scroll.contentView.bounds, from: scroll.contentView)
    check("transcript has a native scroll viewport", viewport.height > 100)
    fixture.focusOther()
    await fixture.settle()
    fixture.click(NSPoint(x: viewport.midX, y: viewport.maxY - 32))
    await fixture.settle { fixture.hasComposerFocus }
    check("empty transcript whitespace focuses the native composer", fixture.hasComposerFocus)
    fixture.key("c", code: 8)
    await fixture.settle()
    check("typing after an empty transcript click reaches the draft", fixture.model.draft == "c")

    fixture.model.entries = [
      .assistant(id: "message", blocks: [.paragraph("Selectable message")])
    ]
    fixture.model.preparedMarkdown = [
      "message": [.paragraph(AttributedString("Selectable message"))]
    ]
    await fixture.settle()
    for (name, point, character, code) in [
      ("tail", NSPoint(x: viewport.midX, y: viewport.maxY - 32), "c", UInt16(8)),
      ("left inset", NSPoint(x: viewport.minX + 4, y: viewport.minY + 65), "d", UInt16(2)),
      ("right inset", NSPoint(x: viewport.maxX - 4, y: viewport.minY + 65), "e", UInt16(14)),
    ] {
      fixture.model.draft = ""
      fixture.focusOther()
      await fixture.settle()
      fixture.click(point)
      await fixture.settle { fixture.hasComposerFocus }
      fixture.key(character, code: code)
      await fixture.settle()
      check(
        "\(name) whitespace lets typing reach the same composer",
        fixture.model.draft == character)
    }
    check(
      "whitespace clicks do not send or invoke controls",
      fixture.model.sends == 0 && fixture.model.inserts == 0)

    // Compare with the existing padding entry point; keep the observed native selection
    // and typing result visible instead of testing only an empty draft.
    var refocus: [(focused: Bool, before: String, range: NSRange, after: String)] = []
    let composerTop =
      fixture.host.bounds.maxY - Theme.Metric.composerBottomInset
      - Theme.Metric.composerHeight
    for (name, target) in [
      ("padding", NSPoint(x: fixture.host.bounds.midX, y: composerTop + 2)),
      ("transcript", NSPoint(x: viewport.midX, y: viewport.maxY - 32)),
    ] {
      fixture.model.draft = "Keep this draft"
      fixture.click(NSPoint(x: 100, y: composerTop + Theme.Metric.composerHeight / 2))
      await fixture.settle()
      let ready: Bool
      if let editor = fixture.window.firstResponder as? NSTextView,
        fixture.hasComposerFocus, editor.string == "Keep this draft"
      {
        let caret = NSRange(location: 5, length: 0)
        editor.setSelectedRange(caret)
        ready = editor.selectedRange() == caret
      } else {
        ready = false
      }
      check("\(name) refocus starts with the real composer, draft and caret", ready)
      fixture.focusOther()
      fixture.click(target)
      await fixture.settle()
      let focused = fixture.hasComposerFocus
      let before = fixture.model.draft
      let range =
        (fixture.window.firstResponder as? NSTextView)?.selectedRange()
        ?? NSRange(location: NSNotFound, length: 0)
      fixture.key("x", code: 7)
      await fixture.settle()
      refocus.append((focused, before, range, fixture.model.draft))
      editingStates.append([
        "step": "nonemptyRefocus", "target": name, "composerFocus": focused,
        "draftBeforeTyping": before, "selectionLocation": range.location,
        "selectionLength": range.length, "draftAfterTyping": fixture.model.draft,
      ])
    }
    check(
      "nonempty draft stays intact at both refocus entry points",
      refocus[0].before == "Keep this draft" && refocus[1].before == "Keep this draft"
        && refocus[1].focused)
    check(
      "nonempty refocus selection and typing retain native composer padding behavior",
      refocus[0].focused && refocus[1].focused && refocus[0].range == refocus[1].range
        && refocus[0].after == refocus[1].after && refocus[1].after.contains("x"))

    let draft = fixture.model.draft
    let messagePoint = NSPoint(
      x: viewport.minX + Theme.Metric.conversationInset + 38,
      y: viewport.minY + Theme.Metric.edgeFadeHeight + 10 + 22)
    fixture.focusOther()
    await fixture.hover(messagePoint)
    await fixture.drainRunLoop(for: 0.2)
    state("beforeMessageSelection", fixture)
    fixture.click(messagePoint, count: 1)
    await fixture.settle()
    fixture.click(messagePoint, count: 2)
    await fixture.settle()
    let selectedText = await fixture.selectedText()
    editingStates.append([
      "step": "messageSelection", "selectedText": selectedText,
      "keyWindow": fixture.window.isKeyWindow,
    ])
    check("hovered message text can actually be selected", selectedText == "Selectable")
    check(
      "message selection does not focus or edit the composer",
      !fixture.hasComposerFocus && fixture.model.draft == draft && fixture.model.sends == 0)

    var link = AttributedString("Fixture link")
    link.link = URL(string: "https://example.invalid/focus")!
    fixture.model.preparedMarkdown = ["message": [.paragraph(link)]]
    await fixture.settle()
    fixture.focusOther()
    fixture.move(messagePoint)
    fixture.click(messagePoint)
    await fixture.settle()
    check(
      "transcript link keeps its action without focusing the composer",
      fixture.model.openedURLs == ["https://example.invalid/focus"]
        && !fixture.hasComposerFocus && fixture.model.draft == draft)

    fixture.model.entries = [
      .toolRun(id: "tool", rows: [ToolRow(id: "call", name: "Fixture tool", subtitle: "")])
    ]
    await fixture.settle()
    fixture.focusOther()
    ComposerFocusTrace.mark("sheet.open.enter")
    fixture.click(NSPoint(x: messagePoint.x, y: messagePoint.y - 10))
    await fixture.settle()
    ComposerFocusTrace.mark("sheet.open.return count=\(fixture.window.sheets.count)")
    check(
      "transcript tool button opens its details without focusing the composer",
      fixture.window.sheets.count == 1 && !fixture.hasComposerFocus && fixture.model.draft == draft
    )
    await fixture.dismissSheets()

    fixture.model.entries = (0..<30).map {
      .assistant(id: "long-\($0)", blocks: [.paragraph("History message \($0)")])
    }
    fixture.model.preparedMarkdown = Dictionary(
      uniqueKeysWithValues: (0..<30).map {
        ("long-\($0)", [.paragraph(AttributedString("History message \($0)"))])
      })
    await fixture.settle()
    await fixture.drainRunLoop(for: ComposerFocusTiming.ci ? 1.0 : 0.35)
    fixture.focusOther()
    let beforeScroll = scroll.contentView.bounds.origin
    let scrollDelta = fixture.scrollViewport(scroll, by: 80)
    await fixture.settle()
    await fixture.drainRunLoop()
    editingStates.append([
      "step": "historyScroll", "before": NSStringFromPoint(beforeScroll),
      "after": NSStringFromPoint(scroll.contentView.bounds.origin),
      "scrollDelta": scrollDelta,
      "viewport": NSStringFromRect(scroll.contentView.bounds),
      "document": NSStringFromRect(scroll.documentView?.frame ?? .zero),
      "otherFocus": fixture.otherHasFocus, "composerFocus": fixture.hasComposerFocus,
      "draftBefore": draft, "draftAfter": fixture.model.draft,
      "sheets": fixture.window.sheets.count, "keyWindow": fixture.window.isKeyWindow,
    ])
    check(
      "scrolling history moves the viewport without focusing the composer",
      scroll.contentView.bounds.origin != beforeScroll && fixture.otherHasFocus
        && fixture.model.draft == draft)
  }
}

@MainActor
private final class ComposerFocusModel: ObservableObject {
  @Published var draft = ""
  @Published var entries: [TranscriptEntry] = []
  @Published var conversationID = "first"
  @Published var running = false
  @Published var preparedMarkdown: [String: [RenderedMarkdownBlock]] = [:]
  var sends = 0
  var attachments = 0
  var inserts = 0
  var openedURLs: [String] = []
}

private struct ComposerFocusView: View {
  @ObservedObject var model: ComposerFocusModel
  let conversation: Bool

  var body: some View {
    if conversation {
      ConversationColumn(
        title: "Fixture", subtitle: "", tintIndex: 0, entries: model.entries,
        preparedMarkdown: model.preparedMarkdown,
        draft: $model.draft, onSend: { model.sends += 1 },
        onInsert: model.running ? { model.inserts += 1 } : nil
      )
      .id(model.conversationID)
      .environment(
        \.openURL,
        OpenURLAction { url in
          model.openedURLs.append(url.absoluteString)
          return .handled
        })
    } else {
      Composer(
        placeholder: "Fixture input", text: $model.draft,
        onSend: { model.sends += 1 },
        onInsert: model.running ? { model.inserts += 1 } : nil,
        onAttach: { model.attachments += 1 }
      )
    }
  }
}

@MainActor
private final class ComposerFocusWindow {
  let model = ComposerFocusModel()
  let window: NSWindow
  let other = NSTextField(string: "Other control")
  let host: NSHostingView<ComposerFocusView>

  init(conversation: Bool) {
    ComposerFocusTrace.mark("window.init.enter conversation=\(conversation)")
    let height: CGFloat = conversation ? 360 : Theme.Metric.composerHeight
    window = NSWindow(
      contentRect: NSRect(x: 100, y: 100, width: 360, height: height + 40),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.acceptsMouseMovedEvents = true
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: height + 40))
    window.contentView = container
    other.frame = NSRect(x: 0, y: height + 5, width: 180, height: 28)
    container.addSubview(other)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(other)
    host = NSHostingView(rootView: ComposerFocusView(model: model, conversation: conversation))
    host.frame = NSRect(x: 0, y: 0, width: 360, height: height)
    container.addSubview(host)
    layout("window.init")
    ComposerFocusTrace.mark("window.init.return window=\(window.windowNumber)")
  }

  var hasComposerFocus: Bool {
    guard let editor = window.firstResponder as? NSTextView, editor.isEditable else { return false }
    return editor.isDescendant(of: host)
  }

  var descendants: [NSView] {
    func collect(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(collect) }
    return collect(host)
  }

  var otherHasFocus: Bool { other.currentEditor() === window.firstResponder }

  func focusOther() { window.makeFirstResponder(other) }

  func hitDescription(_ point: NSPoint) -> String {
    guard let hit = host.hitTest(host.convert(point, to: host.superview)) else { return "nil" }
    return "\(type(of: hit)) \(NSStringFromRect(host.convert(hit.bounds, from: hit)))"
  }

  private func layout(_ context: String) {
    ComposerFocusTrace.mark("\(context).layout.enter")
    host.layoutSubtreeIfNeeded()
    ComposerFocusTrace.mark("\(context).layout.return")
  }

  /// When `until` is nil, drain layout for a short idle window. Otherwise wait until the predicate
  /// holds or the readiness deadline expires (slow CI activation/focus).
  func settle(until condition: (() -> Bool)? = nil, timeout: TimeInterval? = nil) async {
    ComposerFocusTrace.mark("settle.enter")
    defer { ComposerFocusTrace.mark("settle.return") }
    let limit = timeout
      ?? (condition == nil ? ComposerFocusTiming.idleSettle : ComposerFocusTiming.readinessTimeout)
    let deadline = ProcessInfo.processInfo.systemUptime + limit
    var step = 0
    while ProcessInfo.processInfo.systemUptime < deadline {
      layout("settle[\(step)]")
      step += 1
      if let condition, condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  /// Let SwiftUI and AppKit drain pending layout/scroll work without posting wheel events.
  func drainRunLoop(for duration: TimeInterval = 0.35) async {
    ComposerFocusTrace.mark("drainRunLoop.enter")
    defer { ComposerFocusTrace.mark("drainRunLoop.return") }
    let steps = max(1, Int(duration / 0.01))
    for step in 0..<steps {
      layout("drainRunLoop[\(step)]")
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  func dismissSheets() async {
    ComposerFocusTrace.mark("sheets.dismiss.enter count=\(window.sheets.count)")
    defer { ComposerFocusTrace.mark("sheets.dismiss.return count=\(window.sheets.count)") }
    for sheet in window.sheets {
      ComposerFocusTrace.mark("sheet.end.enter")
      window.endSheet(sheet, returnCode: .OK)
      ComposerFocusTrace.mark("sheet.end.return")
    }
    await settle()
    guard !window.sheets.isEmpty else { return }
    key("\u{1b}", code: 53)
    await settle()
  }

  @discardableResult
  func scrollViewport(_ scroll: NSScrollView, by deltaY: CGFloat) -> CGFloat {
    let before = scroll.contentView.bounds.origin.y
    let documentHeight = scroll.documentView?.frame.height ?? scroll.contentView.bounds.height
    let maxOffset = max(0, documentHeight - scroll.contentView.bounds.height)
    var origin = scroll.contentView.bounds.origin
    origin.y = min(max(0, origin.y + deltaY), maxOffset)
    scroll.contentView.scroll(to: origin)
    scroll.reflectScrolledClipView(scroll.contentView)
    return scroll.contentView.bounds.origin.y - before
  }

  func click(_ point: NSPoint, count: Int = 1) {
    let location = host.convert(point, to: nil)
    let down = NSEvent.mouseEvent(
      with: .leftMouseDown, location: location, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 1, clickCount: count, pressure: 1)!
    let up = NSEvent.mouseEvent(
      with: .leftMouseUp, location: location, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime + 0.01, windowNumber: window.windowNumber,
      context: nil, eventNumber: 2, clickCount: count, pressure: 0)!
    NSApp.postEvent(down, atStart: false)
    NSApp.postEvent(up, atStart: false)
  }

  func move(_ point: NSPoint) {
    ComposerFocusTrace.mark("move.enter")
    defer { ComposerFocusTrace.mark("move.return") }
    let screen = window.convertPoint(toScreen: host.convert(point, to: nil))
    CGWarpMouseCursorPosition(CGPoint(x: screen.x, y: NSScreen.screens[0].frame.maxY - screen.y))
    let location = host.convert(point, to: nil)
    let entered = NSEvent.enterExitEvent(
      with: .mouseEntered, location: location, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 3, trackingNumber: 0, userData: nil)!
    for view in descendants {
      for area in view.trackingAreas
      where area.options.contains(.mouseEnteredAndExited)
        && (area.options.contains(.activeAlways) || area.options.contains(.activeInKeyWindow))
      {
        ComposerFocusTrace.mark("move.mouseEntered.enter")
        (area.owner as? NSResponder)?.mouseEntered(with: entered)
        ComposerFocusTrace.mark("move.mouseEntered.return")
      }
    }
    let event = NSEvent.mouseEvent(
      with: .mouseMoved, location: location, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 3, clickCount: 0, pressure: 0)!
    if let hit = host.hitTest(location) {
      ComposerFocusTrace.mark("move.mouseMoved.enter")
      hit.mouseMoved(with: event)
      ComposerFocusTrace.mark("move.mouseMoved.return")
    }
    NSApp.postEvent(event, atStart: false)
  }

  func hover(_ point: NSPoint) async {
    ComposerFocusTrace.mark("hover.enter")
    defer { ComposerFocusTrace.mark("hover.return") }
    let start = NSPoint(x: host.bounds.midX, y: host.bounds.midY)
    for step in 0...12 {
      let t = CGFloat(step) / 12
      move(
        NSPoint(
          x: start.x + (point.x - start.x) * t,
          y: start.y + (point.y - start.y) * t
        ))
      await settle()
    }
    move(point)
    await settle()
  }

  func selectedText() async -> String {
    for view in descendants.compactMap({ $0 as? NSTextView }) {
      let range = view.selectedRange()
      guard range.length > 0 else { continue }
      return (view.string as NSString).substring(with: range)
    }
    return ""
  }

  func scroll(at point: NSPoint, delta: Int32) async -> [[String: Any]] {
    let screen = window.convertPoint(toScreen: host.convert(point, to: nil))
    let location = CGPoint(x: screen.x, y: NSScreen.screens[0].frame.maxY - screen.y)
    var events: [[String: Any]] = []
    for (phase, amount) in [
      (CGScrollPhase.began, Int32(0)), (.changed, delta), (.ended, Int32(0)),
    ] {
      let wheel = CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
        wheel1: amount, wheel2: 0, wheel3: 0)!
      wheel.location = location
      wheel.setIntegerValueField(
        .mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
      wheel.setIntegerValueField(
        .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
      wheel.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
      let event = RoutedScrollEvent(
        source: NSEvent(cgEvent: wheel)!, target: window, point: host.convert(point, to: nil))
      events.append([
        "windowNumber": event.windowNumber, "point": NSStringFromPoint(event.locationInWindow),
        "phase": event.phase.rawValue, "delta": event.scrollingDeltaY,
      ])
      NSApp.sendEvent(event)
      await settle()
      events.append([
        "step": "afterPhase", "phase": event.phase.rawValue,
        "viewports": descendants.compactMap {
          ($0 as? NSScrollView).map { NSStringFromRect($0.contentView.bounds) }
        },
      ])
    }
    return events
  }

  func key(_ characters: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) {
    let modifierCode: UInt16 = modifiers.contains(.command) ? 55 : 56
    if !modifiers.isEmpty {
      let changed = NSEvent.keyEvent(
        with: .flagsChanged, location: .zero, modifierFlags: modifiers,
        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
        context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false,
        keyCode: modifierCode)!
      NSApp.postEvent(changed, atStart: false)
    }
    let event = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: modifiers,
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, characters: characters, charactersIgnoringModifiers: characters,
      isARepeat: false,
      keyCode: code)!
    let released = NSEvent.keyEvent(
      with: .keyUp, location: .zero, modifierFlags: modifiers,
      timestamp: ProcessInfo.processInfo.systemUptime + 0.01, windowNumber: window.windowNumber,
      context: nil, characters: characters, charactersIgnoringModifiers: characters,
      isARepeat: false,
      keyCode: code)!
    NSApp.postEvent(event, atStart: false)
    NSApp.postEvent(released, atStart: false)
    if !modifiers.isEmpty {
      let changed = NSEvent.keyEvent(
        with: .flagsChanged, location: .zero, modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime + 0.02, windowNumber: window.windowNumber,
        context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false,
        keyCode: modifierCode)!
      NSApp.postEvent(changed, atStart: false)
    }
  }

  func close() {
    ComposerFocusTrace.mark("close.responder.enter window=\(window.windowNumber)")
    window.makeFirstResponder(nil)
    ComposerFocusTrace.mark("close.responder.return")
    ComposerFocusTrace.mark("close.content.enter")
    window.contentView = nil
    ComposerFocusTrace.mark("close.content.return")
    ComposerFocusTrace.mark("close.window.enter")
    window.close()
    ComposerFocusTrace.mark("close.window.return")
  }
}

private final class RoutedScrollEvent: NSEvent {
  let source: NSEvent
  let target: NSWindow
  let targetNumber: Int
  let point: NSPoint
  @MainActor init(source: NSEvent, target: NSWindow, point: NSPoint) {
    self.source = source
    self.target = target
    self.targetNumber = target.windowNumber
    self.point = point
    super.init()
  }
  required init?(coder: NSCoder) { nil }
  override var type: NSEvent.EventType { .scrollWheel }
  override var window: NSWindow? { target }
  override var windowNumber: Int { targetNumber }
  override var locationInWindow: NSPoint { point }
  override var timestamp: TimeInterval { source.timestamp }
  override var modifierFlags: NSEvent.ModifierFlags { source.modifierFlags }
  override var hasPreciseScrollingDeltas: Bool { source.hasPreciseScrollingDeltas }
  override var scrollingDeltaY: CGFloat { source.scrollingDeltaY }
  override var scrollingDeltaX: CGFloat { source.scrollingDeltaX }
  override var deltaY: CGFloat { source.deltaY }
  override var deltaX: CGFloat { source.deltaX }
  override var deltaZ: CGFloat { source.deltaZ }
  override var phase: NSEvent.Phase { source.phase }
  override var momentumPhase: NSEvent.Phase { source.momentumPhase }
  override var isDirectionInvertedFromDevice: Bool { source.isDirectionInvertedFromDevice }
  override var cgEvent: CGEvent? { source.cgEvent }
}
