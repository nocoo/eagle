import { createHash, createPublicKey, verify } from "node:crypto";
import type { z } from "zod";
import {
  Authorization,
  type AuthorizationValue,
  Carrier,
  type CarrierValue,
  MAX_CIPHER,
  type RequestValue,
  type SyncIdentity,
  SyncKeyDescriptor,
  SyncKeyEnvelope,
  SyncObjectManifest,
} from "./wire.ts";

// Only the new controlled metadata is canonicalized; no page/plaintext reaches this Worker.
export function canonical(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return JSON.stringify(value);
}
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const metadataDigest = (value: unknown) => digest(canonical(value));
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function unsigned<T extends { signature: string }>(value: T) {
  const { signature: _, ...body } = value;
  return body;
}
function signature(value: string, domain: string, body: unknown, key: string): void {
  if (
    !verify(
      null,
      Buffer.from(domain + "\n" + canonical(body)),
      createPublicKey({ key: Buffer.from(key, "base64url"), type: "spki", format: "der" }),
      Buffer.from(value, "base64url"),
    )
  )
    throw new Error("sync_object_signature_invalid");
}
export function descriptor(input: unknown, peer: z.infer<typeof SyncIdentity>, origin: string) {
  const value = SyncKeyDescriptor.parse(input);
  if (
    value.registryOrigin !== origin ||
    value.deviceId !== peer.deviceId ||
    value.publicKey !== peer.publicKey ||
    value.credentialVersion !== peer.credentialVersion ||
    value.keyId !== digest(Buffer.from(value.wrappingPublicKey, "base64url"))
  )
    throw new Error("sync_object_descriptor_invalid");
  signature(value.signature, "eagle-bots-wrap-descriptor-v1", unsigned(value), peer.publicKey);
  return value;
}
export function manifest(input: unknown) {
  const value = SyncObjectManifest.parse(input);
  if (
    !value.publisher.groupId ||
    value.objectId !==
      metadataDigest({
        version: 1,
        purpose: "replica.page",
        publisherDeviceId: value.publisher.deviceId,
        sharedBotId: value.sharedBotId,
        keyEpoch: value.keyEpoch,
        source: value.source,
        pageDigest: value.pageDigest,
      }) ||
    value.range.from > value.range.to + 1 ||
    value.nextAfter > value.range.to ||
    value.included.some(
      (event, i) =>
        event.seq < value.range.from ||
        event.seq > value.range.to ||
        (i > 0 && event.seq !== (value.included[i - 1]?.seq ?? 0) + 1),
    ) ||
    (value.included.length > 0 && value.included.at(-1)?.seq !== value.nextAfter)
  )
    throw new Error("sync_object_manifest_invalid");
  signature(
    value.signature,
    "eagle-bots-page-manifest-v1",
    unsigned(value),
    value.publisher.publicKey,
  );
  return value;
}
export function envelope(input: unknown, object: unknown) {
  const m = manifest(object),
    value = SyncKeyEnvelope.parse(input);
  if (
    value.registryOrigin !== m.registryOrigin ||
    !same(value.publisher, m.publisher) ||
    value.issuer.deviceId !== m.publisher.deviceId ||
    value.issuer.publicKey !== m.publisher.publicKey ||
    !value.issuer.groupId ||
    value.issuer.groupId !== value.recipient.groupId ||
    value.sharedBotId !== m.sharedBotId ||
    value.keyEpoch !== m.keyEpoch ||
    value.keyId !== m.keyId ||
    value.objectId !== m.objectId ||
    value.manifestDigest !== metadataDigest(m)
  )
    throw new Error("sync_object_envelope_invalid");
  descriptor(value.issuerDescriptor, value.issuer, value.registryOrigin);
  descriptor(value.recipientDescriptor, value.recipient, value.registryOrigin);
  signature(
    value.signature,
    "eagle-bots-key-envelope-signature-v1",
    unsigned(value),
    value.issuer.publicKey,
  );
  return value;
}
export function carrier(input: unknown) {
  const value = Carrier.parse(input),
    m = manifest(value.manifest);
  descriptor(value.descriptor, m.publisher, m.registryOrigin);
  envelope(value.envelope, m);
  const cipher = Buffer.from(value.ciphertext, "base64url");
  if (
    cipher.length < 16 ||
    cipher.length > MAX_CIPHER ||
    cipher.toString("base64url") !== value.ciphertext ||
    digest(cipher) !== m.cipherDigest
  )
    throw new Error("sync_object_cipher_invalid");
  return value;
}
export function requestDigest(input: RequestValue) {
  if (input.operation !== "publish") return metadataDigest(input);
  const { ciphertext, ...metadata } = input.carrier;
  const bytes = Buffer.from(ciphertext, "base64url");
  return metadataDigest({
    ...input,
    carrier: { ...metadata, cipherDigest: digest(bytes), cipherLength: bytes.length },
  });
}
export function claims(
  input: RequestValue,
  value: unknown,
  origin: string,
  expectedDigest: string,
) {
  const auth = Authorization.parse(value);
  if (
    auth.registryOrigin !== origin ||
    auth.operation !== input.operation ||
    auth.sharedBotId !== input.sharedBotId ||
    auth.requestDigest !== expectedDigest ||
    !auth.uploader.groupId ||
    auth.uploader.groupId !== auth.recipient.groupId ||
    auth.uploader.deviceId === auth.recipient.deviceId ||
    input.peerDeviceId !==
      (input.operation === "publish" ? auth.recipient.deviceId : auth.uploader.deviceId)
  )
    throw new Error("sync_cache_authority_mismatch");
  if (input.operation === "publish") boundCarrier(input.carrier, auth);
  return auth;
}
export function boundCarrier(value: CarrierValue, auth: AuthorizationValue) {
  if (
    value.manifest.sharedBotId !== auth.sharedBotId ||
    value.manifest.registryOrigin !== auth.registryOrigin ||
    value.manifest.publisher.deviceId !== auth.uploader.deviceId ||
    value.manifest.publisher.publicKey !== auth.uploader.publicKey ||
    !same(value.envelope.issuer, auth.uploader) ||
    !same(value.envelope.recipient, auth.recipient)
  )
    throw new Error("sync_cache_identity_mismatch");
}
export function slotKey(value: CarrierValue["envelope"]) {
  return metadataDigest({
    issuer: value.issuer,
    recipient: value.recipient,
    registryOrigin: value.registryOrigin,
    issuerDescriptor: unsigned(value.issuerDescriptor),
    recipientDescriptor: unsigned(value.recipientDescriptor),
  });
}
