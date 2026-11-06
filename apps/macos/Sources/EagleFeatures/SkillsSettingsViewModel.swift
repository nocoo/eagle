import BotsCore
import BotsTransport
import Combine
import Foundation

/// One scan root as the page shows it: where it is, whether it can go away, and what the last
/// scan made of it.
public struct SkillRootRow: Identifiable, Hashable, Sendable {
  public let id: String
  public let url: URL
  public let displayPath: String
  /// The automatic root is always there; only the folders a person added can be removed.
  public let removable: Bool
  public let status: SkillRootStatus

  public init(
    id: String, url: URL, displayPath: String, removable: Bool, status: SkillRootStatus
  ) {
    self.id = id
    self.url = url
    self.displayPath = displayPath
    self.removable = removable
    self.status = status
  }

  /// The line under the path: how many skills the root holds, or why it holds none.
  public var detail: String {
    switch status {
    case .pending: return "还没有扫描"
    case .scanned(let count): return "\(count) 个技能"
    case .missing: return "找不到这个文件夹"
    case .unreadable(let reason): return reason
    }
  }
}

/// The 技能 page's state.
///
/// The page scans folders and shows what it found. The ticks themselves, and the one queue
/// that sends them, belong to the App-scoped `SkillsSelection`: a page is a view of the
/// selection, so closing and reopening one neither forgets a tick nor starts a second queue.
/// A failed push changes nothing locally: the tick stays, the page says what the daemon
/// answered, and the next change or page visit sends it again.
@MainActor
public final class SkillsSettingsViewModel: ObservableObject {
  /// What the list shows: everything, only the ticked skills, or only the untouched ones.
  public enum Filter: String, CaseIterable, Sendable {
    case all = "全部"
    case selected = "已勾选"
    case unselected = "未勾选"
  }

  public static let customRootsKey = "eagle.skills.customRoots"
  /// The folder every machine keeps its skills in; it is scanned without being asked.
  public static let automaticRootPath = ".agents/skills"

  /// The skills the last scan found.
  @Published public private(set) var skills: [SkillEntry] = []
  /// What the last scan made of each root.
  @Published public private(set) var rootStatuses: [String: SkillRootStatus] = [:]
  /// The keyword the list is filtered by.
  @Published public var keyword = ""
  /// Which skills the list shows.
  @Published public var filter: Filter = .all
  /// A scan is running; the page says so instead of pretending the list is current.
  @Published public private(set) var scanning = false

  private let defaults: UserDefaults
  private let home: URL
  /// How the folders are read. The scan runs off the main actor; the tests hand in their own
  /// so the order of two scans can be pinned down.
  private let scan: @Sendable ([URL]) async -> SkillScanResult
  /// What this machine ticked and the one queue that sends it: shared by every settings view.
  private let selection: SkillsSelection
  /// The selection publishes on its own; the page carries those changes to the window.
  private var selectionObserver: AnyCancellable?
  /// Every reload is a request of its own, and only the newest one may answer the page.
  private var requestCounter = 0
  private var newestRequest = 0
  private var runningScans = 0

  public init(
    defaults: UserDefaults = .standard,
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    scan: @escaping @Sendable ([URL]) async -> SkillScanResult = { SkillScanner.scan(roots: $0) },
    selection: SkillsSelection = .shared
  ) {
    self.defaults = defaults
    self.home = home
    self.scan = scan
    self.selection = selection
    selectionObserver = selection.objectWillChange.sink { [weak self] _ in
      self?.objectWillChange.send()
    }
  }

  /// The paths of the ticked skills, as this machine remembers them.
  public var selectedPaths: Set<String> { selection.selectedPaths }

  /// The last push's refusal, in the daemon's own words; nil once a push succeeds.
  public var pushNote: String? { selection.pushNote }

  /// The folder that is always scanned.
  public var automaticRoot: URL {
    home.appendingPathComponent(Self.automaticRootPath, isDirectory: true)
  }

  /// The folders a person added, in the order they were added.
  public var customRoots: [URL] {
    (defaults.stringArray(forKey: Self.customRootsKey) ?? []).map {
      URL(fileURLWithPath: $0, isDirectory: true)
    }
  }

  /// Every scanned folder: the automatic one first, then the person's own.
  public var scanRoots: [URL] {
    [automaticRoot] + customRoots
  }

  /// The roots as the page lists them.
  public var rootRows: [SkillRootRow] {
    scanRoots.enumerated().map { index, root in
      let path = root.standardizedFileURL.path
      return SkillRootRow(
        id: path,
        url: root,
        displayPath: displayPath(root),
        removable: index > 0,
        status: rootStatuses[path] ?? .pending
      )
    }
  }

  /// A path as a person reads it: the home folder is a `~`.
  public func displayPath(_ url: URL) -> String {
    let path = url.standardizedFileURL.path
    let homePath = home.standardizedFileURL.path
    if path == homePath { return "~" }
    if path.hasPrefix(homePath + "/") { return "~" + String(path.dropFirst(homePath.count)) }
    return path
  }

  /// Adds the folders a person chose. The automatic root is never added twice, and a folder
  /// that is already scanned is kept once.
  public func addRoots(_ urls: [URL]) async {
    var paths = customRoots.map { $0.standardizedFileURL.path }
    let automatic = automaticRoot.standardizedFileURL.path
    for url in urls {
      let path = url.standardizedFileURL.path
      guard path != automatic, !paths.contains(path) else { continue }
      paths.append(path)
    }
    defaults.set(paths, forKey: Self.customRootsKey)
    await reload()
  }

  /// Takes a folder away again. The automatic root stays: it is not the person's to remove.
  public func removeRoot(_ url: URL) async {
    let path = url.standardizedFileURL.path
    let paths = customRoots.map { $0.standardizedFileURL.path }.filter { $0 != path }
    defaults.set(paths, forKey: Self.customRootsKey)
    await reload()
  }

  /// Reads every root again. The selection is kept: a rescan does not forget what was ticked.
  ///
  /// Every call is a request of its own. Only the newest request answers the page: a request
  /// that a newer one has superseded leaves the page alone, and it does not scan again —
  /// the newer request already reads the scope that is stored now.
  public func reload() async {
    requestCounter += 1
    let request = requestCounter
    newestRequest = request
    // The shared selection decides which scan is the newest across every window: this one
    // must not teach the machine an older list after another page already did.
    let generation = selection.beginScan()
    runningScans += 1
    scanning = true
    defer {
      runningScans -= 1
      scanning = runningScans > 0
    }
    let roots = scanRoots
    let scanner = scan
    let result = await Task.detached(priority: .userInitiated) {
      await scanner(roots)
    }.value
    guard request == newestRequest else { return }
    skills = result.skills
    rootStatuses = Dictionary(
      result.roots.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
    // A push names the version, description and path this scan found, so the selection is
    // told what exists before anything is sent. A newer page's scan makes this one stale, and
    // a stale scan neither teaches the selection nor pushes.
    let learned = selection.learn(
      result.skills.map { skill in
        ScannedSkill(
          id: skill.id,
          entry: SelectedSkill(
            name: skill.name,
            version: skill.version,
            description: skill.description,
            path: displayPath(skill.directory)
          )
        )
      },
      generation: generation)
    guard learned else { return }
    // The scan is also what a page visit sends: the same path is how a failed push is tried
    // again.
    selection.pushSelection()
  }

  /// Whether a skill is ticked.
  public func isSelected(_ skill: SkillEntry) -> Bool {
    selection.isSelected(skill)
  }

  /// Ticks a skill, or unticks it, remembers the choice on this machine and tells the Bot
  /// service at once, through the one queue. The tick is local first: a refused push never
  /// undoes it.
  public func setSelected(_ selected: Bool, for skill: SkillEntry) {
    selection.setSelected(selected, for: skill)
  }

  /// The selected skills as the daemon stores them: a path a person could read, and the
  /// version and description the last scan found.
  public var selectedSkills: [SelectedSkill] { selection.selectedSkills }

  /// Waits for every queued push; a page never needs to, and a test does.
  public func awaitSkillPush() async {
    await selection.awaitPush()
  }

  /// The skills the list shows: the keyword first, then the filter.
  public var visibleSkills: [SkillEntry] {
    let query = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return skills.filter { skill in
      guard matchesKeyword(skill, query) else { return false }
      switch filter {
      case .all: return true
      case .selected: return selectedPaths.contains(skill.id)
      case .unselected: return !selectedPaths.contains(skill.id)
      }
    }
  }

  /// Every skill the last scan found.
  public var totalCount: Int { skills.count }

  /// How many of those skills are ticked.
  public var selectedCount: Int { skills.count { selectedPaths.contains($0.id) } }

  /// How many skills the list shows right now.
  public var visibleCount: Int { visibleSkills.count }

  private func matchesKeyword(_ skill: SkillEntry, _ query: String) -> Bool {
    guard !query.isEmpty else { return true }
    return skill.name.lowercased().contains(query)
      || skill.description.lowercased().contains(query)
      || skill.directory.path.lowercased().contains(query)
  }
}
