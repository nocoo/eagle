import AppKit

/// A `swift run` build has no `Info.plist`, so AppKit names the app after the executable file
/// — "Eagle". The development app is **Eagle Dev**, which keeps it apart from an installed
/// release in the menu bar and in the About panel. A bundled App keeps its `CFBundleName`;
/// nothing here touches it.
///
/// `setprogname` does not move `ProcessInfo.processName` on macOS (measured), so the visible
/// name is set where AppKit reads it: the menu items it already built, and the About panel,
/// which is given the name explicitly instead of deriving one from a bundle that is not there.
@MainActor
public enum DevAppIdentity {
  public static let name = "Eagle Dev"

  /// The product's own name: a source run is **Eagle Dev**, so the window title and the
  /// About card agree with the menu; a bundled App keeps the name its Info.plist carries.
  public static let productName = "Eagle for Mac"

  /// Only a source run needs the rename: a bundle carries `CFBundleName` already.
  public static func shouldRename(bundleIdentifier: String?) -> Bool {
    bundleIdentifier == nil
  }

  /// What the window title and the About card say for this build.
  public static func displayName(bundleIdentifier: String?) -> String {
    shouldRename(bundleIdentifier: bundleIdentifier) ? name : productName
  }

  /// The same answer for the running build.
  public static var currentDisplayName: String {
    displayName(bundleIdentifier: Bundle.main.bundleIdentifier)
  }

  /// Exact matches only: a window title or a submenu that merely contains "Eagle" is not the
  /// app's own name.
  public static func renamed(_ title: String) -> String {
    switch title {
    case "Eagle": return name
    case "关于 Eagle", "About Eagle": return "关于 \(name)"
    case "隐藏 Eagle", "Hide Eagle": return "隐藏 \(name)"
    case "退出 Eagle", "Quit Eagle": return "退出 \(name)"
    default: return title
    }
  }

  /// AppKit has already built the menu by the time the delegate runs, so the items are
  /// rewritten in place, and the standard About item is pointed at our own panel.
  public static func apply(to menu: NSMenu?, version: String) {
    guard let menu else { return }
    for item in menu.items {
      item.title = renamed(item.title)
      if item.action == #selector(NSApplication.orderFrontStandardAboutPanel(_:)) {
        item.target = AboutPanel.target
        item.action = #selector(AboutPanel.show(_:))
        item.representedObject = version
      }
      apply(to: item.submenu, version: version)
    }
  }
}

/// The one About panel a source run shows: same panel, with the development name.
@MainActor
final class AboutPanel: NSObject {
  static let target = AboutPanel()

  @objc func show(_ sender: Any?) {
    let version = (sender as? NSMenuItem)?.representedObject as? String ?? ""
    NSApp.orderFrontStandardAboutPanel(options: [
      .applicationName: DevAppIdentity.name,
      .applicationVersion: version,
    ])
  }
}
