import { z } from "zod";
import { canonicalDeviceJSON, DeviceId } from "./devices.ts";

export const SyncIdentity = z.strictObject({
  deviceId: DeviceId,
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(2048),
  groupId: DeviceId.nullable(),
  membershipEpoch: z.number().int().nonnegative(),
  credentialVersion: z.number().int().positive(),
});
export const SyncAccess = z.strictObject({
  sharedBotId: DeviceId,
  peerDeviceId: DeviceId,
  purpose: z.literal("replica.read"),
});
export const SyncShare = SyncAccess.omit({ purpose: true }).extend({
  enabled: z.boolean(),
});
export const SyncIncomingRequest = z.strictObject({
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(128).default(128),
});
export const SyncIncomingResult = z.strictObject({
  version: z.literal(1),
  local: SyncIdentity,
  items: z
    .array(z.strictObject({ sharedBotId: DeviceId, holder: SyncIdentity }))
    .max(128),
  nextAfter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hasMore: z.boolean(),
});
export const SyncPort = z.number().int().min(1).max(65535).nullable();
export const SyncPublish = z.strictObject({
  syncPort: SyncPort,
  expectedSelfDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const TailscaleAddress = z.union([z.ipv4(), z.ipv6()]).refine((ip) => {
  if (ip.includes(":")) return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
});
export const SyncCandidate = z.strictObject({
  address: TailscaleAddress,
  port: z.number().int().min(1).max(65535),
});
export const SyncEndpoints = z.strictObject({
  identity: SyncIdentity,
  publishedAt: z.number().int().positive(),
  candidates: z.array(SyncCandidate).max(8),
});
export const SyncIdentityResult = z.strictObject({
  version: z.literal(1),
  identity: SyncIdentity,
});
export const SyncAccessResult = z.strictObject({
  version: z.literal(1),
  sharedBotId: DeviceId,
  purpose: z.literal("replica.read"),
  local: SyncIdentity,
  peer: SyncIdentity,
  endpoints: SyncEndpoints.nullable(),
});

const syncBytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const SyncSelf = z.strictObject({
  version: z.literal(1),
  addresses: z.array(TailscaleAddress).max(8),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SyncProofRequest = z
  .strictObject({
    version: z.literal(1),
    registryOrigin: z.url().refine((value) => new URL(value).origin === value),
    role: z.enum(["reader", "server"]),
    purpose: z.literal("replica.read"),
    sharedBotId: DeviceId,
    reader: SyncIdentity,
    server: SyncIdentity,
    readerNonce: syncBytes32,
    serverNonce: syncBytes32,
    generation: syncBytes32,
    sessionId: syncBytes32,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    readerEphemeral: syncBytes32,
    serverEphemeral: syncBytes32,
  })
  .refine(
    (value) =>
      value.reader.deviceId !== value.server.deviceId &&
      value.reader.groupId !== null &&
      value.reader.groupId === value.server.groupId,
  );

/** Fixed domain and canonical typed metadata only; never caller-supplied signing bytes. */
export function syncProofPayload(input: unknown): string {
  return (
    "eagle-bots-sync-proof-v1\n" +
    canonicalDeviceJSON(SyncProofRequest.parse(input))
  );
}
