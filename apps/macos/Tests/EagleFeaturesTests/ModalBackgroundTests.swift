import AppKit
import SwiftUI
import Testing

@testable import EagleDesign
@testable import EagleFeatures

/// While a dialog is up the workspace behind it is inert: the native composer is disabled, its
/// send control and the workspace's own buttons do not fire, and the dialog's action still
/// works. Closing the dialog hands the workspace back. Focus itself is not asserted here: an
/// offscreen window never becomes key, so the keyboard belongs to the window, not to a field.
@Suite("Modal background", .serialized)
@MainActor
struct ModalBackgroundTests {
  @Test("the workspace behind a dialog cannot be typed in or pressed")
  func backgroundIsInert() async throws {
    let harness = ModalHarness()
    let fixture = try DialogFixture(ModalHarnessView(harness: harness), size: harnessSize)
    defer { fixture.close() }
    try await waitUntil { !fixture.editableTextFields.isEmpty }
    #expect(fixture.editableTextFields.allSatisfy { $0.isEnabled }, "the composer starts live")

    harness.showing = true
    try await waitUntil { fixture.text(of: "对话框动作") != nil }
    #expect(
      fixture.editableTextFields.allSatisfy { !$0.isEnabled },
      "the native field is disabled, not merely covered")

    try fixture.press("发送")
    try fixture.press("背景动作")
    #expect(harness.background == 0, "nothing behind the card can send or fire")
    #expect(harness.draft == "hello", "and the draft was not committed")

    try fixture.press("对话框动作")
    #expect(harness.modal == 1, "the dialog's own action still works")

    harness.showing = false
    harness.restore += 1
    try await waitUntil { fixture.editableTextFields.allSatisfy { $0.isEnabled } }
    #expect(harness.background == 0, "the background was never silently used")
  }

  private var harnessSize: CGSize {
    CGSize(width: Theme.Metric.windowMinWidth, height: Theme.Metric.windowMinHeight)
  }

  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<300 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(domain: "ModalBackgroundTests", code: 1)
  }
}

@MainActor
final class ModalHarness: ObservableObject {
  @Published var showing = false
  @Published var restore = 0
  var background = 0
  var modal = 0
  var draft = "hello"
}

struct ModalHarnessView: View {
  @ObservedObject var harness: ModalHarness
  @State private var draft = "hello"

  var body: some View {
    ModalWorkspace(
      showsDialog: harness.showing,
      workspace: {
        VStack(spacing: 0) {
          ConversationColumn(
            title: "研究员", entries: [], draft: $draft,
            onSend: {
              harness.background += 1
              harness.draft = draft
            },
            focusRestore: harness.restore
          )
          SettingsActionButton("背景动作") { harness.background += 10 }
            .padding(Theme.Layout.pageInset)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      },
      dialog: {
        ModalHost(onDismiss: {}) {
          SettingsActionButton("对话框动作") { harness.modal += 1 }
            .padding(Theme.Layout.pageInset)
        }
      }
    )
  }
}
