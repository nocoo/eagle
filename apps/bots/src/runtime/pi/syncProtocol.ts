import { z } from "zod";
import { ClassifiedFailure } from "../../core/domain.ts";
import {
  INVOCATION_ID,
  MAX_INVOCATION_TEXT,
  MAX_REPLICA_BODY_BYTES,
} from "../../core/RuntimePort.ts";
import { FailureClassifier } from "./classify.ts";
import {
  bundleSchema,
  entrySchema,
  hash,
  originSchema,
  resourceSchema,
  validateResource,
} from "./HistoryReplica.ts";

export const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceSchema = z.strictObject({ replicaId: z.uuid(), epoch: z.uuid() });
export const runSchema = z.strictObject({
  requestId: z.string().regex(INVOCATION_ID),
  head: digest,
  text: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= MAX_INVOCATION_TEXT),
});
const edits = z.array(
  z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("omit") }),
    z.strictObject({ action: z.literal("replace"), messages: entrySchema.shape.model.unwrap() }),
  ]),
);
const contentSchema = entrySchema.pick({ kind: true, model: true, data: true }).extend({
  edits: edits.optional(),
});
export const entryFactSchema = z.strictObject({
  kind: z.literal("entry"),
  origin: originSchema,
  content: contentSchema,
  dependencies: z.array(digest),
});
export const resourceFactSchema = z.strictObject({
  kind: z.literal("resource"),
  resource: resourceSchema,
});
export const resourceManifestSchema = z.strictObject({
  kind: z.literal("resource_manifest"),
  resources: z.array(digest).min(1),
});
export const resourceCarrierSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("resources"),
  head: digest,
  resources: z.array(resourceSchema).min(1),
});
export const resourceExportSchema = z.union([
  z.strictObject({ kind: z.literal("resources"), resources: z.array(resourceSchema).min(1) }),
  z.strictObject({ kind: z.literal("resources"), head: digest }),
]);
export const factSchema = z.discriminatedUnion("kind", [
  entryFactSchema,
  resourceFactSchema,
  resourceManifestSchema,
]);
export const headerSchema = entrySchema
  .pick({ id: true, conversationId: true, byTaskId: true, head: true })
  .extend({
    ref: digest,
    targets: z.array(integer.min(1)).optional(),
  });
export const manifestSchema = z.strictObject({
  kind: z.literal("head"),
  head: digest,
  meta: bundleSchema.omit({ entries: true, origins: true, resources: true, head: true }),
  entries: z.array(headerSchema).min(1),
  resources: z.array(digest),
});
// These are immutable historical facts, never an incoming admission command.
export const intentSchema = z.strictObject({
  kind: z.literal("run"),
  mode: z.enum(["root", "branch"]),
  requestId: z.string().min(1),
  head: digest.nullable(),
  text: z.string(),
  whenBusy: z.enum(["followUp", "steer", "reject"]).optional(),
  resourceHead: digest.optional(),
  contextId: z.string().regex(INVOCATION_ID).optional(),
  resourceVersion: z.union([z.literal(""), digest]).optional(),
});
export const bodySchema = z.discriminatedUnion("kind", [
  entryFactSchema,
  resourceFactSchema,
  resourceManifestSchema,
  manifestSchema,
  intentSchema,
]);
export const eventSchema = z.strictObject({ seq: integer.min(1), body: bodySchema });
export const pageSchema = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid(),
  source: sourceSchema,
  range: z.strictObject({ from: integer.min(1), to: integer }),
  events: z.array(eventSchema).max(128),
  nextAfter: integer,
  hasMore: z.boolean(),
});
export type Source = z.infer<typeof sourceSchema>;
export type Fact = z.infer<typeof factSchema>;
export type EntryFact = z.infer<typeof entryFactSchema>;
export type ResourceManifest = z.infer<typeof resourceManifestSchema>;
export type ResourceCarrier = z.infer<typeof resourceCarrierSchema>;
export type Header = z.infer<typeof headerSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Body = z.infer<typeof bodySchema>;
export type Intent = z.infer<typeof intentSchema>;
export type Page = z.infer<typeof pageSchema>;
export const keyOf = (fact: Fact): string =>
  hash(
    fact.kind === "entry"
      ? { origin: fact.origin }
      : fact.kind === "resource"
        ? { resource: fact.resource }
        : fact,
  );
export const resourceManifest = (resources: ResourceCarrier["resources"]): ResourceManifest => ({
  kind: "resource_manifest",
  resources: resources.map((resource) => keyOf({ kind: "resource", resource })),
});
export const validateResourceCarrier = (value: unknown): ResourceCarrier => {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPLICA_BODY_BYTES - 32)
    syncReject("resource carrier exceeds local handoff limit");
  const carrier = parse(resourceCarrierSchema, value);
  for (const resource of carrier.resources) validateResource(resource);
  if (keyOf(resourceManifest(carrier.resources)) !== carrier.head)
    syncReject("resource carrier digest mismatch");
  return carrier;
};
export const sourceKey = (source: Source): string =>
  JSON.stringify({ replicaId: source.replicaId, epoch: source.epoch });
export const syncReject = (message: string): never => {
  throw new ClassifiedFailure(
    new FailureClassifier().classify("replica:sync", "invalid_command", "runtime").classification
      .failure,
    "not_admitted",
    message,
  );
};
export const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : syncReject("invalid replica sync request");
};
export const bounded = (value: unknown): void => {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPLICA_BODY_BYTES)
    syncReject("replica sync exceeds 8 MiB limit");
};
