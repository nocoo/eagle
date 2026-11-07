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
  private var started = false
  private var windowOpen = true

  public init(
    supervisor: SuperagentDaemonSupervisor = .shared,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.supervisor = supervisor
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
    .appendingPathComponent("eagle-superagent", isDirectory: true)
    chat = SuperagentChatViewModel(port: port, store: FilePendingInputStore(directory: support))
    settings = SuperagentSettingsViewModel(port: settingsPort)
    observation = SuperagentObservationViewModel(
      port: port as? SuperagentObservationPort ?? FailingObservationPort())
    forwarding = Publishers.Merge(
      chat.objectWillChange.map { _ in () },
      supervisor.objectWillChange.map { _ in () }
    ).sink { [weak self] _ in self?.objectWillChange.send() }
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
    await chat.connect()
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
