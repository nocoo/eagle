import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  acceptedPin,
  bytesDigest,
  metadataDigest,
  objectCanonical,
  preparePage,
  type StoredObject,
  verifyCarrier,
} from "../../src/sync-objects.ts";
export function objectFixture() {
  const signing = generateKeyPairSync("ed25519");
  const publicKey = signing.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const publisher = {
    deviceId: randomUUID(),
    publicKey,
    groupId: randomUUID(),
    membershipEpoch: 1,
    credentialVersion: 1,
  };
  const origin = "http://127.0.0.1:17053";
  const signed = <T>(domain: string, value: T) => ({
    ...value,
    signature: sign(
      null,
      Buffer.from(domain + "\n" + objectCanonical(value)),
      signing.privateKey,
    ).toString("base64url"),
  });
  const wrappingPublicKey = randomBytes(32).toString("base64url");
  const descriptor = signed("eagle-bots-wrap-descriptor-v1", {
    version: 1 as const,
    purpose: "replica.wrap" as const,
    registryOrigin: origin,
    deviceId: publisher.deviceId,
    publicKey,
    credentialVersion: 1,
    keyId: bytesDigest(Buffer.from(wrappingPublicKey, "base64url")),
    wrappingPublicKey,
  });
  const page = JSON.parse(
    readFileSync(
      new URL("../../../../fixtures/bots-sync/resource-page.v1.json", import.meta.url),
      "utf8",
    ),
  );
  const prepared = preparePage(page, publisher, origin).encrypt();
  const manifest = signed("eagle-bots-page-manifest-v1", prepared.manifest);
  const envelope = signed("eagle-bots-key-envelope-signature-v1", {
    version: 1 as const,
    purpose: "replica.key" as const,
    registryOrigin: origin,
    publisher,
    issuer: publisher,
    recipient: publisher,
    issuerDescriptor: descriptor,
    recipientDescriptor: descriptor,
    sharedBotId: manifest.sharedBotId,
    keyEpoch: 1 as const,
    keyId: manifest.keyId,
    objectId: manifest.objectId,
    manifestDigest: metadataDigest(manifest),
    ephemeral: randomBytes(32).toString("base64url"),
    nonce: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(32).toString("base64url"),
    tag: randomBytes(16).toString("base64url"),
  });
  const carrier = verifyCarrier({
    version: 1,
    manifest,
    descriptor,
    envelope,
    ciphertext: prepared.ciphertext,
  });
  const botId = "b_" + randomUUID();
  const record: StoredObject = {
    version: 1,
    kind: "publisher",
    botId,
    binding: {
      localBotId: botId,
      sharedBotId: manifest.sharedBotId,
      replicaId: randomUUID(),
      epoch: randomUUID(),
    },
    carrier,
    pin: acceptedPin(carrier),
  };
  return { page, prepared, record, publisher, descriptor, manifest, envelope, signed };
}
