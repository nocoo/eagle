import { createHash, createPublicKey, verify } from "node:crypto";
import type { z } from "zod";
import {
  SyncKeyDescriptor,
  SyncKeyEnvelope,
  SyncObjectManifest,
  syncDescriptorPayload,
  syncEnvelopePayload,
  syncObjectPayload,
} from "../contracts/src/device-objects.ts";
import type { SyncIdentity } from "../contracts/src/device-sync.ts";
import { canonicalDeviceJSON } from "../contracts/src/devices.ts";

type Peer = z.infer<typeof SyncIdentity>;
export const objectDigest = (value: unknown) =>
  createHash("sha256").update(canonicalDeviceJSON(value)).digest("hex");
const same = (a: unknown, b: unknown) =>
  canonicalDeviceJSON(a) === canonicalDeviceJSON(b);
function signature(value: string, text: string, publicKey: string): void {
  if (
    !verify(
      null,
      Buffer.from(text),
      createPublicKey({
        key: Buffer.from(publicKey, "base64url"),
        type: "spki",
        format: "der",
      }),
      Buffer.from(value, "base64url"),
    )
  )
    throw new Error("invalid_sync_key_signature");
}
export function verifyWrappingDescriptor(
  input: unknown,
  peer: Peer,
  origin: string,
) {
  const value = SyncKeyDescriptor.parse(input);
  const { signature: signed, ...body } = value;
  if (
    value.registryOrigin !== origin ||
    value.deviceId !== peer.deviceId ||
    value.publicKey !== peer.publicKey ||
    value.credentialVersion !== peer.credentialVersion ||
    createHash("sha256")
      .update(Buffer.from(value.wrappingPublicKey, "base64url"))
      .digest("hex") !== value.keyId
  )
    throw new Error("invalid_sync_key_descriptor");
  signature(signed, syncDescriptorPayload(body), peer.publicKey);
  return value;
}
export function verifyObjectManifest(input: unknown) {
  const value = SyncObjectManifest.parse(input);
  const { signature: signed, ...body } = value;
  if (
    !value.publisher.groupId ||
    value.range.from > value.range.to + 1 ||
    value.nextAfter > value.range.to ||
    value.included.some(
      (event, i) =>
        event.seq < value.range.from ||
        event.seq > value.range.to ||
        (i > 0 && event.seq !== (value.included[i - 1]?.seq ?? 0) + 1),
    ) ||
    (value.included.length && value.included.at(-1)?.seq !== value.nextAfter) ||
    value.objectId !==
      objectDigest({
        version: 1,
        purpose: "replica.page",
        publisherDeviceId: value.publisher.deviceId,
        sharedBotId: value.sharedBotId,
        keyEpoch: value.keyEpoch,
        source: value.source,
        pageDigest: value.pageDigest,
      })
  )
    throw new Error("invalid_sync_object_manifest");
  signature(signed, syncObjectPayload(body), value.publisher.publicKey);
  return value;
}
export function verifyKeyEnvelope(input: unknown, manifestInput: unknown) {
  const manifest = verifyObjectManifest(manifestInput);
  const value = SyncKeyEnvelope.parse(input);
  const { signature: signed, ...body } = value;
  if (
    value.registryOrigin !== manifest.registryOrigin ||
    !same(value.publisher, manifest.publisher) ||
    value.issuer.deviceId !== manifest.publisher.deviceId ||
    value.issuer.publicKey !== manifest.publisher.publicKey ||
    !value.issuer.groupId ||
    value.issuer.groupId !== value.recipient.groupId ||
    value.sharedBotId !== manifest.sharedBotId ||
    value.objectId !== manifest.objectId ||
    value.keyEpoch !== manifest.keyEpoch ||
    value.keyId !== manifest.keyId ||
    value.manifestDigest !== objectDigest(manifest)
  )
    throw new Error("invalid_sync_key_envelope");
  verifyWrappingDescriptor(
    value.issuerDescriptor,
    value.issuer,
    value.registryOrigin,
  );
  verifyWrappingDescriptor(
    value.recipientDescriptor,
    value.recipient,
    value.registryOrigin,
  );
  signature(signed, syncEnvelopePayload(body), value.issuer.publicKey);
  return value;
}
