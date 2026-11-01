import Foundation

struct TranscriptScrollMetrics: Equatable {
  let contentHeight: CGFloat
  let visibleBottom: CGFloat
}

struct TranscriptScrollState {
  private(set) var followsBottom = true
  private var contentHeight: CGFloat = 0
  private var visibleBottom: CGFloat?
  private var pendingFollow = false

  mutating func update(_ metrics: TranscriptScrollMetrics, userIsScrolling: Bool) -> Bool {
    let resized = metrics.contentHeight != contentHeight
    let movedUp = visibleBottom.map { metrics.visibleBottom < $0 } ?? false
    let moved = visibleBottom != metrics.visibleBottom
    let first = visibleBottom == nil
    contentHeight = metrics.contentHeight
    visibleBottom = metrics.visibleBottom
    if userIsScrolling {
      if first || movedUp || (!resized && moved) {
        followsBottom = metrics.visibleBottom >= metrics.contentHeight - 20
      }
      pendingFollow = followsBottom && (pendingFollow || resized)
      return false
    }
    let shouldFollow = followsBottom && (resized || pendingFollow)
    pendingFollow = false
    return shouldFollow
  }

  mutating func endUserScroll() -> Bool {
    defer { pendingFollow = false }
    return followsBottom && pendingFollow
  }
}

/// Holder for the scroll bookkeeping above. Deliberately not an `ObservableObject`: the
/// geometry callback runs once per scroll tick, and writing SwiftUI state there
/// invalidated the whole transcript every tick, re-placing every visible row.
final class TranscriptScroller {
  private var state = TranscriptScrollState()
  private var userIsScrolling = false

  func setUserScrolling(_ scrolling: Bool) {
    userIsScrolling = scrolling
  }

  /// Whether the transcript should move to the bottom for this geometry change.
  func update(_ metrics: TranscriptScrollMetrics) -> Bool {
    state.update(metrics, userIsScrolling: userIsScrolling)
  }

  /// Whether a finished gesture left a follow pending.
  func endUserScroll() -> Bool {
    state.endUserScroll()
  }
}
