import SwiftUI

/// What a section shows instead of rows: one glyph, one short line and one sentence, so an
/// empty section still carries the panel's decoration instead of leaving a hole
/// (docs/bots/PRODUCT.md, inspector).
public struct InspectorPlaceholder: Hashable, Sendable {
  public let symbolName: String
  public let title: String
  public let detail: String

  public init(symbolName: String, title: String, detail: String) {
    self.symbolName = symbolName
    self.title = title
    self.detail = detail
  }
}

/// One live task as the inspector draws it: already named, already indented, already spelled
/// in the person's language. The mapping lives in the view model, never in the view.
public struct InspectorTaskRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  public let symbolName: String
  public let status: String
  /// 0 for a root task, one more for every owner above it.
  public let depth: Int
  public let isRunning: Bool
  public let isBlocked: Bool

  /// A parked task is the one a person can start again; everything else live can be stopped.
  public var showsRetry: Bool { isBlocked }
  public var showsStop: Bool { !isBlocked }

  public init(
    id: String,
    title: String,
    symbolName: String,
    status: String,
    depth: Int,
    isRunning: Bool,
    isBlocked: Bool
  ) {
    self.id = id
    self.title = title
    self.symbolName = symbolName
    self.status = status
    self.depth = depth
    self.isRunning = isRunning
    self.isBlocked = isBlocked
  }
}

/// One reported pull request in the 编码 section: the link opens it, the state colours it.
public struct InspectorPullRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let title: String
  /// github.com, dev.azure.com, … — the row's own label for any forge.
  public let host: String
  /// draft, open, reviewing, merged, closed or failed.
  public let status: String
  public let url: String

  public init(id: String, title: String, host: String, status: String, url: String) {
    self.id = id
    self.title = title
    self.host = host
    self.status = status
    self.url = url
  }

  /// The glyph and colour a state is shown with; an unknown state stays neutral rather than
  /// guessing a colour. The model reports the state, so it is always one of the six.
  public var appearance: (symbol: String, tint: Color, label: String) {
    switch status {
    case "draft": return ("pencil.circle", Theme.Palette.textMuted, "草稿")
    case "open": return ("arrow.triangle.pull", Theme.Palette.info, "进行中")
    case "reviewing": return ("eye.circle", Theme.Palette.warning, "审查中")
    case "merged": return ("arrow.triangle.merge", Theme.Palette.accentStrong, "已合并")
    case "closed": return ("xmark.circle", Theme.Palette.textMuted, "已关闭")
    case "failed": return ("exclamationmark.triangle", Theme.Palette.destructive, "失败")
    default: return ("questionmark.circle", Theme.Palette.textMuted, status)
    }
  }
}

/// One read-only figure of the 用量 section: a label and its already-formatted value.
public struct InspectorUsageRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let label: String
  public let value: String

  public init(id: String, label: String, value: String) {
    self.id = id
    self.label = label
    self.value = value
  }
}

/// One trigger the selected bot owns: its plan on the left, a switch on the right. Triggers live
/// in the bot's own panel, never in the sidebar's bot list.
public struct InspectorTriggerRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let name: String
  public let detail: String
  public let isOn: Bool

  public init(id: String, name: String, detail: String, isOn: Bool) {
    self.id = id
    self.name = name
    self.detail = detail
    self.isOn = isOn
  }
}

/// One row of the 模型 section: a label, the current choice, and the choices a menu offers.
public struct InspectorChoiceRow: Identifiable, Hashable, Sendable {
  public struct Choice: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
      self.id = id
      self.title = title
    }
  }

  public let id: String
  public let label: String
  public let value: String
  /// The chosen id, or nil when the bot follows the daemon-wide setting.
  public let selected: String?
  public let choices: [Choice]
  /// The change is in flight: the menu waits and says so.
  public let isSaving: Bool
  /// The daemon's refusal, when the change did not land.
  public let error: String?

  public init(
    id: String,
    label: String,
    value: String,
    selected: String?,
    choices: [Choice],
    isSaving: Bool = false,
    error: String? = nil
  ) {
    self.id = id
    self.label = label
    self.value = value
    self.selected = selected
    self.choices = choices
    self.isSaving = isSaving
    self.error = error
  }
}

/// One decorated section of the inspector: its header and either rows or a placeholder.
public struct InspectorSectionModel: Identifiable, Hashable, Sendable {
  public enum Rows: Hashable, Sendable {
    case pulls([InspectorPullRow])
    case triggers([InspectorTriggerRow])
    case tasks([InspectorTaskRow])
    case usage([InspectorUsageRow])
    case choices([InspectorChoiceRow])
    /// A section whose whole body is its placeholder.
    case none
  }

  public let id: String
  public let title: String
  public let symbolName: String
  public let rows: Rows
  public let placeholder: InspectorPlaceholder

  public init(
    id: String,
    title: String,
    symbolName: String,
    rows: Rows,
    placeholder: InspectorPlaceholder
  ) {
    self.id = id
    self.title = title
    self.symbolName = symbolName
    self.rows = rows
    self.placeholder = placeholder
  }

  public var isEmpty: Bool {
    switch rows {
    case .pulls(let rows): return rows.isEmpty
    case .triggers(let rows): return rows.isEmpty
    case .tasks(let rows): return rows.isEmpty
    case .usage(let rows): return rows.isEmpty
    case .choices(let rows): return rows.isEmpty
    case .none: return true
    }
  }
}

/// The inspector's sections as data: which ones exist, in which order, and what they say when
/// they hold nothing. Pure, so the decoration is decided without a running view.
public enum InspectorSections {
  public static let codingSection = InspectorSectionModel(
    id: "pulls",
    title: "编码",
    symbolName: "chevron.left.forwardslash.chevron.right",
    rows: .pulls([]),
    placeholder: InspectorPlaceholder(
      symbolName: "arrow.triangle.pull",
      title: "还没有 Pull Request",
      detail: "Bot 打开的 PR 会出现在这里，点一行就到它的链接。"
    )
  )

  public static let tasksSection = InspectorSectionModel(
    id: "tasks",
    title: "任务",
    symbolName: "bolt",
    rows: .tasks([]),
    placeholder: InspectorPlaceholder(
      symbolName: "checkmark.circle",
      title: "没有正在运行的任务",
      detail: "发出消息后，正在跑的步骤会实时出现在这里。"
    )
  )

  public static let modelSection = InspectorSectionModel(
    id: "model",
    title: "模型",
    symbolName: "cpu",
    rows: .choices([]),
    placeholder: InspectorPlaceholder(
      symbolName: "cpu",
      title: "这个会话没有模型",
      detail: "选中一个 Bot 后，它的模型与思考等级会出现在这里。"
    )
  )

  public static let triggersSection = InspectorSectionModel(
    id: "triggers",
    title: "触发器",
    symbolName: "bolt.badge.clock",
    rows: .triggers([]),
    placeholder: InspectorPlaceholder(
      symbolName: "bolt.slash",
      title: "还没有触发器",
      detail: "让这个 Bot 创建定时或 webhook 触发器，它们会出现在这里。"
    )
  )

  public static let usageSection = InspectorSectionModel(
    id: "usage",
    title: "用量",
    symbolName: "chart.bar",
    rows: .usage([]),
    placeholder: InspectorPlaceholder(
      symbolName: "chart.bar",
      title: "还没有用量",
      detail: "发出消息后，token 与花费会累加在这里。"
    )
  )

  public static let librarySection = InspectorSectionModel(
    id: "library",
    title: "资料库",
    symbolName: "books.vertical",
    rows: .none,
    placeholder: InspectorPlaceholder(
      symbolName: "books.vertical",
      title: "资料库还是空的",
      detail: "接入 Herdr 后，Space 的证据与产物会出现在这里。"
    )
  )

  public static let computerSection = InspectorSectionModel(
    id: "computer",
    title: "电脑",
    symbolName: "desktopcomputer",
    rows: .none,
    placeholder: InspectorPlaceholder(
      symbolName: "desktopcomputer",
      title: "还没接入电脑",
      detail: "终端与会话信息在接入后展示。"
    )
  )

  /// 编码 and 任务 — what the open conversation is doing right now. The model and its spend
  /// have their own tab, and triggers are a tab of their own rather than a line here.
  public static func detail(
    pulls: [InspectorPullRow],
    tasks: [InspectorTaskRow]
  ) -> [InspectorSectionModel] {
    [
      codingSection.with(.pulls(pulls)),
      tasksSection.with(.tasks(tasks)),
    ]
  }

  /// 模型 and 用量: how the open bot thinks and what that has cost so far.
  public static func model(
    choices: [InspectorChoiceRow],
    usage: [InspectorUsageRow]
  ) -> [InspectorSectionModel] {
    [
      modelSection.with(.choices(choices)),
      usageSection.with(.usage(usage)),
    ]
  }

  public static func library() -> [InspectorSectionModel] {
    [librarySection.with(.none)]
  }

  public static func computer() -> [InspectorSectionModel] {
    [computerSection]
  }
}

extension InspectorSectionModel {
  func with(_ rows: Rows) -> InspectorSectionModel {
    InspectorSectionModel(
      id: id,
      title: title,
      symbolName: symbolName,
      rows: rows,
      placeholder: placeholder
    )
  }
}
