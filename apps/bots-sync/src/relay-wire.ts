import { z } from "zod";
import { SyncDigest, SyncIdentity, SyncKeyBytes } from "./wire.ts";
export const RelayOperation = z.enum([
  "register",
  "discover",
  "exchange",
  "ack",
  "receipts",
  "status-report",
  "status-read",
]);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RelaySource = z.strictObject({ replicaId: z.uuid(), epoch: z.uuid() });
export const RelayBinding = RelaySource.extend({
  localBotId: z.string().regex(/^b_[A-Za-z0-9_-]{1,128}$/),
  sharedBotId: z.uuid(),
});
export const RelayStream = z
  .strictObject({
    source: RelaySource,
    received: sequence,
    applied: sequence,
    available: z
      .array(
        z
          .strictObject({ from: sequence.min(1), to: sequence.min(1) })
          .refine((v) => v.from <= v.to),
      )
      .max(128),
  })
  .refine((v) => v.applied <= v.received);
export const RelayRegister = z
  .strictObject({
    version: z.literal(1),
    operation: z.literal("register"),
    sharedBotId: z.uuid(),
    binding: RelayBinding,
    generation: SyncKeyBytes,
    streams: z.array(RelayStream).max(128),
  })
  .refine((v) => v.binding.sharedBotId === v.sharedBotId);
export const RelayDiscover = z.strictObject({
  version: z.literal(1),
  operation: z.literal("discover"),
  sharedBotId: z.uuid(),
});
export const RelayAuthorization = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.relay"),
  operation: RelayOperation,
  sharedBotId: z.uuid(),
  requestDigest: SyncDigest,
  registryOrigin: z.url().refine((v) => new URL(v).origin === v),
  requester: SyncIdentity,
  holder: SyncIdentity.nullable(),
  reader: SyncIdentity.nullable(),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const base = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid(),
  peerDeviceId: z.uuid(),
});
export const RelayChallenge = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid(),
  readerDeviceId: z.uuid(),
  readerNonce: SyncKeyBytes,
  readerEphemeral: SyncKeyBytes,
});
export const RelayObject = z.strictObject({
  sessionId: SyncKeyBytes,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  box: z.strictObject({
    version: z.literal(1),
    sequence: z.literal(0),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9_-]*$/)
      .max(16384),
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
export const RelayExchange = base.extend({
  operation: z.literal("exchange"),
  requestId: z.uuid(),
  generation: SyncKeyBytes,
  method: z.enum(["challenge", "object"]),
  payload: z.unknown(),
  receiverBinding: RelayBinding,
});
export const RelayDelivery = z.strictObject({
  requestId: z.uuid(),
  sessionId: SyncKeyBytes,
  objectId: SyncDigest,
  source: RelaySource,
});
export const RelayAck = base
  .extend({
    operation: z.literal("ack"),
    delivery: RelayDelivery,
    binding: RelayBinding,
    source: RelaySource,
    received: sequence,
    applied: sequence,
    available: RelayStream.shape.available,
  })
  .refine((v) => v.applied <= v.received && v.binding.sharedBotId === v.sharedBotId);
export const RelayReceipts = base.extend({ operation: z.literal("receipts") });
export const RelayProgress = z
  .strictObject({ source: RelaySource, received: sequence, applied: sequence })
  .refine((value) => value.applied <= value.received);
export const RelayStatusReport = base
  .extend({
    operation: z.literal("status-report"),
    binding: RelayBinding,
    streams: z.array(RelayProgress).max(128),
  })
  .refine(
    (value) =>
      value.binding.sharedBotId === value.sharedBotId &&
      new Set(value.streams.map((s) => `${s.source.replicaId}/${s.source.epoch}`)).size ===
        value.streams.length,
  );
export const RelayStatusRead = base.extend({ operation: z.literal("status-read") });
export const RelayStatusSnapshot = RelayProgress.safeExtend({
  registryOrigin: RelayAuthorization.shape.registryOrigin,
  sharedBotId: z.uuid(),
  holder: SyncIdentity,
  receiver: SyncIdentity,
  binding: RelayBinding,
  recordedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const relayStatusResult = z.strictObject({
  version: z.literal(1),
  snapshots: z.array(RelayStatusSnapshot).max(128),
  hasMore: z.boolean(),
});
export const RelayRequest = z.union([
  RelayRegister,
  RelayDiscover,
  RelayExchange,
  RelayAck,
  RelayReceipts,
  RelayStatusReport,
  RelayStatusRead,
]);
