import AppKit
import BotsCore
import BotsTransport
import EagleDesign
import EagleDevices
import EagleFeatures
import SwiftUI

/// Headless snapshot entry point. Renders the shell and the template gallery to
/// PNG files so the layout can be reviewed without screen-recording permission.
///
/// `ImageRenderer` cannot draw AppKit-backed views (`ScrollView`, `TextField`),
/// so this hosts each view in an offscreen `NSWindow` and caches its display.
///
///     swift run SnapshotRenderer [output-directory] [--inspector-only]
@main
struct SnapshotRenderer {
  @MainActor
  static func main() async {
    let output =
      CommandLine.arguments.count > 1
      ? CommandLine.arguments[1]
      : ".local/macos-snapshots"
    let directory = URL(fileURLWithPath: output, isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    if CommandLine.arguments.contains("--devices-only") {
      do { try await captureDevices(in: directory) } catch {
        print("device snapshot fixture failed: \(error)")
      }
      print("wrote device snapshots to \(directory.path)")
      return
    }
    if CommandLine.arguments.contains("--services-only") {
      captureSearchProviders(in: directory)
      print("wrote service snapshots to \(directory.path)")
      return
    }
    captureInspectors(in: directory)
    if CommandLine.arguments.contains("--inspector-only") {
      print("wrote inspector snapshots to \(directory.path)")
      return
    }

    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      capture(
        ConversationColumn(
          title: "一个需要保持停止按钮可见的很长的研究员名字", subtitle: "Bots", tintIndex: 2,
          entries: [.streamingAssistant(id: "preview", blocks: [.paragraph("正在整理已经观察到的信息。")])],
          draft: .constant("第一行：输入框向上展开。\n第二行：按钮留在底部。\n第三行：高度到此为止。\n第四行：在内部滚动。"),
          onSend: {},
          participantStatus: ParticipantStatus(label: "回答中", phase: .working, canStop: true)
        )
        .preferredColorScheme(scheme),
        size: CGSize(width: 480, height: 520), named: "chat-experience-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
      capture(
        ConversationColumn(
          title: "依赖修复专家", subtitle: "Bots", tintIndex: 4,
          entries: [.user(id: "u1", text: "PR #490 已开好，我先过闸门再合并发版。", origin: nil)],
          draft: .constant(""),
          onSend: {},
          participantStatus: ParticipantStatus(label: "回答中", phase: .working, canStop: true),
          isWaiting: true,
          onInsert: {}
        )
        .preferredColorScheme(scheme),
        size: CGSize(width: 480, height: 420), named: "chat-waiting-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }

    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      capture(
        ConversationColumn(
          title: "依赖修复专家", subtitle: "Bots", tintIndex: 4,
          entries: [
            .user(id: "u1", text: "PR #490 已开好，我先过闸门再合并发版。", origin: nil),
            .peerExchange(id: "x1", exchange: MockWorkspace.vesExchange),
            .assistant(
              id: "a1",
              blocks: [
                .paragraph("哥，v3.1.1 好了。"),
                .bullets([
                  "PR #490 已用 merge commit 合进 main（bb6ee42）",
                  "Release: v3.1.1 —— 修的是 dashboard 里 `useSearchParams` / `usePathname` 可能为 null 的类型问题",
                  "已叫 VPS管家去升 us2 / jp1",
                ]),
              ],
              from: PeerOrigin(peer: MockWorkspace.ves, exchangeId: "x1")),
          ],
          draft: .constant(""),
          onSend: {}
        )
        .preferredColorScheme(scheme),
        size: CGSize(width: 760, height: 520), named: "peers-inline-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
      capture(
        PeerConversationDialog(exchange: MockWorkspace.vesExchange) {}
          .preferredColorScheme(scheme),
        size: CGSize(width: 1186, height: 820), named: "peers-dialog-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }

    capture(
      WorkspaceShellView().preferredColorScheme(.light),
      size: CGSize(width: 1728, height: 1082),
      named: "shell-1728x1082",
      in: directory
    )
    capture(
      WorkspaceShellView().preferredColorScheme(.light),
      size: CGSize(width: 1300, height: 800),
      named: "shell-1300x800",
      in: directory
    )
    capture(
      TemplateGallery().preferredColorScheme(.light),
      size: CGSize(width: 1180, height: 820),
      named: "gallery",
      in: directory
    )
    capture(
      TemplateGallery(darkPreview: true),
      size: CGSize(width: 1180, height: 820), named: "gallery-dark", in: directory,
      appearance: .darkAqua
    )
    let collapsed = ShellLayoutViewModel(showsSidebar: false, showsInspector: false)
    capture(
      WorkspaceShellView(layout: collapsed).preferredColorScheme(.light),
      size: CGSize(width: 1440, height: 900),
      named: "shell-collapsed",
      in: directory
    )

    let account = AccountMenuViewModel()
    capture(
      AccountMenu(rows: account.rows, onSelect: { _ in })
        .padding(20)
        .background(Theme.Palette.canvas),
      size: CGSize(width: 266, height: 360),
      named: "account-menu",
      in: directory
    )

    let deviceFixture = SnapshotDeviceControl()
    let deviceDefaults = UserDefaults(suiteName: "EagleDeviceSnapshots")!
    defer { deviceDefaults.removePersistentDomain(forName: "EagleDeviceSnapshots") }
    let devices = DeviceSettingsViewModel(control: deviceFixture, defaults: deviceDefaults)
    await devices.startIfNeeded()
    // The inspector's 电脑 tab: three machines, one of them this one and one offline.
    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      capture(
        DeviceInspectorList(
          entries: [
            DeviceInspectorEntry(
              id: "d1", name: "MBPHome.LZ", isLocal: true, online: true, policy: "始终允许"),
            DeviceInspectorEntry(
              id: "d2", name: "MacMini-2", isLocal: false, online: true, policy: "每次询问"),
            DeviceInspectorEntry(
              id: "d3", name: "MacMini-1", isLocal: false, online: false, policy: "暂停"),
            DeviceInspectorEntry(
              id: "d4", name: "studio-away", isLocal: false, online: nil, policy: "策略未知"),
          ]
        )
        .padding(Theme.Metric.panelInset)
        .frame(width: Theme.Metric.inspectorWidth)
        .background(Theme.Palette.surface)
        .preferredColorScheme(scheme),
        size: CGSize(width: Theme.Metric.inspectorWidth, height: 260),
        named: "inspector-computer-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }

    // The about page, with an update available: the only state a person cannot reach by
    // building a development copy, so it is reviewed as an image instead.
    let about = SettingsViewModel(
      appVersion: AppVersion(short: "0.15.0", build: "1761000000", isRelease: true),
      links: ProductLinks(
        github: URL(string: "https://github.com/nocoo/eagle"),
        release: URL(string: "https://github.com/nocoo/eagle/releases/latest"),
        updates: URL(string: "https://eagle.example.com/api/live")
      )
    )
    about.selection = .about
    about.updateState = .available(
      latest: "0.16.0",
      release: URL(string: "https://github.com/nocoo/eagle/releases/latest")
    )
    capture(
      SettingsView(model: about).preferredColorScheme(.light),
      size: CGSize(
        width: CGFloat(Theme.Metric.settingsWidth), height: CGFloat(Theme.Metric.settingsHeight)),
      named: "settings-about",
      in: directory
    )

    // The same page as a build from source sees it: no published version to jump to, so the
    // card states the version in hand instead.
    let development = SettingsViewModel(
      appVersion: AppVersion(short: "0.16.0", build: "dev", isRelease: false),
      links: ProductLinks(
        github: URL(string: "https://github.com/nocoo/eagle"),
        release: URL(string: "https://github.com/nocoo/eagle/releases/latest"),
        updates: nil
      )
    )
    development.selection = .about
    development.updateState = .development("0.16.0")
    capture(
      SettingsView(model: development).preferredColorScheme(.light),
      size: CGSize(
        width: CGFloat(Theme.Metric.settingsWidth), height: CGFloat(Theme.Metric.settingsHeight)),
      named: "settings-about-development",
      in: directory
    )

    let machines = SettingsViewModel()
    machines.selection = .machines
    capture(
      SettingsView(model: machines, devices: devices).preferredColorScheme(.light),
      size: CGSize(width: 920, height: 720),
      named: "settings-machines",
      in: directory
    )

    let tools = SettingsViewModel()
    tools.selection = .tools
    tools.gatewayCorePrompt = "你是一个务实、友好的 agent：先说结论，再给依据；做不到就直说。"
    tools.gatewayMachinePrompt = MachinePromptPreview(
      path: "/Users/me/workspace/personal/workflow/agents/AGENTS.md",
      text: """
        # system0 machine setup

        一个维护机器指令、可复用技能和命令的来源。项目指令放在各仓根的 AGENTS.md。
        """
    )
    capture(
      SettingsView(model: tools).preferredColorScheme(.light),
      size: CGSize(width: 920, height: 720),
      named: "settings-tools",
      in: directory
    )

    let general = SettingsViewModel()
    general.selection = .general
    capture(
      SettingsView(model: general).preferredColorScheme(.light),
      size: CGSize(width: 920, height: 720),
      named: "settings-general",
      in: directory
    )

    // The 服务 and 用量与账单 pages read the daemon, so the snapshot answers for it: a stub
    // session keeps the review images static and offline.
    let settings = snapshotBotsSettings()
    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      let providers = SettingsViewModel(
        botsSettings: settings.settings, urlSession: settings.session)
      providers.selection = .providers
      capture(
        SettingsView(model: providers).preferredColorScheme(scheme),
        size: CGSize(width: 920, height: 720),
        named: "settings-providers-\(name)",
        in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
      let usage = SettingsViewModel(
        botsSettings: settings.settings, urlSession: settings.session)
      usage.selection = .usage
      capture(
        SettingsView(model: usage).preferredColorScheme(scheme),
        size: CGSize(width: 920, height: 720),
        named: "settings-usage-\(name)",
        in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }

    capture(
      WorkspaceShellView().preferredColorScheme(.dark),
      size: CGSize(width: 1728, height: 1082),
      named: "shell-dark",
      in: directory
    )
    capture(
      SettingsView(
        model: SettingsViewModel(
          botsSettings: settings.settings, urlSession: settings.session)
      ).preferredColorScheme(.dark),
      size: CGSize(width: 920, height: 920),
      named: "settings-dark",
      in: directory,
      appearance: .darkAqua
    )

    print("wrote snapshots to \(directory.path)")
  }

  @MainActor
  private static func captureDevices(in directory: URL) async throws {
    let control = SnapshotDeviceControl()
    let domain = "EagleDeviceSnapshots.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { defaults.removePersistentDomain(forName: domain) }
    let model = DeviceSettingsViewModel(control: control, defaults: defaults)
    await model.startIfNeeded()
    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      let settings = SettingsViewModel()
      settings.selection = .machines
      capture(
        SettingsView(model: settings, devices: model, showsCloseButton: false)
          .preferredColorScheme(scheme),
        size: CGSize(width: 1120, height: 820), named: "devices-settings-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua)
      capture(
        DeviceInspectorView(model: model, onManage: {})
          .padding(Theme.Metric.panelInset).background(Theme.Palette.surface)
          .preferredColorScheme(scheme),
        size: CGSize(width: 300, height: 530), named: "devices-inspector-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua)
      let operation: DeviceJSON = .object([
        "kind": .string("command"), "command": .string("printf '%s\\n' '设备已连接'"),
        "cwd": .string("/Users/demo/Projects"), "timeoutMs": .number(30000),
      ])
      let request = try DeviceJSON.object([
        "requestId": .string(UUID().uuidString), "operationId": .string(UUID().uuidString),
        "sourceDeviceId": .string(SnapshotDeviceControl.localID),
        "targetDeviceId": .string(SnapshotDeviceControl.remoteID), "operation": operation,
        "digest": .string(try DeviceApprovalRequest.digest(operation)), "policyVersion": .number(1),
        "expiresAt": .number(Double(Int64(Date().timeIntervalSince1970 * 1000) + 120000)),
      ]).decoded(DeviceApprovalRequest.self)
      let pending = Task { await control.confirm?(request) }
      while model.pendingApproval == nil { await Task.yield() }
      capture(
        DeviceApprovalView(model: model).preferredColorScheme(scheme),
        size: CGSize(width: 640, height: 640), named: "devices-approval-\(name)", in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua)
      model.denyPendingApproval()
      _ = await pending.value
    }
  }

  @MainActor
  private static func captureSearchProviders(in directory: URL) {
    let fixture = snapshotBotsSettings()
    defer {
      fixture.session.invalidateAndCancel()
      try? FileManager.default.removeItem(at: fixture.settings.rootURL)
    }
    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      for width in [920, 760] {
        let model = SettingsViewModel(
          botsSettings: fixture.settings, urlSession: fixture.session)
        model.selection = .providers
        capture(
          SettingsView(model: model).preferredColorScheme(scheme),
          size: CGSize(width: width, height: 600),
          named: "search-providers-\(name)-\(width)", in: directory,
          appearance: scheme == .dark ? .darkAqua : .aqua
        )
      }
    }
  }

  /// A root with a readable token and a session whose answers are fixtures, never a daemon.
  private static func snapshotBotsSettings() -> (settings: BotsSettings, session: URLSession) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-snapshot-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let token = root.appendingPathComponent("token")
    try? "snapshot-token-012345678901234567890123".write(
      to: token, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes(
      [.posixPermissions: 0o600], ofItemAtPath: token.path)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SnapshotHTTPStub.self]
    return (
      BotsSettings(environment: ["BOTS_ROOT": root.path, "BOTS_PORT": "43117"]),
      URLSession(configuration: configuration)
    )
  }

  @MainActor
  private static func captureInspectors(in directory: URL) {
    let inspectorTasks = [
      InspectorTaskRow(
        id: "t_12", title: "生成回答", symbolName: "sparkles", status: "运行中", depth: 0,
        isRunning: true, isBlocked: false),
      InspectorTaskRow(
        id: "t_13", title: "工具调用", symbolName: "wrench.and.screwdriver", status: "等待",
        depth: 1, isRunning: false, isBlocked: false),
      InspectorTaskRow(
        id: "t_14", title: "子 Agent", symbolName: "person.2", status: "已停放：重试次数过多",
        depth: 2, isRunning: false, isBlocked: true),
      InspectorTaskRow(
        id: "t_16", title: "读取文件", symbolName: "doc.text", status: "等待",
        depth: 2, isRunning: false, isBlocked: false),
      InspectorTaskRow(
        id: "t_17", title: "工具调用", symbolName: "wrench.and.screwdriver", status: "运行中",
        depth: 1, isRunning: true, isBlocked: false),
      InspectorTaskRow(
        id: "t_18", title: "检查结果", symbolName: "checkmark.circle", status: "排队",
        depth: 2, isRunning: false, isBlocked: false),
      InspectorTaskRow(
        id: "t_15", title: "上下文压缩", symbolName: "rectangle.compress.vertical",
        status: "休眠", depth: 0, isRunning: false, isBlocked: false),
    ]
    for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
      let taskSection = InspectorSections.detail(pulls: [], tasks: inspectorTasks)[1]
      let taskHeight =
        Theme.Metric.sectionHeaderHeight + Theme.Metric.panelSectionBodyGap
        + CGFloat(inspectorTasks.count) * Theme.Metric.panelTaskRowHeight
        + CGFloat(inspectorTasks.count - 1) * Theme.Metric.panelTaskRowGap
        + Theme.Metric.panelInset * 2
      for width: CGFloat in [Theme.Metric.inspectorWidth, 256] {
        capture(
          InspectorSectionView(section: taskSection)
            .padding(Theme.Metric.panelInset)
            .background(Theme.Palette.surface)
            .preferredColorScheme(scheme),
          size: CGSize(width: width, height: taskHeight),
          named: "task-tree-\(Int(width))-\(name)", in: directory,
          appearance: scheme == .dark ? .darkAqua : .aqua)
      }
      capture(
        InspectorColumn(
          name: "研究员",
          subtitle: "Bots",
          tintIndex: 2,
          pulls: [
            InspectorPullRow(
              id: "p1", title: "deps: 依赖升级到 2.4.0",
              host: "github.com", status: "merged",
              url: "https://github.com/nocoo/eagle/pull/490"),
            InspectorPullRow(
              id: "p2", title: "fix: reconnect after sleep",
              host: "dev.azure.com", status: "reviewing",
              url: "https://dev.azure.com/hexly/eagle/_git/eagle/pullrequest/12"),
            InspectorPullRow(
              id: "p3", title: "wip: split the transcript renderer",
              host: "github.com", status: "draft",
              url: "https://github.com/nocoo/eagle/pull/491"),
          ],
          tasks: inspectorTasks,
          tab: .constant(.detail)
        )
        .preferredColorScheme(scheme),
        size: CGSize(width: Theme.Metric.inspectorWidth, height: 780),
        named: "inspector-\(name)",
        in: directory,
        appearance: scheme == .dark ? .darkAqua : .aqua
      )
    }
    capture(
      InspectorColumn(
        name: "新的 Bot",
        subtitle: "Bots",
        tintIndex: 5,
        pulls: [],
        tasks: [],
        tab: .constant(.detail)
      )
      .preferredColorScheme(.light),
      size: CGSize(width: Theme.Metric.inspectorWidth, height: 780),
      named: "inspector-empty",
      in: directory
    )

  }

  @MainActor
  private static func capture<V: View>(
    _ view: V, size: CGSize, named name: String, in directory: URL,
    appearance: NSAppearance.Name = .aqua
  ) {
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: appearance)
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(origin: .zero, size: size)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    // Let SwiftUI finish its first layout pass before caching the display.
    RunLoop.main.run(until: Date().addingTimeInterval(0.35))
    host.layoutSubtreeIfNeeded()

    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
      print("failed to allocate bitmap for \(name)")
      return
    }
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else {
      print("failed to encode \(name)")
      return
    }
    try? png.write(to: directory.appendingPathComponent("\(name).png"))
    window.contentView = nil
  }
}

/// Answers the two settings reads with static JSON so a snapshot needs no daemon.
final class SnapshotHTTPStub: URLProtocol {
  private static let provider = """
    {"id":"deepseek-search","title":"DeepSeek","kind":"deepseek-search",
     "baseUrl":"https://api.deepseek.com",
     "docsUrl":"https://api-docs.deepseek.com/guides/search/",
     "keyLabel":"DeepSeek API Key","hasApiKey":true,"enabled":true}
    """

  private static let tavily = """
    {"id":"tavily-search","title":"Tavily","kind":"tavily-search",
     "baseUrl":"https://api.tavily.com",
     "docsUrl":"https://docs.tavily.com/documentation/quickstart",
     "keyLabel":"Tavily API Key","hasApiKey":true,"enabled":false}
    """

  private static let usage = """
    {"retentionDays":90,
     "today":{"totalTokens":12345,"calls":3,"costUsd":0.42},
     "week":{"totalTokens":89000,"calls":21,"costUsd":2.1},
     "month":{"totalTokens":412000,"calls":96,"costUsd":9.4},
     "days":[{"day":"2026-10-01","totalTokens":0,"calls":0,"costUsd":0},
             {"day":"2026-10-02","totalTokens":12000,"calls":2,"costUsd":0.3},
             {"day":"2026-10-03","totalTokens":48000,"calls":5,"costUsd":1.1},
             {"day":"2026-10-04","totalTokens":9000,"calls":1,"costUsd":0.2}],
     "bots":[{"botId":"b_1","title":"研究员","totalTokens":300000,"calls":61,"costUsd":6.2},
             {"botId":"b_2","title":"运维","totalTokens":112000,"calls":35,"costUsd":3.2}],
     "sources":[{"source":"model","totalTokens":412000,"calls":0,"costUsd":9.4},
                {"source":"search","totalTokens":0,"calls":96,"costUsd":0}]}
    """

  private static let gateway = """
    {"configured":true,"provider":"magpie","baseUrl":"http://127.0.0.1:3425/v1",
     "model":"auto/gpt-6-luna","hasApiKey":true,"thinkingLevel":"medium",
     "toolGroups":["core","coding","herdr","agents"]}
    """

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url?.path ?? ""
    let body: String
    switch path {
    case "/v1/providers": body = "{\"providers\":[\(Self.provider),\(Self.tavily)]}"
    case "/v1/usage": body = "{\"usage\":\(Self.usage)}"
    case "/v1/settings": body = "{\"settings\":\(Self.gateway)}"
    default: body = "{}"
    }
    let response = HTTPURLResponse(
      url: request.url ?? URL(string: "http://127.0.0.1")!, statusCode: 200,
      httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// A standalone UI fixture: never registers SMAppService or contacts a real helper.
@MainActor private final class SnapshotDeviceControl: DeviceControl {
  static let localID = "11111111-1111-4111-8111-111111111111"
  static let remoteID = "22222222-2222-4222-8222-222222222222"
  var socketPath: String? { nil }
  var confirm: (@MainActor @Sendable (DeviceApprovalRequest) async -> Bool)?
  func start(
    confirm: @escaping @MainActor @Sendable (DeviceApprovalRequest) async -> Bool
  ) async throws {
    self.confirm = confirm
  }
  func stop() async throws {}
  func openSystemSettings() {}
  func call(_ method: String, params: DeviceJSON?) async throws -> DeviceJSON {
    switch method {
    case "service.status":
      return .object([
        "deviceId": .string(Self.localID), "localReady": .bool(true),
        "cloudStatus": .string("online"),
      ])
    case "policy.get": return .object(["mode": .string("all-approve"), "version": .number(1)])
    case "directory":
      let rows: [(String, String, DeviceJSON, DeviceJSON)] = [
        (Self.localID, "工作 Mac", .bool(true), .string("all-approve")),
        (Self.remoteID, "实验室 Mac", .bool(true), .string("always-ask")),
        ("33333333-3333-4333-8333-333333333333", "Mac mini", .bool(false), .string("paused")),
        ("44444444-4444-4444-8444-444444444444", "备用 Mac", .null, .null),
      ]
      return .object([
        "localDeviceId": .string(Self.localID), "groupId": .string("snapshot-group"),
        "revision": .number(4), "observationRevision": .string("snapshot-observed"),
        "devices": .array(
          rows.map { id, name, online, mode in
            .object([
              "deviceId": .string(id), "name": .string(name), "platform": .string("darwin"),
              "arch": .string("arm64"), "groupId": .string("snapshot-group"), "online": online,
              "lastSeenAt": .null,
              "capabilities": online == .null
                ? .null
                : .array([.string("command"), .string("file.read"), .string("policy.manage")]),
              "policy": mode == .null ? .null : .object(["mode": mode, "version": .number(1)]),
            ])
          }),
      ])
    default: throw DeviceHostError.forbidden
    }
  }
}
