import { z } from "zod";
import {
  SyncDigest,
  SyncKeyDescriptor,
  SyncObjectCarrier,
  syncObjectPullInput,
} from "./DeviceSyncObjects.ts";
import { deviceSyncPeer } from "./DeviceSyncPort.ts";

export const cachePublishInput = syncObjectPullInput;
export const cacheListInput = z.strictObject({
  peerDeviceId: z.uuid().toLowerCase(),
  source: z.strictObject({ replicaId: z.uuid(), epoch: z.uuid() }),
  after: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(128).default(128),
});
export const cacheReceiveInput = z.strictObject({
  peerDeviceId: z.uuid().toLowerCase(),
  objectId: SyncDigest,
});
export const publishedDescriptor = z.strictObject({
  version: z.literal(1),
  identity: deviceSyncPeer,
  descriptor: SyncKeyDescriptor,
  publishedAt: z.number().int().positive(),
});
export const cacheAuthorityRequest = z.strictObject({
  version: z.literal(1),
  operation: z.enum(["publish", "list", "get"]),
  sharedBotId: z.uuid(),
  peerDeviceId: z.uuid(),
  requestDigest: SyncDigest,
});
export const cacheAuthorization = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.cache"),
  operation: cacheAuthorityRequest.shape.operation,
  registryOrigin: z.url().refine((value) => new URL(value).origin === value),
  sharedBotId: z.uuid(),
  requestDigest: SyncDigest,
  uploader: deviceSyncPeer,
  recipient: deviceSyncPeer,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const cacheAuthority = cacheAuthorization.extend({
  authority: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const base = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid(),
  peerDeviceId: z.uuid(),
});
export const cacheWirePublish = base.extend({
  operation: z.literal("publish"),
  carrier: SyncObjectCarrier,
});
export const cacheWireList = base.extend({
  operation: z.literal("list"),
  source: cacheListInput.shape.source,
  after: cacheListInput.shape.after,
  limit: cacheListInput.shape.limit,
});
export const cacheWireGet = base.extend({ operation: z.literal("get"), objectId: SyncDigest });
export const cacheWireRequest = z.discriminatedUnion("operation", [
  cacheWirePublish,
  cacheWireList,
  cacheWireGet,
]);
export const cacheGetResult = z.strictObject({
  version: z.literal(1),
  cloudCached: z.literal(true),
  firstCachedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  carrier: SyncObjectCarrier,
});
export const cachePublishResult = z.union([
  z.strictObject({
    version: z.literal(1),
    objectId: SyncDigest,
    cloudCached: z.literal(true),
    firstCachedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  }),
  z.strictObject({
    version: z.literal(1),
    cloudCached: z.literal(false),
    reason: z.literal("empty_page"),
  }),
]);

export const cacheListResult = z.strictObject({
  version: z.literal(1),
  objects: z
    .array(
      z.strictObject({
        objectId: SyncDigest,
        expiresAt: z.number().int().positive(),
        included: z
          .array(z.strictObject({ seq: z.number().int().positive(), eventDigest: SyncDigest }))
          .max(128),
      }),
    )
    .max(128),
  gaps: z
    .array(
      z.strictObject({
        seq: z.number().int().positive(),
        reason: z.enum(["expired", "pending", "unavailable"]),
      }),
    )
    .max(128),
  hasMore: z.boolean(),
  nextAfter: z.number().int().nonnegative(),
  complete: z.literal(false),
});
