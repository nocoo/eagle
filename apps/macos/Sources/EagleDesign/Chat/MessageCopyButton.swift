import AppKit
import SwiftUI

@MainActor
final class MessageCopyViewModel: ObservableObject {
  enum Feedback { case idle, copied, failed }
  @Published private(set) var feedback: Feedback = .idle
  private let pasteboard: NSPasteboard
  private var reset: Task<Void, Never>?

  init(pasteboard: NSPasteboard = .general) {
    self.pasteboard = pasteboard
  }

  func copy(_ text: String) {
    guard !text.isEmpty else { return }
    reset?.cancel()
    pasteboard.clearContents()
    feedback = pasteboard.setString(text, forType: .string) ? .copied : .failed
    reset = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
      self?.feedback = .idle
    }
  }

  func resetFeedback() {
    reset?.cancel()
    feedback = .idle
  }

  deinit { reset?.cancel() }
}

struct MessageCopyButton: View {
  let text: String
  let label: String
  @StateObject private var model = MessageCopyViewModel()
  @FocusState private var focused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    IconButton(
      systemName: model.feedback == .copied ? "checkmark" : "doc.on.doc",
      label: feedbackLabel,
      size: Theme.Metric.hitTarget,
      glyphSize: Theme.Metric.messageActionGlyph,
      tint: model.feedback == .copied
        ? Theme.Palette.accentStrong
        : (model.feedback == .failed ? Theme.Palette.destructive : Theme.Palette.textSecondary),
      action: { model.copy(text) }
    )
    .focused($focused)
    .disabled(text.isEmpty)
    .animation(reduceMotion ? nil : Theme.Motion.copyFeedback, value: model.feedback)
    .onDisappear { model.resetFeedback() }
  }

  private var feedbackLabel: String {
    switch model.feedback {
    case .idle: label
    case .copied: "已复制"
    case .failed: "复制失败，请重试"
    }
  }
}

extension View {
  func messageCopyAlignment() -> some View {
    alignmentGuide(.bottom) { dimensions in
      if let first = dimensions[explicit: .firstTextBaseline],
        let last = dimensions[explicit: .lastTextBaseline], abs(first - last) < 1
      {
        return dimensions[VerticalAlignment.center] + Theme.Metric.hitTarget / 2
      }
      return dimensions[.bottom]
    }
  }
}
