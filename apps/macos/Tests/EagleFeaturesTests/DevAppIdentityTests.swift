import AppKit
import Testing

@testable import EagleFeatures

@Suite("Development app identity")
@MainActor
struct DevAppIdentityTests {
  @Test("a source run is renamed and an installed bundle is not")
  func when() {
    #expect(DevAppIdentity.shouldRename(bundleIdentifier: nil))
    #expect(
      !DevAppIdentity.shouldRename(bundleIdentifier: "ai.hexly.eagle.macos"),
      "an installed App keeps the name in its Info.plist")
  }

  @Test("only the items that are the app's own name change")
  func titles() {
    #expect(DevAppIdentity.renamed("Eagle") == "Eagle Dev")
    #expect(DevAppIdentity.renamed("关于 Eagle") == "关于 Eagle Dev")
    #expect(DevAppIdentity.renamed("About Eagle") == "关于 Eagle Dev")
    #expect(DevAppIdentity.renamed("隐藏 Eagle") == "隐藏 Eagle Dev")
    #expect(DevAppIdentity.renamed("退出 Eagle") == "退出 Eagle Dev")
    #expect(DevAppIdentity.renamed("隐藏其他") == "隐藏其他")
    #expect(
      DevAppIdentity.renamed("Eagle for Mac") == "Eagle for Mac",
      "a window title is not the app name")
  }

  @Test("the built menu is rewritten in place and About is given our own panel")
  func menu() {
    let app = NSMenu()
    let appItem = NSMenuItem(title: "Eagle", action: nil, keyEquivalent: "")
    let submenu = NSMenu()
    let about = NSMenuItem(
      title: "关于 Eagle", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: "")
    submenu.addItem(about)
    submenu.addItem(NSMenuItem(title: "隐藏 Eagle", action: nil, keyEquivalent: ""))
    submenu.addItem(NSMenuItem(title: "退出 Eagle", action: nil, keyEquivalent: ""))
    appItem.submenu = submenu
    app.addItem(appItem)
    let windowMenu = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
    windowMenu.submenu = NSMenu(title: "窗口")
    windowMenu.submenu?.addItem(NSMenuItem(title: "Eagle", action: nil, keyEquivalent: ""))
    app.addItem(windowMenu)

    DevAppIdentity.apply(to: app, version: "0.16.0")

    #expect(app.items.first?.title == "Eagle Dev")
    #expect(
      app.items.first?.submenu?.items.map(\.title) == [
        "关于 Eagle Dev", "隐藏 Eagle Dev", "退出 Eagle Dev",
      ])
    #expect(
      windowMenu.submenu?.items.map(\.title) == ["Eagle Dev"],
      "every menu that names the app is covered")
    #expect(about.action == #selector(AboutPanel.show(_:)))
    #expect(about.target != nil)
    #expect(about.representedObject as? String == "0.16.0")
  }
}
