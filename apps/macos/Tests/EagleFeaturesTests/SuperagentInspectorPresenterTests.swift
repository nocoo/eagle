import EagleDesign
import SuperagentCore
import SuperagentFeatures
import Testing

@testable import EagleFeatures

@MainActor
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

  @Test("the model tab offers the same pair a bot does, from this service's own values")
  func modelChoices() {
    let settings = SuperagentSettingsViewModel(port: FailingSuperagentPort())
    settings.model = "gpt-5"
    settings.thinkingLevel = "high"
    let rows = SuperagentInspectorPresenter.modelChoices(
      settings: settings, models: ["gpt-5", "gpt-5-mini"])
    #expect(rows.map(\.label) == ["模型", "思考等级", "密钥"])
    #expect(rows[0].selected == "gpt-5")
    #expect(rows[0].choices.map(\.id) == ["gpt-5", "gpt-5-mini"])
    #expect(rows[1].value == "高", "the level reads like a bot's level")
    #expect(rows[1].selected == "high")
    #expect(rows[2].value == "未配置")
    #expect(
      rows[2].choices.map(\.id) == ["inherit-key", "clear-key"],
      "the Super Bot's own credential can be taken from the Bot again, or cleared")
  }
}
