import Combine
import Foundation
import SuperagentCore

@MainActor
public final class SuperagentChatViewModel: ObservableObject {
  @Published public var draft = ""
  @Published public private(set) var state = ChatState()
  @Published public private(set) var error: String?
  public init() {}
}
