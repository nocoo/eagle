import Testing

@testable import EagleDesign
@testable import EagleFeatures

@Suite("Settings")
struct SettingsTests {
  @Test("permissions cycle through every option")
  func permissionCycle() {
    let model = SettingsViewModel()
    let start = model.machines[0].permission
    model.cyclePermission(model.machines[0].id)
    #expect(model.machines[0].permission != start)
    for _ in 1..<MachinePermission.allCases.count {
      model.cyclePermission(model.machines[0].id)
    }
    #expect(model.machines[0].permission == start)
  }

  @Test("unknown machines are ignored")
  func unknownMachine() {
    let model = SettingsViewModel()
    let before = model.machines
    model.cyclePermission("nope")
    model.setPermission("nope", .deny)
    model.remove("nope")
    #expect(model.machines == before)
  }

  @Test("renaming trims input and rejects blanks")
  func rename() {
    let model = SettingsViewModel()
    let target = try! #require(model.machines.first { $0.renamable })
    model.beginRename(target.id)
    #expect(model.renameTarget == target.id)

    model.rename(target.id, to: " 书房 Mac ")
    #expect(model.machines.first { $0.id == target.id }?.name == "书房 Mac")
    #expect(model.renameTarget == nil)

    model.rename(target.id, to: "   ")
    #expect(model.machines.first { $0.id == target.id }?.name == "书房 Mac")
  }

  @Test("removing a machine drops exactly one row")
  func remove() {
    let model = SettingsViewModel()
    let before = model.machines.count
    let id = try! #require(model.machines.last?.id)
    model.remove(id)
    #expect(model.machines.count == before - 1)
    #expect(model.machines.contains { $0.id == id } == false)
  }

  @Test("online count follows the mock data")
  func onlineCount() {
    let model = SettingsViewModel()
    #expect(model.onlineCount == model.machines.filter(\.online).count)
    #expect(model.onlineCount > 0)
  }

  @Test("checking for updates settles on the current version")
  func updates() {
    let model = SettingsViewModel()
    model.checkForUpdates()
    #expect(model.updateState == .current("0.14.1"))
  }

  @Test("setPermission writes the chosen option")
  func setPermission() {
    let model = SettingsViewModel()
    let id = try! #require(model.machines.first?.id)
    model.setPermission(id, .deny)
    #expect(model.machines.first { $0.id == id }?.permission == .deny)
  }

  @Test("cancelRename clears the active target")
  func cancelRename() {
    let model = SettingsViewModel()
    let id = try! #require(model.machines.first?.id)
    model.beginRename(id)
    model.cancelRename()
    #expect(model.renameTarget == nil)
  }
}

@Suite("Settings models")
struct SettingsModelTests {
  @Test("permission cycles through every case")
  func permissionNext() {
    var permission = MachinePermission.always
    let seen = Set(
      (0..<MachinePermission.allCases.count).map { _ in
        permission = permission.next
        return permission
      }
    )
    #expect(seen.count == MachinePermission.allCases.count)
  }

  @Test("machine rows expose platform symbols and status copy")
  func machinePresentation() {
    let mac = MachineDevice(id: "m", name: "Mac", platform: "电脑", online: true)
    #expect(mac.symbol == "display")
    #expect(mac.status == "电脑 · 当前在线")

    let phone = MachineDevice(
      id: "p", name: "Phone", platform: "iOS", online: false, lastOpened: "1小时前")
    #expect(phone.symbol == "iphone")
    #expect(phone.status == "iOS · 上次打开：1小时前")

    let offline = MachineDevice(id: "o", name: "Off", platform: "电脑", online: false)
    #expect(offline.status == "电脑 · 离线")
  }

  @Test("mock usage fixtures stay populated")
  func mockUsage() {
    #expect(MockSettings.machines.count >= 2)
    #expect(MockSettings.usage.planName == "Pro")
    #expect(MockSettings.usage.percentUsed > 0)
  }
}

@Suite("Account menu")
struct AccountMenuTests {
  @Test("rows keep the reference order and one separator")
  func rows() {
    let model = AccountMenuViewModel()
    #expect(model.rows.map(\.id) == ["plan", "mobile", "support", "settings", "add", "signout"])
    #expect(model.rows.filter(\.separatorBefore).map(\.id) == ["add"])
    #expect(model.rows.last?.destructive == true)
    #expect(model.rows.first?.detail == "73% 已用")
    #expect(model.rows.first?.showsChevron == true)
  }
}
