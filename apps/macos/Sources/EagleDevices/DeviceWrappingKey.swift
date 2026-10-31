import CryptoKit
import Foundation

/// One helper-owned wrapping key; pages and plaintext data keys never enter this vault.
public struct DeviceWrappingKey: Sendable {
  private let key: Curve25519.KeyAgreement.PrivateKey
  private let deviceId: String
  private let edPublicKey: String
  private let registryOrigin: String
  func requireOwner(_ identity: DeviceIdentity, serviceOrigin: String) throws {
    guard identity.deviceId == deviceId, identity.publicKey == edPublicKey,
      serviceOrigin == registryOrigin
    else {
      throw DeviceIdentityError.invalidPayload
    }
  }
  public var publicKey: String { key.publicKey.rawRepresentation.base64URL }
  public var keyId: String {
    SHA256.hash(data: key.publicKey.rawRepresentation).map { String(format: "%02x", $0) }.joined()
  }
  func open(_ envelope: DeviceKeyEnvelope) throws -> Data {
    try envelope.open(privateKey: key)
  }
  private struct Record: Codable {
    let version: Int
    let profile: String
    let registryOrigin: String
    let deviceId: String
    let publicKey: String
    let privateKey: Data
  }
  private static func decode(
    _ data: Data, profile: String, serviceOrigin: String, identity: DeviceIdentity
  ) throws -> Self {
    do {
      let raw = try JSONDecoder().decode(DeviceJSON.self, from: data)
      guard case .object(let fields) = raw,
        Set(fields.keys)
          == Set(["version", "profile", "registryOrigin", "deviceId", "publicKey", "privateKey"])
      else { throw DeviceIdentityError.corruptIdentity }
      let record = try JSONDecoder().decode(Record.self, from: data)
      guard record.version == 1, record.profile == profile, record.registryOrigin == serviceOrigin,
        record.deviceId == identity.deviceId, record.publicKey == identity.publicKey
      else { throw DeviceIdentityError.corruptIdentity }
      return Self(
        key: try .init(rawRepresentation: record.privateKey), deviceId: record.deviceId,
        edPublicKey: record.publicKey, registryOrigin: record.registryOrigin)
    } catch { throw DeviceIdentityError.corruptIdentity }
  }
  public static func loadExisting(
    profile: String, serviceOrigin: String, identity: DeviceIdentity, vault: any DeviceIdentityVault
  ) throws -> Self {
    guard let data = try vault.read(account: "eagle-bots-wrap-v1:" + profile) else {
      throw DeviceIdentityError.storageUnavailable
    }
    return try decode(data, profile: profile, serviceOrigin: serviceOrigin, identity: identity)
  }
  public static func loadOrCreate(
    profile: String, serviceOrigin: String, identity: DeviceIdentity, vault: any DeviceIdentityVault
  ) throws -> Self {
    let account = "eagle-bots-wrap-v1:" + profile
    if let data = try vault.read(account: account) {
      return try decode(data, profile: profile, serviceOrigin: serviceOrigin, identity: identity)
    }
    let key = Curve25519.KeyAgreement.PrivateKey()
    let data = try JSONEncoder().encode(
      Record(
        version: 1, profile: profile, registryOrigin: serviceOrigin, deviceId: identity.deviceId,
        publicKey: identity.publicKey, privateKey: key.rawRepresentation))
    if try vault.insert(data, account: account) {
      return Self(
        key: key, deviceId: identity.deviceId, edPublicKey: identity.publicKey,
        registryOrigin: serviceOrigin)
    }
    guard let winner = try vault.read(account: account) else {
      throw DeviceIdentityError.corruptIdentity
    }
    return try decode(winner, profile: profile, serviceOrigin: serviceOrigin, identity: identity)
  }
}
