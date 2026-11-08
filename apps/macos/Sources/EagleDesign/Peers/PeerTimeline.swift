import Foundation

/// How the dialog names a moment: "今天 19:30" for today, "10-28 19:30" otherwise. One place, so a
/// divider and a row never disagree about what "today" means.
public enum PeerTimeline {
  public static func label(_ date: Date) -> String { label(date, now: Date()) }

  public static func label(_ date: Date, now: Date) -> String {
    // The dialog names a moment the way every other surface does: short and relative.
    RelativeMoment.short(date, now: now)
  }

  /// The daemon's ISO instant, read the way every other surface reads it.
  public static func date(_ iso: String) -> Date? {
    RelativeMoment.date(iso)
  }
}
