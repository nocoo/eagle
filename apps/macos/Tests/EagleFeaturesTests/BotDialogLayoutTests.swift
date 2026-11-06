import AppKit
import SwiftUI
import Testing

@testable import EagleDesign
@testable import EagleFeatures

/// The create and face dialogs as a person meets them: a compact card whose identity reads
/// like the inspector's, standard footer buttons, and no leftover explanation about colour.
@Suite("Bot dialog layout", .serialized)
@MainActor
struct BotDialogLayoutTests {
  @Test("the create dialog is compact instead of the old tall sheet")
  func compactBounds() throws {
    let fixture = try DialogFixture(BotCreateSheet(onCreate: { _, _, _ in }, onCancel: {}))
    defer { fixture.close() }
    let size = fixture.host.fittingSize
    #expect(size.width >= 420 && size.width <= 480, "width was \(size.width)")
    #expect(size.height >= 420 && size.height <= 520, "height was \(size.height)")
  }

  @Test("the name and the tag sit beside the face, not in two tall boxes")
  func identityArrangement() throws {
    let fixture = try DialogFixture(BotCreateSheet(onCreate: { _, _, _ in }, onCancel: {}))
    defer { fixture.close() }
    let fields = fixture.nodes.filter { fixture.role($0) == "AXTextField" }
    #expect(fields.count == 2, "a name and an optional tag")
    #expect(
      Set(fields.compactMap(fixture.title)) == ["给你的 Bot 起个名字", "标签（可选）"],
      "each field names itself: the field's own title is empty")
    let nameNode = try #require(fields.first { fixture.title($0) == "给你的 Bot 起个名字" })
    let tagNode = try #require(fields.first { fixture.title($0) == "标签（可选）" })
    let name = try #require(fixture.frame(nameNode))
    let tag = try #require(fixture.frame(tagNode))
    // A form box would put the two rows an input apart; identity rows sit one type step apart.
    #expect(abs(tag.midY - name.midY) <= Theme.Inspector.nameHeight, "two compact identity rows")
    #expect(name.height > tag.height, "the name is the title and the tag is the subtitle")
    // Accessibility frames are screen coordinates: the larger y is the higher row.
    #expect(name.minY > tag.minY, "the tag follows the name")
    #expect(tag.minX == name.minX, "the identity is one column")
    let lefts = fixture.nodes.compactMap { fixture.frame($0)?.minX }
    let cardLeft = try #require(lefts.min())
    let portraitAndInset = Theme.Metric.avatarInspector + Theme.Layout.sectionGap
    #expect(
      name.minX - cardLeft >= portraitAndInset,
      "the face owns the space to the left of the name")
  }

  @Test("the shape grid and the eight chips fit without a wasted row")
  func pickerGrid() throws {
    let fixture = try DialogFixture(BotCreateSheet(onCreate: { _, _, _ in }, onCancel: {}))
    defer { fixture.close() }
    // The picker's buttons are the unnamed ones; the footer and the close control are named.
    let buttons = fixture.nodes.filter {
      fixture.role($0) == "AXButton" && fixture.title($0) == nil
    }
    .compactMap { fixture.frame($0) }
    let rows = clusters(buttons, gap: Theme.Picker.swatchSize).map(\.count).sorted()
    #expect(rows == [5, 5, 8] as [Int], "two rows of five shapes, then eight colours: \(rows)")
  }

  @Test("the footer uses the standard action boxes")
  func footerButtons() throws {
    let fixture = try DialogFixture(BotCreateSheet(onCreate: { _, _, _ in }, onCancel: {}))
    defer { fixture.close() }
    for title in ["取消", "创建"] {
      let node = try #require(
        fixture.nodes.first { fixture.role($0) == "AXButton" && fixture.title($0) == title },
        "no footer button named \(title)")
      let frame = try #require(fixture.frame(node))
      #expect(abs(frame.height - Theme.Form.actionHeight) < 1, "\(title) is a standard action")
    }
  }

  @Test("the dialog no longer explains how colour is assigned")
  func noColourNote() throws {
    let fixture = try DialogFixture(BotCreateSheet(onCreate: { _, _, _ in }, onCancel: {}))
    defer { fixture.close() }
    let texts = fixture.nodes.compactMap(fixture.title)
    #expect(!texts.contains { $0.contains("分配颜色") })
    #expect(!texts.contains { $0.contains("固定 ID") })
  }

  @Test("nothing in the card is laid out past its bounds")
  func noOverflow() throws {
    let fixture = try DialogFixture(BotCreateSheet(onCreate: { _, _, _ in }, onCancel: {}))
    defer { fixture.close() }
    // The hosting view's own node spans the window, so the card's contents start below it.
    let frames = fixture.nodes.dropFirst().compactMap { fixture.frame($0) }
    let maxX = try #require(frames.map { $0.maxX }.max())
    let minX = try #require(frames.map { $0.minX }.min())
    let maxY = try #require(frames.map { $0.maxY }.max())
    let minY = try #require(frames.map { $0.minY }.min())
    let width = maxX - minX
    let height = maxY - minY
    let size = fixture.host.fittingSize
    #expect(width <= size.width + Theme.Layout.controlGap, "width was \(width)")
    #expect(height <= size.height + Theme.Layout.controlGap, "height was \(height)")
  }

  @Test("the face editor matches the create dialog's compact surface")
  func faceEditor() throws {
    let fixture = try DialogFixture(
      BotFaceEditorSheet(initial: .init(shape: .star, tint: .teal), onSave: { _ in }, onCancel: {}))
    defer { fixture.close() }
    let size = fixture.host.fittingSize
    #expect(size.width >= 420 && size.width <= 480, "width was \(size.width)")
    #expect(size.height <= 520, "height was \(size.height)")
    let buttons = fixture.nodes.filter { fixture.role($0) == "AXButton" }
    for title in ["取消", "保存"] {
      let node = try #require(
        buttons.first { fixture.title($0) == title }, "no footer button named \(title)")
      #expect(abs((try #require(fixture.frame(node))).height - Theme.Form.actionHeight) < 1)
    }
  }

  /// The preference is the machine's own: a test never writes it (see the retrospective
  /// note on the read-only reduce-motion environment value).
  @Test("the portrait follows the system Reduce Motion preference")
  func reduceMotion() async throws {
    let held = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let preview = BotFacePreview(style: .init(shape: .star, tint: .violet))
      .background(Theme.Palette.surface)
    let first = try render(preview)
    try await Task.sleep(for: .milliseconds(140))
    let second = try render(preview)
    #expect(try hasVioletPixel(first), "the preview renders the colour it will store")
    if held {
      #expect(first == second, "Reduce Motion holds the portrait still")
    }
  }

  /// Rows of sibling buttons: one cluster per visual row, split where the vertical gap grows.
  private func clusters(_ frames: [NSRect], gap: CGFloat) -> [[NSRect]] {
    let sorted = frames.sorted { $0.midY < $1.midY }
    var rows: [[NSRect]] = []
    for frame in sorted {
      if let row = rows.last, let first = row.first, frame.midY - first.midY < gap {
        rows[rows.count - 1].append(frame)
      } else {
        rows.append([frame])
      }
    }
    return rows
  }

  private func render(_ view: some View) throws -> Data {
    let renderer = ImageRenderer(content: view)
    renderer.scale = 1
    let image = try #require(renderer.cgImage)
    let bitmap = NSBitmapImageRep(cgImage: image)
    return try #require(bitmap.representation(using: .png, properties: [:]))
  }

  private func hasVioletPixel(_ png: Data) throws -> Bool {
    let bitmap = try #require(NSBitmapImageRep(data: png))
    for y in 0..<bitmap.pixelsHigh {
      for x in 0..<bitmap.pixelsWide {
        guard let colour = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        if colour.blueComponent > 0.7 && colour.redComponent > 0.5 && colour.greenComponent < 0.7 {
          return true
        }
      }
    }
    return false
  }
}
