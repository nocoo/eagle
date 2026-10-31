import { createHash, randomUUID } from "node:crypto";
import { type Context, BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type AgentState,
  type ConversationId,
  type Cursor,
  defineDoc,
  defineDocFamily,
  defineEntry,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Registry,
  type Storage,
  StorageRequestError,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { ClassifiedFailure } from "../../core/domain.ts";
import {
  INVOCATION_ID,
  MAX_INVOCATION_TEXT,
  MAX_REPLICA_BODY_BYTES,
  type RuntimeHandle,
} from "../../core/RuntimePort.ts";
import { FailureClassifier } from "./classify.ts";
import { HistoryResources, RESOURCE_EXTENSION, ResourcePin } from "./HistoryResources.ts";
import { historyMessage } from "./historyMessages.ts";
import { convertSubmission } from "./mapEvents.ts";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestIdSchema = z.string().regex(INVOCATION_ID);
const receiptSchema = z.object({ conversationId: id, entries: z.record(z.string(), id) });
export const entrySchema = z.strictObject({
  id,
  conversationId: id,
  byTaskId: id.optional(),
  kind: z.string().min(1),
  model: z.array(historyMessage).optional(),
  data: z.json().optional(),
  head: id.optional(),
  edits: z
    .array(
      z.discriminatedUnion("action", [
        z.strictObject({ target: id, action: z.literal("omit") }),
        z.strictObject({
          target: id,
          action: z.literal("replace"),
          messages: z.array(historyMessage),
        }),
      ]),
    )
    .optional(),
});
const agentSchema = z.strictObject({
  model: z.strictObject({ provider: z.string(), modelId: z.string() }).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  extensions: z
    .union([
      z.array(z.string()),
      z.strictObject({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
  tools: z.union([z.array(z.string()), z.strictObject({ remove: z.array(z.string()) })]).optional(),
  modelTools: z
    .union([
      z.array(z.string()),
      z.strictObject({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
  instructions: z.string().optional(),
  cwd: z.string().optional(),
});
export const resourceSchema = z.strictObject({
  name: z.string().min(1).max(4096),
  kind: z.enum(["attachment", "instructions", "skill"]),
  sha256: digest,
  base64: z.string(),
});
export const originSchema = z.strictObject({
  replicaId: z.uuid(),
  conversationId: id,
  entryId: id,
  taskId: id.optional(),
});
const payloadSchema = z.strictObject({
  version: z.literal(1),
  engine: z.literal("pi-durable@1.4.0"),
  source: z.strictObject({ replicaId: z.uuid(), botId: z.string().min(1), conversationId: id }),
  parents: z.array(digest),
  entries: z.array(entrySchema).min(1),
  origins: z.record(z.string(), originSchema),
  agent: agentSchema,
  resources: z.array(resourceSchema),
});
export const bundleSchema = payloadSchema.extend({ head: digest });
export const exportSchema = z.strictObject({
  head: digest.optional(),
  branch: requestIdSchema.optional(),
  contextId: requestIdSchema.optional(),
  resources: z.array(resourceSchema).optional(),
});
export type HistoryBundle = z.infer<typeof bundleSchema>;
export const mergeSchema = z.strictObject({
  requestId: requestIdSchema,
  heads: z.tuple([digest, digest]),
  choices: z.array(z.strictObject({ origin: originSchema, head: digest })).default([]),
  resources: z.array(z.strictObject({ name: z.string().min(1), sha256: digest })).default([]),
});
export const mergePreviewSchema = z.strictObject({
  preview: z.literal(true),
  heads: z.tuple([digest, digest]),
});
export const mergeRequestSchema = z.union([mergeSchema, mergePreviewSchema]);
type MergePreview = {
  conflicts: {
    origin: MergeOrigin;
    options: { head: string; action: string; messageCount: number; digest: string }[];
  }[];
  resources: { name: string; versions: { sha256: string; kind: string; heads: string[] }[] }[];
};
type MergeOrigin = { replicaId: string; conversationId: number; entryId: number; taskId?: number };
const mergeOrigin = (value: z.infer<typeof originSchema>): MergeOrigin => ({
  replicaId: value.replicaId,
  conversationId: value.conversationId,
  entryId: value.entryId,
  ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
});
export const MergeContribution = defineEntry<{
  origin: MergeOrigin;
  parentHead: string;
  entryId: number;
  effect: { action: string; origin?: MergeOrigin };
  toolIds: { original: string; mapped: string }[];
  group: string;
  index: number;
  size: number;
}>("bots.merge.contribution");
const mergeContributionSchema = z.object({
  origin: originSchema,
  effect: z.object({ action: z.string(), origin: originSchema.optional() }),
  toolIds: z.array(z.strictObject({ original: z.string(), mapped: z.string() })),
});
const merges = defineDocFamily({
  kind: "bots.replica.merge",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ input: "", head: "" }),
  checkpointWhen: () => true,
});

const identity = defineDoc({
  kind: "bots.replica.identity",
  version: 1,
  scope: "session",
  initial: () => ({ replicaId: randomUUID() }),
  checkpointWhen: () => true,
});
const imports = defineDocFamily({
  kind: "bots.replica.import",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({
    bundle: "",
    manifest: "",
    conversationId: 0,
    entries: {} as Record<string, number>,
  }),
  checkpointWhen: () => true,
});
const runs = defineDocFamily({
  kind: "bots.replica.run",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ head: "", text: "", conversationId: 0 }),
  checkpointWhen: () => true,
});
const contexts = defineDocFamily({
  kind: "bots.replica.context",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ head: "", resourceHead: "", conversationId: 0 }),
  checkpointWhen: () => true,
});
export const contextSchema = z.strictObject({
  contextId: requestIdSchema,
  head: digest.optional(),
  resourceHead: digest.optional(),
});
export const LocalContext = defineDoc({
  kind: "bots.replica.context.selection",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ contextId: "", head: "", resourceHead: "" }),
  checkpointWhen: () => true,
});

/** SDK prompt sections use object insertion order, so sorting JSON changes history semantics. */
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reject = (message: string): never => {
  throw new ClassifiedFailure(
    new FailureClassifier().classify("replica:preflight", "invalid_command", "runtime")
      .classification.failure,
    "not_admitted",
    message,
  );
};
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  return result.success ? result.data : reject("invalid replica request");
};

const carrierReceipt = (encoded: string): HistoryBundle => {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof SyntaxError) reject("invalid history receipt");
    throw error;
  }
  return validateBundle(value);
};

export const validateBundle = (value: unknown): HistoryBundle => {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPLICA_BODY_BYTES - 32)
    reject("history exceeds local handoff limit");
  return validateHistory(value);
};

/** Complete history integrity is independent of the public P0 carrier byte limit. */
export const validateHistory = (value: unknown): HistoryBundle => {
  const bundle = parsed(bundleSchema, value);
  const { head, ...payload } = bundle;
  if (hash(payload) !== head) reject("history digest mismatch");
  const seen = new Set<number>();
  let previous = 0;
  for (const entry of bundle.entries) {
    if (entry.id <= previous || seen.has(entry.id)) reject("unordered history");
    if (entry.head !== undefined && entry.head !== entry.id && !seen.has(entry.head))
      reject("missing head dependency");
    if (entry.edits?.some((edit) => !seen.has(edit.target))) reject("missing edit dependency");
    if (bundle.origins[String(entry.id)] === undefined) reject("missing entry origin");
    seen.add(entry.id);
    previous = entry.id;
  }
  if (
    Object.keys(bundle.origins).some((key) => !seen.has(Number(key))) ||
    Object.keys(bundle.origins).length !== seen.size
  )
    reject("missing entry for original provenance");
  for (const resource of bundle.resources) validateResource(resource);
  return bundle;
};

/** Shared raw resource integrity check; receipt ACKs cannot precede this validation. */
export const validateResource = (resource: z.infer<typeof resourceSchema>): void => {
  const bytes = Buffer.from(resource.base64, "base64");
  if (
    bytes.toString("base64") !== resource.base64 ||
    createHash("sha256").update(bytes).digest("hex") !== resource.sha256
  )
    reject("invalid resource bytes");
};

/** Public SDK commits only: imported entries cannot create a submission or a task. */
export class HistoryReplica {
  readonly #harness: Harness;
  readonly #rootId: ConversationId;
  readonly #botId: string;
  readonly #cwd: string;
  readonly #registry: Registry;
  readonly #storage: Pick<Storage, "scanDocuments" | "document">;
  readonly #resources: HistoryResources;

  constructor(
    harness: Harness,
    rootId: ConversationId,
    botId: string,
    cwd: string,
    registry: Registry,
    storage: Pick<Storage, "scanDocuments" | "document">,
    stateDir: string,
  ) {
    this.#harness = harness;
    this.#rootId = rootId;
    this.#botId = botId;
    this.#cwd = cwd;
    this.#registry = registry;
    this.#storage = storage;
    this.#resources = new HistoryResources(`${stateDir}/resources`, registry, harness);
  }

  async prepareResources(): Promise<void> {
    await this.#resources.validatePins(this.#harness);
  }

  async installResources(bundle: Pick<HistoryBundle, "resources">): Promise<string> {
    try {
      return await this.#resources.install(bundle.resources);
    } catch (cause) {
      if (cause instanceof ClassifiedFailure) throw cause;
      if (!(cause instanceof Error) || !("code" in cause)) throw cause;
      throw new ClassifiedFailure(
        new FailureClassifier().classify("replica:resources:install", "storage_failed", "runtime")
          .classification.failure,
        "not_admitted",
        "resource installation failed",
        { cause },
      );
    }
  }

  async replicaId(): Promise<string> {
    return this.#harness.commit(async (tx) => (await tx.doc(identity)).replicaId, ctx);
  }

  async materialize(
    value: unknown,
    prefix: { head: string; entries: number[] } | null,
  ): Promise<{ head: string }> {
    const bundle = validateHistory(value);
    await this.#harness.commit(async (tx) => {
      const receipt = await tx.doc(imports, bundle.head, null);
      if (receipt.conversationId !== 0) return;
      const previous = prefix === null ? undefined : await tx.doc(imports, prefix.head, null);
      const tail = prefix?.entries.at(-1);
      const at = tail === undefined ? undefined : previous?.entries[String(tail)];
      if (
        prefix !== null &&
        (previous?.conversationId === 0 ||
          at === undefined ||
          prefix.entries.length > bundle.entries.length)
      )
        reject("missing complete passive prefix");
      const conversation =
        prefix === null
          ? await tx.createConversation({ ownership: { kind: "ownerless" } })
          : await tx.forkConversation(
              (previous?.conversationId ?? reject("missing prefix conversation")) as ConversationId,
              at as EntryId,
              { ownership: { kind: "ownerless" } },
            );
      const agent = await tx.doc(AgentDoc, conversation.id);
      for (const key of Object.keys(agent) as (keyof AgentState)[]) delete agent[key];
      Object.assign(agent, bundle.agent);
      for (let index = 0; index < bundle.entries.length; index += 1) {
        const original = bundle.entries[index];
        if (original === undefined) return reject("missing complete entry");
        if (prefix !== null && index < prefix.entries.length) {
          receipt.entries[String(original.id)] =
            previous?.entries[String(prefix.entries[index])] ??
            reject("missing prefix entry mapping");
          continue;
        }
        const { id: sourceId, head, edits } = original;
        const draft: EntryDraft = {
          kind: original.kind,
          ...(original.model === undefined ? {} : { model: original.model }),
          ...(original.data === undefined ? {} : { data: original.data }),
          ...(head === undefined
            ? {}
            : { head: head === sourceId ? "self" : (receipt.entries[String(head)] as EntryId) }),
          ...(edits === undefined
            ? {}
            : {
                edits: edits.map((edit) => ({
                  ...edit,
                  target: receipt.entries[String(edit.target)] as EntryId,
                })),
              }),
        };
        receipt.entries[String(sourceId)] = (await tx.appendEntry(conversation.id, draft)).id;
      }
      receipt.conversationId = conversation.id;
      receipt.manifest = bundle.head;
    }, ctx);
    return { head: bundle.head };
  }

  /** Only the explicit P0 carrier API stores a complete bundle in the SDK receipt. */
  async carrier(value: unknown): Promise<HistoryBundle> {
    const bundle = validateBundle(value);
    await this.#harness.commit(async (tx) => {
      const receipt = await tx.doc(imports, bundle.head, null);
      if (receipt.conversationId === 0) return reject("missing carrier receipt");
      receipt.bundle = JSON.stringify(bundle);
    }, ctx);
    return bundle;
  }

  async exportBranch(parent: HistoryBundle, params: unknown): Promise<HistoryBundle> {
    return this.#export(params, validateHistory(parent));
  }

  /** Explicit edits derive from a fixed receipt, never the active root's tail. */
  async exportResources(
    value: unknown,
    resources: HistoryBundle["resources"],
  ): Promise<HistoryBundle> {
    const base = validateBundle(value);
    const mapped = await this.checkedEntries(base, await this.receipt(base.head));
    const origins: HistoryBundle["origins"] = {};
    mapped.entries.forEach((entry, index) => {
      const original = base.entries[index] ?? reject("missing resource base entry");
      origins[String(entry.id)] =
        base.origins[String(original.id)] ?? reject("missing resource base origin");
    });
    const { head: _baseHead, ...original } = base;
    const payload = parsed(payloadSchema, {
      ...original,
      source: {
        replicaId: await this.replicaId(),
        botId: this.#botId,
        conversationId: mapped.conversationId,
      },
      parents: [base.head],
      entries: mapped.entries,
      origins,
      resources,
    });
    const bundle = validateBundle({ ...payload, head: hash(payload) });
    await this.pinLocal(bundle);
    return this.carrier(bundle);
  }

  async runFrom(value: unknown, params: unknown): Promise<unknown> {
    const bundle = validateHistory(value);
    return this.#run(params, bundle);
  }

  /** A bounded SDK fork pins native history without appending duplicate entries. */
  async pinLocal(value: unknown): Promise<{ head: string }> {
    const bundle = validateHistory(value);
    await this.#harness.commit(async (tx) => {
      if (
        bundle.source.replicaId !== (await tx.doc(identity)).replicaId ||
        bundle.source.botId !== this.#botId
      )
        reject("cannot pin another source as local");
      const receipt = await tx.doc(imports, bundle.head, null);
      if (receipt.conversationId !== 0) return;
      const tail = bundle.entries.at(-1);
      if (tail === undefined) return reject("missing local head tail");
      const fork = await tx.forkConversation(
        bundle.source.conversationId as ConversationId,
        tail.id as EntryId,
        { ownership: { kind: "ownerless" } },
      );
      const agent = await tx.doc(AgentDoc, fork.id);
      for (const key of Object.keys(agent) as (keyof AgentState)[]) delete agent[key];
      Object.assign(agent, bundle.agent);
      receipt.conversationId = fork.id;
      for (const entry of bundle.entries) receipt.entries[String(entry.id)] = entry.id;
      receipt.manifest = bundle.head;
    }, ctx);
    return { head: bundle.head };
  }

  async receipt(head: string) {
    return this.#harness.snapshot(imports, head, ctx);
  }

  async checkedEntries(bundle: HistoryBundle, value: unknown) {
    const receipt = parsed(receiptSchema, value);
    return this.#harness.commit(async (tx) => {
      if ((await tx.conversation(receipt.conversationId as ConversationId)) === undefined)
        return reject("missing receipt conversation");
      const entries: HistoryBundle["entries"] = [];
      for (const original of bundle.entries) {
        const local =
          receipt.entries[String(original.id)] ?? reject("missing receipt entry mapping");
        const page = await tx.scanEntries(
          {
            conversationId: receipt.conversationId as ConversationId,
            minEntryId: local as EntryId,
            maxEntryId: local as EntryId,
            order: "ascending",
          },
          1,
        );
        const record = page.items[0] ?? reject("missing visible receipt entry");
        const mapped = parsed(entrySchema, record);
        const { id: _id, conversationId: _conversation, byTaskId: _task, ...content } = original;
        const {
          id: _local,
          conversationId: _localConversation,
          byTaskId: _localTask,
          ...actual
        } = mapped;
        const expected = {
          ...content,
          ...(original.head === undefined ? {} : { head: receipt.entries[String(original.head)] }),
          ...(original.edits === undefined
            ? {}
            : {
                edits: original.edits.map((edit) => ({
                  ...edit,
                  target: receipt.entries[String(edit.target)],
                })),
              }),
        };
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          reject("history receipt entry content mismatch");
        entries.push(mapped);
      }
      return { conversationId: receipt.conversationId, entries };
    }, ctx);
  }

  async #readReceipt<T>(read: () => Promise<T>, context: Context): Promise<T> {
    await this.#harness.commit(() => undefined, context);
    let value: T;
    try {
      value = await read();
    } catch (cause) {
      if (!(cause instanceof StorageRequestError) && context.abortSignal?.aborted !== true) {
        // Public close seals immediately; the SDK reports any secondary close failure.
        void this.#harness.close(ctx).catch(() => undefined);
      }
      throw cause;
    }
    await this.#harness.commit(() => undefined, context);
    return value;
  }

  async receipts(params: unknown, context: Context = ctx) {
    const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
    const input = parsed(
      z.strictObject({ after: integer, limit: integer.min(1).max(128).default(128) }),
      params,
    );
    const items: { id: number; head: string }[] = [];
    let cursor: Cursor | undefined;
    let nextAfter = input.after;
    let checked = 0;
    do {
      const page = await this.#readReceipt(
        () =>
          this.#storage.scanDocuments(
            { scope: { kind: "session" }, at: "current", kind: imports.definition.kind },
            128,
            cursor,
            context,
          ),
        context,
      );
      for (let index = 0; index < page.items.length; index += 1) {
        const record = page.items[index];
        if (record === undefined || record.id <= input.after) continue;
        const head = parsed(digest, record.key);
        const stored = await this.#readReceipt(
          () => this.#storage.document(record.id, "current", context),
          context,
        );
        if (stored === undefined || stored.version !== 1)
          return reject("missing or unsupported history receipt");
        const encoded = stored.value.bundle;
        if (encoded !== "") {
          if (typeof encoded !== "string") return reject("invalid history receipt carrier");
          const bundle = carrierReceipt(encoded);
          if (bundle.head !== head) reject("history receipt head mismatch");
          await this.checkedEntries(bundle, stored.value);
          items.push({ id: record.id, head });
        }
        nextAfter = record.id;
        checked += 1;
        if (checked === input.limit)
          return {
            items,
            nextAfter,
            hasMore: index + 1 < page.items.length || page.next !== undefined,
          };
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return { items, nextAfter, hasMore: false };
  }

  async branch(requestId: string) {
    return this.#harness.snapshot(runs, hash(requestId), ctx);
  }

  async contextInfo(contextId: string) {
    parsed(requestIdSchema, contextId);
    const stored = await this.#harness.snapshot(contexts, contextId, ctx);
    if (stored === undefined || stored.conversationId === 0) return reject("unknown local context");
    return stored;
  }

  async createContext(bundle: HistoryBundle, params: unknown, guard: () => void) {
    const input = parsed(contextSchema, params);
    if (input.head !== bundle.head) reject("context seed binding mismatch");
    const receipt = await this.receipt(bundle.head);
    const mapped = await this.checkedEntries(bundle, receipt);
    return this.#harness.commit(async (tx) => {
      guard();
      const local = await tx.doc(contexts, input.contextId, null);
      const resourceHead = input.resourceHead ?? bundle.head;
      if (local.conversationId !== 0) {
        if (local.head !== bundle.head || local.resourceHead !== resourceHead)
          reject("context seed binding conflict");
        return {
          contextId: input.contextId,
          seedHead: local.head,
          resourceHead: local.resourceHead,
        };
      }
      const tail = mapped.entries.at(-1)?.id ?? reject("empty context seed");
      const conversation = await tx.forkConversation(
        mapped.conversationId as ConversationId,
        tail as EntryId,
        { ownership: { kind: "ownerless" } },
      );
      const agent = await tx.doc(AgentDoc, conversation.id);
      for (const key of Object.keys(agent) as (keyof AgentState)[]) delete agent[key];
      Object.assign(agent, bundle.agent, { cwd: this.#cwd });
      local.head = bundle.head;
      local.resourceHead = resourceHead;
      local.conversationId = conversation.id;
      Object.assign(await tx.doc(LocalContext, conversation.id), {
        contextId: input.contextId,
        head: bundle.head,
        resourceHead,
      });
      guard();
      return { contextId: input.contextId, seedHead: local.head, resourceHead: local.resourceHead };
    }, ctx);
  }

  /** Each effective message has a real entry; a group retains its complete original origin. */
  async mergeFrom(
    values: readonly HistoryBundle[],
    params: unknown,
    guard: () => void = () => undefined,
  ): Promise<{ head: string }> {
    const result = await this.#merge(values, params, false, guard);
    return "head" in result ? result : reject("missing merge result");
  }

  async previewMerge(
    values: readonly HistoryBundle[],
    params: unknown,
    guard: () => void = () => undefined,
  ): Promise<MergePreview> {
    const result = await this.#merge(values, params, true, guard);
    return "conflicts" in result ? result : reject("missing merge preview");
  }

  async #merge(
    values: readonly HistoryBundle[],
    params: unknown,
    preview: boolean,
    guard: () => void,
  ): Promise<{ head: string } | MergePreview> {
    const input = preview
      ? { ...parsed(mergePreviewSchema, params), requestId: "", choices: [], resources: [] }
      : parsed(mergeSchema, params);
    if (input.heads[0] === input.heads[1]) reject("merge requires two distinct heads");
    const bundles = values.map(validateBundle);
    if (bundles.length !== 2 || bundles.some((bundle, index) => bundle.head !== input.heads[index]))
      reject("merge parent binding mismatch");
    const saved = preview
      ? undefined
      : await this.#harness.snapshot(merges, hash(input.requestId), ctx);
    const encoded = JSON.stringify(input);
    if (saved?.head) {
      if (saved.input !== encoded) reject("merge request id conflict");
      guard();
      return { head: saved.head };
    }
    type Contribution = {
      origin: MergeOrigin;
      parentHead: string;
      entryId: number;
      model: NonNullable<HistoryBundle["entries"][number]["model"]>;
      effect: { action: string; origin?: MergeOrigin };
      toolIds: { original: string; mapped: string }[];
    };
    const candidates = new Map<string, Contribution[]>();
    for (const bundle of bundles) {
      const receipt = await this.receipt(bundle.head);
      const mapped = await this.checkedEntries(bundle, receipt);
      const conversation = await this.#harness.conversation(
        mapped.conversationId as ConversationId,
        ctx,
      );
      if (conversation === undefined) return reject("missing merge parent conversation");
      const tail = mapped.entries.at(-1)?.id ?? reject("empty merge parent");
      const view = await conversation.context(ctx, { at: tail as EntryId });
      const active = new Map<number, (typeof view.contributions)[number] | undefined>(
        view.entries.map((entry, index) => [entry.id, view.contributions[index]]),
      );
      const originalByLocal = new Map(
        mapped.entries.map((entry, index) => [
          entry.id,
          bundle.entries[index] ?? reject("missing merge source entry"),
        ]),
      );
      const canonical = (original: HistoryBundle["entries"][number]) =>
        mergeOrigin(
          original.kind === MergeContribution.kind
            ? parsed(z.object({ origin: originSchema }), original.data).origin
            : (bundle.origins[String(original.id)] ?? reject("missing merge origin")),
        );
      const effects = new Map<number, Contribution["effect"]>();
      for (const [index, entry] of mapped.entries.entries()) {
        if (entry.id < (view.head?.head ?? 0)) continue;
        const original = bundle.entries[index] ?? reject("missing merge edit");
        for (const edit of entry.edits ?? [])
          effects.set(edit.target, { action: edit.action, origin: canonical(original) });
      }
      const toolIds = new Map<string, string>();
      const normalized = new Map<number, Pick<Contribution, "model" | "toolIds">>();
      for (const entry of view.entries) {
        const original = originalByLocal.get(entry.id) ?? reject("missing active merge origin");
        const origin = canonical(original);
        const mappings: Contribution["toolIds"] = [];
        const model = parsed(z.array(historyMessage), active.get(entry.id) ?? []).map((message) => {
          if (message.role === "assistant")
            return {
              ...message,
              content: message.content.map((part) => {
                if (part.type !== "toolCall") return part;
                const prior =
                  original.kind === MergeContribution.kind
                    ? parsed(mergeContributionSchema, original.data).toolIds.find(
                        (item) => item.mapped === part.id,
                      )
                    : undefined;
                const originalId = prior?.original ?? part.id;
                const mappedId = `merge_${hash({ origin, id: originalId }).slice(0, 40)}`;
                toolIds.set(part.id, mappedId);
                mappings.push({ original: originalId, mapped: mappedId });
                return { ...part, id: mappedId };
              }),
            };
          if (message.role !== "toolResult") return message;
          const mappedId =
            toolIds.get(message.toolCallId) ?? reject("merge tool result has no original call");
          const prior =
            original.kind === MergeContribution.kind
              ? parsed(mergeContributionSchema, original.data).toolIds.find(
                  (item) => item.mapped === message.toolCallId,
                )
              : undefined;
          mappings.push({ original: prior?.original ?? message.toolCallId, mapped: mappedId });
          return { ...message, toolCallId: mappedId };
        });
        normalized.set(entry.id, { model, toolIds: mappings });
      }
      // SDK context moves its current baseline ahead of retained pre-compaction messages.
      const baseline = view.messages[0]?.role === "system" ? view.messages[0] : undefined;
      const baselineEntry =
        baseline === undefined
          ? undefined
          : view.entries.find((entry) =>
              active
                .get(entry.id)
                ?.some((message) => JSON.stringify(message) === JSON.stringify(baseline)),
            );
      const ordered = [
        ...(baselineEntry === undefined ? [] : [baselineEntry]),
        ...view.entries.filter((entry) => entry.id !== baselineEntry?.id),
        ...mapped.entries.filter((entry) => !active.has(entry.id)),
      ];
      for (const local of ordered) {
        const original = originalByLocal.get(local.id) ?? reject("missing merge entry");
        const origin = canonical(original);
        const inheritedEffect =
          original.kind === MergeContribution.kind
            ? parsed(
                z.object({
                  effect: z.object({ action: z.string(), origin: originSchema.optional() }),
                }),
                original.data,
              ).effect
            : { action: "unchanged" };
        const item: Contribution = {
          origin,
          parentHead: bundle.head,
          entryId: original.id,
          effect:
            effects.get(local.id) ??
            (active.has(local.id)
              ? {
                  action: inheritedEffect.action,
                  ...(inheritedEffect.origin === undefined
                    ? {}
                    : { origin: mergeOrigin(inheritedEffect.origin) }),
                }
              : { action: "inactive" }),
          ...(normalized.get(local.id) ?? { model: [], toolIds: [] }),
        };
        const key = hash(origin);
        const options = candidates.get(key) ?? [];
        const prior = options.find((candidate) => candidate.parentHead === bundle.head);
        if (prior !== undefined) {
          if (original.kind !== MergeContribution.kind)
            reject("duplicate effective origin in merge parent");
          prior.model.push(...item.model);
          prior.toolIds.push(...item.toolIds);
          if (effects.has(local.id)) prior.effect = item.effect;
        } else options.push(item);
        candidates.set(key, options);
      }
    }
    const files = new Map<string, HistoryBundle["resources"]>();
    for (const bundle of bundles)
      for (const resource of bundle.resources) {
        const versions = files.get(resource.name) ?? [];
        if (
          !versions.some((item) => item.sha256 === resource.sha256 && item.kind === resource.kind)
        )
          versions.push(resource);
        files.set(resource.name, versions);
      }
    if (preview) {
      const conflicts = [...candidates.values()].flatMap((options) => {
        const first = options[0] ?? reject("missing merge contribution");
        if (
          options.every(
            (item) =>
              hash({ model: item.model, effect: item.effect }) ===
              hash({ model: first.model, effect: first.effect }),
          )
        )
          return [];
        return [
          {
            origin: first.origin,
            options: options.map((item) => ({
              head: item.parentHead,
              action: item.effect.action,
              messageCount: item.model.length,
              digest: hash({ model: item.model, effect: item.effect }),
            })),
          },
        ];
      });
      const resources = [...files].map(([name, options]) => ({
        name,
        versions: options.map((item) => ({
          sha256: item.sha256,
          kind: item.kind,
          heads: bundles
            .filter((bundle) =>
              bundle.resources.some(
                (file) =>
                  file.name === name && file.kind === item.kind && file.sha256 === item.sha256,
              ),
            )
            .map((bundle) => bundle.head),
        })),
      }));
      const result = { conflicts, resources };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_REPLICA_BODY_BYTES)
        reject("merge preview exceeds local page limit");
      guard();
      return result;
    }
    const choices = new Map(input.choices.map((choice) => [hash(choice.origin), choice.head]));
    if (choices.size !== input.choices.length) reject("duplicate merge choice");
    for (const [key, head] of choices)
      if (!candidates.get(key)?.some((item) => item.parentHead === head))
        reject("unknown merge origin choice");
    const selected: Contribution[] = [];
    for (const [key, options] of candidates) {
      const first = options[0] ?? reject("missing merge contribution");
      const explicit = choices.get(key);
      const conflicts = options.some(
        (item) =>
          JSON.stringify({ model: item.model, effect: item.effect }) !==
          JSON.stringify({ model: first.model, effect: first.effect }),
      );
      if (conflicts && explicit === undefined)
        reject("merge contribution conflict requires a choice");
      selected.push(
        explicit === undefined
          ? first
          : (options.find((item) => item.parentHead === explicit) ??
              reject("missing selected merge contribution")),
      );
    }
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const contribution of selected)
      for (const message of contribution.model) {
        if (message.role === "assistant")
          for (const part of message.content) {
            if (part.type !== "toolCall") continue;
            if (calls.has(part.id)) reject("merge tool call conflict");
            calls.add(part.id);
          }
        if (message.role === "toolResult") {
          if (!calls.has(message.toolCallId) || results.has(message.toolCallId))
            reject("merge tool result conflict");
          results.add(message.toolCallId);
        }
      }
    if (calls.size !== results.size) reject("merge tool result conflict requires a complete pair");
    const versions = new Map(input.resources.map((item) => [item.name, item.sha256]));
    if (versions.size !== input.resources.length) reject("duplicate merge resource choice");
    for (const [name, sha] of versions)
      if (!files.get(name)?.some((item) => item.sha256 === sha))
        reject("unknown merge resource choice");
    const resources = [...files].map(([name, options]) => {
      const sha = versions.get(name);
      if (options.length > 1 && sha === undefined)
        reject("merge resource conflict requires a choice");
      return (
        (sha === undefined ? options[0] : options.find((item) => item.sha256 === sha)) ??
        reject("missing selected resource")
      );
    });
    // Validate/install immutable resources before committing the passive context; no task is admitted.
    guard();
    const version = await this.installResources({ resources });
    return this.#harness.commit(async (tx) => {
      guard();
      const merge = await tx.doc(merges, hash(input.requestId), null);
      if (merge.head !== "") {
        if (merge.input !== encoded) reject("merge request id conflict");
        return { head: merge.head };
      }
      const parent = bundles[0] ?? reject("missing first merge parent");
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const agent = await tx.doc(AgentDoc, conversation.id);
      for (const key of Object.keys(agent) as (keyof AgentState)[]) delete agent[key];
      Object.assign(agent, parent.agent);
      if (version !== "") {
        const extensions = agent.extensions;
        agent.extensions = Array.isArray(extensions)
          ? [...new Set([...extensions, RESOURCE_EXTENSION])]
          : {
              ...extensions,
              add: [...new Set([...(extensions?.add ?? []), RESOURCE_EXTENSION])],
              ...(extensions?.remove === undefined
                ? {}
                : { remove: extensions.remove.filter((name) => name !== RESOURCE_EXTENSION) }),
            };
        (await tx.doc(ResourcePin, conversation.id)).version = version;
      }
      const entries: HistoryBundle["entries"] = [];
      for (const contribution of selected) {
        const messages = contribution.model.length === 0 ? [undefined] : contribution.model;
        for (const [index, message] of messages.entries())
          entries.push(
            parsed(
              entrySchema,
              await tx.appendEntry(conversation.id, {
                kind: MergeContribution.kind,
                model: message === undefined ? [] : [message],
                data: {
                  origin: contribution.origin,
                  parentHead: contribution.parentHead,
                  entryId: contribution.entryId,
                  effect: contribution.effect,
                  toolIds: contribution.toolIds,
                  group: hash(contribution.origin),
                  index,
                  size: contribution.model.length,
                },
              }),
            ),
          );
      }
      const replicaId = (await tx.doc(identity)).replicaId;
      const origins: HistoryBundle["origins"] = {};
      for (const entry of entries)
        origins[String(entry.id)] = {
          replicaId,
          conversationId: conversation.id,
          entryId: entry.id,
        };
      const payload = parsed(payloadSchema, {
        version: 1,
        engine: "pi-durable@1.4.0",
        source: { replicaId, botId: this.#botId, conversationId: conversation.id },
        parents: input.heads,
        entries,
        origins,
        agent: JSON.parse(JSON.stringify(agent)),
        resources,
      });
      const bundle = validateBundle({ ...payload, head: hash(payload) });
      const receipt = await tx.doc(imports, bundle.head, null);
      receipt.conversationId = conversation.id;
      receipt.manifest = bundle.head;
      receipt.bundle = JSON.stringify(bundle);
      for (const entry of entries) receipt.entries[String(entry.id)] = entry.id;
      merge.input = encoded;
      merge.head = bundle.head;
      guard();
      return { head: bundle.head };
    }, ctx);
  }

  async command(command: Parameters<NonNullable<RuntimeHandle["replica"]>>[0]): Promise<unknown> {
    switch (command.method) {
      case "merge": {
        const input = parsed(mergeRequestSchema, command.params);
        const bundles = await Promise.all(
          input.heads.map(async (head) => {
            const receipt = await this.receipt(head);
            return receipt?.bundle ? carrierReceipt(receipt.bundle) : reject("unknown merge head");
          }),
        );
        return "preview" in input
          ? this.previewMerge(bundles, input, command.guard)
          : this.mergeFrom(bundles, input, command.guard);
      }
      case "import": {
        const { bundle } = parsed(z.strictObject({ bundle: z.unknown() }), command.params);
        return this.#import(validateBundle(bundle));
      }
      case "export":
        return this.#export(command.params);
      case "run":
        return this.#run(command.params);
      case "status": {
        const { requestId } = parsed(
          z.strictObject({ requestId: requestIdSchema }),
          command.params,
        );
        const run = await this.#harness.snapshot(runs, hash(requestId), ctx);
        if (run === undefined || run.conversationId === 0) return { submission: null };
        const record = await this.#harness.commit(
          (tx) => tx.submissionByRequest(run.conversationId as ConversationId, requestId),
          ctx,
        );
        return {
          branch: requestId,
          submission: record === undefined ? null : convertSubmission(record),
        };
      }
    }
  }

  async #import(bundle: HistoryBundle): Promise<{ head: string }> {
    const result = await this.materialize(bundle, null);
    await this.carrier(bundle);
    return result;
  }

  async #export(params: unknown, suppliedParent?: HistoryBundle): Promise<HistoryBundle> {
    const input = parsed(exportSchema, params);
    if (input.contextId !== undefined && (input.head !== undefined || input.branch !== undefined))
      reject("select one context or head");
    if (input.head !== undefined) {
      if (input.branch !== undefined) reject("select one immutable head");
      const receipt = await this.#harness.snapshot(imports, input.head, ctx);
      const base = receipt?.bundle
        ? carrierReceipt(receipt.bundle)
        : reject("unknown history head");
      return input.resources === undefined ? base : this.exportResources(base, input.resources);
    }
    const run =
      input.contextId !== undefined
        ? await this.contextInfo(input.contextId)
        : input.branch === undefined
          ? undefined
          : await this.#harness.snapshot(runs, hash(input.branch), ctx);
    if (input.branch !== undefined && (run === undefined || run.conversationId === 0))
      reject("unknown local branch");
    const inherited =
      run === undefined ? undefined : await this.#harness.snapshot(imports, run.head, ctx);
    const parent =
      suppliedParent ?? (inherited?.bundle ? carrierReceipt(inherited.bundle) : undefined);
    if (run !== undefined && parent?.head !== run.head) reject("missing selected parent manifest");
    const conversationId = (run?.conversationId ?? this.#rootId) as ConversationId;
    const payload = await this.#harness.commit(async (tx) => {
      let cursor: Cursor | undefined;
      let ancestor: ConversationId | undefined = conversationId;
      let checkBusy = true;
      while (ancestor !== undefined) {
        if (parent !== undefined && ancestor === inherited?.conversationId) checkBusy = false;
        do {
          const page = await tx.scanTasks({ conversationId: ancestor }, 128, cursor);
          if (checkBusy && page.items.some((task) => task.state.status !== "terminal"))
            reject("history is not a complete head");
          if (
            page.items.some(
              (task) =>
                task.kind === "pi.tool" &&
                task.input !== null &&
                typeof task.input === "object" &&
                !Array.isArray(task.input) &&
                task.input.kind === "nested",
            )
          )
            reject("nested tool results are unsupported by P0 history export");
          cursor = page.next;
        } while (cursor !== undefined);
        ancestor = (await tx.conversation(ancestor))?.parent?.conversationId;
      }
      const entries: EntryRecord[] = [];
      let bytes = 0;
      do {
        const page = await tx.scanEntries({ conversationId, order: "ascending" }, 128, cursor);
        bytes += Buffer.byteLength(JSON.stringify(page.items));
        if (bytes > MAX_REPLICA_BODY_BYTES - 32) reject("history exceeds local handoff limit");
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      if (entries.length === 0) reject("history is empty");
      const source = await tx.doc(identity);
      const agent = JSON.parse(
        JSON.stringify(await tx.doc(AgentDoc, conversationId)),
      ) as AgentState;
      const origins: HistoryBundle["origins"] = {};
      const originalIds = new Map(
        Object.entries(inherited?.entries ?? {}).map(([original, local]) => [local, original]),
      );
      for (const entry of entries) {
        const originalId = originalIds.get(entry.id);
        origins[String(entry.id)] =
          originalId === undefined
            ? {
                replicaId: source.replicaId,
                conversationId: entry.conversationId,
                entryId: entry.id,
                ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
              }
            : (parent?.origins[originalId] ?? reject("missing original provenance"));
      }
      return parsed(payloadSchema, {
        version: 1,
        engine: "pi-durable@1.4.0",
        source: { replicaId: source.replicaId, botId: this.#botId, conversationId },
        parents: run === undefined ? [] : [run.head],
        entries,
        origins,
        agent,
        resources: input.resources ?? parent?.resources ?? [],
      });
    }, ctx);
    const bundle = validateBundle({ ...payload, head: hash(payload) });
    // Pin it before replying: a lost response or process exit can re-export the same head.
    await this.pinLocal(bundle);
    return this.carrier(bundle);
  }

  async #run(params: unknown, selectedBundle?: HistoryBundle): Promise<unknown> {
    const input = parsed(
      z.strictObject({
        head: digest,
        requestId: requestIdSchema,
        text: z
          .string()
          .min(1)
          .refine((value) => Array.from(value).length <= MAX_INVOCATION_TEXT),
      }),
      params,
    );
    const admitted = await this.#harness.commit(async (tx) => {
      const run = await tx.doc(runs, hash(input.requestId), null);
      if (run.conversationId === 0) return undefined;
      if (run.head !== input.head || run.text !== input.text) reject("run request id conflict");
      return tx.submissionByRequest(run.conversationId as ConversationId, input.requestId);
    }, ctx);
    if (admitted !== undefined)
      return { branch: input.requestId, submission: convertSubmission(admitted) };
    const receipt = await this.#harness.snapshot(imports, input.head, ctx);
    if (receipt === undefined || receipt.conversationId === 0)
      return reject("unknown history head");
    const bundle = selectedBundle ?? carrierReceipt(receipt.bundle);
    if (bundle.head !== input.head) reject("run head binding mismatch");
    const installed = new Set(
      this.#registry
        .snapshot()
        .installed()
        .map((extension) => extension.name),
    );
    const selected = bundle.agent.extensions;
    const required = Array.isArray(selected) ? selected : (selected?.add ?? []);
    if (required.some((name) => !installed.has(name)))
      reject("history requires unavailable extensions");
    const version = await this.installResources(bundle);
    const conversationId = await this.#harness.commit(async (tx) => {
      const run = await tx.doc(runs, hash(input.requestId), null);
      if (run.conversationId !== 0) {
        if (run.head !== input.head || run.text !== input.text) reject("run request id conflict");
        return run.conversationId as ConversationId;
      }
      const tail = bundle.entries.at(-1);
      const at = receipt.entries[String(tail?.id)] as EntryId;
      const branch = await tx.forkConversation(receipt.conversationId as ConversationId, at, {
        ownership: { kind: "ownerless" },
      });
      const agent = await tx.doc(AgentDoc, branch.id);
      for (const key of Object.keys(agent) as (keyof AgentState)[]) delete agent[key];
      Object.assign(agent, bundle.agent, { cwd: this.#cwd });
      if (version !== "") {
        const selected = agent.extensions;
        agent.extensions = Array.isArray(selected)
          ? [...new Set([...selected, RESOURCE_EXTENSION])]
          : {
              ...selected,
              add: [...new Set([...(selected?.add ?? []), RESOURCE_EXTENSION])],
              ...(selected?.remove === undefined
                ? {}
                : { remove: selected.remove.filter((name) => name !== RESOURCE_EXTENSION) }),
            };
      }
      if (version !== "" || required.includes(RESOURCE_EXTENSION))
        (await tx.doc(ResourcePin, branch.id)).version = version;
      run.head = input.head;
      run.text = input.text;
      run.conversationId = branch.id;
      return branch.id;
    }, ctx);
    const conversation = await this.#harness.conversation(conversationId, ctx);
    if (conversation === undefined) return reject("missing local branch");
    // The durable fork intent precedes submit; retry after a crash uses this same branch/key.
    const submission = await conversation.submit(
      { type: "input", content: input.text, requestId: input.requestId, whenBusy: "reject" },
      ctx,
    );
    return { branch: input.requestId, submission: convertSubmission(await submission.status(ctx)) };
  }
}
