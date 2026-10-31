import CryptoKit
import Foundation

public enum DeviceIdentityError: String, Error {
  case invalidPayload = "device_identity_invalid_payload"
  case corruptIdentity = "device_identity_corrupt"
  case insecureStorage = "device_identity_storage_insecure"
  case storageUnavailable = "device_identity_storage_unavailable"
}

public protocol DeviceIdentityVault: Sendable {
  func read(account: String) throws -> Data?
  func insert(_ data: Data, account: String) throws -> Bool
}

public struct DeviceIdentity: Sendable {
  public let deviceId: String
  private let key: Curve25519.Signing.PrivateKey
  private static let spkiPrefix = Data([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ])
  public var publicKey: String { (Self.spkiPrefix + key.publicKey.rawRepresentation).base64URL }
  private struct Record: Codable {
    let deviceId: String
    let privateKey: Data
  }

  public static func loadOrCreate(
    profile: String, vault: any DeviceIdentityVault = DeviceFileVault()
  ) throws -> Self {
    if let data = try vault.read(account: profile) { return try decode(data) }
    let key = Curve25519.Signing.PrivateKey()
    let identity = Self(deviceId: UUID().uuidString.lowercased(), key: key)
    let data = try JSONEncoder().encode(
      Record(deviceId: identity.deviceId, privateKey: key.rawRepresentation))
    if try vault.insert(data, account: profile) { return identity }
    guard let stored = try vault.read(account: profile) else {
      throw DeviceIdentityError.corruptIdentity
    }
    return try decode(stored)
  }
  private static func decode(_ data: Data) throws -> Self {
    do {
      let record = try JSONDecoder().decode(Record.self, from: data)
      guard UUID(uuidString: record.deviceId) != nil else {
        throw DeviceIdentityError.corruptIdentity
      }
      return Self(
        deviceId: record.deviceId.lowercased(), key: try .init(rawRepresentation: record.privateKey)
      )
    } catch {
      throw DeviceIdentityError.corruptIdentity
    }
  }

  public func signRegistration(
    _ payload: String, serviceOrigin: String, now: Int64
  ) throws -> String {
    let fields = payload.components(separatedBy: "\n")
    guard fields.count == 7, fields[0] == "eagle-device-register-v1",
      fields[1] == serviceOrigin, fields[2] == deviceId, fields[3] == publicKey,
      UUID(uuidString: fields[4]) != nil,
      Data(base64URL: fields[5])?.count == 32,
      let expiry = Int64(fields[6]), expiry > now, expiry <= now + 60000
    else { throw DeviceIdentityError.invalidPayload }
    return try key.signature(for: Data(payload.utf8)).base64URL
  }

  public func signSyncProof(
    _ request: SyncProofRequest, serviceOrigin: String, now: Int64
  ) throws -> String {
    let payload = try request.signingPayload(
      serviceOrigin: serviceOrigin, deviceId: deviceId, publicKey: publicKey, now: now)
    return try key.signature(for: Data(payload.utf8)).base64URL
  }

  public func wrappingDescriptor(
    key: DeviceWrappingKey, serviceOrigin: String, credentialVersion: Int64
  ) throws -> DeviceJSON {
    try key.requireOwner(self, serviceOrigin: serviceOrigin)
    guard credentialVersion > 0, credentialVersion <= 9_007_199_254_740_991 else {
      throw DeviceIdentityError.invalidPayload
    }
    var fields: [String: DeviceJSON] = [
      "version": .number(1), "purpose": .string("replica.wrap"),
      "registryOrigin": .string(serviceOrigin), "deviceId": .string(deviceId),
      "publicKey": .string(publicKey), "credentialVersion": .number(Double(credentialVersion)),
      "keyId": .string(key.keyId), "wrappingPublicKey": .string(key.publicKey),
    ]
    let payload = "eagle-bots-wrap-descriptor-v1\n" + (try DeviceJSON.object(fields).canonical())
    fields["signature"] = .string(try self.key.signature(for: Data(payload.utf8)).base64URL)
    return .object(fields)
  }

  func signPageManifest(_ manifest: DevicePageManifest) throws -> DeviceJSON {
    guard case .object(var fields) = manifest.value else {
      throw DeviceIdentityError.invalidPayload
    }
    fields["signature"] = .string(
      try key.signature(for: Data(manifest.signingPayload(identity: self).utf8)).base64URL)
    return .object(fields)
  }
  func signKeyEnvelope(_ envelope: DeviceKeyEnvelope) throws -> DeviceJSON {
    guard case .object(var fields) = envelope.value else {
      throw DeviceIdentityError.invalidPayload
    }
    fields["signature"] = .string(
      try key.signature(for: Data(envelope.signingPayload(identity: self).utf8)).base64URL)
    return .object(fields)
  }

  /// Called only after the trusted App confirms this exact immutable request.
  public func approve(_ request: DeviceApprovalRequest, now: Int64) throws -> DeviceApproval {
    try request.validate(sourceDeviceId: deviceId, now: now)
    let signature = try key.signature(for: Data(request.signingPayload.utf8)).base64URL
    return DeviceApproval(request: request, signature: signature)
  }
}

public struct DeviceApprovalRequest: Codable, Equatable, Sendable, Identifiable {
  public let requestId: String
  public let operationId: String
  public let sourceDeviceId: String
  public let targetDeviceId: String
  public let operation: DeviceJSON
  public let digest: String
  public let policyVersion: Int
  public let expiresAt: Int64
  private enum CodingKeys: String, CodingKey {
    case requestId, operationId, sourceDeviceId, targetDeviceId, operation, digest, policyVersion,
      expiresAt
  }
  public init(from decoder: any Decoder) throws {
    let fields = try decoder.container(keyedBy: CodingKeys.self)
    requestId = try fields.decode(String.self, forKey: .requestId).lowercased()
    operationId = try fields.decode(String.self, forKey: .operationId).lowercased()
    sourceDeviceId = try fields.decode(String.self, forKey: .sourceDeviceId).lowercased()
    targetDeviceId = try fields.decode(String.self, forKey: .targetDeviceId).lowercased()
    operation = try fields.decode(DeviceJSON.self, forKey: .operation)
    digest = try fields.decode(String.self, forKey: .digest)
    policyVersion = try fields.decode(Int.self, forKey: .policyVersion)
    expiresAt = try fields.decode(Int64.self, forKey: .expiresAt)
  }
  public var id: String { requestId }
  public var signingPayload: String {
    [
      "eagle-device-approval-v1", operationId, sourceDeviceId, targetDeviceId,
      digest, String(policyVersion), String(expiresAt),
    ].joined(separator: "\n")
  }
  public func validate(sourceDeviceId: String, now: Int64) throws {
    guard self.sourceDeviceId == sourceDeviceId, UUID(uuidString: requestId) != nil,
      UUID(uuidString: operationId) != nil, UUID(uuidString: targetDeviceId) != nil,
      policyVersion > 0, expiresAt > now, expiresAt <= now + 300000,
      ["native", "command", "file.read", "file.write", "file.list"].contains(
        operation["kind"]?.string ?? ""),
      try Self.digest(operation) == digest
    else { throw DeviceIdentityError.invalidPayload }
    try Self.validateOperation(operation)
  }
  private static func validateOperation(_ operation: DeviceJSON) throws {
    guard case .object(let fields) = operation, let kind = fields["kind"]?.string,
      try operation.canonical().utf8.count <= 524288
    else { throw DeviceIdentityError.invalidPayload }
    let allowed: Set<String>
    var valid = true
    func text(_ key: String, maximum: Int, empty: Bool = false) -> Bool {
      guard let value = fields[key]?.string else { return false }
      return (empty || !value.isEmpty) && value.utf16.count <= maximum
    }
    switch kind {
    case "command":
      allowed = ["kind", "command", "cwd", "timeoutMs"]
      valid = text("command", maximum: 65536)
      if let timeout = fields["timeoutMs"] {
        valid =
          valid && timeout.number.map { $0 >= 1 && $0 <= 300000 && $0.rounded() == $0 } == true
      }
    case "file.read", "file.list":
      allowed = ["kind", "path"]
      valid = text("path", maximum: 4096)
    case "file.write":
      allowed = ["kind", "path", "content"]
      valid = text("path", maximum: 4096) && text("content", maximum: 262144, empty: true)
    case "native":
      allowed = ["kind", "tool", "args", "cwd"]
      valid = ["read", "write", "edit", "bash", "list"].contains(fields["tool"]?.string ?? "")
      if case .object = fields["args"] {} else { valid = false }
    default: throw DeviceIdentityError.invalidPayload
    }
    if fields["cwd"] != nil { valid = valid && text("cwd", maximum: 4096, empty: true) }
    guard valid, Set(fields.keys).isSubset(of: allowed) else {
      throw DeviceIdentityError.invalidPayload
    }
  }
  public static func digest(_ value: DeviceJSON) throws -> String {
    SHA256.hash(data: Data(try value.canonical().utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

public struct DeviceApproval: Codable, Sendable {
  public let operationId: String
  public let sourceDeviceId: String
  public let targetDeviceId: String
  public let digest: String
  public let policyVersion: Int
  public let expiresAt: Int64
  public let signature: String
  init(request: DeviceApprovalRequest, signature: String) {
    operationId = request.operationId
    sourceDeviceId = request.sourceDeviceId
    targetDeviceId = request.targetDeviceId
    digest = request.digest
    policyVersion = request.policyVersion
    expiresAt = request.expiresAt
    self.signature = signature
  }
}

extension Data {
  public var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  public init?(base64URL: String) {
    guard
      base64URL.unicodeScalars.allSatisfy({
        CharacterSet(
          charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        ).contains($0)
      })
    else { return nil }
    let value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    self.init(base64Encoded: value + String(repeating: "=", count: (4 - value.count % 4) % 4))
  }
}
