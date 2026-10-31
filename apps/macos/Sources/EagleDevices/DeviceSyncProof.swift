import CryptoKit
import Foundation

/// The one permitted sync-signing domain; callers never supply signing bytes.
public struct SyncProofRequest: Sendable {
  private let value: DeviceJSON
  public init(_ value: DeviceJSON) throws {
    guard case .object(let fields) = value,
      Set(fields.keys)
        == Set([
          "version", "registryOrigin", "role", "purpose", "sharedBotId", "reader", "server",
          "readerNonce", "serverNonce", "generation", "sessionId", "expiresAt",
          "readerEphemeral", "serverEphemeral",
        ]), value["version"] == .number(1), value["purpose"] == .string("replica.read"),
      ["reader", "server"].contains(value["role"]?.string ?? ""),
      Self.uuid(value["sharedBotId"]),
      Self.peer(value["reader"]), Self.peer(value["server"]),
      value["reader"]?["deviceId"] != value["server"]?["deviceId"],
      value["reader"]?["groupId"] == value["server"]?["groupId"],
      [
        "readerNonce", "serverNonce", "generation", "sessionId", "readerEphemeral",
        "serverEphemeral",
      ]
      .allSatisfy({ Self.bytes32(value[$0]) }),
      let expires = value["expiresAt"]?.number, expires > 0,
      expires <= 9_007_199_254_740_991, expires.rounded() == expires,
      let origin = value["registryOrigin"]?.string, origin.utf8.count <= 2048,
      let url = URLComponents(string: origin), ["http", "https"].contains(url.scheme ?? ""),
      url.host != nil, url.user == nil, url.password == nil, url.query == nil,
      url.fragment == nil, url.path.isEmpty, try value.canonical().utf8.count <= 8192
    else { throw DeviceIdentityError.invalidPayload }
    self.value = value
  }
  public func signingPayload(
    serviceOrigin: String, deviceId: String, publicKey: String, now: Int64
  ) throws -> String {
    guard let role = value["role"]?.string, let expiry = value["expiresAt"]?.number,
      value["registryOrigin"] == .string(serviceOrigin),
      value[role]?["deviceId"] == .string(deviceId),
      value[role]?["publicKey"] == .string(publicKey),
      expiry > Double(now), expiry <= Double(now) + 60000
    else { throw DeviceIdentityError.invalidPayload }
    return "eagle-bots-sync-proof-v1\n" + (try value.canonical())
  }
  private static func uuid(_ value: DeviceJSON?) -> Bool {
    guard let text = value?.string else { return false }
    return UUID(uuidString: text)?.uuidString.lowercased() == text
  }
  private static func bytes32(_ value: DeviceJSON?) -> Bool {
    guard let text = value?.string, let data = Data(base64URL: text) else { return false }
    return data.count == 32 && data.base64URL == text
  }
  private static func peer(_ value: DeviceJSON?) -> Bool {
    guard case .object(let fields) = value,
      Set(fields.keys)
        == Set(["deviceId", "publicKey", "groupId", "membershipEpoch", "credentialVersion"]),
      uuid(value?["deviceId"]), uuid(value?["groupId"]),
      let encoded = value?["publicKey"]?.string, let key = Data(base64URL: encoded),
      key.count == 44, key.base64URL == encoded,
      key.prefix(12)
        == Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
      let epoch = value?["membershipEpoch"]?.number, epoch >= 0, epoch.rounded() == epoch,
      epoch <= 9_007_199_254_740_991,
      let credential = value?["credentialVersion"]?.number, credential >= 1,
      credential.rounded() == credential, credential <= 9_007_199_254_740_991
    else { return false }
    return true
  }
}
