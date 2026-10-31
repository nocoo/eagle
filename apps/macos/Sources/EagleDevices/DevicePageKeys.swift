import CryptoKit
import Foundation

/// Typed page-key metadata only; no page plaintext or general signing/decryption input.
enum PageKeyCodec {
  static let peerFields: Set<String> = [
    "deviceId", "publicKey", "groupId", "membershipEpoch", "credentialVersion",
  ]
  static let descriptorFields: Set<String> = [
    "version", "purpose", "registryOrigin", "deviceId", "publicKey", "credentialVersion", "keyId",
    "wrappingPublicKey", "signature",
  ]
  static let manifestFields: Set<String> = [
    "version", "purpose", "registryOrigin", "publisher", "sharedBotId", "keyEpoch", "keyId",
    "objectId", "source", "range", "included", "nextAfter", "hasMore", "pageDigest", "nonce",
    "cipherDigest",
  ]
  static let envelopeFields: Set<String> = [
    "version", "purpose", "registryOrigin", "publisher", "issuer", "recipient", "issuerDescriptor",
    "recipientDescriptor", "sharedBotId", "keyEpoch", "keyId", "objectId", "manifestDigest",
    "ephemeral", "nonce", "ciphertext", "tag",
  ]
  static func fields(_ value: DeviceJSON, _ keys: Set<String>) throws -> [String: DeviceJSON] {
    guard case .object(let fields) = value, Set(fields.keys) == keys,
      try value.canonical().utf8.count <= 65536
    else { throw DeviceIdentityError.invalidPayload }
    return fields
  }
  static func bytes(_ value: DeviceJSON?, _ count: Int) throws -> Data {
    guard let text = value?.string, let data = Data(base64URL: text), data.count == count,
      data.base64URL == text
    else { throw DeviceIdentityError.invalidPayload }
    return data
  }
  static func number(_ value: DeviceJSON?, minimum: Double = 0) throws -> Double {
    guard let x = value?.number, x >= minimum, x <= 9_007_199_254_740_991, x.rounded() == x else {
      throw DeviceIdentityError.invalidPayload
    }
    return x
  }
  static func uuid(_ value: DeviceJSON?) throws {
    guard let text = value?.string, UUID(uuidString: text)?.uuidString.lowercased() == text else {
      throw DeviceIdentityError.invalidPayload
    }
  }
  static func digest(_ value: DeviceJSON?) throws {
    guard let text = value?.string,
      text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    else {
      throw DeviceIdentityError.invalidPayload
    }
  }
  static func hash(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  static func hash(_ value: DeviceJSON) throws -> String { hash(Data(try value.canonical().utf8)) }
  static func peer(_ value: DeviceJSON) throws {
    _ = try fields(value, peerFields)
    try uuid(value["deviceId"])
    try uuid(value["groupId"])
    _ = try signingKey(value["publicKey"])
    _ = try number(value["membershipEpoch"])
    _ = try number(value["credentialVersion"], minimum: 1)
  }
  static func signingKey(_ value: DeviceJSON?) throws -> Curve25519.Signing.PublicKey {
    let encoded = try bytes(value, 44)
    guard
      encoded.prefix(12)
        == Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
    else {
      throw DeviceIdentityError.invalidPayload
    }
    return try .init(rawRepresentation: encoded.suffix(32))
  }
  static func unsigned(_ value: DeviceJSON) throws -> DeviceJSON {
    guard case .object(var fields) = value else { throw DeviceIdentityError.invalidPayload }
    fields.removeValue(forKey: "signature")
    return .object(fields)
  }
  static func verify(_ value: DeviceJSON, domain: String, key: DeviceJSON?) throws {
    let payload = domain + "\n" + (try unsigned(value).canonical())
    guard
      try signingKey(key).isValidSignature(bytes(value["signature"], 64), for: Data(payload.utf8))
    else {
      throw DeviceIdentityError.invalidPayload
    }
  }
  static func descriptor(_ value: DeviceJSON, peer: DeviceJSON, origin: String) throws {
    _ = try fields(value, descriptorFields)
    guard value["version"] == .number(1), value["purpose"] == .string("replica.wrap"),
      value["registryOrigin"] == .string(origin), value["deviceId"] == peer["deviceId"],
      value["publicKey"] == peer["publicKey"],
      value["credentialVersion"] == peer["credentialVersion"],
      value["keyId"] == .string(hash(try bytes(value["wrappingPublicKey"], 32)))
    else { throw DeviceIdentityError.invalidPayload }
    try verify(value, domain: "eagle-bots-wrap-descriptor-v1", key: peer["publicKey"])
  }
}

struct DevicePageManifest {
  let value: DeviceJSON
  init(_ value: DeviceJSON, signed: Bool) throws {
    _ = try PageKeyCodec.fields(
      value, PageKeyCodec.manifestFields.union(signed ? ["signature"] : []))
    guard value["version"] == .number(1), value["purpose"] == .string("replica.page"),
      value["keyEpoch"] == .number(1), let publisher = value["publisher"],
      let origin = value["registryOrigin"]?.string, let url = URLComponents(string: origin),
      ["http", "https"].contains(url.scheme ?? ""), url.host != nil, url.path.isEmpty,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      let source = value["source"], let range = value["range"],
      let included = value["included"]?.array, included.count <= 128,
      value["hasMore"]?.bool != nil
    else { throw DeviceIdentityError.invalidPayload }
    try PageKeyCodec.peer(publisher)
    try PageKeyCodec.uuid(value["sharedBotId"])
    _ = try PageKeyCodec.fields(source, ["replicaId", "epoch"])
    try PageKeyCodec.uuid(source["replicaId"])
    try PageKeyCodec.uuid(source["epoch"])
    _ = try PageKeyCodec.fields(range, ["from", "to"])
    let from = try PageKeyCodec.number(range["from"])
    let to = try PageKeyCodec.number(range["to"])
    guard from <= to + 1 else { throw DeviceIdentityError.invalidPayload }
    var previous: Double?
    for event in included {
      _ = try PageKeyCodec.fields(event, ["seq", "eventDigest"])
      let seq = try PageKeyCodec.number(event["seq"], minimum: 1)
      guard seq >= from, seq <= to, previous == nil || seq == previous! + 1 else {
        throw DeviceIdentityError.invalidPayload
      }
      try PageKeyCodec.digest(event["eventDigest"])
      previous = seq
    }
    let next = try PageKeyCodec.number(value["nextAfter"])
    guard next <= to, previous == nil || next == previous else {
      throw DeviceIdentityError.invalidPayload
    }
    for field in ["keyId", "objectId", "pageDigest", "cipherDigest"] {
      try PageKeyCodec.digest(value[field])
    }
    _ = try PageKeyCodec.bytes(value["nonce"], 12)
    let logical: DeviceJSON = .object([
      "version": .number(1), "purpose": .string("replica.page"),
      "publisherDeviceId": publisher["deviceId"]!,
      "sharedBotId": value["sharedBotId"]!, "keyEpoch": .number(1), "source": source,
      "pageDigest": value["pageDigest"]!,
    ])
    guard value["objectId"] == .string(try PageKeyCodec.hash(logical)) else {
      throw DeviceIdentityError.invalidPayload
    }
    if signed {
      try PageKeyCodec.verify(
        value, domain: "eagle-bots-page-manifest-v1", key: publisher["publicKey"])
    }
    self.value = value
  }
  func signingPayload(identity: DeviceIdentity) throws -> String {
    guard value["publisher"]?["deviceId"] == .string(identity.deviceId),
      value["publisher"]?["publicKey"] == .string(identity.publicKey)
    else { throw DeviceIdentityError.invalidPayload }
    return "eagle-bots-page-manifest-v1\n" + (try value.canonical())
  }
}

struct DeviceKeyEnvelope {
  let value: DeviceJSON
  init(_ value: DeviceJSON, manifest: DeviceJSON, signed: Bool) throws {
    _ = try PageKeyCodec.fields(
      value, PageKeyCodec.envelopeFields.union(signed ? ["signature"] : []))
    guard value["version"] == .number(1), value["purpose"] == .string("replica.key"),
      let issuer = value["issuer"], let recipient = value["recipient"],
      let origin = value["registryOrigin"]?.string,
      value["publisher"] == manifest["publisher"],
      value["registryOrigin"] == manifest["registryOrigin"],
      issuer["deviceId"] == manifest["publisher"]?["deviceId"],
      issuer["publicKey"] == manifest["publisher"]?["publicKey"],
      issuer["groupId"] == recipient["groupId"],
      ["sharedBotId", "keyEpoch", "keyId", "objectId"].allSatisfy({ value[$0] == manifest[$0] }),
      value["manifestDigest"] == .string(try PageKeyCodec.hash(manifest)),
      let issuerDescriptor = value["issuerDescriptor"],
      let recipientDescriptor = value["recipientDescriptor"]
    else { throw DeviceIdentityError.invalidPayload }
    try PageKeyCodec.peer(issuer)
    try PageKeyCodec.peer(recipient)
    try PageKeyCodec.descriptor(issuerDescriptor, peer: issuer, origin: origin)
    try PageKeyCodec.descriptor(recipientDescriptor, peer: recipient, origin: origin)
    _ = try PageKeyCodec.bytes(value["ephemeral"], 32)
    _ = try PageKeyCodec.bytes(value["nonce"], 12)
    _ = try PageKeyCodec.bytes(value["ciphertext"], 32)
    _ = try PageKeyCodec.bytes(value["tag"], 16)
    if signed {
      try PageKeyCodec.verify(
        value, domain: "eagle-bots-key-envelope-signature-v1", key: issuer["publicKey"])
    }
    self.value = value
  }
  func signingPayload(identity: DeviceIdentity) throws -> String {
    guard value["issuer"]?["deviceId"] == .string(identity.deviceId),
      value["issuer"]?["publicKey"] == .string(identity.publicKey)
    else { throw DeviceIdentityError.invalidPayload }
    return "eagle-bots-key-envelope-signature-v1\n" + (try value.canonical())
  }
  var header: DeviceJSON {
    guard case .object(var fields) = value else { return .null }
    for key in ["signature", "ciphertext", "tag"] { fields.removeValue(forKey: key) }
    return .object(fields)
  }
  static func material(shared: SharedSecret, header: DeviceJSON) throws -> (SymmetricKey, Data) {
    let aad = Data(("eagle-bots-key-envelope-v1\n" + (try header.canonical())).utf8)
    let key = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: Data(SHA256.hash(data: Data("eagle-bots-key-envelope-v1".utf8))),
      sharedInfo: Data(SHA256.hash(data: aad)), outputByteCount: 32)
    return (key, aad)
  }
  func open(privateKey: Curve25519.KeyAgreement.PrivateKey) throws -> Data {
    guard
      value["recipientDescriptor"]?["wrappingPublicKey"]
        == .string(privateKey.publicKey.rawRepresentation.base64URL)
    else { throw DeviceIdentityError.invalidPayload }
    let peer = try Curve25519.KeyAgreement.PublicKey(
      rawRepresentation: PageKeyCodec.bytes(value["ephemeral"], 32))
    let (key, aad) = try Self.material(
      shared: privateKey.sharedSecretFromKeyAgreement(with: peer), header: header)
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: PageKeyCodec.bytes(value["nonce"], 12)),
      ciphertext: PageKeyCodec.bytes(value["ciphertext"], 32),
      tag: PageKeyCodec.bytes(value["tag"], 16))
    return try AES.GCM.open(box, using: key, authenticating: aad)
  }
}

struct DevicePageKeys {
  let identity: DeviceIdentity
  let wrapping: DeviceWrappingKey
  let origin: String
  private func own(_ peer: DeviceJSON) throws {
    try PageKeyCodec.peer(peer)
    guard peer["deviceId"] == .string(identity.deviceId),
      peer["publicKey"] == .string(identity.publicKey)
    else { throw DeviceIdentityError.invalidPayload }
  }
  private func wrap(
    _ dek: Data, manifest: DeviceJSON, issuer: DeviceJSON, recipient: DeviceJSON,
    recipientDescriptor: DeviceJSON
  ) throws -> DeviceJSON {
    try own(issuer)
    let descriptor = try identity.wrappingDescriptor(
      key: wrapping, serviceOrigin: origin,
      credentialVersion: Int64(PageKeyCodec.number(issuer["credentialVersion"], minimum: 1)))
    try PageKeyCodec.descriptor(recipientDescriptor, peer: recipient, origin: origin)
    let ephemeral = Curve25519.KeyAgreement.PrivateKey()
    let nonce = AES.GCM.Nonce()
    var header: [String: DeviceJSON] = [
      "version": .number(1), "purpose": .string("replica.key"), "registryOrigin": .string(origin),
      "publisher": manifest["publisher"]!, "issuer": issuer, "recipient": recipient,
      "issuerDescriptor": descriptor, "recipientDescriptor": recipientDescriptor,
      "sharedBotId": manifest["sharedBotId"]!, "keyEpoch": manifest["keyEpoch"]!,
      "keyId": manifest["keyId"]!,
      "objectId": manifest["objectId"]!, "manifestDigest": .string(try PageKeyCodec.hash(manifest)),
      "ephemeral": .string(ephemeral.publicKey.rawRepresentation.base64URL),
      "nonce": .string(nonce.withUnsafeBytes { Data($0).base64URL }),
    ]
    let peer = try Curve25519.KeyAgreement.PublicKey(
      rawRepresentation: PageKeyCodec.bytes(recipientDescriptor["wrappingPublicKey"], 32))
    let (key, aad) = try DeviceKeyEnvelope.material(
      shared: ephemeral.sharedSecretFromKeyAgreement(with: peer), header: .object(header))
    let box = try AES.GCM.seal(dek, using: key, nonce: nonce, authenticating: aad)
    header["ciphertext"] = .string(box.ciphertext.base64URL)
    header["tag"] = .string(box.tag.base64URL)
    let envelope = try DeviceKeyEnvelope(.object(header), manifest: manifest, signed: false)
    return try identity.signKeyEnvelope(envelope)
  }
  func seal(_ request: DeviceJSON) throws -> DeviceJSON {
    _ = try PageKeyCodec.fields(request, ["version", "identity", "manifest", "dek"])
    guard request["version"] == .number(1), let peer = request["identity"],
      let raw = request["manifest"],
      raw["publisher"] == peer, raw["registryOrigin"] == .string(origin)
    else { throw DeviceIdentityError.invalidPayload }
    try own(peer)
    let manifest = try identity.signPageManifest(DevicePageManifest(raw, signed: false))
    let descriptor = try identity.wrappingDescriptor(
      key: wrapping, serviceOrigin: origin,
      credentialVersion: Int64(PageKeyCodec.number(peer["credentialVersion"], minimum: 1)))
    let envelope = try wrap(
      PageKeyCodec.bytes(request["dek"], 32), manifest: manifest, issuer: peer, recipient: peer,
      recipientDescriptor: descriptor)
    return .object(["manifest": manifest, "descriptor": descriptor, "envelope": envelope])
  }
  func issue(_ request: DeviceJSON) throws -> DeviceJSON {
    _ = try PageKeyCodec.fields(
      request, ["version", "identity", "manifest", "envelope", "recipient", "recipientDescriptor"])
    guard request["version"] == .number(1), let issuer = request["identity"],
      let raw = request["manifest"],
      let source = request["envelope"], let recipient = request["recipient"],
      let descriptor = request["recipientDescriptor"],
      raw["registryOrigin"] == .string(origin)
    else { throw DeviceIdentityError.invalidPayload }
    try own(issuer)
    _ = try DevicePageManifest(raw, signed: true)
    let selfEnvelope = try DeviceKeyEnvelope(source, manifest: raw, signed: true)
    try own(source["recipient"]!)
    guard source["issuer"]?["deviceId"] == .string(identity.deviceId),
      source["issuer"]?["publicKey"] == .string(identity.publicKey),
      source["recipientDescriptor"]?["keyId"] == .string(wrapping.keyId)
    else { throw DeviceIdentityError.invalidPayload }
    let dek = try wrapping.open(selfEnvelope)
    return try wrap(
      dek, manifest: raw, issuer: issuer, recipient: recipient, recipientDescriptor: descriptor)
  }
  func open(_ request: DeviceJSON) throws -> DeviceJSON {
    _ = try PageKeyCodec.fields(
      request, ["version", "manifest", "envelope", "publisherPin", "issuerPin", "recipientPin"])
    guard request["version"] == .number(1), let raw = request["manifest"],
      let source = request["envelope"],
      raw["registryOrigin"] == .string(origin), raw["publisher"] == request["publisherPin"],
      source["issuer"] == request["issuerPin"], source["recipient"] == request["recipientPin"]
    else { throw DeviceIdentityError.invalidPayload }
    _ = try DevicePageManifest(raw, signed: true)
    let envelope = try DeviceKeyEnvelope(source, manifest: raw, signed: true)
    try own(source["recipient"]!)
    guard source["recipientDescriptor"]?["keyId"] == .string(wrapping.keyId) else {
      throw DeviceIdentityError.invalidPayload
    }
    return .object(["version": .number(1), "dek": .string(try wrapping.open(envelope).base64URL)])
  }
}
