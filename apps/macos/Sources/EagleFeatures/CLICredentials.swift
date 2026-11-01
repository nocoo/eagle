import BotsCore
import BotsTransport
import Foundation

/// One named CLI credential as the daemon reports it (docs/bots/PROTOCOL.md "CLI clients
/// and scopes"). The secret is never part of this: it is shown once, when it is issued.
public struct CLIClient: Identifiable, Decodable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let scopes: [String]
  public let createdAt: String
  public let lastUsedAt: String?
  public let revokedAt: String?

  public var isRevoked: Bool { revokedAt != nil }

  public var scopeLabel: String { scopes.joined(separator: " · ") }

  public var statusLabel: String { isRevoked ? "已撤销" : "有效" }
}

/// The `/v1/clients` surface, owner-scoped: a 401 fails closed, and nothing here retries.
public final class CLICredentialsClient: @unchecked Sendable {
  private let baseURL: URL
  private let token: String
  private let session: URLSession

  public init(baseURL: URL, token: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  public func list() async throws -> [CLIClient] {
    struct Payload: Decodable { let clients: [CLIClient] }
    return try await send(as: Payload.self, path: "v1/clients").clients
  }

  /// Issues a credential; the token in the answer exists only in this one response.
  public func issue(name: String, scopes: [String]) async throws -> (CLIClient, String) {
    struct Payload: Decodable {
      let client: CLIClient
      let token: String
    }
    let payload = try await send(
      as: Payload.self,
      method: "POST",
      path: "v1/clients",
      body: ["name": name, "scopes": scopes])
    return (payload.client, payload.token)
  }

  public func revoke(_ id: String) async throws -> CLIClient {
    struct Payload: Decodable { let client: CLIClient }
    return try await send(
      as: Payload.self, method: "POST", path: "v1/clients/\(id)/revoke"
    ).client
  }

  /// Only a revoked record may be deleted; the daemon answers `409 client_active` otherwise.
  public func delete(_ id: String) async throws {
    _ = try await sendRaw(method: "DELETE", path: "v1/clients/\(id)")
  }

  private func send<Value: Decodable>(
    as type: Value.Type,
    method: String = "GET",
    path: String,
    body: [String: Any]? = nil
  ) async throws -> Value {
    let data = try await sendRaw(method: method, path: path, body: body)
    do {
      return try JSONDecoder().decode(Value.self, from: data)
    } catch {
      throw ClientError("the daemon answered something this version does not understand")
    }
  }

  @discardableResult
  private func sendRaw(
    method: String,
    path: String,
    body: [String: Any]? = nil
  ) async throws -> Data {
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.timeoutInterval = 10
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw ClientError("the Bots daemon is not answering: \(error.localizedDescription)")
    }
    guard let http = response as? HTTPURLResponse else {
      throw ClientError("the Bots daemon did not answer HTTP")
    }
    guard (200..<300).contains(http.statusCode) else {
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      let error = object?["error"] as? [String: Any]
      let message = error?["message"] as? String ?? "HTTP \(http.statusCode)"
      throw ClientError(message)
    }
    return data
  }
}
