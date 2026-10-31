import { z } from "zod";
export const SyncIdentity = z.strictObject({
  deviceId: z.uuid(),
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(2048),
  groupId: z.uuid().nullable(),
  membershipEpoch: z.number().int().nonnegative(),
  credentialVersion: z.number().int().positive(),
});

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

export const MAX_CIPHER = 8 * 1024 * 1024 + 16;
export const MAX_FRAME = Math.ceil((MAX_CIPHER * 4) / 3) + 65536;
export const Carrier = z.strictObject({
  version: z.literal(1),
  manifest: SyncObjectManifest,
  descriptor: SyncKeyDescriptor,
  envelope: SyncKeyEnvelope,
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(Math.ceil((MAX_CIPHER * 4) / 3)),
});
export const Metadata = Carrier.omit({ ciphertext: true, envelope: true });
const base = z.strictObject({
  version: z.literal(1),
  sharedBotId: DeviceId,
  peerDeviceId: DeviceId,
});
export const Publish = base.extend({ operation: z.literal("publish"), carrier: Carrier });
export const List = base.extend({
  operation: z.literal("list"),
  source,
  after: sequence,
  limit: z.number().int().min(1).max(128),
});
export const Get = base.extend({ operation: z.literal("get"), objectId: SyncDigest });
export const RequestBody = z.discriminatedUnion("operation", [Publish, List, Get]);
export const Authorization = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.cache"),
  operation: z.enum(["publish", "list", "get"]),
  registryOrigin: SyncKeyDescriptorBody.shape.registryOrigin,
  sharedBotId: DeviceId,
  requestDigest: SyncDigest,
  uploader: SyncIdentity,
  recipient: SyncIdentity,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type CarrierValue = z.infer<typeof Carrier>;
export type ManifestValue = z.infer<typeof SyncObjectManifest>;
export type RequestValue = z.infer<typeof RequestBody>;
export type AuthorizationValue = z.infer<typeof Authorization>;
