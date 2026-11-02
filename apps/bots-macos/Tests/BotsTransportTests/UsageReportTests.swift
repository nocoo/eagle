import BotsCore
import BotsTransport
import XCTest

/// PROTOCOL.md, "Usage statistics": the report carries the windows, the padded day series
/// and the busiest bots, and a daemon without the endpoint is a plain failure.
private struct UsageEnvelope: Decodable { let usage: UsageReport }

final class UsageReportTests: XCTestCase {
  func testTheReportDecodesItsWindowsDaysAndBots() throws {
    let decoded = try JSONDecoder().decode(
      UsageEnvelope.self,
      from: Data(
        #"""
        {"usage":{"retentionDays":90,
        "today":{"totalTokens":120,"costUsd":0.01},
        "week":{"totalTokens":900,"costUsd":0.05},
        "month":{"totalTokens":5000,"costUsd":0.3},
        "days":[{"day":"2026-10-20","totalTokens":0,"costUsd":0},
                {"day":"2026-10-21","totalTokens":120,"costUsd":0.01}],
        "bots":[{"botId":"b_1","title":"研究员","totalTokens":5000,"costUsd":0.3}]}}
        """#.utf8)
    ).usage
    XCTAssertEqual(decoded.retentionDays, 90)
    XCTAssertEqual(decoded.today.totalTokens, 120)
    XCTAssertEqual(decoded.days.map(\.day), ["2026-10-20", "2026-10-21"])
    XCTAssertEqual(decoded.days.last?.totalTokens, 120)
    XCTAssertEqual(decoded.bots.first?.title, "研究员")
  }
}
