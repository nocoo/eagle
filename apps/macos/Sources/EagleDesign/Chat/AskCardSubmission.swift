import Combine

public struct AskCardFailure: Error, Sendable {
  public let message: String

  public init(_ message: String) { self.message = message }
}

@MainActor
public final class AskCardSubmission: ObservableObject {
  @Published public private(set) var pending = false
  @Published public private(set) var confirmed = false
  @Published public private(set) var failure: String?

  public init() {}

  public func submit(_ action: () async -> Result<Void, AskCardFailure>) async {
    guard !pending, !confirmed else { return }
    pending = true
    failure = nil
    defer { pending = false }
    switch await action() {
    case .success: confirmed = true
    case .failure(let error): failure = error.message
    }
  }
}
