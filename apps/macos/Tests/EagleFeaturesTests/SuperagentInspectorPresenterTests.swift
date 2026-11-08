import EagleDesign
import SuperagentCore
import Testing

@testable import EagleFeatures

@Suite("Super agent inspector")
struct SuperagentInspectorPresenterTests {
  @Test("a ready read fills the same section shape a bot uses")
  func ready() {
    let sections = SuperagentInspectorPresenter.detailSections(
      ObservationSummary(
        state: .ready, reachable: true, botsVisible: 8, botsUnknown: 0,
        lastReadAt: "2026-11-08T08:44:00Z", isEmpty: false))
    #expect(sections.map(\.title) == ["观测"])
    guard case .facts(let rows) = sections[0].rows else {
      Issue.record("the observation section must use the shared figure rows")
      return
    }
    #expect(rows.map(\.label) == ["状态", "覆盖", "上次读取"])
    #expect(rows[1].value == "可见 8 · 未知 0")
  }

  @Test("an unread provider says unknown instead of zero")
  func unread() {
    let sections = SuperagentInspectorPresenter.detailSections(
      ObservationSummary(state: .unconfigured, reachable: false, detail: "no_provider"))
    guard case .facts(let rows) = sections[0].rows else {
      Issue.record("expected figure rows")
      return
    }
    #expect(rows.map(\.label) == ["状态", "覆盖", "上次读取", "原因"])
    #expect(rows[1].value == "未知")
    #expect(rows[2].value == "尚未读取")
  }
}
