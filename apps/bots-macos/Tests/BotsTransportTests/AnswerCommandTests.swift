import Foundation
import XCTest

@testable import BotsTransport

final class AnswerCommandTests: XCTestCase {
  private func encoded(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testChoicesTravelAsLabelsBesideTheEntryTheyAnswer() throws {
    let body = try encoded(
      Wire.answer(entryId: "e_11", chosen: ["继续"], skipped: false, trace: "tr_1"))
    XCTAssertEqual(body["type"] as? String, "answer")
    XCTAssertEqual(body["entryId"] as? String, "e_11")
    XCTAssertEqual(body["chosen"] as? [String], ["继续"])
    XCTAssertNil(body["skipped"])
    XCTAssertEqual(body["trace"] as? String, "tr_1")
  }

  func testASkipCarriesNoChoicesAtAll() throws {
    let body = try encoded(Wire.answer(entryId: "e_11", chosen: [], skipped: true, trace: "tr_1"))
    XCTAssertEqual(body["skipped"] as? Bool, true)
    XCTAssertNil(body["chosen"])
  }
}
