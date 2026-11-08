import Foundation

/// One way to name a moment in the App. A surface shows the short relative form — "3分之前",
/// "1小时3分之前" — and its hover carries the exact instant, so a person can read both without
/// the panel growing a second column. Dates far enough back read as a date, because "412天之前"
/// stops being useful long before it stops being true.
public enum RelativeMoment {
  public static func short(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 60 { return "刚刚" }
    if seconds < 3_600 {
      return "\(Int(seconds / 60))分之前"
    }
    if seconds < 86_400 {
      let hours = Int(seconds / 3_600)
      let minutes = Int(seconds.truncatingRemainder(dividingBy: 3_600) / 60)
      return minutes == 0 ? "\(hours)小时之前" : "\(hours)小时\(minutes)分之前"
    }
    if seconds < 30 * 86_400 {
      return "\(Int(seconds / 86_400))天之前"
    }
    return exact(date, pattern: "yyyy-MM-dd")
  }

  /// The instant a hover shows, to the second, in the machine's own zone.
  public static func exact(_ date: Date, pattern: String = "yyyy-MM-dd HH:mm:ss") -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = pattern
    return formatter.string(from: date)
  }

  /// The daemon's ISO instant, read the way every other surface reads it.
  public static func date(_ iso: String) -> Date? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }

  /// Short form for an ISO instant, or the raw string when it cannot be parsed.
  public static func short(iso: String, now: Date = Date()) -> String {
    date(iso).map { short($0, now: now) } ?? iso
  }

  /// The hover form for an ISO instant; absent when it cannot be parsed.
  public static func exact(iso: String) -> String? {
    date(iso).map { exact($0) }
  }
}
