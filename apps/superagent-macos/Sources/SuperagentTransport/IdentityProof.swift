import CryptoKit
import Darwin
import Foundation
import SuperagentCore

public enum IdentityProof {
  public static func rootBinding(_ root: URL) throws -> String {
    guard let canonical = root.path.withCString({ realpath($0, nil) }) else {
      throw SuperagentError.identity
    }
    defer { free(canonical) }
    return SHA256.hash(data: Data(String(cString: canonical).utf8))
      .map { String(format: "%02x", $0) }.joined()
  }
  public static func server(
    token: String, clientNonce: String, serverNonce: String, endpoint: String, rootBinding: String,
    instance: String
  ) -> String {
    sign(token, [clientNonce, serverNonce, endpoint, rootBinding, instance])
  }
  public static func health(
    token: String, clientNonce: String, endpoint: String, rootBinding: String, instance: String
  ) -> String {
    sign(token, [clientNonce, endpoint, rootBinding, instance])
  }
  public static func client(
    token: String, clientNonce: String, serverNonce: String, instance: String
  ) -> String {
    sign(token, ["client", clientNonce, serverNonce, instance])
  }
  public static func nonce() -> String {
    UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  }
  public static func validHex(_ value: String, length: Int) -> Bool {
    value.utf8.count == length
      && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  private static func sign(_ token: String, _ fields: [String]) -> String {
    HMAC<SHA256>.authenticationCode(
      for: Data(fields.joined(separator: "\n").utf8), using: SymmetricKey(data: Data(token.utf8))
    )
    .map { String(format: "%02x", $0) }.joined()
  }
}
