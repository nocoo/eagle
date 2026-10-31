import Foundation
import Testing

@testable import EagleDevices

@Suite("Typed durable page-key wire")
struct DevicePageKeyTests {
  private func vector() throws -> DeviceJSON {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../fixtures/bots-protocol/sync-objects-v1/canonical.json")
      .standardizedFileURL
    return try JSONDecoder().decode(DeviceJSON.self, from: Data(contentsOf: url))
  }

  @Test("CryptoKit signatures verify the exact Node canonical metadata bytes")
  func canonical() throws {
    let v = try vector()
    let manifest = try #require(v["manifest"])
    let descriptor = try #require(v["descriptor"])
    let envelope = try #require(v["envelope"])
    let publisher = try #require(manifest["publisher"])
    let origin = try #require(manifest["registryOrigin"]?.string)
    try PageKeyCodec.descriptor(descriptor, peer: publisher, origin: origin)
    _ = try DevicePageManifest(manifest, signed: true)
    _ = try DeviceKeyEnvelope(envelope, manifest: manifest, signed: true)
    for (name, value, domain) in [
      ("descriptor", descriptor, "eagle-bots-wrap-descriptor-v1"),
      ("manifest", manifest, "eagle-bots-page-manifest-v1"),
      ("envelope", envelope, "eagle-bots-key-envelope-signature-v1"),
    ] {
      #expect(
        domain + "\n" + (try PageKeyCodec.unsigned(value).canonical())
          == v["canonical"]?[name]?.string)
    }
  }

  @Test("typed metadata rejects unknown fields, wrong purpose, object, key and signature")
  func rejects() throws {
    let v = try vector()
    let manifest = try #require(v["manifest"])
    let envelope = try #require(v["envelope"])
    guard case .object(let m) = manifest, case .object(let e) = envelope else {
      Issue.record("fixture object missing")
      return
    }
    for (key, value) in [
      ("purpose", DeviceJSON.string("replica.read")),
      ("objectId", .string(String(repeating: "0", count: 64))),
      ("keyId", .string(String(repeating: "0", count: 64))),
      ("signature", .string(String(repeating: "A", count: 86))),
      ("unexpected", .bool(true)),
    ] {
      var changed = m
      changed[key] = value
      #expect(throws: DeviceIdentityError.self) {
        try DevicePageManifest(.object(changed), signed: true)
      }
      var changedEnvelope = e
      changedEnvelope[key] = value
      #expect(throws: DeviceIdentityError.self) {
        try DeviceKeyEnvelope(.object(changedEnvelope), manifest: manifest, signed: true)
      }
    }
  }
}
