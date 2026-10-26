import BotsCore
import BotsTransport
import Combine
import EagleDesign
import Foundation

extension Notification.Name {
  /// The stored gateway settings changed: the Bots surface re-reads them before send.
  static let botsGatewayChanged = Notification.Name("eagle.bots.gatewayChanged")
}

/// State and behaviour of the settings window.
@MainActor
public final class SettingsViewModel: ObservableObject {
  @Published public var selection: SettingsSection = .bots
  @Published public var machines: [MachineDevice]
  @Published public var usage: UsageSummary
  @Published public var launchAtLogin = true
  @Published public var showUnfocusedSpaces = true
  @Published public var followTerminal = true
  @Published public var allowRemoteInput = false
  @Published public var updateState: UpdateState = .current("0.14.1")
  @Published public private(set) var renameTarget: String?
  /// The model gateway tab: values are loaded only when that tab is opened.
  @Published public var gateway: GatewaySettings?
  @Published public var gatewayBaseURL = ""
  @Published public var gatewayModel = ""
  @Published public var gatewayAPIKey = ""
  @Published public var gatewayProbe: GatewayProbe?
  @Published public var gatewayBusy = false
  @Published public var gatewayMessage: String?
  private var gatewayLoaded = false
  private let botsSettings: BotsSettings
  private let urlSession: URLSession

  public init(
    machines: [MachineDevice] = MockSettings.machines,
    usage: UsageSummary = MockSettings.usage,
    botsSettings: BotsSettings = BotsSettings(),
    urlSession: URLSession = .shared
  ) {
    self.machines = machines
    self.usage = usage
    self.botsSettings = botsSettings
    self.urlSession = urlSession
  }

  public var onlineCount: Int {
    machines.filter(\.online).count
  }

  public func cyclePermission(_ id: String) {
    guard let index = machines.firstIndex(where: { $0.id == id }) else { return }
    machines[index].permission = machines[index].permission.next
  }

  public func setPermission(_ id: String, _ permission: MachinePermission) {
    guard let index = machines.firstIndex(where: { $0.id == id }) else { return }
    machines[index].permission = permission
  }

  public func remove(_ id: String) {
    machines.removeAll { $0.id == id }
  }

  public func beginRename(_ id: String) {
    renameTarget = id
  }

  public func cancelRename() {
    renameTarget = nil
  }

  public func rename(_ id: String, to name: String) {
    defer { renameTarget = nil }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let index = machines.firstIndex(where: { $0.id == id }) else { return }
    machines[index].name = trimmed
  }

  /// Reads the daemon's gateway settings once, when the Bots tab is first opened.
  public func loadGatewayIfNeeded() async {
    guard !gatewayLoaded else { return }
    await loadGateway()
  }

  public func loadGateway() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let settings = try await client().loadGateway()
      gateway = settings
      gatewayLoaded = true
      if gatewayBaseURL.isEmpty { gatewayBaseURL = settings.baseUrl }
      if gatewayModel.isEmpty { gatewayModel = settings.model }
      gatewayMessage = settings.configured ? "已配置" : "尚未配置"
    } catch {
      gatewayMessage = "无法读取 Bots 设置：\(error.localizedDescription)"
    }
  }

  /// Probes the typed values; an empty key field tests the one already stored.
  public func testGateway() async {
    gatewayBusy = true
    gatewayProbe = nil
    defer { gatewayBusy = false }
    do {
      gatewayProbe = try await client().testGateway(
        baseURL: gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
        model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
        apiKey: gatewayAPIKey
      )
    } catch {
      gatewayMessage = error.localizedDescription
    }
  }

  public func saveGateway() async {
    gatewayBusy = true
    defer { gatewayBusy = false }
    do {
      let settings = try await client().saveGateway(
        baseURL: gatewayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
        model: gatewayModel.trimmingCharacters(in: .whitespacesAndNewlines),
        apiKey: gatewayAPIKey
      )
      gateway = settings
      gatewayLoaded = true
      gatewayAPIKey = ""
      gatewayProbe = nil
      gatewayMessage = "已保存，Bot 会使用这个网关"
      NotificationCenter.default.post(name: .botsGatewayChanged, object: nil)
    } catch {
      gatewayMessage = (error as? ClientError)?.message ?? error.localizedDescription
    }
  }

  private func client() throws -> CatalogHTTPClient {
    let token = try TokenStore(root: botsSettings.rootURL).read()
    return CatalogHTTPClient(baseURL: botsSettings.baseURL, token: token, session: urlSession)
  }

  public func checkForUpdates() {
    updateState = .checking
    updateState = .current("0.14.1")
  }
}

/// Rows of the account popover and the plan summary it shows.
public final class AccountMenuViewModel: ObservableObject {
  @Published public var planName: String
  @Published public var percentUsed: Int
  @Published public var userName: String

  public init(
    planName: String = "Pro",
    percentUsed: Int = 73,
    userName: String = "Zheng Li"
  ) {
    self.planName = planName
    self.percentUsed = percentUsed
    self.userName = userName
  }

  public var rows: [AccountMenuRow] {
    [
      AccountMenuRow(
        id: "plan",
        systemName: "gauge.with.dots.needle.33percent",
        title: planName,
        detail: "\(percentUsed)% 已用",
        showsChevron: true,
        kind: .plan
      ),
      AccountMenuRow(id: "mobile", systemName: "iphone", title: "获取移动版 Eagle"),
      AccountMenuRow(
        id: "support", systemName: "book", title: "支持", showsChevron: true),
      AccountMenuRow(id: "settings", systemName: "gearshape", title: "设置"),
      AccountMenuRow(
        id: "add", systemName: "person.badge.plus", title: "添加账户", separatorBefore: true),
      AccountMenuRow(
        id: "signout", systemName: "rectangle.portrait.and.arrow.right", title: "退出登录",
        destructive: true),
    ]
  }
}
