import CryptoKit
import Darwin
import Foundation
import Testing

@testable import EagleDevices

@Suite("Persistent sync wrapping identity")
struct DeviceWrappingKeyTests {
  private func fixture() throws -> URL {
    let pointer = try #require(realpath(FileManager.default.temporaryDirectory.path, nil))
    defer { free(pointer) }
    let root = URL(fileURLWithPath: String(cString: pointer)).appendingPathComponent(
      "eagle-wrap-" + UUID().uuidString)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    return root
  }
  private let origin = "http://127.0.0.1:17053"
  private func load(
    _ vault: DeviceFileVault, _ identity: DeviceIdentity
  ) throws -> DeviceWrappingKey {
    try .loadOrCreate(profile: "fixture", serviceOrigin: origin, identity: identity, vault: vault)
  }
  @Test("real vault persists a distinct wrapping key and signs canonical descriptor bytes")
  func persists() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let vault = DeviceFileVault(directory: root.appendingPathComponent("vault"))
    let identity = try DeviceIdentity.loadOrCreate(profile: "fixture", vault: vault)
    let first = try load(vault, identity)
    let reopened = try load(vault, identity)
    #expect(first.keyId == reopened.keyId)
    #expect(first.publicKey == reopened.publicKey)
    #expect(Data(base64URL: first.publicKey)?.count == 32)
    let descriptor = try identity.wrappingDescriptor(
      key: first, serviceOrigin: origin, credentialVersion: 1)
    guard case .object(var fields) = descriptor else {
      Issue.record("descriptor object missing")
      return
    }
    let signature = try #require(fields.removeValue(forKey: "signature")?.string)
    let encoded = try #require(Data(base64URL: identity.publicKey))
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: encoded.suffix(32))
    #expect(
      publicKey.isValidSignature(
        try #require(Data(base64URL: signature)),
        for: Data(
          ("eagle-bots-wrap-descriptor-v1\n" + (try DeviceJSON.object(fields).canonical())).utf8)))
    let renewed = try identity.wrappingDescriptor(
      key: reopened, serviceOrigin: origin, credentialVersion: 2)
    #expect(renewed["keyId"] == descriptor["keyId"])
    #expect(renewed["wrappingPublicKey"] == descriptor["wrappingPublicKey"])
    #expect(renewed["credentialVersion"] == .number(2))
    #expect(renewed["signature"] != descriptor["signature"])
    #expect(
      try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("vault").path)
        .count == 2)
  }
  @Test("opening old key material never creates a missing wrapping identity")
  func missingExisting() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("vault")
    let vault = DeviceFileVault(directory: directory)
    let identity = try DeviceIdentity.loadOrCreate(profile: "fixture", vault: vault)
    #expect(throws: DeviceIdentityError.storageUnavailable) {
      try DeviceWrappingKey.loadExisting(
        profile: "fixture", serviceOrigin: origin, identity: identity, vault: vault)
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).count == 1)
    let created = try load(vault, identity)
    let existing = try DeviceWrappingKey.loadExisting(
      profile: "fixture", serviceOrigin: origin, identity: identity, vault: vault)
    #expect(created.keyId == existing.keyId)
  }
  @Test("concurrent creators reread the same successfully persisted winner")
  func concurrent() async throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let vault = DeviceFileVault(directory: root.appendingPathComponent("vault"))
    let identity = try DeviceIdentity.loadOrCreate(profile: "fixture", vault: vault)
    let keys = try await withThrowingTaskGroup(of: DeviceWrappingKey.self) { group in
      for _ in 0..<24 { group.addTask { try load(vault, identity) } }
      var result: [DeviceWrappingKey] = []
      for try await key in group { result.append(key) }
      return result
    }
    #expect(Set(keys.map(\.publicKey)).count == 1)
    #expect(Set(keys.map(\.keyId)).count == 1)
  }
  @Test("corrupt or insecure wrapping records reject without silently replacing the key")
  func corrupt() throws {
    let root = try fixture()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("vault")
    let vault = DeviceFileVault(directory: directory)
    let identity = try DeviceIdentity.loadOrCreate(profile: "fixture", vault: vault)
    _ = try load(vault, identity)
    let name =
      SHA256.hash(data: Data("eagle-bots-wrap-v1:fixture".utf8)).map { String(format: "%02x", $0) }
      .joined() + ".json"
    let file = directory.appendingPathComponent(name)
    let original = try Data(contentsOf: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
    #expect(throws: DeviceIdentityError.insecureStorage) { try load(vault, identity) }
    #expect(try Data(contentsOf: file) == original)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    try Data("{}".utf8).write(to: file)
    #expect(throws: DeviceIdentityError.corruptIdentity) { try load(vault, identity) }
    #expect(try Data(contentsOf: file) == Data("{}".utf8))
  }
}
