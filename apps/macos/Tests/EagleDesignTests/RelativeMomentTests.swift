import Foundation
import Testing

@testable import EagleDesign

@Suite("Relative moment")
struct RelativeMomentTests {
  private let now = Date(timeIntervalSince1970: 1_790_000_000)

  private func at(_ secondsAgo: TimeInterval) -> Date {
    now.addingTimeInterval(-secondsAgo)
  }

  @Test("the short form counts up in the unit a person would use")
  func shortForm() {
    #expect(RelativeMoment.short(at(0), now: now) == "刚刚")
    #expect(RelativeMoment.short(at(59), now: now) == "刚刚")
    #expect(RelativeMoment.short(at(60), now: now) == "1分之前")
    #expect(RelativeMoment.short(at(59 * 60), now: now) == "59分之前")
    #expect(RelativeMoment.short(at(3_600), now: now) == "1小时之前")
    #expect(RelativeMoment.short(at(3_780), now: now) == "1小时3分之前", "1小时3分")
    #expect(RelativeMoment.short(at(86_400), now: now) == "1天之前")
    #expect(RelativeMoment.short(at(29 * 86_400), now: now) == "29天之前")
  }

  @Test("a clock that runs ahead is not reported as a negative age")
  func future() {
    #expect(RelativeMoment.short(now.addingTimeInterval(120), now: now) == "刚刚")
  }

  @Test("beyond a month the short form becomes the date itself")
  func distant() {
    let iso = RelativeMoment.short(at(40 * 86_400), now: now)
    #expect(iso.count == 10, "a date, not a count: \(iso)")
  }

  @Test("the hover form is the exact instant, and an ISO input decodes to both forms")
  func exactForm() throws {
    let date = Date(timeIntervalSince1970: 1_788_000_000)
    let exact = RelativeMoment.exact(date)
    #expect(exact.count == 19, "yyyy-MM-dd HH:mm:ss: \(exact)")
    let iso = "2026-09-01T05:45:33.000Z"
    #expect(RelativeMoment.exact(iso: iso)?.count == 19)
    #expect(RelativeMoment.short(iso: iso, now: now).isEmpty == false)
    #expect(RelativeMoment.short(iso: "not a date", now: now) == "not a date")
  }
}
