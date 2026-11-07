import Combine
import Foundation
import SuperagentCore

/// The read-only observation surface (SG-002). It owns one summary and one in-flight read:
/// no bot selection, no paging state, no command. A late result never overwrites a newer
/// refresh, and an unavailable provider stays visible as the reason rather than as zero.
@MainActor
public final class SuperagentObservationViewModel: ObservableObject {
  public enum Phase: Equatable, Sendable { case idle, reading, ready, failed }

  @Published public private(set) var phase: Phase = .idle
  @Published public private(set) var summary: ObservationSummary = .unconfigured

  private let port: SuperagentObservationPort
  private var generation = 0

  public init(port: SuperagentObservationPort) {
    self.port = port
  }

  /// True while a read is in flight, so a surface can disable its own refresh control.
  public var isReading: Bool { phase == .reading }

  public func refresh() async {
    generation += 1
    let current = generation
    phase = .reading
    do {
      let next = try await port.observation()
      guard current == generation else { return }
      summary = next
      phase = next.state == .ready ? .ready : .failed
    } catch {
      guard current == generation else { return }
      summary = ObservationSummary(state: .unreachable, reachable: false, detail: "unreachable")
      phase = .failed
    }
  }
}
