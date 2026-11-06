import BotsCore
import BotsTransport
import Combine
import Foundation

/// What one push sends: the whole selection, in the order the page lists it.
public typealias SkillPush = @Sendable ([SelectedSkill]) async throws -> Void

/// One skill a scan found, as a push names it: the tick's identity and what the daemon stores.
struct ScannedSkill: Equatable, Sendable {
  let id: String
  let entry: SelectedSkill
}

/// What this machine ticked, and the one queue that sends it.
///
/// A settings window is a view of the selection, not its owner. The ticks and the queue
/// outlive the window, because two pushes that overlap can land in either order and leave
/// the daemon holding the older selection: reopening the page must not start a second queue.
/// One App-scoped object holds both, and every settings view shares it; the scans stay with
/// the page, which is what a view of the folders is.
@MainActor
public final class SkillsSelection: ObservableObject {
  /// The App's own instance: every settings window reads the same ticks and one queue.
  public static let shared = SkillsSelection()

  public static let selectionKey = "eagle.skills.selection"

  /// The paths of the ticked skills.
  @Published public private(set) var selectedPaths: Set<String> = []
  /// The last push's refusal, in the daemon's own words; nil once a push succeeds.
  @Published public private(set) var pushNote: String?

  private let defaults: UserDefaults
  private let push: SkillPush
  /// The skills the newest scan found, in its order: a push names only these.
  private var scanned: [ScannedSkill] = []
  /// Which scan is the newest. A page takes a number before it scans, and only that scan may
  /// teach this machine what exists, so only it may push.
  private var scanGeneration = 0
  /// The one queue every tick goes through.
  private var pushTask: Task<Void, Never>?

  public init(
    defaults: UserDefaults = .standard,
    push: @escaping SkillPush = SkillsSelection.pushToDaemon
  ) {
    self.defaults = defaults
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

  /// Whether a skill is ticked.
  public func isSelected(_ skill: SkillEntry) -> Bool {
    selectedPaths.contains(skill.id)
  }

  /// A page asks for the next generation before it scans. A scan that was superseded while it
  /// ran must not answer: two pages share one selection, and the list that arrives last is not
  /// the newest one.
  public func beginScan() -> Int {
    scanGeneration += 1
    return scanGeneration
  }

  /// What a scan found, if no newer scan began after it. A skill the scan no longer finds is
  /// not pushed as if it still existed, and a superseded scan teaches nothing.
  @discardableResult
  func learn(_ skills: [ScannedSkill], generation: Int) -> Bool {
    guard generation == scanGeneration else { return false }
    scanned = skills
    return true
  }

  /// The ticked skills as the daemon stores them, in the order the page lists them.
  public var selectedSkills: [SelectedSkill] {
    scanned.filter { selectedPaths.contains($0.id) }.map(\.entry)
  }

  /// Ticks a skill, or unticks it, remembers the choice on this machine and queues the whole
  /// selection. The tick is local first: a refused push never undoes it.
  public func setSelected(_ selected: Bool, for skill: SkillEntry) {
    if selected {
      selectedPaths.insert(skill.id)
    } else {
      selectedPaths.remove(skill.id)
    }
    defaults.set(selectedPaths.sorted(), forKey: Self.selectionKey)
    pushSelection()
  }

  /// Sends the selection once the push before it is done, so two ticks — in one window or in
  /// two — cannot land out of order. A refusal keeps the local selection and stays on the
  /// page until a push works.
  public func pushSelection() {
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
  public func awaitPush() async {
    await pushTask?.value
  }
}
