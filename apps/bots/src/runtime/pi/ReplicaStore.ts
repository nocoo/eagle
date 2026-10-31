import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MAX_REPLICA_BODY_BYTES } from "../../core/RuntimePort.ts";
import { validateResource } from "./HistoryReplica.ts";
import {
  type Body,
  bodySchema,
  type Fact,
  factSchema,
  type Header,
  headerSchema,
  type Intent,
  integer,
  intentSchema,
  keyOf,
  type Manifest,
  manifestSchema,
  type Page,
  parse,
  type Source,
  sourceKey,
  sourceSchema,
  syncReject,
} from "./syncProtocol.ts";

const bindingSchema = sourceSchema.extend({ localBotId: z.string(), sharedBotId: z.uuid() });
const conversationSchema = z.object({
  id: integer.min(1),
  parent: z.string().nullable(),
  cursor: integer,
  signature: z.string(),
});
const localRunSchema = z.object({
  intent: intentSchema,
  admitted: z.boolean(),
  rejected: z.boolean().optional(),
});
export type Binding = z.infer<typeof bindingSchema>;

export const readReplicaBinding = async (
  path: string,
  localBotId: string,
): Promise<Binding | undefined> => {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const saved = db.prepare("SELECT value FROM binding WHERE id=1").get();
    if (saved === undefined) throw new Error("missing replica binding");
    const binding = bindingSchema.parse(JSON.parse(String(saved.value)));
    if (binding.localBotId !== localBotId)
      throw new Error("replica binding belongs to another Bot");
    return binding;
  } finally {
    db.close();
  }
};

/** Local durable facts/outbox. No SDK call or asynchronous work occurs in a transaction. */
export class ReplicaStore {
  readonly db: DatabaseSync;
  binding: Binding;

  constructor(path: string, localBotId: string, replicaId: string) {
    closeSync(openSync(path, "a", 0o600));
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS streams (source TEXT PRIMARY KEY, known INTEGER NOT NULL, received INTEGER NOT NULL, applied INTEGER NOT NULL, blocked INTEGER);
      CREATE TABLE IF NOT EXISTS source_events (source TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(source,seq));
      CREATE TABLE IF NOT EXISTS outbox_keys (key TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (ref TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS heads (head TEXT PRIMARY KEY, value TEXT NOT NULL, ready INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS head_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, head TEXT NOT NULL UNIQUE);
      INSERT OR IGNORE INTO head_changes(head) SELECT head FROM heads ORDER BY rowid;
      CREATE TABLE IF NOT EXISTS local_runs (request_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_conversations (id INTEGER PRIMARY KEY, parent TEXT, cursor INTEGER NOT NULL, signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS materializations (head TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL);
    `);
    const saved = this.db.prepare("SELECT value FROM binding WHERE id=1").get();
    this.binding =
      saved === undefined
        ? { localBotId, replicaId, epoch: randomUUID(), sharedBotId: randomUUID() }
        : parse(bindingSchema, JSON.parse(String(saved.value)));
    if (this.binding.localBotId !== localBotId || this.binding.replicaId !== replicaId)
      syncReject("replica database belongs to another local Bot/runtime");
    if (saved === undefined)
      this.db.prepare("INSERT INTO binding VALUES(1,?)").run(JSON.stringify(this.binding));
    this.stream(this.binding);
  }

  transaction<T>(change: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = change();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  bind(sharedBotId: string): Binding {
    if (sharedBotId === this.binding.sharedBotId) return this.binding;
    this.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM source_events UNION ALL SELECT 1 FROM heads UNION ALL SELECT 1 FROM local_runs UNION ALL SELECT 1 FROM facts LIMIT 1",
          )
          .get() !== undefined
      )
        syncReject("a populated replica binding cannot change shared Bot identity");
      this.db
        .prepare("UPDATE binding SET value=? WHERE id=1")
        .run(JSON.stringify({ ...this.binding, sharedBotId }));
    });
    this.binding = { ...this.binding, sharedBotId };
    return this.binding;
  }

  stream(source: Source) {
    const sameReplica = this.db
      .prepare("SELECT source FROM streams")
      .all()
      .map((row) => parse(sourceSchema, JSON.parse(String(row.source))))
      .find((item) => item.replicaId === source.replicaId);
    if (sameReplica !== undefined && sameReplica.epoch !== source.epoch)
      syncReject("source epoch mismatch; rotation is not implemented");
    const key = sourceKey(source);
    this.db.prepare("INSERT OR IGNORE INTO streams VALUES(?,0,0,0,NULL)").run(key);
    const row = this.db
      .prepare("SELECT known,received,applied FROM streams WHERE source=?")
      .get(key);
    return parse(z.object({ known: integer, received: integer, applied: integer }), row);
  }

  sources(): Source[] {
    return this.db
      .prepare("SELECT source FROM streams ORDER BY source")
      .all()
      .map((row) => parse(sourceSchema, JSON.parse(String(row.source))));
  }

  append(key: string, body: Body): void {
    const own = sourceKey(this.binding);
    const prior = this.db.prepare("SELECT seq FROM outbox_keys WHERE key=?").get(key);
    if (prior !== undefined) {
      if (JSON.stringify(this.event(this.binding, Number(prior.seq))) !== JSON.stringify(body))
        syncReject("local source fact identity conflict");
      return;
    }
    const seq = this.stream(this.binding).known + 1;
    this.db.prepare("INSERT INTO source_events VALUES(?,?,?)").run(own, seq, JSON.stringify(body));
    this.db.prepare("INSERT INTO outbox_keys VALUES(?,?)").run(key, seq);
    this.db
      .prepare("UPDATE streams SET known=?,received=?,applied=? WHERE source=?")
      .run(seq, seq, seq, own);
  }

  receive(page: Page): void {
    if (page.sharedBotId !== this.binding.sharedBotId) syncReject("shared Bot binding mismatch");
    if (page.source.replicaId === this.binding.replicaId)
      syncReject("cannot receive a local source stream");
    if (
      page.range.from > page.range.to + 1 ||
      page.events.some((event) => event.seq < page.range.from || event.seq > page.range.to)
    )
      syncReject("event outside advertised source range");
    this.transaction(() => {
      const state = this.stream(page.source);
      const key = sourceKey(page.source);
      for (const event of page.events) {
        const prior = this.event(page.source, event.seq);
        if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(event.body))
          syncReject("same source sequence has different content");
        if (
          (event.body.kind === "entry" && event.body.origin.replicaId !== page.source.replicaId) ||
          (event.body.kind === "head" && event.body.meta.source.replicaId !== page.source.replicaId)
        )
          syncReject("source provenance mismatch");
        this.db
          .prepare("INSERT OR IGNORE INTO source_events VALUES(?,?,?)")
          .run(key, event.seq, JSON.stringify(event.body));
      }
      let received = state.received;
      while (this.event(page.source, received + 1) !== undefined) received += 1;
      this.db
        .prepare("UPDATE streams SET known=?,received=? WHERE source=?")
        .run(Math.max(state.known, page.range.to), received, key);
    });
  }

  block(source: Source, seq: number): void {
    this.db.prepare("UPDATE streams SET blocked=? WHERE source=?").run(seq, sourceKey(source));
  }

  blocked(source: Source): number | undefined {
    const value = this.db
      .prepare("SELECT blocked FROM streams WHERE source=?")
      .get(sourceKey(source))?.blocked;
    return value === null || value === undefined ? undefined : Number(value);
  }

  event(source: Source, seq: number): Body | undefined {
    const row = this.db
      .prepare("SELECT event FROM source_events WHERE source=? AND seq=?")
      .get(sourceKey(source), seq);
    return row === undefined ? undefined : parse(bodySchema, JSON.parse(String(row.event)));
  }

  applied(source: Source, seq: number): void {
    this.db.prepare("UPDATE streams SET applied=? WHERE source=?").run(seq, sourceKey(source));
  }

  page(source: Source, after: number, limit: number): Page {
    if (!this.sources().some((item) => sourceKey(item) === sourceKey(source)))
      syncReject("unknown source stream");
    const rows = this.db
      .prepare("SELECT seq,event FROM source_events WHERE source=? AND seq>? ORDER BY seq LIMIT ?")
      .iterate(sourceKey(source), after, limit);
    const state = this.stream(source);
    const page: Page = {
      version: 1,
      sharedBotId: this.binding.sharedBotId,
      source,
      range: { from: 1, to: state.known },
      events: [],
      nextAfter: after,
      hasMore: after < state.known,
    };
    for (const row of rows) {
      const seq = Number(row.seq);
      if (seq !== page.nextAfter + 1) break;
      const event = { seq, body: parse(bodySchema, JSON.parse(String(row.event))) };
      const next = {
        ...page,
        events: [...page.events, event],
        nextAfter: seq,
        hasMore: seq < state.known,
      };
      if (Buffer.byteLength(JSON.stringify({ page: next })) > MAX_REPLICA_BODY_BYTES) {
        if (page.events.length === 0)
          syncReject("single source event exceeds 8 MiB page limit; source gap retained");
        break;
      }
      Object.assign(page, next);
    }
    return page;
  }

  status() {
    return {
      ...this.binding,
      streams: this.sources().map((source) => {
        const available: { from: number; to: number }[] = [];
        for (const row of this.db
          .prepare("SELECT seq FROM source_events WHERE source=? ORDER BY seq")
          .all(sourceKey(source))) {
          const seq = Number(row.seq);
          const last = available.at(-1);
          if (last !== undefined && last.to + 1 === seq) last.to = seq;
          else available.push({ from: seq, to: seq });
        }
        const blocked = this.blocked(source);
        return {
          source,
          ...this.stream(source),
          available,
          ...(blocked === undefined ? {} : { error: { seq: blocked, code: "invalid_history" } }),
        };
      }),
      heads: this.db
        .prepare("SELECT head,ready FROM heads ORDER BY head")
        .all()
        .map((row) => ({ head: String(row.head), ready: row.ready === 1 })),
    };
  }

  putFact(fact: Fact): string {
    if (fact.kind === "resource") validateResource(fact.resource);
    const ref = keyOf(fact);
    const value = JSON.stringify(fact);
    const prior = this.db.prepare("SELECT value FROM facts WHERE ref=?").get(ref);
    if (prior !== undefined && prior.value !== value) syncReject("original fact identity conflict");
    this.db.prepare("INSERT OR IGNORE INTO facts VALUES(?,?)").run(ref, value);
    return ref;
  }

  fact(ref: string): Fact | undefined {
    const row = this.db.prepare("SELECT value FROM facts WHERE ref=?").get(ref);
    return row === undefined ? undefined : parse(factSchema, JSON.parse(String(row.value)));
  }

  putHead(manifest: Manifest, ready: boolean): void {
    const prior = this.head(manifest.head);
    const wasReady = this.ready(manifest.head);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(manifest))
      syncReject("history head identity conflict");
    this.db
      .prepare(
        "INSERT INTO heads VALUES(?,?,?) ON CONFLICT(head) DO UPDATE SET ready=MAX(ready,excluded.ready)",
      )
      .run(manifest.head, JSON.stringify(manifest), Number(ready));
    if (prior === undefined || (!wasReady && ready))
      this.db
        .prepare(
          "INSERT INTO head_changes(head) VALUES(?) ON CONFLICT(head) DO UPDATE SET seq=excluded.seq",
        )
        .run(manifest.head);
  }

  headChanges(after: number, limit: number) {
    return this.db
      .prepare(
        "SELECT head_changes.seq, heads.value, heads.ready FROM head_changes JOIN heads USING(head) WHERE head_changes.seq>? ORDER BY head_changes.seq LIMIT ?",
      )
      .all(after, limit)
      .map((row) => ({
        seq: Number(row.seq),
        manifest: parse(manifestSchema, JSON.parse(String(row.value))),
        ready: row.ready === 1,
      }));
  }

  head(head: string): Manifest | undefined {
    const row = this.db.prepare("SELECT value FROM heads WHERE head=?").get(head);
    return row === undefined ? undefined : parse(manifestSchema, JSON.parse(String(row.value)));
  }
  ready(head: string): boolean {
    return this.db.prepare("SELECT ready FROM heads WHERE head=?").get(head)?.ready === 1;
  }
  finishMaterialization(head: string, conversationId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO materializations VALUES(?,?)").run(head, conversationId);
  }
  readyHeads(): Manifest[] {
    return this.db
      .prepare("SELECT value FROM heads WHERE ready=1 ORDER BY rowid DESC")
      .all()
      .map((row) => parse(manifestSchema, JSON.parse(String(row.value))));
  }
  latestHead(conversationId: number): string | null {
    const manifests = this.db
      .prepare("SELECT value FROM heads WHERE ready=1 ORDER BY rowid DESC")
      .all()
      .map((row) => parse(manifestSchema, JSON.parse(String(row.value))));
    return (
      manifests.find(
        (item) =>
          item.meta.source.replicaId === this.binding.replicaId &&
          item.meta.source.conversationId === conversationId,
      )?.head ?? null
    );
  }

  remember(header: Header): void {
    header = parse(headerSchema, header);
    const old = this.localEntry(header.id);
    if (old !== undefined && JSON.stringify(old) !== JSON.stringify(header))
      syncReject("runtime entry mapping conflict");
    this.db
      .prepare("INSERT OR IGNORE INTO local_entries VALUES(?,?,?)")
      .run(header.id, header.conversationId, JSON.stringify(header));
  }
  localEntry(id: number): Header | undefined {
    const row = this.db.prepare("SELECT value FROM local_entries WHERE id=?").get(id);
    return row === undefined ? undefined : parse(headerSchema, JSON.parse(String(row.value)));
  }
  entries(conversationId: number): Header[] {
    return this.db
      .prepare("SELECT value FROM local_entries WHERE conversation_id=? ORDER BY id")
      .all(conversationId)
      .map((row) => parse(headerSchema, JSON.parse(String(row.value))));
  }

  conversation(id: number, parent: string | null, cursor = 0): void {
    this.db
      .prepare("INSERT OR IGNORE INTO local_conversations VALUES(?,?,?,'')")
      .run(id, parent, cursor);
  }
  conversations() {
    return this.db
      .prepare("SELECT * FROM local_conversations ORDER BY id")
      .all()
      .map((row) => parse(conversationSchema, row));
  }
  cursor(id: number, cursor: number): void {
    this.db.prepare("UPDATE local_conversations SET cursor=? WHERE id=?").run(cursor, id);
  }
  signature(id: number, signature: string): void {
    this.db.prepare("UPDATE local_conversations SET signature=? WHERE id=?").run(signature, id);
  }

  intent(intent: Intent): void {
    this.transaction(() => {
      const prior = this.run(intent.requestId);
      if (prior !== undefined && JSON.stringify(prior.intent) !== JSON.stringify(intent))
        syncReject("local run request ID binding conflict");
      if (prior !== undefined) return;
      this.db
        .prepare("INSERT INTO local_runs VALUES(?,?)")
        .run(intent.requestId, JSON.stringify({ intent, admitted: false }));
      this.append(`run:${intent.requestId}`, intent);
    });
  }
  run(requestId: string) {
    const row = this.db.prepare("SELECT value FROM local_runs WHERE request_id=?").get(requestId);
    return row === undefined ? undefined : parse(localRunSchema, JSON.parse(String(row.value)));
  }
  pending(): Intent[] {
    return this.db
      .prepare("SELECT value FROM local_runs ORDER BY rowid")
      .all()
      .map((row) => parse(localRunSchema, JSON.parse(String(row.value))))
      .filter((run) => !run.admitted && !run.rejected)
      .map((run) => run.intent);
  }
  admitted(requestId: string): void {
    const run = this.run(requestId);
    if (run === undefined) throw new Error("missing local intent");
    this.db
      .prepare("UPDATE local_runs SET value=? WHERE request_id=?")
      .run(JSON.stringify({ ...run, admitted: true, rejected: false }), requestId);
  }
  rejected(requestId: string): void {
    const run = this.run(requestId);
    if (run === undefined) throw new Error("missing local intent");
    this.db
      .prepare("UPDATE local_runs SET value=? WHERE request_id=?")
      .run(JSON.stringify({ ...run, rejected: true }), requestId);
  }
}
