import BotsCore
import BotsFeatures
import BotsTransport
import Foundation
import Testing

@testable import EagleFeatures

/// The window against a **real** daemon: a schedule fires on its own, a delivery arrives,
/// the sidebar shows both triggers with a one-click switch, and the switch changes the
/// daemon's state. Skipped unless `BOTS_LIVE_ROOT` and `BOTS_LIVE_PORT` point at a running
/// daemon whose first bot already owns a schedule and a webhook trigger.
///
///     BOTS_LIVE_ROOT=/tmp/live-mac BOTS_LIVE_PORT=45001 \
///       DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
///       swift test --filter LiveDaemon
@MainActor
@Suite(
  "Bots against a live daemon",
  .serialized,
  .enabled(
    if: ProcessInfo.processInfo.environment["BOTS_LIVE_ROOT"] != nil
      && ProcessInfo.processInfo.environment["BOTS_LIVE_PORT"] != nil)
)
struct LiveDaemonTests {
  private var settings: BotsSettings {
    let environment = ProcessInfo.processInfo.environment
    return BotsSettings(
      environment: [
        "BOTS_ROOT": environment["BOTS_LIVE_ROOT"] ?? "",
        "BOTS_PORT": environment["BOTS_LIVE_PORT"] ?? "",
      ])
  }

  private func waitUntil(
    timeout: TimeInterval = 120, _ condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    Issue.record("condition not met within \(timeout)s")
  }

  @Test("a trigger is visible, switchable, and both kinds deliver")
  func live() async throws {
    let bots = BotsWorkspaceViewModel(settings: settings)
    await bots.start()
    try await waitUntil { bots.triggerItems.count == 2 }
    #expect(
      !bots.sections.contains { $0.title == "触发器" },
      "triggers belong to the bot's own panel, not the sidebar")

    let schedule = try #require(bots.triggerItems.first { $0.name == "每分钟巡查" })
    let webhook = try #require(bots.triggerItems.first { $0.name == "deploy notify" })
    #expect(schedule.isOn)
    #expect(webhook.isOn)

    // One switch, and the daemon's own event moves the row.
    bots.setTriggerEnabled(webhook.id, false)
    try await waitUntil(timeout: 15) {
      bots.triggerItems.first { $0.name == "deploy notify" }?.isOn == false
    }
    bots.setTriggerEnabled(webhook.id, true)
    try await waitUntil(timeout: 15) {
      bots.triggerItems.first { $0.name == "deploy notify" }?.isOn == true
    }

    // Deliver through the trigger's own endpoint, exactly as a service would.
    let token = try TokenStore(root: settings.rootURL).read()
    let client = TriggerHTTPClient(baseURL: settings.baseURL, token: token)
    let detail = try #require(
      try await client.list(botId: bots.selectedId ?? "").first {
        $0.summary.name == "deploy notify"
      })
    let triggerToken = try #require(detail.token)
    var request = URLRequest(
      url: settings.baseURL.appendingPathComponent(
        "v1/triggers/\(bots.selectedId ?? "")/\(detail.id)"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(triggerToken)", forHTTPHeaderField: "authorization")
    request.setValue("text/plain", forHTTPHeaderField: "content-type")
    request.httpBody = Data("deploy 77aa finished".utf8)
    let (_, response) = try await URLSession.shared.data(for: request)
    #expect((response as? HTTPURLResponse)?.statusCode == 202)

    try await waitUntil {
      bots.transcript.entries.contains { entry in
        if case .user(_, let text, let origin) = entry {
          return origin == "Webhook" && text.contains("deploy 77aa finished")
        }
        return false
      }
    }

    // The schedule fires on its own, with no client involved.
    try await waitUntil(timeout: 150) {
      bots.transcript.entries.contains { entry in
        if case .user(_, _, let origin) = entry { return origin == "定时" }
        return false
      }
    }
  }
}
