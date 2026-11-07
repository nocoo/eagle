// Passive reads of one Bot's committed store (SG-002, "inert cold reads"). The schema
// comes from provider-owned constants guarded by a conformance test; the connection is
// read-only, the file must already exist, and nothing here migrates, repairs or opens a
// Harness. Converters and byte measurement are the daemon's own.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "../core/domain.ts";
import { convertMessage, messageBytes } from "../runtime/pi/convert.ts";
import { CURRENT_SCHEMA_VERSION, DELIVERY_MESSAGE_BYTES, TABLES } from "./schema.ts";

export type StoreStateName =
  | "available"
  | "session_missing"
  | "schema_unsupported"
  | "store_unreadable";

export type StoreState = {
  readonly state: StoreStateName;
  readonly schemaVersion?: number;
  readonly incarnation?: string;
};

export type Generation = {
  readonly min: string | null;
  readonly max: string | null;
  readonly count: number;
};

export type ScopeOwner = {
  readonly conversationId: string;
  readonly taskId: string;
};

export type Scope = {
  readonly id: string;
  readonly kind: "root" | "child";
  readonly owner: ScopeOwner | null;
  readonly entries: number;
};

export type Activity = "idle" | "running" | "queued" | "unknown";

/** One committed entry as the wire describes it; `entryId` and `at` are wire names. */
export type ObservedMessage = {
  readonly entryId: string;
  readonly commitSeq: number;
  readonly role: Message["role"];
  readonly state: Message["state"];
  readonly at: string;
  readonly blocks: Message["blocks"];
  readonly kind: string;
  readonly trimmed?: true;
};

export type CompactionBoundary = { readonly entryId: string; readonly head: string };

export type Coverage = {
  readonly scopes: "complete" | "truncated";
  readonly page: "complete" | "truncated";
  readonly content: "complete" | "partial";
  readonly reasons: readonly string[];
};

export type HistoryPage = {
  readonly scopes: readonly Scope[];
  readonly messages: readonly ObservedMessage[];
  readonly boundary: {
    readonly newestEntryId: string | null;
    readonly before: string | null;
    readonly compactions: readonly CompactionBoundary[];
  };
  readonly next?: { readonly before: string };
  readonly omitted: {
    readonly entries: number;
    readonly blocks: number;
    readonly kinds: readonly string[];
  };
  readonly coverage: Coverage;
};

export type SnapshotFacts = {
  readonly activity: Activity;
  readonly generation: Generation;
  readonly scopes: readonly Scope[];
  readonly entries: number;
  readonly newestEntryId: string | null;
};

/** The kinds the contract maps into messages; everything else is an omission. */
const MAPPED_KINDS = new Set([
  "pi.user",
  "pi.assistant",
  "pi.tool-result",
  "pi.compaction",
  "bots.reflection",
  "bots.reflection.tool",
]);

/** Kinds that are deliberately hidden by design, not unsupported. */
const KNOWN_HIDDEN_KINDS = new Set(["pi.system", "pi.reasoning"]);

const wired = (id: number): string => `e_${id}`;
const numbered = (id: string): number => Number(id.replace(/^e_/, ""));

type Row = {
  readonly id: number;
  readonly conversation_id: number;
  readonly head: number | null;
  readonly commit_seq: number;
  readonly record: string;
};

type EntryRecord = { readonly kind?: string; readonly model?: readonly Record<string, unknown>[] };

const parseRecord = (row: Row): EntryRecord | undefined => {
  try {
    const value = JSON.parse(row.record) as unknown;
    return value !== null && typeof value === "object" ? (value as EntryRecord) : undefined;
  } catch {
    return undefined;
  }
};

type Handle = {
  readonly db: DatabaseSync;
  close(): void;
};

/** One read-only connection, closed by the caller in a `finally`. */
const open = (path: string): Handle => {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 3000");
  return {
    db,
    close: () => db.close(),
  };
};

const schemaVersionOf = (db: DatabaseSync): number | undefined => {
  const row = db.prepare(`SELECT version FROM durable_schema WHERE singleton = 1`).get() as
    | { version: number }
    | undefined;
  return row?.version;
};

const incarnationOf = async (path: string): Promise<string | undefined> => {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return undefined;
  return createHash("sha256")
    .update(`${stats.ino}:${stats.birthtimeMs}`)
    .digest("hex")
    .slice(0, 16);
};

/** What a Bot's store is, without touching it: missing, unsupported, unreadable or usable. */
export const inspectStore = async (path: string): Promise<StoreState> => {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return { state: "session_missing" };
  if (!stats.isFile()) return { state: "store_unreadable" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const version = schemaVersionOf(db);
    if (version === undefined) return { state: "store_unreadable" };
    if (version !== CURRENT_SCHEMA_VERSION) {
      return { state: "schema_unsupported", schemaVersion: version };
    }
    const incarnation = await incarnationOf(path);
    return {
      state: "available",
      schemaVersion: version,
      ...(incarnation === undefined ? {} : { incarnation }),
    };
  } catch {
    return { state: "store_unreadable" };
  } finally {
    db?.close();
  }
};

export const readGeneration = async (path: string): Promise<Generation> => {
  const state = await inspectStore(path);
  if (state.state !== "available") return { min: null, max: null, count: 0 };
  const handle = open(path);
  try {
    const row = handle.db
      .prepare(`SELECT MIN(id) AS low, MAX(id) AS high, COUNT(*) AS total FROM ${TABLES.entries}`)
      .get() as { low: number | null; high: number | null; total: number };
    return {
      min: row.low === null ? null : wired(row.low),
      max: row.high === null ? null : wired(row.high),
      count: row.total,
    };
  } catch {
    return { min: null, max: null, count: 0 };
  } finally {
    handle.close();
  }
};

export const readScopes = async (path: string): Promise<readonly Scope[]> => {
  const state = await inspectStore(path);
  if (state.state !== "available") return [];
  const handle = open(path);
  try {
    const rows = handle.db
      .prepare(
        `SELECT c.id AS id, c.owner_conversation_id AS parent, c.owner_task_id AS ownerTask,
                (SELECT COUNT(*) FROM ${TABLES.entries} e WHERE e.conversation_id = c.id) AS entries
         FROM ${TABLES.conversations} c ORDER BY c.id`,
      )
      .all() as { id: number; parent: number | null; ownerTask: number | null; entries: number }[];
    return rows.map((row) => {
      const owner =
        row.parent === null && row.ownerTask === null
          ? null
          : {
              conversationId: `c_${row.parent ?? row.id}`,
              taskId: `t_${row.ownerTask ?? 0}`,
            };
      return {
        id: `c_${row.id}`,
        kind: owner === null ? "root" : "child",
        owner,
        entries: row.entries,
      };
    });
  } catch {
    return [];
  } finally {
    handle.close();
  }
};

const activityIn = (db: DatabaseSync): Activity => {
  const rows = db.prepare(`SELECT status FROM ${TABLES.tasks}`).all() as { status: string }[];
  const statuses = new Set(rows.map((row) => row.status));
  if (statuses.has("running") || statuses.has("completing")) return "running";
  if (statuses.has("pending") || statuses.has("waiting") || statuses.has("sleeping")) {
    return "queued";
  }
  return "idle";
};

export const readSnapshotFacts = async (path: string): Promise<SnapshotFacts> => {
  const state = await inspectStore(path);
  if (state.state !== "available") {
    return {
      activity: "unknown",
      generation: { min: null, max: null, count: 0 },
      scopes: [],
      entries: 0,
      newestEntryId: null,
    };
  }
  const handle = open(path);
  try {
    const activity = activityIn(handle.db);
    const row = handle.db
      .prepare(`SELECT MIN(id) AS low, MAX(id) AS high, COUNT(*) AS total FROM ${TABLES.entries}`)
      .get() as { low: number | null; high: number | null; total: number };
    const scopes = await readScopes(path);
    return {
      activity,
      generation: {
        min: row.low === null ? null : wired(row.low),
        max: row.high === null ? null : wired(row.high),
        count: row.total,
      },
      scopes,
      entries: row.total,
      newestEntryId: row.high === null ? null : wired(row.high),
    };
  } catch {
    return {
      activity: "unknown",
      generation: { min: null, max: null, count: 0 },
      scopes: [],
      entries: 0,
      newestEntryId: null,
    };
  } finally {
    handle.close();
  }
};

const conversationNumber = (scopeId: string, scopes: readonly Scope[]): number | undefined => {
  if (scopeId === "root") {
    const root = scopes.find((scope) => scope.kind === "root");
    return root === undefined ? undefined : Number(root.id.replace(/^c_/, ""));
  }
  return Number(scopeId.replace(/^c_/, ""));
};

/** Thinking is hidden by design and counted, never exposed as a block. */
const withoutThinking = (message: Message): { message: Message; hiddenBlocks: number } => {
  const kept = message.blocks.filter((block) => block.type !== "thinking");
  return {
    message: kept.length === message.blocks.length ? message : { ...message, blocks: kept },
    hiddenBlocks: message.blocks.length - kept.length,
  };
};

/** Trimmed at delivery only; the stored entry keeps every byte it had. */
const trimForDelivery = (message: Message): Message | undefined => {
  if (messageBytes(message) <= DELIVERY_MESSAGE_BYTES) return undefined;
  const blocks = message.blocks.map((block) => {
    if (block.type === "text" || block.type === "toolResult") {
      const room = Math.max(0, DELIVERY_MESSAGE_BYTES - 512);
      const text = block.text.slice(0, room);
      return { ...block, text: text === block.text ? text : `${text}\n[delivery trimmed]` };
    }
    return block;
  });
  return { ...message, blocks };
};

export type HistoryRequest = {
  readonly scopeId: string;
  readonly before?: string;
  readonly limit: number;
};

export const readHistoryPage = async (
  path: string,
  request: HistoryRequest,
): Promise<HistoryPage> => {
  const state = await inspectStore(path);
  const emptyBoundary = { newestEntryId: null, before: request.before ?? null, compactions: [] };
  const empty: HistoryPage = {
    scopes: [],
    messages: [],
    boundary: emptyBoundary,
    omitted: { entries: 0, blocks: 0, kinds: [] },
    coverage: { scopes: "complete", page: "complete", content: "complete", reasons: [] },
  };
  if (state.state !== "available") return empty;

  const scopes = await readScopes(path);
  const conversationId = conversationNumber(request.scopeId, scopes);
  if (conversationId === undefined) return empty;

  const handle = open(path);
  try {
    const newest = handle.db.prepare(`SELECT MAX(id) AS high FROM ${TABLES.entries}`).get() as {
      high: number | null;
    };
    const beforeNumber = request.before === undefined ? undefined : numbered(request.before);

    const rows = handle.db
      .prepare(
        `SELECT id, conversation_id, head, commit_seq, record FROM ${TABLES.entries}
         WHERE conversation_id = ? ${beforeNumber === undefined ? "" : "AND id < ?"}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        ...(beforeNumber === undefined
          ? [conversationId, request.limit + 1]
          : [conversationId, beforeNumber, request.limit + 1]),
      ) as Row[];

    const now = () => new Date();
    const messages: ObservedMessage[] = [];
    const compactions: CompactionBoundary[] = [];
    const omittedKinds: string[] = [];
    let hiddenBlocks = 0;
    let omittedEntries = 0;
    let trimmed = 0;
    let unmapped = false;
    let hasMore = false;

    for (const row of rows) {
      if (messages.length >= request.limit) {
        hasMore = true;
        break;
      }
      const record = parseRecord(row);
      const kind = record?.kind;
      const model = record?.model?.[0];
      if (kind === "pi.compaction") {
        compactions.push({
          entryId: wired(row.id),
          head: row.head === null ? wired(row.id) : wired(row.head),
        });
        messages.push({
          entryId: wired(row.id),
          role: "notice",
          state: "complete",
          at: new Date().toISOString(),
          blocks: [{ type: "text", text: "Context compacted; earlier entries stay readable." }],
          commitSeq: row.commit_seq,
          kind,
        });
        continue;
      }
      if (kind === undefined || model === undefined || !MAPPED_KINDS.has(kind)) {
        if (kind !== undefined && !KNOWN_HIDDEN_KINDS.has(kind)) unmapped = true;
        omittedEntries += 1;
        if (kind !== undefined) omittedKinds.push(kind);
        continue;
      }
      const converted = convertMessage(model as never, { id: wired(row.id), now });
      if (converted === undefined) {
        omittedEntries += 1;
        omittedKinds.push(kind);
        continue;
      }
      const hidden = withoutThinking(converted);
      hiddenBlocks += hidden.hiddenBlocks;
      const delivery = trimForDelivery(hidden.message);
      if (delivery !== undefined) trimmed += 1;
      const final = delivery ?? hidden.message;
      messages.push({
        entryId: final.id,
        commitSeq: row.commit_seq,
        role: final.role,
        state: final.state,
        at: final.createdAt,
        blocks: final.blocks,
        kind,
        ...(delivery === undefined ? {} : { trimmed: true as const }),
      });
    }

    const ordered = messages.reverse();
    const reasons = [
      ...(trimmed > 0 ? ["entry_trimmed"] : []),
      ...(unmapped ? ["unsupported_kind"] : []),
    ];
    const nextBefore = hasMore ? ordered[0]?.entryId : undefined;
    return {
      scopes,
      messages: ordered,
      boundary: {
        newestEntryId: newest.high === null ? null : wired(newest.high),
        before: request.before ?? null,
        compactions: compactions.reverse(),
      },
      ...(nextBefore === undefined ? {} : { next: { before: nextBefore } }),
      omitted: {
        entries: omittedEntries,
        blocks: hiddenBlocks,
        kinds: [...new Set(omittedKinds)],
      },
      coverage: {
        scopes: "complete",
        page: hasMore ? "truncated" : "complete",
        content: reasons.length === 0 ? "complete" : "partial",
        reasons,
      },
    };
  } catch {
    return empty;
  } finally {
    handle.close();
  }
};
