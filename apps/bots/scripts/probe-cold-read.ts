// SG-002 cold-read spike (docs/bots/specs/OBSERVATION-SPIKE.md): can the daemon serve
// committed worker history without opening a Harness and without changing worker data?
// The store is a real pi-durable sqlite written by the real runtime over the faux model.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeEvent } from "../src/core/RuntimePort.ts";
import { createBench, text, trace, waitFor } from "../test/support/pi.ts";

type FileState = { readonly size: number; readonly sha256: string };
type Fingerprint = Readonly<Record<string, FileState>>;

const TABLES = {
  metadata: "durable_metadata",
  conversations: "conversations",
  entries: "entries",
  tasks: "tasks",
  submissions: "submissions",
} as const;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 16);

const fingerprint = async (dir: string): Promise<Fingerprint> => {
  const found: Record<string, FileState> = {};
  const walk = async (current: string): Promise<void> => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!item.isFile()) continue;
      const info = await stat(path);
      found[relative(dir, path)] = { size: info.size, sha256: sha256(await readFile(path)) };
    }
  };
  await walk(dir);
  return found;
};

/** What a read changed on disk: created, deleted or byte-changed files. */
const describeChange = (before: Fingerprint, after: Fingerprint): string => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    const was = before[name];
    const now = after[name];
    if (was === undefined && now !== undefined) {
      lines.push(`+${name} (${now.size}B)`);
      continue;
    }
    if (was !== undefined && now === undefined) {
      lines.push(`-${name}`);
      continue;
    }
    if (was !== undefined && now !== undefined && was.sha256 !== now.sha256) {
      lines.push(`~${name} ${was.size}B->${now.size}B`);
    }
  }
  return lines.length === 0 ? "unchanged" : lines.join(", ");
};

type Counts = Readonly<Record<string, number>>;

const countsOf = async (db: DatabaseSync): Promise<Counts> => {
  const read = (sql: string): number => {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  };
  return {
    entries: read(`SELECT COUNT(*) AS count FROM ${TABLES.entries}`),
    heads: read(`SELECT COUNT(*) AS count FROM ${TABLES.entries} WHERE head IS NOT NULL`),
    conversations: read(`SELECT COUNT(*) AS count FROM ${TABLES.conversations}`),
    childConversations: read(
      `SELECT COUNT(*) AS count FROM ${TABLES.conversations} WHERE owner_conversation_id IS NOT NULL`,
    ),
    taskConversations: read(
      `SELECT COUNT(*) AS count FROM ${TABLES.conversations} WHERE owner_task_id IS NOT NULL`,
    ),
    tasks: read(`SELECT COUNT(*) AS count FROM ${TABLES.tasks}`),
    submissions: read(`SELECT COUNT(*) AS count FROM ${TABLES.submissions}`),
  };
};

const readCounts = async (path: string): Promise<Counts> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return await countsOf(db);
  } finally {
    db.close();
  }
};

const maxSeq = async (path: string): Promise<number> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT next_seq AS seq FROM ${TABLES.metadata} WHERE singleton = 1`)
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  } finally {
    db.close();
  }
};

type Row = Readonly<Record<string, string | number | boolean>>;
const rows: Row[] = [];
const record = (row: Row): void => {
  rows.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
};

/** S1/S2: three ways to open a cold store, each measured against the untouched bytes. */
const coldOpen = async (path: string, dir: string): Promise<void> => {
  const before = await fingerprint(dir);
  const viaNodeReadOnly = await readCounts(path);
  record({
    probe: "S1 node:sqlite readOnly",
    disk: describeChange(before, await fingerprint(dir)),
    entries: viaNodeReadOnly.entries ?? 0,
    conversations: viaNodeReadOnly.conversations ?? 0,
  });

  const afterReadOnly = await fingerprint(dir);
  const db = await openNodeSqliteDatabase(path);
  const facade = await countsOf(new DatabaseSync(path, { readOnly: true }));
  await db.close();
  record({
    probe: "S2a chord facade (openNodeSqliteDatabase)",
    disk: describeChange(afterReadOnly, await fingerprint(dir)),
    entries: facade.entries ?? 0,
    note: "no migrations on this layer; journal_mode/WAL pragma only",
  });

  const afterFacade = await fingerprint(dir);
  const storage = await openNodeSqliteStorage(path);
  const conversations = await storage.scanConversations({}, 5, undefined, {
    trace: "spike",
  } as never);
  const root = conversations.items[0];
  const opened =
    root === undefined
      ? { items: [] }
      : await storage.scanEntries({ conversationId: root.id }, 5, undefined, {
          trace: "spike",
        } as never);
  await storage.close({ trace: "spike" } as never);
  record({
    probe: "S2b pi-durable SqliteStorage (runs migrations)",
    disk: describeChange(afterFacade, await fingerprint(dir)),
    firstPage: opened.items.length,
    note: "open-or-create plus applySqliteMigrationsForSchema",
  });
};

/** S3: complete retained history, not the merged head window a runtime read returns. */
const completeness = async (path: string, dir: string): Promise<void> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const counts = await countsOf(db);
    const perConversation = db
      .prepare(
        `SELECT conversation_id AS id, COUNT(*) AS total, SUM(head IS NOT NULL) AS held
         FROM ${TABLES.entries} GROUP BY conversation_id ORDER BY conversation_id`,
      )
      .all() as { id: number; total: number; held: number }[];
    record({
      probe: "S3 retained history",
      conversations: counts.conversations ?? 0,
      childScopes: counts.childConversations ?? 0,
      taskScopes: counts.taskConversations ?? 0,
      entryRows: counts.entries ?? 0,
      headMarkers: counts.heads ?? 0,
      perConversation: perConversation.map((row) => `${row.id}:${row.total}/${row.held}`).join(","),
      note: `root dir ${dir.split("/").at(-1)}`,
    });
  } finally {
    db.close();
  }
};

/** S5: a reader next to a live writer — latency, visibility of commits, busy failures. */
const liveReader = async (
  path: string,
  submit: (requestId: string) => Promise<void>,
): Promise<void> => {
  let reads = 0;
  let failures = 0;
  let seen = 0;
  let stopped = false;
  const latencies: number[] = [];
  const loop = (async () => {
    while (!stopped) {
      const started = performance.now();
      try {
        const counts = await readCounts(path);
        seen = counts.entries ?? 0;
        reads += 1;
        latencies.push(performance.now() - started);
      } catch {
        failures += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();
  const startedTurns = performance.now();
  for (let turn = 0; turn < 40; turn += 1) {
    await submit(`r_spike_${turn}`);
  }
  const writerMs = performance.now() - startedTurns;
  stopped = true;
  await loop;
  latencies.sort((left, right) => left - right);
  record({
    probe: "S5 live reader beside writer",
    turns: 40,
    writerTotalMs: Math.round(writerMs),
    reads,
    readFailures: failures,
    readP50Ms: Number((latencies[Math.floor(latencies.length / 2)] ?? 0).toFixed(2)),
    readMaxMs: Number((latencies.at(-1) ?? 0).toFixed(2)),
    lastEntriesSeen: seen,
  });
};

/** S6: the store's own sequence as a change cursor. */
const changeCursor = async (path: string): Promise<void> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const seqs = db
      .prepare(`SELECT commit_seq AS seq FROM ${TABLES.entries} ORDER BY id`)
      .all() as { seq: number }[];
    let monotonic = true;
    for (let index = 1; index < seqs.length; index += 1) {
      if ((seqs[index]?.seq ?? 0) < (seqs[index - 1]?.seq ?? 0)) monotonic = false;
    }
    const distinct = new Set(seqs.map((row) => row.seq)).size;
    record({
      probe: "S6 change cursor",
      entryRows: seqs.length,
      distinctSeq: distinct,
      monotonicCommitSeq: monotonic,
      nextSeq: await maxSeq(path),
      note: "per-store next_seq; no fleet-wide sequence exists",
    });
  } finally {
    db.close();
  }
};

/** S4: a Bot with no session database must be unknown, not a freshly created empty store. */
const missingStore = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "bots-probe-missing-"));
  const path = join(dir, "session.sqlite");
  try {
    const created: string[] = [];
    const attempt = async (name: string, open: () => Promise<void>): Promise<void> => {
      try {
        await open();
      } catch {
        // A refusal is a valid outcome; only file creation is recorded.
      }
      const files = await readdir(dir).catch(() => [] as string[]);
      created.push(`${name}:${files.length === 0 ? "nothing" : files.join("+")}`);
    };
    await attempt("nodeReadOnly", async () => {
      const db = new DatabaseSync(path, { readOnly: true });
      db.close();
    });
    await attempt("chordFacade", async () => {
      const db = await openNodeSqliteDatabase(path);
      await db.close();
    });
    await attempt("sqliteStorage", async () => {
      const storage = await openNodeSqliteStorage(path);
      await storage.close({ trace: "spike" } as never);
    });
    record({ probe: "S4 missing store", outcome: created.join(" | ") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** S7: a reader holding an open read transaction must not block a committing writer. */
const longReadTransaction = async (
  path: string,
  submit: (requestId: string) => Promise<void>,
): Promise<void> => {
  const db = new DatabaseSync(path, { readOnly: true });
  const startedRead = performance.now();
  try {
    db.exec("BEGIN");
    db.prepare(`SELECT COUNT(*) AS count FROM ${TABLES.entries}`).get();
    const startedTurns = performance.now();
    for (let turn = 0; turn < 5; turn += 1) await submit(`r_hold_${turn}`);
    const writerMs = performance.now() - startedTurns;
    db.exec("COMMIT");
    record({
      probe: "S7 held read transaction",
      writerTotalMs: Math.round(writerMs),
      perTurnMs: Number((writerMs / 5).toFixed(1)),
      readHeldMs: Math.round(performance.now() - startedRead),
      busyFailures: 0,
    });
  } finally {
    db.close();
  }
};

const main = async (): Promise<void> => {
  await basicScenario();
  await scopeScenario();
  await missingStore();
  record({ probe: "conclusion", see: "docs/bots/specs/OBSERVATION-SPIKE.md" });
};

/** A store with compaction entries and a forked child conversation (reflection task). */
const scopeScenario = async (): Promise<void> => {
  const bench = await createBench({
    provider: { models: [{ id: "faux-tiny", contextWindow: 1_200, maxTokens: 200 }] },
    settings: {
      compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 150, backgroundTokens: 0 },
    },
    note: (spec) => ({
      botId: spec.id,
      current: () => ({}),
      set: async (note: string) => ({ note }),
    }),
  });
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    const long = "please summarise the state of the build ".repeat(12);
    bench.faux.setResponses(
      Array.from({ length: 40 }, (_unused, index) => () => text(`${long}Turn ${index} done.`)),
    );
    const handle = await bench.runtime.open(spec);
    for (let turn = 1; turn <= 6; turn += 1) {
      const admission = await handle.submit({
        requestId: `r_scope_${turn}`,
        text: `Turn ${turn}: ${long}`,
        whenBusy: "followUp",
        trace,
      });
      const requestId = admission.requestId;
      await waitFor(async () => {
        const status = (await handle.submission({ requestId }))?.status;
        return status === "done" || status === "unanswered";
      }, `turn ${turn} to settle`);
    }
    await waitFor(async () => (await handle.busy()).tasks === false, "reflection to finish");
    const served = await handle.history({ limit: 500 });
    await handle.close(trace, 6_000);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const conversations = db
        .prepare(
          `SELECT id, owner_conversation_id AS parent, owner_task_id AS ownerTask
           FROM ${TABLES.conversations} ORDER BY id`,
        )
        .all() as { id: number; parent: number | null; ownerTask: number | null }[];
      const kinds = db
        .prepare(`SELECT record FROM ${TABLES.entries}`)
        .all()
        .map((row) => {
          const record = JSON.parse(String((row as { record: string }).record)) as {
            kind?: string;
          };
          return record.kind ?? "unknown";
        });
      const perConversation = db
        .prepare(
          `SELECT conversation_id AS id, COUNT(*) AS total FROM ${TABLES.entries}
           GROUP BY conversation_id ORDER BY conversation_id`,
        )
        .all() as { id: number; total: number }[];
      record({
        probe: "S3 compaction and scope coverage",
        conversations: conversations.length,
        childConversations: conversations.filter(
          (row) => row.parent !== null || row.ownerTask !== null,
        ).length,
        scopes: conversations
          .map(
            (row) =>
              `${row.id}/${row.parent === null ? "-" : row.parent}/${row.ownerTask === null ? "-" : row.ownerTask}`,
          )
          .join(","),
        entryRows: kinds.length,
        headMarkers: (
          db
            .prepare(`SELECT COUNT(*) AS count FROM ${TABLES.entries} WHERE head IS NOT NULL`)
            .get() as {
            count: number;
          }
        ).count,
        compactionEntries: kinds.filter((kind) => kind === "pi.compaction").length,
        rawMessages: kinds.filter((kind) => kind === "pi.user" || kind === "pi.assistant").length,
        perConversation: perConversation.map((row) => `${row.id}:${row.total}`).join(","),
        servedByHistory: served.messages.length,
        servedHasMore: served.hasMore,
        authorMessages: served.messages.filter((message) => message.role === "user").length,
      });
    } finally {
      db.close();
    }
  } finally {
    await bench.cleanup();
  }
};

const basicScenario = async (): Promise<void> => {
  const bench = await createBench({ provider: { models: [{ id: "faux-1", name: "Faux" }] } });
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses(
      Array.from({ length: 96 }, (_unused, index) => () => text(`a${index}`)),
    );
    const handle = await bench.runtime.open(spec);
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    let turn = 0;
    const submit = async (requestId: string): Promise<void> => {
      await handle.submit({
        requestId,
        text: `question ${turn}`,
        whenBusy: "followUp",
        trace,
      });
      turn += 1;
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "submission" &&
              event.record.requestId === requestId &&
              event.record.status === "done",
          ),
        `question ${requestId} to settle`,
      );
    };
    await liveReader(path, submit);
    await longReadTransaction(path, submit);
    await handle.close(trace, 6_000);
    await coldOpen(path, spec.dir);
    await completeness(path, spec.dir);
    await changeCursor(path);
    record({ probe: "conclusion", see: "docs/bots/specs/OBSERVATION-SPIKE.md" });
  } finally {
    await bench.cleanup();
  }
};

await main();
