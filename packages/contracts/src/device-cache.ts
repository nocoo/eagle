import { z } from "zod";
import { SyncDigest } from "./device-objects.ts";
import { SyncIdentity } from "./device-sync.ts";
import { DeviceId } from "./devices.ts";

export const SyncCacheOperation = z.enum(["publish", "list", "get"]);
export const SyncCacheAuthorityRequest = z.strictObject({
  version: z.literal(1),
  operation: SyncCacheOperation,
  sharedBotId: DeviceId,
  peerDeviceId: DeviceId,
  requestDigest: SyncDigest,
});
export const SyncCacheAuthorityCheck = SyncCacheAuthorityRequest.omit({
  version: true,
  peerDeviceId: true,
}).extend({ authority: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const SyncCacheAuthorization = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("replica.cache"),
  operation: SyncCacheOperation,
  registryOrigin: z.url().refine((value) => new URL(value).origin === value),
  sharedBotId: DeviceId,
  requestDigest: SyncDigest,
  uploader: SyncIdentity,
  recipient: SyncIdentity,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const SyncCacheAuthority = SyncCacheAuthorization.extend({
  authority: SyncCacheAuthorityCheck.shape.authority,
});
