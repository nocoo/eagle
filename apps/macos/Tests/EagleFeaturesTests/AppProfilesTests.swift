import Foundation
import Testing

@testable import EagleFeatures

/// A development run and the released App own separate services: different roots, ports and
/// client state, so an experiment in one build cannot start, adopt, change or delete anything
/// the other build is using.
@Suite("App profiles")
struct AppProfilesTests {
  @Test("a source run keeps its own daemon, port and client state")
  func developmentProfile() {
    let settings = BotsSettings(
      environment: [:], bundle: URL(fileURLWithPath: "/tmp/Eagle Dev"))
    #expect(settings.rootPath.hasSuffix("eagle-bots-dev"))
    #expect(settings.port == "43119")
    #expect(settings.isIsolated, "its config home and client state live under its own root")
    #expect(settings.clientDirectory.path.hasPrefix(settings.rootPath))
  }

  @Test("the released App keeps the documented root, port and client state")
  func releaseProfile() {
    let settings = BotsSettings(
      environment: ["BOTS_ROOT": "/ignored", "BOTS_PORT": "4000"],
      bundle: URL(fileURLWithPath: "/Applications/Eagle for Mac.app"))
    #expect(settings.rootPath.hasSuffix(".local/share/eagle-bots"))
    #expect(!settings.rootPath.hasSuffix("-dev"))
    #expect(settings.port == "43117")
    #expect(!settings.isIsolated)
    #expect(settings.clientDirectory.lastPathComponent == "ai.hexly.bots")
  }

  @Test("an explicit environment root still names the run's own service")
  func environmentWins() {
    let settings = BotsSettings(
      environment: ["BOTS_ROOT": "/tmp/eagle-bots-test", "BOTS_PORT": "43999"],
      bundle: URL(fileURLWithPath: "/tmp/Eagle Dev"))
    #expect(settings.rootPath == "/tmp/eagle-bots-test")
    #expect(settings.port == "43999")
    #expect(settings.isIsolated)
  }

  @Test("the Super Bot observes the daemon of its own build")
  func observationTargetFollowsTheProfile() {
    let development = BotsSettings(
      environment: [:], bundle: URL(fileURLWithPath: "/tmp/Eagle Dev"))
    let child = SuperagentDaemonSupervisor.childEnvironment(
      [:], release: false, bots: development)
    #expect(child["BOTS_OBSERVATION_ENDPOINT"] == "http://127.0.0.1:43119")
    #expect(
      child["BOTS_OBSERVATION_TOKEN_FILE"]?.hasSuffix("eagle-bots-dev/observation/token") == true)

    let release = BotsSettings(
      environment: [:], bundle: URL(fileURLWithPath: "/Applications/Eagle for Mac.app"))
    let packaged = SuperagentDaemonSupervisor.childEnvironment(
      [:], release: true, bots: release)
    #expect(packaged["BOTS_OBSERVATION_ENDPOINT"] == "http://127.0.0.1:43117")
    #expect(
      packaged["BOTS_OBSERVATION_TOKEN_FILE"]?.hasSuffix("eagle-bots/observation/token") == true)
  }

  @Test("one instance per build, and the two builds never share a lock")
  func instanceLock() {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-instance-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    var release = AppInstanceLock(surface: .release, directory: directory)
    let first = release.acquire()
    #expect(first)
    var second = AppInstanceLock(surface: .release, directory: directory)
    let contended = second.acquire()
    #expect(contended == false, "a second copy of the same build must not start")
    let again = release.acquire()
    #expect(again, "the owner may ask again")
    var development = AppInstanceLock(surface: .development, directory: directory)
    let beside = development.acquire()
    #expect(beside, "the released App runs beside a source run")
  }

  @Test("the Super Bot's local outbox belongs to the build")
  func superagentOutbox() {
    let base = URL(fileURLWithPath: "/tmp/support")
    #expect(
      SuperagentWorkspaceViewModel.pendingInputDirectory(base, release: true)
        .lastPathComponent == "eagle-superagent")
    #expect(
      SuperagentWorkspaceViewModel.pendingInputDirectory(base, release: false)
        .lastPathComponent == "eagle-superagent-dev")
  }
}
