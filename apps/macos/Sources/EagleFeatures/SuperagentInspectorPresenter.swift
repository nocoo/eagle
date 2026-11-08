import EagleDesign
import SuperagentCore
import SuperagentFeatures

/// Maps what the Super Bot can see into the inspector's own section shape. The panel is
/// structured exactly like a bot's — 详情 with its sections, placeholders and tabs — so a
/// person cannot tell the two apart; only the rows differ.
@MainActor
enum SuperagentInspectorPresenter {
  /// The 模型 tab a Bot has, filled with the Super Bot's own pair. The menu offers the ids the
  /// daemon knows plus whatever is already configured, so no level or model disappears because
  /// this service discovered them on its own.
  static func modelChoices(
    settings: SuperagentSettingsViewModel, models: [String]
  ) -> [InspectorChoiceRow] {
    let configured = settings.model
    let ids =
      models.contains(configured) || models.isEmpty || configured.isEmpty
      ? models : [configured] + models
    let levels = BotsPresenter.thinkingLevels
    return [
      InspectorChoiceRow(
        id: "model", label: "模型", value: configured.isEmpty ? "未配置" : configured,
        selected: configured,
        choices: ids.map { InspectorChoiceRow.Choice(id: $0, title: $0) }),
      InspectorChoiceRow(
        id: "thinking", label: "思考等级",
        value: BotsPresenter.thinkingLabel(settings.thinkingLevel),
        selected: settings.thinkingLevel,
        choices: levels.map {
          InspectorChoiceRow.Choice(id: $0, title: BotsPresenter.thinkingLabel($0))
        }),
    ]
  }

  static func detailSections(_ summary: ObservationSummary) -> [InspectorSectionModel] {
    var rows: [InspectorUsageRow] = [
      InspectorUsageRow(id: "state", label: "状态", value: summary.headline),
      InspectorUsageRow(
        id: "coverage", label: "覆盖",
        value: summary.state == .ready
          ? "可见 \(summary.botsVisible) · 未知 \(summary.botsUnknown)" : "未知"),
      InspectorUsageRow(
        id: "last-read", label: "上次读取",
        value: summary.lastReadAt.map { RelativeMoment.short(iso: $0) } ?? "尚未读取",
        hint: summary.lastReadAt.flatMap { RelativeMoment.exact(iso: $0) }),
    ]
    if let detail = summary.detail {
      rows.append(InspectorUsageRow(id: "reason", label: "原因", value: detail))
    }
    return [
      InspectorSections.factsSection(
        id: "observation", title: "观测", symbolName: "eye", rows: rows,
        placeholder: InspectorPlaceholder(
          symbolName: "eye", title: "还没有读取",
          detail: "Super Bot 读取 worker 之后会在这里列出覆盖情况。"))
    ]
  }
}
