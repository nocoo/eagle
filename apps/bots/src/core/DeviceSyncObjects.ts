import { z } from "zod";
import { deviceSyncPeer as SyncIdentity, syncPullInput } from "./DeviceSyncPort.ts";

const DeviceId = z.uuid().toLowerCase();

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
  included: z.array(z.strictObject({ seq: sequence.min(1), eventDigest: SyncDigest })).max(128),
  nextAfter: sequence,
  hasMore: z.boolean(),
  pageDigest: SyncDigest,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
});
export const SyncObjectBody = SyncObjectHeader.extend({ cipherDigest: SyncDigest });
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

export const syncObjectPullInput = z.union([
  syncPullInput,
  z.strictObject({ peerDeviceId: z.uuid().toLowerCase(), objectId: SyncDigest }),
]);
export const syncObjectApplyInput = z.strictObject({ objectId: SyncDigest });
export const SyncObjectCarrier = z.strictObject({
  version: z.literal(1),
  manifest: SyncObjectManifest,
  descriptor: SyncKeyDescriptor,
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(Math.ceil(((8 * 1024 * 1024 + 16) * 4) / 3)),
  envelope: SyncKeyEnvelope,
});
export type KeyDescriptor = z.infer<typeof SyncKeyDescriptor>;
export type KeyManifest = z.infer<typeof SyncObjectManifest>;
export type KeyEnvelope = z.infer<typeof SyncKeyEnvelope>;
export type ObjectCarrier = z.infer<typeof SyncObjectCarrier>;
