import Combine
import EagleDesign
import Foundation
import SwiftUI

/// Static demo content so the shell and the template library can be judged
/// before any real Herdr data is wired in.
public struct WorkspaceGroup: Identifiable, Hashable, Sendable {
  public let id: String
  public var title: String
  public var items: [SidebarItem]

  public init(id: String, title: String, items: [SidebarItem]) {
    self.id = id
    self.title = title
    self.items = items
  }
}

public enum MockWorkspace {
  public static let groups: [WorkspaceGroup] = [
    WorkspaceGroup(
      id: "secretariat", title: "秘书处",
      items: [
        SidebarItem(
          id: "investigator", title: "首席调查官",
          subtitle: "哥，最值得借鉴的是 OpenClaw 的聊天界面模块...", tintIndex: 0),
        SidebarItem(
          id: "secretary", title: "工作秘书",
          subtitle: "哥，周末早上有两件事：", tag: "Personal", tintIndex: 1),
        SidebarItem(
          id: "xbutler", title: "X管家",
          subtitle: "Brotli 那条已经转给 @安全审查师了，原帖和 C...", tag: "Personal", tintIndex: 2),
        SidebarItem(
          id: "mail", title: "个人邮件管家",
          subtitle: "收件箱摘要 2026-10-24 06:00（北京时间）", tag: "Personal", tintIndex: 3),
        SidebarItem(
          id: "life", title: "生活秘书",
          subtitle: "读到了，你现在在北京大兴区旧宫镇，坐标大约...", tag: "Personal", tintIndex: 4),
        SidebarItem(
          id: "skills", title: "技能优化大师",
          subtitle: "哥，安全审查师的 security-incident-daily 第四...", tintIndex: 5),
        SidebarItem(
          id: "knowledge", title: "知识库",
          subtitle: "哥，我查过了：翻墙大师的知识库 key 现在只能...", tag: "Personal", tintIndex: 5),
        SidebarItem(
          id: "fund", title: "基金经理",
          subtitle: "好，那次同步就让它在 Studio 上跑完，我不催...", tag: "Personal", tintIndex: 3),
        SidebarItem(
          id: "blog", title: "博客秘书",
          subtitle: "文章已经在站上发布了：这次 reorg 没写到的那...", tag: "Personal", tintIndex: 0),
        SidebarItem(
          id: "finance", title: "财务助手",
          subtitle: "规则已写进知识库；脚本也是按「远期」标识...", tag: "Personal", tintIndex: 4),
      ]),
    WorkspaceGroup(
      id: "news", title: "新闻组",
      items: [
        SidebarItem(
          id: "translator", title: "首席翻译官",
          subtitle: "已经发给 @博客秘书 了，附上了终稿路径、Xra...", tag: "News", tintIndex: 3),
        SidebarItem(
          id: "reporter", title: "行业记者",
          subtitle: "今天值得读的三条：Cursor 的 sandbox 设计、...", tag: "News", tintIndex: 1),
        SidebarItem(
          id: "digest", title: "早报编辑",
          subtitle: "早报已排好版，头图用的是昨天那张航拍。", tag: "News", tintIndex: 6),
        SidebarItem(
          id: "research", title: "调研助手",
          subtitle: "查到 4 家同类产品的定价，最低的是按席位计费。", tag: "News", tintIndex: 0),
      ]),
    WorkspaceGroup(
      id: "review", title: "审查组",
      items: [
        SidebarItem(
          id: "deps", title: "依赖修复专家",
          subtitle: "第一批 8 个仓库已经开始修了，每小时给你发一次进度",
          tag: "GitHub", tintIndex: 2),
        SidebarItem(
          id: "security", title: "安全审查师",
          subtitle: "CVE-2026-3185 已确认影响 body-parser 2.3.x。", tag: "Security", tintIndex: 0),
        SidebarItem(
          id: "codex", title: "Codex 审查",
          subtitle: "PR #854 第 1 轮通过，没有需要追加的修改。", tag: "GitHub", tintIndex: 1),
      ]),
    WorkspaceGroup(
      id: "ops", title: "运维组",
      items: [
        SidebarItem(
          id: "build", title: "构建守护",
          subtitle: "main 分支 3 次构建失败，都是同一个快照测试。", tintIndex: 6),
        SidebarItem(
          id: "infra", title: "基础设施",
          subtitle: "东京区域的 D1 读延迟回落到 2.1ms。", tintIndex: 0),
      ]),
  ]

  /// The demo bots a fresh shell shows before a daemon answers.
  public static let botTranscript: [TranscriptEntry] = [
    .assistant(
      id: "a1",
      blocks: [
        .bullets([
          "firefly: 5 / 2, 有 CVE",
          "octo: 5 / 2, 有 CVE",
          "zhe: 11 / 2, 有 CVE，而且可修的超过 10 个",
          "bogo: 7 / 1, 有 CVE",
          "hexly.ai: 10 / 1, 有 CVE",
          "his.fm: 1 / 1, 有 CVE",
          "meowth: 1 / 1, 有 CVE",
          "next-ai: 5 / 1, 有 CVE",
          "sleepy: 2 / 1, 有 CVE",
          "giraffe: 7 / 0, 距上次修复已经 8 天",
        ]),
        .paragraph(
          "执行计划：每个仓库开一个 PR，最多同时修 8 个。第一批是 base-mcp、firefly、octo、zhe、bogo、hexly.ai、his.fm 和 meowth，next-ai、sleepy、giraffe 和 matrix 排在后面，前面合并一个就补上一个。每个 PR 等 CI 通过后用 Codex 审查，最多 10 轮，审查通过后用 merge 方式合并。"
        ),
      ]
    ),
    .note(id: "n1", text: "已发送给 8 个智能体", tintIndices: [1, 2, 3]),
    .assistant(
      id: "a2",
      blocks: [
        .paragraph(
          "第一批 8 个仓库已经开始修了：base-mcp、firefly、octo、zhe、bogo、hexly.ai、his.fm 和 meowth。今天 10:00 到 20:00 北京时间，每小时给你发一次进度，第一次大约在 9:45 到 10:15 之间。哪个仓库合并了，我会马上告诉你。"
        )
      ]
    ),
    .peerExchange(id: "x1", exchange: MockWorkspace.vesExchange),
    .assistant(
      id: "a3",
      blocks: [
        .paragraph(
          "2026-10-24 09:00 北京时间，base-mcp 合并了：PR #73，merge commit fd621be，关掉 3 个 issue（#70 #71 #72）。其中 2 个是 CVE，body-parser 升到了 2.4.0，fast-uri 升到了 3.1.9。Codex 审查 1 轮就通过了。排队的 next-ai 已经接着开始修。"
        )
      ],
      from: PeerOrigin(peer: MockWorkspace.ves, exchangeId: "x1")
    ),
    .peerExchange(id: "x2", exchange: MockWorkspace.fireflyExchange),
    .assistant(
      id: "a4",
      blocks: [
        .paragraph(
          "2026-10-24 09:05 北京时间，firefly 合并了：PR #854，merge commit ac06e59，关掉 5 个 issue（#849–#853）。其中 2 个是 CVE，body-parser 升到了 2.4.0，fast-uri 升到了 4.2.3。Codex 审查 1 轮通过。sleepy 已经接着开始修。"
        )
      ]
    ),
    .note(
      id: "n4", text: "已发送给 deps 2026-10-24 next-ai 和 deps 2026-10-24 bogo", tintIndices: [2, 3]),
    .user(id: "u1", text: "今天 eagle 会修吗", origin: nil),
    .assistant(
      id: "a5",
      blocks: [
        .paragraph(
          "eagle 不在这一批名单里：它的 6 个依赖都在上个月升过了，剩下的 1 个是 @nocoo/basalt 的次版本，等 3.3 发布再一起升。如果你现在就要，我把它插到队首。"
        )
      ]
    ),
  ]

  /// The counterpart of the sample exchange, and the exchange itself: one round trip with four
  /// messages, the shape the collapsed row and the dialog are built for.
  public static let ves = PeerRef(
    id: "ves", title: "VPS管家",
    face: BotFace.Style(shape: .blob, tint: .sky), tintIndex: 1)

  public static let depsExpert = PeerRef(
    id: "deps", title: "依赖修复专家",
    face: BotFace.Style(shape: .pebble, tint: .violet), tintIndex: 4)

  public static let firefly = PeerRef(
    id: "firefly", title: "发布管家",
    face: BotFace.Style(shape: .squircle, tint: .orange), tintIndex: 3)

  public static let fireflyExchange = PeerExchange(
    id: "x2",
    participants: [firefly, depsExpert],
    messages: [
      PeerMessage(
        id: "x2m1", senderId: "firefly",
        text: "firefly 的 v3.1.1 补丁版已经在 CI 里了，通过就合并。",
        at: Date(timeIntervalSince1970: 1_790_000_000)),
      PeerMessage(
        id: "x2m2", senderId: "deps",
        text: "好，合并后我同步给依赖清单，next-ai 接着开始修。",
        at: Date(timeIntervalSince1970: 1_790_000_040)),
    ])

  public static let vesExchange = PeerExchange(
    id: "x1",
    participants: [ves, depsExpert],
    messages: [
      PeerMessage(
        id: "x1m1", senderId: "ves",
        text: "us2 和 jp1 上 dashboard 的 `tsc --noEmit` 都过不了，帮我看下是不是 `useSearchParams` 可能为 null。",
        at: Date(timeIntervalSince1970: 1_790_000_000)),
      PeerMessage(
        id: "x1m2", senderId: "deps",
        text: "收到，已经定位到 `packages/dashboard/sidebar.tsx` 和 `request-table.tsx` 两处没有判空，一共十来个调用点。",
        at: Date(timeIntervalSince1970: 1_790_000_055)),
      PeerMessage(
        id: "x1m3", senderId: "ves",
        text: "要发补丁版吗？两台机器都在等，旧依赖一共占了大概 7G。",
        at: Date(timeIntervalSince1970: 1_790_001_400)),
      PeerMessage(
        id: "x1m4", senderId: "deps",
        text: "发 v3.1.1：\n\n"
          + "- 修 `useSearchParams` / `usePathname` 的判空\n"
          + "- 全新 `bun install` 下 `build` 和 `tsc` 都过\n"
          + "- 合并后我通知你升 us2 / jp1",
        at: Date(timeIntervalSince1970: 1_790_001_440)),
    ])

  /// The sample conversation's pull requests, so the 编码 section has rows to review.
  public static let pulls: [InspectorPullRow] = [
    InspectorPullRow(
      id: "p1", title: "deps: 依赖升级到 2.4.0", host: "github.com", status: "merged",
      url: "https://github.com/nocoo/eagle/pull/490"),
    InspectorPullRow(
      id: "p2", title: "fix: reconnect after sleep", host: "dev.azure.com", status: "reviewing",
      url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12"),
    InspectorPullRow(
      id: "p3", title: "wip: split the transcript renderer", host: "github.com", status: "draft",
      url: "https://github.com/nocoo/eagle/pull/491"),
  ]

}

/// Left column state. Every item is a bot; the groups are how the user files them.
/// Group expansion and item editing live here so the views stay dumb.
public final class WorkspaceListViewModel: ObservableObject {
  @Published public var groups: [WorkspaceGroup]
  @Published public var expanded: Set<String>
  @Published public var selection: String?

  public init(groups: [WorkspaceGroup] = MockWorkspace.groups, selection: String? = "deps") {
    self.groups = groups
    self.expanded = Set(groups.map(\.id))
    self.selection = selection
  }

  public func select(_ id: String) {
    selection = id
  }

  public var sections: [SidebarSection] {
    groups.map { group in
      SidebarSection(
        id: group.id,
        title: group.title,
        isExpanded: expanded.contains(group.id),
        items: group.items
      )
    }
  }

  public var selectedItem: SidebarItem? {
    groups.flatMap(\.items).first { $0.id == selection }
  }

  public func toggleSection(_ id: String) {
    if expanded.contains(id) {
      expanded.remove(id)
    } else {
      expanded.insert(id)
    }
  }

  public func createSection() {
    var index = 1
    var id = "group-\(index)"
    while groups.contains(where: { $0.id == id }) {
      index += 1
      id = "group-\(index)"
    }
    groups.append(WorkspaceGroup(id: id, title: "新分组 \(index)", items: []))
    expanded.insert(id)
  }

  public func renameSection(_ id: String, to title: String) {
    guard let index = groups.firstIndex(where: { $0.id == id }) else { return }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    groups[index].title = trimmed
  }

  public func deleteSection(_ id: String) {
    guard let index = groups.firstIndex(where: { $0.id == id }) else { return }
    let removed = groups.remove(at: index)
    expanded.remove(id)
    if let selection, removed.items.contains(where: { $0.id == selection }) {
      self.selection = groups.flatMap(\.items).first?.id
    }
  }

  public func renameItem(_ id: String, to title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    for groupIndex in groups.indices {
      guard let itemIndex = groups[groupIndex].items.firstIndex(where: { $0.id == id }) else {
        continue
      }
      let item = groups[groupIndex].items[itemIndex]
      groups[groupIndex].items[itemIndex] = SidebarItem(
        id: item.id,
        title: trimmed,
        subtitle: item.subtitle,
        tag: item.tag,
        tintIndex: item.tintIndex
      )
      return
    }
  }

  /// Moves an item to another group, keeping its order stable at the end of the target.
  public func moveItem(_ id: String, to groupId: String) {
    guard let source = groups.firstIndex(where: { $0.items.contains { $0.id == id } }) else {
      return
    }
    guard let target = groups.firstIndex(where: { $0.id == groupId }), source != target else {
      return
    }
    move(id, from: source, to: target)
  }

  private func move(_ id: String, from source: Int, to target: Int) {
    guard let itemIndex = groups[source].items.firstIndex(where: { $0.id == id }) else { return }
    var items = groups[source].items
    let item = items.remove(at: itemIndex)
    groups[source] = WorkspaceGroup(
      id: groups[source].id,
      title: groups[source].title,
      items: items
    )
    groups[target] = WorkspaceGroup(
      id: groups[target].id,
      title: groups[target].title,
      items: groups[target].items + [item]
    )
  }

  public func deleteItem(_ id: String) {
    for groupIndex in groups.indices {
      guard let itemIndex = groups[groupIndex].items.firstIndex(where: { $0.id == id }) else {
        continue
      }
      groups[groupIndex].items.remove(at: itemIndex)
      if selection == id {
        selection = groups.flatMap(\.items).first?.id
      }
      return
    }
  }
}

/// Window layout state: column widths and collapse flags, driven by the
/// draggable dividers and the collapse buttons.
public final class ShellLayoutViewModel: ObservableObject {
  @Published public var sidebarWidth: CGFloat
  @Published public var inspectorWidth: CGFloat
  @Published public var showsSidebar: Bool
  @Published public var showsInspector: Bool

  public init(
    sidebarWidth: CGFloat = Theme.Metric.sidebarWidth,
    inspectorWidth: CGFloat = Theme.Metric.inspectorWidth,
    showsSidebar: Bool = true,
    showsInspector: Bool = true
  ) {
    self.sidebarWidth = sidebarWidth
    self.inspectorWidth = inspectorWidth
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
  }

  public func setSidebarWidth(_ width: CGFloat) {
    sidebarWidth = min(Theme.Metric.sidebarMaxWidth, max(Theme.Metric.sidebarMinWidth, width))
  }

  public func setInspectorWidth(_ width: CGFloat) {
    inspectorWidth = min(Theme.Metric.inspectorMaxWidth, max(Theme.Metric.inspectorMinWidth, width))
  }

  public func toggleSidebar() {
    showsSidebar.toggle()
  }

  public func toggleInspector() {
    showsInspector.toggle()
  }
}

/// Middle column state. `send()` only appends locally until the daemon is wired.
/// The transcript of the selected bot (the demo bots before a daemon is connected).
public final class BotChatViewModel: ObservableObject {
  @Published public var entries: [TranscriptEntry]
  @Published public var draft: String = ""
  @Published public private(set) var sentCount = 0
  /// The sample has no daemon: it waits for an answer the way a real bot does, on the wave
  /// line above the composer.
  @Published public private(set) var waiting = true

  public init(entries: [TranscriptEntry] = MockWorkspace.botTranscript) {
    self.entries = entries
  }

  public func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    entries.append(.user(id: "local-\(sentCount)", text: text, origin: nil))
    sentCount += 1
    waiting = true
    draft = ""
  }
}

/// Right column state.
public final class InspectorViewModel: ObservableObject {
  /// The sample pull requests the 编码 section draws.
  @Published public var pulls: [InspectorPullRow]
  @Published public var tab: InspectorColumn.Tab = .detail

  public init(pulls: [InspectorPullRow] = MockWorkspace.pulls) {
    self.pulls = pulls
  }
}
