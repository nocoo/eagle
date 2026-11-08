import AppKit
import Darwin
import Foundation

/// One running copy per build. The released App and a source run take separate locks, so each
/// may run once beside the other, and a second launch of either focuses what is already running
/// instead of starting a second service against the same root.
public struct AppInstanceLock {
  /// Which build this is. It is also the lock's name: the two never share one file.
  public enum Surface: String, Sendable {
    case release
    case development
  }

  public let url: URL
  private var descriptor: Int32?

  /// The same rule the rest of the shell uses: a bundle is the shipped App, anything else is a
  /// source run.
  public static var current: Surface {
    Bundle.main.bundleURL.pathExtension == "app" ? .release : .development
  }

  public static func defaultDirectory(
    home: URL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
  ) -> URL {
    home.appendingPathComponent("Library/Application Support/ai.hexly.eagle", isDirectory: true)
  }

  public init(
    surface: Surface, directory: URL = AppInstanceLock.defaultDirectory()
  ) {
    url = directory.appendingPathComponent("instance-\(surface.rawValue).lock")
  }

  /// True when this process owns the build. The descriptor stays open for the life of the
  /// process: quitting, or closing it, is what releases the lock. A path that cannot be opened
  /// or locked is treated as "another copy is running", never as permission to start.
  public mutating func acquire() -> Bool {
    if descriptor != nil { return true }
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let opened = url.path.withCString { open($0, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600) }
    guard opened >= 0 else { return false }
    guard flock(opened, LOCK_EX | LOCK_NB) == 0 else {
      close(opened)
      return false
    }
    descriptor = opened
    return true
  }

  /// Brings the copy that holds the lock forward. Best effort: the other process may be starting
  /// or already gone, and the lock, not this call, is what decided to exit.
  @MainActor
  public static func focusRunningInstance(_ surface: Surface) {
    let selfPID = ProcessInfo.processInfo.processIdentifier
    let others = NSWorkspace.shared.runningApplications.filter {
      $0.processIdentifier != selfPID && !$0.isTerminated && $0.activationPolicy == .regular
    }
    let match: NSRunningApplication?
    switch surface {
    case .release:
      match =
        others.first { $0.bundleIdentifier == "ai.hexly.eagle.macos" }
        ?? others.first { $0.localizedName == "Eagle for Mac" }
    case .development:
      match = others.first { $0.localizedName == "Eagle Dev" }
    }
    guard let match else { return }
    NSApp.activate(ignoringOtherApps: false)
    match.activate(options: [.activateAllWindows])
  }
}
