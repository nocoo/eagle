import { z } from "zod";
import { SyncDigest } from "./device-objects.ts";
import { SyncIdentity } from "./device-sync.ts";
import { DeviceId } from "./devices.ts";

export const SyncRelayOperation = z.enum([
  "register",
  "discover",
  "exchange",
  "ack",
  "receipts",
  "status-report",
  "status-read",
]);
const scope = z.strictObject({
  operation: SyncRelayOperation,
  sharedBotId: DeviceId,
  requestDigest: SyncDigest,
});
export const SyncRelayAuthorityRequest = scope
  .extend({
    version: z.literal(1),
    peerDeviceId: DeviceId.optional(),
  })
  .refine((value) =>
    value.operation === "register" || value.operation === "discover"
      ? value.peerDeviceId === undefined
      : value.peerDeviceId !== undefined,
  );
export const SyncRelayAuthorityCheck = scope.extend({
  authority: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const SyncRelayAuthorization = scope.extend({
  version: z.literal(1),
  purpose: z.literal("replica.relay"),
  registryOrigin: z.url().refine((value) => new URL(value).origin === value),
  requester: SyncIdentity,
  holder: SyncIdentity.nullable(),
  reader: SyncIdentity.nullable(),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const SyncRelayAuthority = SyncRelayAuthorization.extend({
  authority: SyncRelayAuthorityCheck.shape.authority,
});
