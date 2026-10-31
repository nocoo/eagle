import Foundation

public struct ReplicaBinding: Decodable, Equatable, Sendable {
  public let localBotId: String
  public let sharedBotId: String
  public let replicaId: String
  public let epoch: String
}

public enum ReplicaSyncDirection: String, Sendable {
  case publish, receive, both
}

public struct ReplicaHead: Decodable, Sendable, Equatable, Identifiable {
  public struct Source: Decodable, Sendable, Equatable {
    public let replicaId: String
    public let botId: String
    public let conversationId: Int
  }
  public let head: String
  public let parents: [String]
  public let source: Source
  public let ready: Bool
  public let entries: Int
  public let resources: [String]
  public let resourceHead: String?
  public var id: String { head }
}

public struct ReplicaHeadPage: Decodable, Sendable, Equatable {
  public let items: [ReplicaHead]
  public let nextAfter: Int
  public let hasMore: Bool
}

public struct ReplicaHeadDetail: Decodable, Sendable, Equatable {
  public struct Resource: Decodable, Sendable, Equatable, Identifiable {
    public let ref: String
    public let name: String?
    public let kind: String?
    public let sha256: String?
    public var id: String { ref }
  }
  public let head: String
  public let parents: [String]
  public let ready: Bool
  public let resourceHead: String?
  public let resourceFiles: [Resource]
}

public struct ReplicaContext: Decodable, Sendable, Equatable {
  public let contextId: String
  public let seedHead: String
  public let resourceHead: String?
  public let tip: String?
}

public struct ReplicaMerge: Decodable, Sendable, Equatable {
  public let head: String
}

public struct ReplicaOrigin: Codable, Sendable, Equatable, Hashable {
  public let replicaId: String
  public let conversationId: Int
  public let entryId: Int
  public let taskId: Int?
}

public struct ReplicaMergeChoice: Encodable, Sendable {
  public let origin: ReplicaOrigin
  public let head: String

  public init(origin: ReplicaOrigin, head: String) {
    self.origin = origin
    self.head = head
  }
}

public struct ReplicaResourceChoice: Encodable, Sendable {
  public let name: String
  public let sha256: String

  public init(name: String, sha256: String) {
    self.name = name
    self.sha256 = sha256
  }
}

public struct ReplicaMergePreview: Decodable, Sendable, Equatable {
  public struct Conflict: Decodable, Sendable, Equatable, Identifiable {
    public struct Option: Decodable, Sendable, Equatable, Identifiable {
      public let head: String
      public let action: String
      public let messageCount: Int
      public let digest: String
      public var id: String { head }
    }
    public let origin: ReplicaOrigin
    public let options: [Option]
    public var id: ReplicaOrigin { origin }
  }
  public struct Resource: Decodable, Sendable, Equatable, Identifiable {
    public struct Version: Decodable, Sendable, Equatable, Identifiable {
      public let sha256: String
      public let kind: String
      public let heads: [String]
      public var id: String { sha256 }
    }
    public let name: String
    public let versions: [Version]
    public var id: String { name }
  }
  public let conflicts: [Conflict]
  public let resources: [Resource]
}

public protocol ReplicaPort: AnyObject, Sendable {
  func loadReplicaBinding(botId: String) async throws -> ReplicaBinding
  func bindReplica(botId: String, sharedBotId: String) async throws -> ReplicaBinding
  func configureSync(botId: String, peerDeviceId: String, direction: ReplicaSyncDirection?)
    async throws
  func loadHeads(botId: String, after: Int) async throws -> ReplicaHeadPage
  func loadHead(botId: String, head: String) async throws -> ReplicaHeadDetail
  func createContext(botId: String, contextId: String, head: String, resourceHead: String?)
    async throws -> ReplicaContext
  func loadContext(botId: String, contextId: String) async throws -> ReplicaContext
  func previewMerge(botId: String, heads: [String]) async throws -> ReplicaMergePreview
  func mergeHeads(
    botId: String, heads: [String], requestId: String, choices: [ReplicaMergeChoice],
    resources: [ReplicaResourceChoice]
  ) async throws -> ReplicaMerge
}
