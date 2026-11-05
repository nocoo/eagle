import AppKit
import SwiftUI

/// One-pixel divider that drags a column width. The drag records the width and
/// pointer position at gesture start and applies the absolute offset, so the
/// column tracks the cursor one-to-one instead of feeding layout changes back
/// into the gesture. The line never changes colour; the cursor changes through a
/// native cursor rect.
public struct ResizeHandle: View {
  private let width: CGFloat
  private let minimum: CGFloat
  private let maximum: CGFloat
  private let inverted: Bool
  private let onChange: (CGFloat) -> Void

  @State private var startX: CGFloat?
  @State private var startWidth: CGFloat?

  public init(
    width: CGFloat,
    minimum: CGFloat,
    maximum: CGFloat,
    inverted: Bool = false,
    onChange: @escaping (CGFloat) -> Void
  ) {
    self.width = width
    self.minimum = minimum
    self.maximum = maximum
    self.inverted = inverted
    self.onChange = onChange
  }

  public var body: some View {
    ZStack {
      Rectangle()
        .fill(Theme.Palette.line)
        .frame(width: Theme.Metric.hairline)
      Theme.Palette.clear
        .contentShape(Rectangle())
        .background(CursorRect(cursor: .resizeLeftRight))
    }
    .frame(width: Theme.Metric.resizeHitWidth)
    .frame(maxHeight: .infinity)
    .gesture(
      DragGesture(minimumDistance: 0, coordinateSpace: .global)
        .onChanged { value in
          if startX == nil {
            startX = value.location.x
            startWidth = width
          }
          let origin = startX ?? value.location.x
          let base = startWidth ?? width
          let offset = value.location.x - origin
          let target = inverted ? base - offset : base + offset
          onChange(min(max(target, minimum), maximum))
        }
        .onEnded { _ in
          startX = nil
          startWidth = nil
        }
    )
    .accessibilityLabel("调整栏宽")
  }
}

/// Native cursor rect: `onHover` plus `NSCursor.push` loses to SwiftUI's own
/// cursor management, a cursor rect does not.
struct CursorRect: NSViewRepresentable {
  let cursor: NSCursor

  func makeNSView(context: Context) -> CursorView {
    CursorView(cursor: cursor)
  }

  func updateNSView(_ view: CursorView, context: Context) {
    view.cursor = cursor
    view.window?.invalidateCursorRects(for: view)
  }

  final class CursorView: NSView {
    var cursor: NSCursor

    init(cursor: NSCursor) {
      self.cursor = cursor
      super.init(frame: .zero)
      translatesAutoresizingMaskIntoConstraints = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) is not used")
    }

    override func resetCursorRects() {
      addCursorRect(bounds, cursor: cursor)
    }
  }
}
