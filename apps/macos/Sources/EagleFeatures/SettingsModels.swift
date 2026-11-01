import EagleDesign
import Foundation

public enum MachinePermission: String, CaseIterable, Hashable, Sendable {
  case always = "始终允许"
  case ask = "每次询问"
  case deny = "禁止"

  public var next: MachinePermission {
    let all = MachinePermission.allCases
    let index = all.firstIndex(of: self) ?? 0
    return all[(index + 1) % all.count]
  }
}

public struct MachineDevice: Identifiable, Hashable, Sendable {
  public let id: String
  public var name: String
  public let platform: String
  public let online: Bool
  public let lastOpened: String?
  public var permission: MachinePermission
  public var renamable: Bool

  public init(
    id: String,
    name: String,
    platform: String,
    online: Bool,
    lastOpened: String? = nil,
    permission: MachinePermission = .always,
    renamable: Bool = false
  ) {
    self.id = id
    self.name = name
    self.platform = platform
    self.online = online
    self.lastOpened = lastOpened
    self.permission = permission
    self.renamable = renamable
  }

  public var symbol: String { platform == "iOS" ? "iphone" : "display" }

  public var status: String {
    if online { return "\(platform) · 当前在线" }
    return lastOpened.map { "\(platform) · 上次打开：\($0)" } ?? "\(platform) · 离线"
  }
}

public struct UsageSummary: Hashable, Sendable {
  public var reportsToday: Int
  public var storageMegabytes: Int
  public var apiCallsToday: Int
  public var planName: String
  public var percentUsed: Int

  public init(
    reportsToday: Int,
    storageMegabytes: Int,
    apiCallsToday: Int,
    planName: String,
    percentUsed: Int
  ) {
    self.reportsToday = reportsToday
    self.storageMegabytes = storageMegabytes
    self.apiCallsToday = apiCallsToday
    self.planName = planName
    self.percentUsed = percentUsed
  }
}

public enum UpdateState: Hashable, Sendable {
  case idle
  case checking
  case current(String)
  /// A newer published build exists; the person downloads it from the release page.
  case available(latest: String, release: URL?)
  /// A development build has nothing published to compare with, so it is the newest by
  /// definition: it shows its own version rather than a newer one.
  case development(String)
  /// Nothing to ask: no published version is reachable from this build.
  case unavailable
}

public enum MockSettings {
  public static let machines: [MachineDevice] = [
    MachineDevice(id: "minim4-a01", name: "MiniM4-A01", platform: "电脑", online: true),
    MachineDevice(id: "mbphomelz", name: "MBPWork", platform: "电脑", online: true, renamable: true),
    MachineDevice(id: "minim4-a02", name: "MiniM4-A02", platform: "电脑", online: true),
    MachineDevice(id: "minim4-w01", name: "MiniM4-W01", platform: "电脑", online: true),
    MachineDevice(id: "macstudiolz", name: "Studio", platform: "电脑", online: true),
    MachineDevice(
      id: "iphone", name: "iPhone 17 Pro Max", platform: "iOS", online: false, lastOpened: "1小时前",
      permission: .ask),
  ]

  public static let usage = UsageSummary(
    reportsToday: 17_280,
    storageMegabytes: 412,
    apiCallsToday: 3_120,
    planName: "Pro",
    percentUsed: 73
  )
}
