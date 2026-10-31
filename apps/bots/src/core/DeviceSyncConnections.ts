import { z } from "zod";
import { RelayDelivery } from "./DeviceSyncRelay.ts";
import { BOT_ID_PATTERN } from "./domain.ts";

export const syncSource = z.strictObject({ replicaId: z.uuid(), epoch: z.uuid() });
export const syncConnectionInput = z.strictObject({
  direction: z.enum(["publish", "receive", "both"]),
  source: syncSource.optional(),
});
export const syncBinding = syncSource.extend({
  localBotId: z.string().regex(BOT_ID_PATTERN),
  sharedBotId: z.uuid(),
});
export const syncUploadPage = z.strictObject({
  objectId: z.string().regex(/^[a-f0-9]{64}$/),
  source: syncSource,
  included: z
    .array(
      z.strictObject({
        seq: z.number().int().positive(),
        eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(128),
  nextAfter: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export const syncPreference = syncConnectionInput.extend({
  botId: z.string().regex(BOT_ID_PATTERN),
  peerDeviceId: z.uuid(),
  binding: syncBinding,
  pendingReceipt: z.strictObject({ peerDeviceId: z.uuid(), delivery: RelayDelivery }).optional(),
  pendingApply: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  upload: z.strictObject({
    after: z.number().int().nonnegative(),
    single: z.boolean(),
    splitThrough: z.number().int().nonnegative().default(0),
    split: syncUploadPage.optional(),
    pending: syncUploadPage.optional(),
    cloudCached: syncUploadPage
      .extend({
        firstCachedAt: z.number().int().positive(),
        expiresAt: z.number().int().positive(),
      })
      .optional(),
    expiredThrough: z.number().int().nonnegative(),
  }),
});
export const syncPreferences = z
  .strictObject({
    version: z.literal(1),
    connections: z.array(syncPreference).max(32),
  })
  .refine(
    (value) =>
      new Set(value.connections.map((p) => `${p.botId}/${p.peerDeviceId}`)).size ===
      value.connections.length,
  );
export type SyncPreference = z.infer<typeof syncPreference>;
export interface SyncConnectionsApi {
  list(botId: string, trace: string): Promise<unknown>;
  put(
    botId: string,
    peerDeviceId: string,
    value: z.infer<typeof syncConnectionInput>,
    trace: string,
  ): Promise<unknown>;
  remove(botId: string, peerDeviceId: string, trace: string): Promise<unknown>;
}
