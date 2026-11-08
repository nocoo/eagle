import Combine
import EagleDesign
import Foundation
import SuperagentCore
import SuperagentFeatures
import SuperagentTransport

/// The App's composition of the independent Superagent: its own client, outbox and view
/// models. None of it borrows a worker connection, catalog or lifecycle object.
@MainActor
public final class SuperagentWorkspaceViewModel: ObservableObject {
  public static let selectionID = "superagent:main"
  public let supervisor: SuperagentDaemonSupervisor
  public let chat: SuperagentChatViewModel
  public let settings: SuperagentSettingsViewModel
  /// SG-002: read-only worker coverage. It has no command surface by construction.
  public let observation: SuperagentObservationViewModel
  private var forwarding: AnyCancellable?
  /// The Bot service this window's model account is inherited from, once.
  private let bots: BotsSettings
  private var started = false
  private var windowOpen = true

  public init(
    supervisor: SuperagentDaemonSupervisor = .shared,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    bots: BotsSettings = BotsSettings()
  ) {
    self.supervisor = supervisor
    self.bots = bots
    let endpoint = supervisor.endpoint
    let port: SuperagentChatPort
    let settingsPort: SuperagentServicePort
    if let endpoint {
      let client = SuperagentClient(endpoint: endpoint)
      port = client
      settingsPort = client
    } else {
      let failing = FailingSuperagentPort()
      port = failing
      settingsPort = failing
    }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[
      0
    ]
    chat = SuperagentChatViewModel(
      port: port,
      store: FilePendingInputStore(
        directory: Self.pendingInputDirectory(support)))
    settings = SuperagentSettingsViewModel(port: settingsPort)
    observation = SuperagentObservationViewModel(
      port: port as? SuperagentObservationPort ?? FailingObservationPort())
    forwarding = Publishers.Merge3(
      chat.objectWillChange.map { _ in () },
      supervisor.objectWillChange.map { _ in () },
      settings.objectWillChange.map { _ in () }
    ).sink { [weak self] _ in self?.objectWillChange.send() }
  }

  /// The local outbox is part of the build, not of the service: an unconfirmed send in a
  /// development run must never resurface as a prompt in the released App, or the other way.
  nonisolated static func pendingInputDirectory(
    _ base: URL, release: Bool = Bundle.main.bundleURL.pathExtension == "app"
  ) -> URL {
    base.appendingPathComponent(
      release ? "eagle-superagent" : "eagle-superagent-dev", isDirectory: true)
  }

  /// The settings window composes its own client: it never starts or stops the service.
  public static func makeSettings() -> SuperagentSettingsViewModel {
    let endpoint = try? SuperagentEndpoint.resolve(
      environment: ProcessInfo.processInfo.environment,
      home: ProcessInfo.processInfo.environment["HOME"],
      release: AppVersion.current().isRelease)
    guard let endpoint else {
      return SuperagentSettingsViewModel(port: FailingSuperagentPort())
    }
    return SuperagentSettingsViewModel(port: SuperagentClient(endpoint: endpoint))
  }

  public var isReady: Bool {
    if case .running = supervisor.status { return true }
    return false
  }

  public var statusLine: String {
    switch supervisor.status {
    case .stopped: return "服务已停止"
    case .starting: return "正在启动独立服务"
    case .failed(let message): return message
    case .running(_, _, let external):
      if !chat.modelReady { return external ? "外部服务 · 未配置模型" : "独立服务 · 未配置模型" }
      switch chat.connection {
      case .ready: return chat.isRunning ? "正在回答" : "空闲"
      case .connecting: return "正在连接"
      case .failed(let message): return message
      case .idle: return "已连接"
      }
    }
  }

  public func start() async {
    windowOpen = true
    await supervisor.startIfNeeded()
    guard windowOpen, isReady else { return }
    if !started {
      started = true
      await settings.load()
    }
    guard windowOpen, isReady else { return }
    // Re-selecting the row must not tear the socket down and rebuild it: that is what made
    // the surface flash "正在连接" on every visit.
    if chat.connection != .ready { await chat.connect() }
    // The service owns its configuration, but the person's model account is one account: a
    // Super Bot that has none continues the Bot's, now that the socket can be written.
    await inheritBotModel()
  }

  /// First use continues the Bot's model account — the same address, model, level and key — so
  /// the Super Bot can answer without a person typing the credential twice. Only what the Super
  /// Bot lacks is copied; a model, a level or a key chosen here is never replaced.
  ///
  /// Everything comes from the daemon's private gateway file, read here rather than over its
  /// API: the API reports only whether a key exists, by design. This is the notice's action and
  /// the 密钥 row too, so a Super Bot whose own configuration lost its credential can take it
  /// again.
  public func inheritBotModel() async {
    guard let saved = BotsGatewayCredential.read(root: bots.rootURL) else { return }
    await adopt(saved)
  }

  public func clearBotKey() async {
    await settings.clearKey()
  }

  private func adopt(_ inherited: BotsGatewayCredential) async {
    guard windowOpen else { return }
    await settings.load()
    guard windowOpen, !settings.saving else { return }
    guard
      let change = SuperagentModelAdoption.change(
        current: settings.configuration, inherited: inherited)
    else { return }
    await settings.apply(change)
  }

  /// One of the inspector's 模型 rows: the menu's id, written to this service's own pair.
  public func chooseModel(id: String, value: String) async {
    switch id {
    case "model":
      await settings.apply(model: value, thinkingLevel: settings.thinkingLevel)
    case "thinking":
      await settings.apply(model: settings.model, thinkingLevel: value)
    case "key":
      switch value {
      case "inherit-key": await inheritBotModel()
      case "clear-key": await clearBotKey()
      default: return
      }
    default:
      return
    }
  }

  public func reconnect() async {
    await supervisor.restart()
    started = false
    await start()
  }

  public func closeWindow() async {
    windowOpen = false
    await chat.close()
  }
}

/// A resolved endpoint always exists in production; this keeps a malformed override visible
/// instead of silently pointing the App at something else.
final class FailingObservationPort: SuperagentObservationPort {
  func observation() async throws -> ObservationSummary { throw SuperagentError.identity }
}

final class FailingSuperagentPort: SuperagentServicePort {
  func health() async throws -> ServiceHealth { throw SuperagentError.identity }
  func events() async throws -> AsyncThrowingStream<SnapshotFrame, Error> {
    throw SuperagentError.identity
  }
  func state() async throws -> SnapshotFrame { throw SuperagentError.identity }
  func configure(_ value: ConfigurationChange) async throws -> ModelConfiguration {
    throw SuperagentError.identity
  }
  func submit(_ input: PendingInput) async throws -> ChatAdmission {
    throw SuperagentError.identity
  }
  func submission(_ requestId: String) async throws -> ChatAdmission? {
    throw SuperagentError.identity
  }
  func history(before: Int?, limit: Int) async throws -> HistoryPage {
    throw SuperagentError.identity
  }
  func abort() async throws { throw SuperagentError.identity }
  func close() async {}
}
