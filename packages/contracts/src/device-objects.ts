import { z } from "zod";
import { SyncIdentity } from "./device-sync.ts";
import {
  canonicalDeviceJSON,
  DeviceId,
  deviceBytes,
  verifyDeviceSignature,
} from "./devices.ts";

export const SyncDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const SyncKeyBytes = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const SyncKeyDescriptorRequest = z.strictObject({
  version: z.literal(1),
  registryOrigin: z.url().refine((value) => new URL(value).origin === value),
  identity: SyncIdentity,
});
export const SyncKeyDescriptorBody = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.wrap"),
  registryOrigin: z.url().refine((value) => new URL(value).origin === value),
  deviceId: DeviceId,
  publicKey: SyncIdentity.shape.publicKey,
  credentialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  keyId: SyncDigest,
  wrappingPublicKey: SyncKeyBytes,
});
export const SyncKeyDescriptor = SyncKeyDescriptorBody.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const SyncPublishedDescriptor = z.strictObject({
  version: z.literal(1),
  identity: SyncIdentity,
  descriptor: SyncKeyDescriptor,
  publishedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export async function verifySyncKeyDescriptor(
  input: unknown,
  identity: z.infer<typeof SyncIdentity>,
  registryOrigin: string,
) {
  const value = SyncKeyDescriptor.parse(input);
  const { signature, ...body } = value;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", deviceBytes(value.wrappingPublicKey)),
  );
  const keyId = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (
    value.registryOrigin !== registryOrigin ||
    value.deviceId !== identity.deviceId ||
    value.publicKey !== identity.publicKey ||
    value.credentialVersion !== identity.credentialVersion ||
    value.keyId !== keyId ||
    !(await verifyDeviceSignature(
      identity.publicKey,
      syncDescriptorPayload(body),
      signature,
    ))
  )
    throw new Error("invalid_sync_key_descriptor");
  return value;
}
export function syncDescriptorPayload(input: unknown): string {
  return (
    "eagle-bots-wrap-descriptor-v1\n" +
    canonicalDeviceJSON(SyncKeyDescriptorBody.parse(input))
  );
}

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const source = z.strictObject({ replicaId: DeviceId, epoch: DeviceId });
export const SyncObjectHeader = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.page"),
  registryOrigin: SyncKeyDescriptorBody.shape.registryOrigin,
  publisher: SyncIdentity,
  sharedBotId: DeviceId,
  keyEpoch: z.literal(1),
  keyId: SyncDigest,
  objectId: SyncDigest,
  source,
  range: z.strictObject({ from: sequence, to: sequence }),
  included: z
    .array(z.strictObject({ seq: sequence.min(1), eventDigest: SyncDigest }))
    .max(128),
  nextAfter: sequence,
  hasMore: z.boolean(),
  pageDigest: SyncDigest,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
});
export const SyncObjectBody = SyncObjectHeader.extend({
  cipherDigest: SyncDigest,
});
const signed = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const SyncObjectManifest = SyncObjectBody.extend({ signature: signed });
export const SyncEnvelopeHeader = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.key"),
  registryOrigin: SyncKeyDescriptorBody.shape.registryOrigin,
  publisher: SyncIdentity,
  issuer: SyncIdentity,
  recipient: SyncIdentity,
  issuerDescriptor: SyncKeyDescriptor,
  recipientDescriptor: SyncKeyDescriptor,
  sharedBotId: DeviceId,
  keyEpoch: z.literal(1),
  keyId: SyncDigest,
  objectId: SyncDigest,
  manifestDigest: SyncDigest,
  ephemeral: SyncKeyBytes,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
});
export const SyncEnvelopeBody = SyncEnvelopeHeader.extend({
  ciphertext: SyncKeyBytes,
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
export const SyncKeyEnvelope = SyncEnvelopeBody.extend({ signature: signed });
export const SyncSealRequest = z.strictObject({
  version: z.literal(1),
  identity: SyncIdentity,
  manifest: SyncObjectBody,
  dek: SyncKeyBytes,
});
export const SyncSealResult = z.strictObject({
  manifest: SyncObjectManifest,
  descriptor: SyncKeyDescriptor,
  envelope: SyncKeyEnvelope,
});
export const SyncEnvelopeRequest = z.strictObject({
  version: z.literal(1),
  identity: SyncIdentity,
  manifest: SyncObjectManifest,
  envelope: SyncKeyEnvelope,
  recipient: SyncIdentity,
  recipientDescriptor: SyncKeyDescriptor,
});
export const SyncOpenRequest = z.strictObject({
  version: z.literal(1),
  manifest: SyncObjectManifest,
  envelope: SyncKeyEnvelope,
  publisherPin: SyncIdentity,
  issuerPin: SyncIdentity,
  recipientPin: SyncIdentity,
});
export function syncObjectPayload(input: unknown): string {
  return (
    "eagle-bots-page-manifest-v1\n" +
    canonicalDeviceJSON(SyncObjectBody.parse(input))
  );
}
export function syncEnvelopePayload(input: unknown): string {
  return (
    "eagle-bots-key-envelope-signature-v1\n" +
    canonicalDeviceJSON(SyncEnvelopeBody.parse(input))
  );
}
