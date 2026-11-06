@preconcurrency import AppKit
import SwiftUI

enum BubbleSelectionAction {
  static func insert(_ selection: String, into draft: inout String) {
    let text = selection.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    guard !draft.isEmpty else {
      draft = text
      return
    }
    if draft.last?.isWhitespace == true {
      draft += text
    } else {
      draft += "\n" + text
    }
  }
}

@MainActor
enum BubbleTextBuilder {
  static func attributedString(
    blocks: [RenderedMarkdownBlock], streaming: Bool
  ) -> AttributedString {
    if blocks.count == 1, case .paragraph(let text) = blocks[0] {
      var result = text
      if streaming { result.append(caret) }
      return result
    }

    var result = AttributedString()
    for (index, block) in blocks.enumerated() {
      if index > 0 { result.append(AttributedString("\n")) }
      switch block {
      case .paragraph(let text):
        result.append(text)
      case .heading(let level, let text):
        var value = text
        value.font = Theme.TypeScale.markdownHeading(level)
        value.foregroundColor = Theme.Palette.textPrimary
        result.append(value)
      case .bullets(let items):
        for (itemIndex, item) in items.enumerated() {
          if itemIndex > 0 { result.append(AttributedString("\n")) }
          result.append(AttributedString("• "))
          result.append(item)
        }
      case .code(_, let body):
        var value = AttributedString(body)
        value.font = Theme.TypeScale.code
        value.foregroundColor = Theme.Palette.textPrimary
        result.append(value)
      case .quote(let lines):
        for (lineIndex, line) in lines.enumerated() {
          if lineIndex > 0 { result.append(AttributedString("\n")) }
          var value = AttributedString("> ")
          value.append(line)
          value.foregroundColor = Theme.Palette.textSecondary
          result.append(value)
        }
      case .table(let headers, let rows):
        result.append(
          AttributedString(headers.map { String($0.characters) }.joined(separator: "\t")))
        for row in rows {
          result.append(AttributedString("\n"))
          result.append(AttributedString(row.map { String($0.characters) }.joined(separator: "\t")))
        }
      }
    }
    if streaming, !result.characters.isEmpty { result.append(caret) }
    return result
  }

  static func plainUserText(_ text: String) -> AttributedString {
    var result = AttributedString(text)
    result.font = Theme.TypeScale.bubble
    result.foregroundColor = Theme.Palette.onColor
    return result
  }

  private static var caret: AttributedString {
    var value = AttributedString("▍")
    value.font = Theme.TypeScale.streamingCaret
    value.foregroundColor = Theme.Palette.accent
    return value
  }
}

struct SelectableTranscriptText: View {
  let attributedText: AttributedString

  var body: some View {
    Text(attributedText)
      .textSelection(.enabled)
  }
}

@MainActor
public final class TranscriptSelectionModel: ObservableObject {
  @Published var sourceText = ""
  @Published var selectedText = ""

  public init() {}

  func clearSelection() {
    selectedText = ""
    sourceText = ""
  }
}

struct TranscriptSelectionObserver: NSViewRepresentable {
  let model: TranscriptSelectionModel

  func makeCoordinator() -> Coordinator {
    Coordinator(model: model)
  }

  func makeNSView(context: Context) -> NSView {
    let view = NSView(frame: .zero)
    let coordinator = context.coordinator
    coordinator.observer = NotificationCenter.default.addObserver(
      forName: NSTextView.didChangeSelectionNotification,
      object: nil,
      queue: .main
    ) { [weak coordinator] notification in
      MainActor.assumeIsolated {
        guard let textView = notification.object as? NSTextView,
          !textView.isEditable
        else { return }
        let range = textView.selectedRange()
        guard range.length > 0 else {
          coordinator?.model.clearSelection()
          return
        }
        coordinator?.model.sourceText = textView.string
        coordinator?.model.selectedText = (textView.string as NSString).substring(with: range)
      }
    }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {
    context.coordinator.model = model
  }

  static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
    coordinator.stopObserving()
  }

  @MainActor
  final class Coordinator: NSObject {
    var model: TranscriptSelectionModel
    var observer: NSObjectProtocol?

    init(model: TranscriptSelectionModel) {
      self.model = model
    }

    func stopObserving() {
      if let observer {
        NotificationCenter.default.removeObserver(observer)
        self.observer = nil
      }
    }
  }
}
