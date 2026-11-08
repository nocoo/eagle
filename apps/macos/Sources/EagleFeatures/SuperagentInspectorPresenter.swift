import EagleDesign
import SuperagentCore

/// Maps what the Super Bot can see into the inspector's own section shape. The panel is
/// structured exactly like a bot's — 详情 with its sections, placeholders and tabs — so a
/// person cannot tell the two apart; only the rows differ.
enum SuperagentInspectorPresenter {
  static func detailSections(_ summary: ObservationSummary) -> [InspectorSectionModel] {
    var rows: [InspectorUsageRow] = [
      InspectorUsageRow(id: "state", label: "状态", value: summary.headline),
      InspectorUsageRow(
        id: "coverage", label: "覆盖",
        value: summary.state == .ready
          ? "可见 \(summary.botsVisible) · 未知 \(summary.botsUnknown)" : "未知"),
      InspectorUsageRow(
        id: "last-read", label: "上次读取", value: summary.lastReadAt ?? "尚未读取"),
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
