import { z } from "zod";
import type {
  cacheAuthority,
  cacheAuthorityRequest,
  cacheListInput,
  cacheReceiveInput,
  publishedDescriptor,
} from "./DeviceSyncCache.ts";
import type {
  SyncEnvelopeRequest,
  SyncKeyDescriptor,
  SyncKeyEnvelope,
  SyncOpenRequest,
  SyncSealRequest,
  SyncSealResult,
  syncObjectPullInput,
} from "./DeviceSyncObjects.ts";
import type { relayAuthority, relayAuthorityRequest } from "./DeviceSyncRelay.ts";

export const deviceSyncPeer = z.strictObject({
  deviceId: z.uuid(),
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(2048),
  groupId: z.uuid().nullable(),
  membershipEpoch: z.number().int().nonnegative(),
  credentialVersion: z.number().int().positive(),
});
export const deviceSyncInput = z.strictObject({
  peerDeviceId: z.uuid().toLowerCase(),
  purpose: z.literal("replica.read"),
});
const address = z.union([z.ipv4(), z.ipv6()]).refine((ip) => {
  if (ip.includes(":")) return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
});
export const deviceSyncIdentity = z.strictObject({
  version: z.literal(1),
  identity: deviceSyncPeer,
});
export const deviceSyncAccess = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid(),
  purpose: z.literal("replica.read"),
  local: deviceSyncPeer,
  peer: deviceSyncPeer,
  endpoints: z
    .strictObject({
      identity: deviceSyncPeer,
      publishedAt: z.number().int().positive(),
      candidates: z
        .array(z.strictObject({ address, port: z.number().int().min(1).max(65535) }))
        .max(8),
    })
    .nullable(),
});

export const deviceSyncPeerAccess = deviceSyncAccess.extend({
  registryOrigin: z.url().refine((value) => new URL(value).origin === value),
});

/** Independently versioned from the host execution port; it carries no page bodies. */
export interface DeviceSyncPort {
  readonly version: 1;
  identity(context: { trace: string; botId: string }): Promise<z.infer<typeof deviceSyncIdentity>>;
  self?(context: { trace: string; botId: string }): Promise<z.infer<typeof deviceSyncSelf>>;
  authorize?(
    input: z.infer<typeof deviceSyncInput> & { sharedBotId: string },
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof deviceSyncPeerAccess>>;
  proof?(
    input: z.infer<typeof deviceSyncProof>,
    context: { trace: string; botId: string },
  ): Promise<{ version: 1; signature: string }>;

  publishDescriptor?(context: {
    trace: string;
    botId: string;
  }): Promise<{ version: 1; descriptor: z.infer<typeof SyncKeyDescriptor> }>;
  descriptor?(context: {
    trace: string;
    botId: string;
  }): Promise<z.infer<typeof SyncKeyDescriptor>>;
  lookup?(
    input: z.infer<typeof deviceSyncInput> & { sharedBotId: string },
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof publishedDescriptor>>;
  relayAuthority?(
    input: z.infer<typeof relayAuthorityRequest>,
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof relayAuthority>>;
  cacheAuthority?(
    input: z.infer<typeof cacheAuthorityRequest>,
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof cacheAuthority>>;
  sealKey?(
    input: z.infer<typeof SyncSealRequest>,
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof SyncSealResult>>;
  envelope?(
    input: z.infer<typeof SyncEnvelopeRequest>,
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof SyncKeyEnvelope>>;
  openKey?(
    input: z.infer<typeof SyncOpenRequest>,
    context: { trace: string; botId: string },
  ): Promise<{ version: 1; dek: string }>;
  access(
    input: z.infer<typeof deviceSyncInput> & { sharedBotId: string },
    context: { trace: string; botId: string },
  ): Promise<z.infer<typeof deviceSyncAccess>>;
}

const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const deviceSyncProof = z
  .strictObject({
    version: z.literal(1),
    registryOrigin: z.url().refine((value) => new URL(value).origin === value),
    role: z.enum(["reader", "server"]),
    purpose: z.literal("replica.read"),
    sharedBotId: z.uuid().toLowerCase(),
    reader: deviceSyncPeer,
    server: deviceSyncPeer,
    readerNonce: bytes32,
    serverNonce: bytes32,
    generation: bytes32,
    sessionId: bytes32,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    readerEphemeral: bytes32,
    serverEphemeral: bytes32,
  })
  .refine(
    (value) =>
      value.reader.deviceId !== value.server.deviceId &&
      value.reader.groupId !== null &&
      value.reader.groupId === value.server.groupId,
  );
export const deviceSyncSelf = z.strictObject({
  version: z.literal(1),
  addresses: z.array(address).max(8),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const syncPullInput = z.strictObject({
  peerDeviceId: z.uuid().toLowerCase(),
  source: z.strictObject({ replicaId: z.uuid(), epoch: z.uuid() }).optional(),
  after: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(128).default(128),
});
export type SyncStatus = {
  readonly version: 1;
  readonly instance: string;
  readonly pid: number;
  readonly binding: string | null;
  readonly ready: boolean;
  readonly actualPort: number | null;
  readonly selfDigest: string | null;
};
export interface SyncApi {
  status(): SyncStatus;
  cachePublish?(
    botId: string,
    input: z.infer<typeof syncObjectPullInput>,
    trace: string,
  ): Promise<unknown>;
  cacheList?(botId: string, input: z.infer<typeof cacheListInput>, trace: string): Promise<unknown>;
  cacheReceive?(
    botId: string,
    input: z.infer<typeof cacheReceiveInput>,
    trace: string,
  ): Promise<unknown>;
  relayAck?(botId: string, input: unknown, trace: string): Promise<unknown>;
  relayReceipts?(botId: string, input: unknown, trace: string): Promise<unknown>;
  statusReport?(botId: string, input: unknown, trace: string): Promise<unknown>;
  statusRead?(botId: string, input: unknown, trace: string): Promise<unknown>;
  relayRegister?(botId: string, trace: string): Promise<unknown>;
  relayDiscover?(botId: string, trace: string): Promise<unknown>;
  relayPull?(botId: string, input: z.infer<typeof syncPullInput>, trace: string): Promise<unknown>;
  pullObject?(
    botId: string,
    input: z.infer<typeof syncObjectPullInput>,
    trace: string,
  ): Promise<unknown>;
  applyObject?(botId: string, objectId: string, trace: string): Promise<unknown>;
  pull(botId: string, input: z.infer<typeof syncPullInput>, trace: string): Promise<unknown>;
}
