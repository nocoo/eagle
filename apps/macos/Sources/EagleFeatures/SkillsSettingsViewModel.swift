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

/// What one push sends: the whole selection, in the order the page lists it.
public typealias SkillPush = @Sendable ([SelectedSkill]) async throws -> Void

/// The 技能 page's state.
///
/// The page scans folders, remembers what a person ticked and pushes that selection to this
/// machine's Bot service, which is what makes a tick reach a Bot. A failed push changes nothing
/// locally: the tick stays, the page says what the daemon answered, and the next change or page
/// visit sends it again.
@MainActor
public final class SkillsSettingsViewModel: ObservableObject {
  /// What the list shows: everything, only the ticked skills, or only the untouched ones.
  public enum Filter: String, CaseIterable, Sendable {
    case all = "全部"
    case selected = "已勾选"
    case unselected = "未勾选"
  }

  public static let customRootsKey = "eagle.skills.customRoots"
  public static let selectionKey = "eagle.skills.selection"
  /// The folder every machine keeps its skills in; it is scanned without being asked.
  public static let automaticRootPath = ".agents/skills"

  /// The skills the last scan found.
  @Published public private(set) var skills: [SkillEntry] = []
  /// What the last scan made of each root.
  @Published public private(set) var rootStatuses: [String: SkillRootStatus] = [:]
  /// The paths of the ticked skills.
  @Published public private(set) var selectedPaths: Set<String> = []
  /// The keyword the list is filtered by.
  @Published public var keyword = ""
  /// Which skills the list shows.
  @Published public var filter: Filter = .all
  /// A scan is running; the page says so instead of pretending the list is current.
  @Published public private(set) var scanning = false
  /// The last push's refusal, in the daemon's own words; nil once a push succeeds.
  @Published public private(set) var pushNote: String?

  private let defaults: UserDefaults
  private let home: URL
  /// How the folders are read. The scan runs off the main actor; the tests hand in their own
  /// so the order of two scans can be pinned down.
  private let scan: @Sendable ([URL]) async -> SkillScanResult
  /// Every reload is a request of its own, and only the newest one may answer the page.
  private var requestCounter = 0
  private var newestRequest = 0
  private var runningScans = 0
  /// How the selection reaches the Bot service, and the queue that keeps two pushes in order.
  private let push: SkillPush
  private var pushTask: Task<Void, Never>?

  public init(
    defaults: UserDefaults = .standard,
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    scan: @escaping @Sendable ([URL]) async -> SkillScanResult = { SkillScanner.scan(roots: $0) },
    push: @escaping SkillPush = SkillsSettingsViewModel.pushToDaemon
  ) {
    self.defaults = defaults
    self.home = home
    self.scan = scan
    self.push = push
    self.selectedPaths = Set(defaults.stringArray(forKey: Self.selectionKey) ?? [])
  }

  /// The real push: the App's own token and the daemon this machine runs, through the same
  /// client the rest of the settings pages use.
  public static let pushToDaemon: SkillPush = { skills in
    let settings = BotsSettings()
    let token = try TokenStore(root: settings.rootURL).read()
    try await CatalogHTTPClient(baseURL: settings.baseURL, token: token).saveSkills(skills)
  }

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
    // The scan is what knows a ticked skill's version and description now, so it is also what
    // a page visit sends: the same path is how a failed push is tried again.
    pushSelection()
  }

  /// Whether a skill is ticked.
  public func isSelected(_ skill: SkillEntry) -> Bool {
    selectedPaths.contains(skill.id)
  }

  /// Ticks a skill, or unticks it, remembers the choice on this machine and tells the Bot
  /// service at once. The tick is local first: a refused push never undoes it.
  public func setSelected(_ selected: Bool, for skill: SkillEntry) {
    if selected {
      selectedPaths.insert(skill.id)
    } else {
      selectedPaths.remove(skill.id)
    }
    defaults.set(Array(selectedPaths).sorted(), forKey: Self.selectionKey)
    pushSelection()
  }

  /// The selected skills as the daemon stores them: a path a person could read, and the
  /// version and description this scan found.
  public var selectedSkills: [SelectedSkill] {
    skills.filter { selectedPaths.contains($0.id) }.map { skill in
      SelectedSkill(
        name: skill.name,
        version: skill.version,
        description: skill.description,
        path: displayPath(skill.directory)
      )
    }
  }

  /// Sends the selection once the push before it is done, so two quick ticks cannot land out
  /// of order. A refusal keeps the local selection and stays on the page until a push works.
  private func pushSelection() {
    let entries = selectedSkills
    let push = self.push
    let previous = pushTask
    pushTask = Task { [weak self] in
      await previous?.value
      do {
        try await push(entries)
        self?.pushNote = nil
      } catch {
        let message = (error as? ClientError)?.message ?? error.localizedDescription
        self?.pushNote = "技能没有同步到 Bot 服务：\(message)"
      }
    }
  }

  /// Waits for every queued push; a page never needs to, and a test does.
  public func awaitSkillPush() async {
    await pushTask?.value
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
