import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  boundCarrier,
  carrier,
  claims,
  digest,
  envelope,
  metadataDigest,
  requestDigest,
  same,
  slotKey,
} from "./crypto.ts";
import { CacheError, context, failure, json } from "./errors.ts";
import { Relay, relayBody } from "./relay.ts";
import {
  Authorization,
  type AuthorizationValue,
  type CarrierValue,
  MAX_CIPHER,
  MAX_FRAME,
  Metadata,
  RequestBody,
  type RequestValue,
  SyncKeyEnvelope,
} from "./wire.ts";

export type CacheEnv = {
  SYNC: DurableObjectNamespace<SyncCache>;
  CIPHERS: R2Bucket;
  REGISTRY_ORIGIN: string;
  REGISTRY: {
    checkCacheAuthority(input: unknown): Promise<unknown>;
    checkRelayAuthority(input: unknown): Promise<unknown>;
  };
};
const TTL = 72 * 60 * 60 * 1000;
async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CacheError(415, "expected_json");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FRAME)
    throw new CacheError(413, "sync_frame_too_large");
  if (!request.body) throw new CacheError(400, "missing_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FRAME) throw new CacheError(413, "sync_frame_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return RequestBody.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
const scope = (input: RequestValue, authority: string, requestHash: string) => ({
  authority,
  operation: input.operation,
  sharedBotId: input.sharedBotId,
  requestDigest: requestHash,
});
async function authorize(
  env: CacheEnv,
  input: RequestValue,
  authority: string,
  requestHash: string,
) {
  let reply: unknown;
  try {
    reply = await env.REGISTRY.checkCacheAuthority(scope(input, authority, requestHash));
  } catch (cause) {
    throw new CacheError(503, "sync_cache_registry_unreachable", { cause });
  }
  const result = z
    .union([
      z.strictObject({ ok: z.literal(true), authorization: Authorization }),
      z.strictObject({ ok: z.literal(false), status: z.number().int(), error: z.string() }),
    ])
    .parse(reply);
  if (!result.ok) throw new CacheError(403, result.error);
  const auth = claims(input, result.authorization, env.REGISTRY_ORIGIN, requestHash);
  deadline(auth.expiresAt);
  return auth;
}
function deadline(...deadlines: number[]): void {
  if (deadlines.some((value) => !Number.isSafeInteger(value) || value <= Date.now()))
    throw new CacheError(410, "sync_cache_expired");
}
export default {
  async fetch(request: Request, env: CacheEnv) {
    try {
      if (new URL(request.url).pathname.startsWith("/v1/relay/")) {
        const sharedBotId =
          request.method === "GET"
            ? z.uuid().parse(new URL(request.url).searchParams.get("sharedBotId"))
            : z.uuid().parse((await relayBody(request.clone())).sharedBotId);
        return await env.SYNC.getByName(sharedBotId).fetch(request);
      }
      const route = new URL(request.url).pathname.match(/^\/v1\/cache\/(publish|list|get)$/);
      if (!route) return json({ error: "not_found" }, 404);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const input = await readBody(request);
      if (input.operation !== route[1]) throw new CacheError(403, "sync_cache_operation_mismatch");
      const authority = request.headers
        .get("authorization")
        ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!authority) throw new CacheError(401, "sync_cache_authority_required");
      if (input.operation === "publish") carrier(input.carrier);
      const hash = requestDigest(input);
      await authorize(env, input, authority, hash);
      return await env.SYNC.getByName(input.sharedBotId).fetch(
        new Request(request.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${authority}`,
            "x-bots-sync-trace": context(request).trace,
            ...(context(request).botId
              ? { "x-bots-sync-bot": context(request).botId as string }
              : {}),
          },
          body: JSON.stringify(input),
        }),
      );
    } catch (error) {
      return failure(error, request);
    }
  },
} satisfies ExportedHandler<CacheEnv>;

type ObjectRow = {
  objectId: string;
  metadata: string;
  cipherLength: number;
  r2Key: string;
  uploaded: number | null;
  firstCachedAt: number | null;
  expiresAt: number | null;
  state: string;
  unresolved: number;
  physical: string;
};
type EventRow = {
  replicaId: string;
  epoch: string;
  seq: number;
  eventDigest: string;
  firstCachedAt: number | null;
  expiresAt: number | null;
  tombstone: number;
  pending: string | null;
};

export class SyncCache extends DurableObject<CacheEnv> {
  readonly relay: Relay;
  constructor(ctx: DurableObjectState, env: CacheEnv) {
    super(ctx, env);
    this.relay = new Relay(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS objects(objectId TEXT PRIMARY KEY,metadata TEXT NOT NULL,cipherLength INTEGER NOT NULL,r2Key TEXT NOT NULL,uploaded INTEGER,firstCachedAt INTEGER,expiresAt INTEGER,state TEXT NOT NULL,unresolved INTEGER NOT NULL DEFAULT 0,physical TEXT NOT NULL DEFAULT 'unknown');
      CREATE TABLE IF NOT EXISTS events(replicaId TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,eventDigest TEXT NOT NULL,firstCachedAt INTEGER,expiresAt INTEGER,tombstone INTEGER NOT NULL DEFAULT 0,pending TEXT,PRIMARY KEY(replicaId,epoch,seq));
      CREATE TABLE IF NOT EXISTS recipients(objectId TEXT NOT NULL,context TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(objectId,context));
      CREATE TABLE IF NOT EXISTS event_objects(replicaId TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,objectId TEXT NOT NULL,PRIMARY KEY(replicaId,epoch,seq,objectId));
    `);
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): T[] {
    try {
      return this.ctx.storage.sql.exec<T>(query, ...values).toArray();
    } catch (cause) {
      throw new CacheError(503, "sync_cache_storage_failed", { cause });
    }
  }
  private one<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): T | undefined {
    return this.rows<T>(query, ...values)[0];
  }
  private object(id: string) {
    return this.one<ObjectRow>("SELECT * FROM objects WHERE objectId=?", id);
  }
  private event(m: CarrierValue["manifest"], seq: number) {
    return this.one<EventRow>(
      "SELECT * FROM events WHERE replicaId=? AND epoch=? AND seq=?",
      m.source.replicaId,
      m.source.epoch,
      seq,
    );
  }
  private async storage<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      if (cause instanceof CacheError) throw cause;
      throw new CacheError(503, "sync_cache_storage_failed", { cause });
    }
  }
  private sql<T>(action: () => T): T {
    try {
      return this.ctx.storage.transactionSync(action);
    } catch (cause) {
      if (cause instanceof CacheError) throw cause;
      throw new CacheError(503, "sync_cache_storage_failed", { cause });
    }
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/v1/relay/")) return this.relay.fetch(request);
    try {
      const input = await readBody(request);
      if (!this.ctx.id.equals(this.env.SYNC.idFromName(input.sharedBotId)))
        throw new CacheError(403, "sync_cache_namespace_mismatch");
      const authority = request.headers
        .get("authorization")
        ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!authority) throw new CacheError(401, "sync_cache_authority_required");
      if (input.operation === "publish") carrier(input.carrier);
      const hash = requestDigest(input),
        auth = await authorize(this.env, input, authority, hash);
      const confirm = async () => {
        const after = await authorize(this.env, input, authority, hash);
        if (!same(after, auth)) throw new CacheError(403, "sync_cache_identity_changed");
        deadline(auth.expiresAt);
      };
      if (input.operation === "publish") return await this.publish(input, auth, confirm);
      if (input.operation === "get") return await this.get(input, auth, confirm);
      return await this.list(input, auth, confirm);
    } catch (error) {
      return failure(error, request);
    }
  }
  private metadata(value: CarrierValue) {
    const { ciphertext: _, envelope: __, ...metadata } = value;
    return Metadata.parse(metadata);
  }
  private expected(row: ObjectRow) {
    const metadata = Metadata.parse(JSON.parse(row.metadata));
    if (metadata.manifest.objectId !== row.objectId)
      throw new CacheError(503, "sync_cache_corrupt_metadata");
    return {
      objectId: row.objectId,
      manifestDigest: metadataDigest(metadata.manifest),
      cipherDigest: metadata.manifest.cipherDigest,
      cipherLength: String(row.cipherLength),
    };
  }
  private async body(row: ObjectRow) {
    const object = await this.storage(() => this.env.CIPHERS.get(row.r2Key));
    if (!object || !("body" in object) || !object.body)
      throw new CacheError(503, "sync_cache_body_unavailable");
    const expected = this.expected(row);
    if (object.size !== row.cipherLength || !same(object.customMetadata, expected))
      throw new CacheError(503, "sync_cache_corrupt_cipher");
    const bytes = await this.storage(async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = object.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_CIPHER || size > row.cipherLength)
            throw new CacheError(503, "sync_cache_corrupt_cipher");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    });
    if (bytes.length !== row.cipherLength || digest(bytes) !== expected.cipherDigest)
      throw new CacheError(503, "sync_cache_corrupt_cipher");
    const uploaded = object.uploaded.getTime();
    if (
      !Number.isSafeInteger(uploaded) ||
      uploaded <= 0 ||
      (row.uploaded !== null && row.uploaded !== uploaded)
    )
      throw new CacheError(503, "sync_cache_corrupt_uploaded");
    return { bytes, uploaded };
  }
  private async schedule() {
    const rows = this.rows<{ expiresAt: number | null; state: string; unresolved: number }>(
      "SELECT expiresAt,state,unresolved FROM objects WHERE state!='deleted' OR unresolved>0",
    );
    if (!rows.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(
      ...rows.map((row) =>
        row.state === "ready" && row.expiresAt !== null && row.expiresAt > Date.now()
          ? row.expiresAt
          : Date.now() + 60000,
      ),
    );
    await this.ctx.storage.setAlarm(next);
  }
  private clocks(row: ObjectRow, uploaded: number): ObjectRow {
    return this.sql(() => {
      const actual = this.object(row.objectId);
      if (!actual) throw new CacheError(503, "sync_cache_pending_missing");
      const m = Metadata.parse(JSON.parse(actual.metadata)).manifest;
      let first = uploaded,
        expires = uploaded + TTL;
      for (const event of m.included) {
        const saved = this.event(m, event.seq);
        if (!saved || saved.eventDigest !== event.eventDigest)
          throw new CacheError(409, "sync_cache_event_conflict");
        const eventFirst =
          saved.firstCachedAt === null ? uploaded : Math.min(uploaded, saved.firstCachedAt);
        const eventExpiry = eventFirst + TTL;
        first = Math.min(first, eventFirst);
        expires = Math.min(expires, eventExpiry);
        this.ctx.storage.sql.exec(
          "UPDATE events SET firstCachedAt=?,expiresAt=?,tombstone=?,pending=NULL WHERE replicaId=? AND epoch=? AND seq=?",
          eventFirst,
          eventExpiry,
          eventExpiry <= Date.now() ? 1 : saved.tombstone,
          m.source.replicaId,
          m.source.epoch,
          event.seq,
        );
      }
      if (actual.uploaded !== null && actual.uploaded !== uploaded)
        throw new CacheError(503, "sync_cache_corrupt_uploaded");
      this.ctx.storage.sql.exec(
        "UPDATE objects SET uploaded=?,firstCachedAt=?,expiresAt=?,state=CASE WHEN ?<=? THEN 'expired' ELSE state END WHERE objectId=?",
        uploaded,
        first,
        expires,
        expires,
        Date.now(),
        row.objectId,
      );
      return this.object(row.objectId) as ObjectRow;
    });
  }
  private async publish(
    input: Extract<RequestValue, { operation: "publish" }>,
    auth: AuthorizationValue,
    confirm: () => Promise<void>,
  ) {
    const value = carrier(input.carrier),
      m = value.manifest;
    boundCarrier(value, auth);
    if (!m.included.length) return json({ version: 1, cloudCached: false, reason: "empty_page" });
    const metadata = this.metadata(value),
      cipher = Buffer.from(value.ciphertext, "base64url");
    let row = this.sql(() => {
      deadline(auth.expiresAt);
      const prior = this.object(m.objectId);
      if (
        prior &&
        (!same(JSON.parse(prior.metadata), metadata) || prior.cipherLength !== cipher.length)
      )
        throw new CacheError(409, "sync_cache_object_conflict");
      for (const event of m.included) {
        const saved = this.event(m, event.seq);
        if (saved?.eventDigest !== undefined && saved.eventDigest !== event.eventDigest)
          throw new CacheError(409, "sync_cache_event_conflict");
        if (
          saved &&
          (saved.tombstone || (saved.expiresAt !== null && saved.expiresAt <= Date.now()))
        )
          throw new CacheError(410, "sync_cache_event_expired");
        if (saved?.pending && saved.pending !== m.objectId)
          throw new CacheError(409, "sync_cache_pending");
      }
      if (prior) {
        if (prior.state === "expired" || prior.state === "deleted")
          throw new CacheError(410, "sync_cache_expired");
        return prior;
      }
      for (const event of m.included) {
        this.ctx.storage.sql.exec(
          "INSERT INTO events VALUES(?,?,?,?,NULL,NULL,0,?) ON CONFLICT(replicaId,epoch,seq) DO UPDATE SET pending=excluded.pending",
          m.source.replicaId,
          m.source.epoch,
          event.seq,
          event.eventDigest,
          m.objectId,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO event_objects VALUES(?,?,?,?)",
          m.source.replicaId,
          m.source.epoch,
          event.seq,
          m.objectId,
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO objects(objectId,metadata,cipherLength,r2Key,state) VALUES(?,?,?,?,'pending')",
        m.objectId,
        JSON.stringify(metadata),
        cipher.length,
        `v1/${input.sharedBotId}/${m.objectId}`,
      );
      return this.object(m.objectId) as ObjectRow;
    });
    // Persist alarm alongside pending before starting an unknown-outcome R2 write.
    await this.storage(() => this.schedule());
    if (row.uploaded === null) {
      this.sql(() => {
        deadline(auth.expiresAt);
        this.ctx.storage.sql.exec(
          "UPDATE objects SET unresolved=unresolved+1 WHERE objectId=?",
          row.objectId,
        );
      });
      let settled = false;
      try {
        // Negative head is deliberately not consulted: only immutable conditional put/get can resolve this intent.
        await this.storage(() =>
          this.env.CIPHERS.put(row.r2Key, cipher, {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            customMetadata: this.expected(row),
          }),
        );
        settled = true;
      } finally {
        if (settled)
          this.sql(() => {
            this.ctx.storage.sql.exec(
              "UPDATE objects SET unresolved=unresolved-1,physical='unknown' WHERE objectId=?",
              row.objectId,
            );
          });
        const actual = this.object(row.objectId);
        if (actual?.state === "expired" || actual?.state === "deleted") {
          this.sql(() => {
            this.ctx.storage.sql.exec(
              "UPDATE objects SET state='expired',physical='unknown' WHERE objectId=?",
              row.objectId,
            );
          });
          this.ctx.waitUntil(this.cleanup());
        }
      }
    }
    const winner = await this.body(row);
    row = this.clocks(row, winner.uploaded);
    await this.storage(() => this.schedule());
    await confirm();
    this.sql(() => {
      deadline(auth.expiresAt, row.expiresAt ?? 0);
      const existing = this.object(row.objectId);
      if (!existing || existing.state === "expired" || existing.state === "deleted")
        throw new CacheError(410, "sync_cache_expired");
      const context = slotKey(value.envelope),
        saved = this.one<{ envelope: string }>(
          "SELECT envelope FROM recipients WHERE objectId=? AND context=?",
          row.objectId,
          context,
        );
      if (saved) {
        const original = envelope(JSON.parse(saved.envelope), metadata.manifest);
        if (slotKey(original) !== context) throw new CacheError(503, "sync_cache_corrupt_envelope");
      } else
        this.ctx.storage.sql.exec(
          "INSERT INTO recipients VALUES(?,?,?)",
          row.objectId,
          context,
          JSON.stringify(value.envelope),
        );
      this.ctx.storage.sql.exec("UPDATE objects SET state='ready' WHERE objectId=?", row.objectId);
    });
    return json({
      version: 1,
      objectId: row.objectId,
      cloudCached: true,
      firstCachedAt: row.firstCachedAt,
      expiresAt: row.expiresAt,
    });
  }
  private recipientRows(row: ObjectRow, auth: AuthorizationValue) {
    return this.rows<{ envelope: string }>(
      "SELECT envelope FROM recipients WHERE objectId=? AND json_extract(envelope,'$.issuer')=? AND json_extract(envelope,'$.recipient')=? LIMIT 1",
      row.objectId,
      JSON.stringify(auth.uploader),
      JSON.stringify(auth.recipient),
    );
  }
  private recipient(
    row: ObjectRow,
    auth: AuthorizationValue,
    slots = this.recipientRows(row, auth),
  ) {
    const metadata = Metadata.parse(JSON.parse(row.metadata));
    for (const saved of slots) {
      const value = SyncKeyEnvelope.parse(JSON.parse(saved.envelope));
      if (same(value.issuer, auth.uploader) && same(value.recipient, auth.recipient)) {
        envelope(value, metadata.manifest);
        return { ...metadata, envelope: value };
      }
    }
    throw new CacheError(403, "sync_cache_recipient_unavailable");
  }
  private live(row: ObjectRow | undefined): asserts row is ObjectRow {
    if (!row) throw new CacheError(404, "sync_cache_object_unavailable");
    if (row.state !== "ready")
      throw new CacheError(
        row.state === "pending" ? 409 : 410,
        `sync_cache_${row.state === "pending" ? "pending" : "expired"}`,
      );
    deadline(row.expiresAt ?? 0);
  }
  private async get(
    input: Extract<RequestValue, { operation: "get" }>,
    auth: AuthorizationValue,
    confirm: () => Promise<void>,
  ) {
    const row = this.object(input.objectId);
    this.live(row);
    const metadata = this.recipient(row, auth),
      winner = await this.body(row);
    const result = carrier({ ...metadata, ciphertext: winner.bytes.toString("base64url") });
    boundCarrier(result, auth);
    await confirm();
    this.live(this.object(input.objectId));
    deadline(auth.expiresAt, row.expiresAt ?? 0);
    return json({
      version: 1,
      cloudCached: true,
      firstCachedAt: row.firstCachedAt,
      expiresAt: row.expiresAt,
      carrier: result,
    });
  }
  private async list(
    input: Extract<RequestValue, { operation: "list" }>,
    auth: AuthorizationValue,
    confirm: () => Promise<void>,
  ) {
    const events = this.rows<EventRow>(
      "SELECT * FROM events WHERE replicaId=? AND epoch=? AND seq>? ORDER BY seq LIMIT ?",
      input.source.replicaId,
      input.source.epoch,
      input.after,
      input.limit + 1,
    );
    const selected = events.slice(0, input.limit),
      objects: { objectId: string; expiresAt: number; included: unknown }[] = [],
      gaps: { seq: number; reason: string }[] = [];
    let inspected = 0,
      bytes = 0;
    const checked = new Map<string, boolean>();
    for (const event of selected) {
      if (event.expiresAt !== null && event.expiresAt <= Date.now()) {
        gaps.push({ seq: event.seq, reason: "expired" });
        continue;
      }
      if (event.pending) {
        gaps.push({ seq: event.seq, reason: "pending" });
        continue;
      }
      let supplied = false;
      const all = this.rows<ObjectRow>(
        "SELECT objects.* FROM event_objects JOIN objects USING(objectId) WHERE event_objects.replicaId=? AND event_objects.epoch=? AND event_objects.seq=? AND objects.state='ready' ORDER BY objectId LIMIT ?",
        input.source.replicaId,
        input.source.epoch,
        event.seq,
        input.limit,
      );
      for (const row of all) {
        if (checked.get(row.objectId) === false) continue;
        if (
          !checked.has(row.objectId) &&
          (inspected >= input.limit || bytes + row.cipherLength > MAX_CIPHER)
        )
          break;
        const metadata = Metadata.parse(JSON.parse(row.metadata));
        if (
          !same(metadata.manifest.source, input.source) ||
          !metadata.manifest.included.some((item) => item.seq === event.seq)
        )
          continue;
        const slots = this.recipientRows(row, auth);
        try {
          this.live(row);
          const result = this.recipient(row, auth, slots);
          boundCarrier({ ...result, ciphertext: "" }, auth);
          if (!checked.has(row.objectId)) {
            inspected++;
            bytes += row.cipherLength;
            checked.set(row.objectId, false);
            await this.body(row);
            checked.set(row.objectId, true);
          }
        } catch {
          continue;
        }
        this.live(this.object(row.objectId));
        supplied = true;
        if (!objects.some((item) => item.objectId === row.objectId))
          objects.push({
            objectId: row.objectId,
            expiresAt: row.expiresAt ?? 0,
            included: metadata.manifest.included,
          });
        break;
      }
      if (!supplied) gaps.push({ seq: event.seq, reason: "unavailable" });
    }
    await confirm();
    deadline(auth.expiresAt, ...objects.map((item) => item.expiresAt));
    return json({
      version: 1,
      objects,
      gaps,
      hasMore: events.length > input.limit,
      nextAfter: selected.at(-1)?.seq ?? input.after,
      complete: false,
    });
  }
  private async cleanup() {
    for (const row of this.rows<ObjectRow>(
      "SELECT * FROM objects WHERE state='pending' AND uploaded IS NULL",
    )) {
      try {
        const winner = await this.body(row);
        this.clocks(row, winner.uploaded);
      } catch {
        // A missing/unreadable winner leaves the durable write outcome unknown.
      }
    }
    this.sql(() => {
      this.ctx.storage.sql.exec(
        "UPDATE events SET tombstone=1 WHERE expiresAt IS NOT NULL AND expiresAt<=?",
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE objects SET state='expired',physical='unknown' WHERE expiresAt IS NOT NULL AND expiresAt<=? AND state!='deleted'",
        Date.now(),
      );
    });
    for (const row of this.rows<ObjectRow>(
      "SELECT * FROM objects WHERE state='expired' OR (state='deleted' AND unresolved>0)",
    )) {
      try {
        await this.env.CIPHERS.delete(row.r2Key);
        this.sql(() => {
          const actual = this.object(row.objectId);
          if (!actual) return;
          this.ctx.storage.sql.exec(
            "UPDATE objects SET state=?,physical=? WHERE objectId=?",
            actual.unresolved === 0 ? "deleted" : "expired",
            actual.unresolved === 0 ? "deleted" : "unknown",
            row.objectId,
          );
        });
      } catch {
        /* Persisted expired row is retried by the next alarm; never resume serving. */
      }
    }
    await this.schedule();
  }
  override async alarm(): Promise<void> {
    await this.cleanup();
  }
}
