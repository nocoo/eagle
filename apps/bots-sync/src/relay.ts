import { z } from "zod";
import { metadataDigest, same } from "./crypto.ts";
import { CacheError, context, failure, json } from "./errors.ts";
import type { CacheEnv } from "./index.ts";
import {
  RelayAck,
  RelayAuthorization,
  RelayChallenge,
  RelayDiscover,
  type RelayExchange,
  RelayObject,
  type RelayReceipts,
  RelayRegister,
  RelayRequest,
  type RelayStatusRead,
  type RelayStatusReport,
  RelayStatusSnapshot,
} from "./relay-wire.ts";
import { Carrier, MAX_FRAME } from "./wire.ts";

const MAX_METADATA = 65536;
const MAX_RELAY_FRAME = MAX_FRAME + 8192;
const LEASE = 45000;
export async function relayBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CacheError(415, "expected_json");
  if (!request.body) throw new CacheError(400, "missing_body");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_METADATA) throw new CacheError(413, "sync_relay_frame_too_large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return RelayRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
type Holder = {
  binding: z.infer<typeof RelayRegister>["binding"];
  socket: WebSocket;
  generation: string;
  until: number;
  identity: z.infer<typeof RelayAuthorization>["requester"];
};
export class Relay {
  readonly #ctx: DurableObjectState;
  readonly #env: CacheEnv;
  readonly #holders = new Map<string, Holder>();
  #connections = 0;
  readonly #pending = new Map<
    string,
    { holder: Holder; resolve(value: unknown): void; reject(error: unknown): void; bytes: number }
  >();
  #pendingBytes = 0;
  constructor(ctx: DurableObjectState, env: CacheEnv) {
    this.#ctx = ctx;
    this.#env = env;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS relay_receipts(key TEXT PRIMARY KEY,holder TEXT NOT NULL,reader TEXT NOT NULL,receipt TEXT NOT NULL,updated INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS relay_deliveries(requestId TEXT PRIMARY KEY,holder TEXT NOT NULL,reader TEXT NOT NULL,binding TEXT NOT NULL,sessionId TEXT NOT NULL,objectId TEXT NOT NULL,source TEXT NOT NULL,through INTEGER NOT NULL,expires INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS relay_holders(deviceId TEXT PRIMARY KEY,identity TEXT NOT NULL,metadata TEXT NOT NULL,until INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS replica_status(key TEXT PRIMARY KEY,holder TEXT NOT NULL,reader TEXT NOT NULL,snapshot TEXT NOT NULL)",
    );
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): T[] {
    try {
      return this.#ctx.storage.sql.exec<T>(query, ...values).toArray();
    } catch (cause) {
      throw new CacheError(503, "sync_relay_storage_failed", { cause });
    }
  }
  async #authorize(input: z.infer<typeof RelayRequest>, authority: string) {
    const requestDigest = metadataDigest(input);
    let reply: unknown;
    try {
      reply = await this.#env.REGISTRY.checkRelayAuthority({
        authority,
        operation: input.operation,
        sharedBotId: input.sharedBotId,
        requestDigest,
      });
    } catch (cause) {
      throw new CacheError(503, "sync_relay_registry_unreachable", { cause });
    }
    const result = z
      .union([
        z.strictObject({
          ok: z.literal(true),
          authorization: RelayAuthorization,
          holders: z.array(RelayAuthorization.shape.requester).max(128).optional(),
        }),
        z.strictObject({
          ok: z.literal(false),
          status: z.number().int(),
          error: z.string().max(100),
        }),
      ])
      .parse(reply);
    if (!result.ok) throw new CacheError(result.status === 429 ? 429 : 403, result.error);
    const a = result.authorization;
    if (
      a.operation !== input.operation ||
      a.sharedBotId !== input.sharedBotId ||
      a.requestDigest !== requestDigest ||
      a.registryOrigin !== this.#env.REGISTRY_ORIGIN ||
      (input.operation === "exchange" ||
      input.operation === "ack" ||
      input.operation === "receipts" ||
      input.operation === "status-report" ||
      input.operation === "status-read"
        ? !a.holder ||
          !a.reader ||
          (input.operation === "receipts" || input.operation === "status-read"
            ? a.reader.deviceId !== input.peerDeviceId || !same(a.requester, a.holder)
            : a.holder.deviceId !== input.peerDeviceId || !same(a.requester, a.reader))
        : a.holder !== null || a.reader !== null)
    )
      throw new CacheError(403, "sync_relay_authority_mismatch");
    this.#deadline(a.expiresAt);
    return { ...result, authorization: a };
  }
  #deadline(until: number) {
    if (until <= Date.now()) throw new CacheError(410, "sync_relay_expired");
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/v1/relay/connect") return this.#connect(request);
      if (
        ![
          "/v1/relay/discover",
          "/v1/relay/exchange",
          "/v1/relay/ack",
          "/v1/relay/receipts",
          "/v1/relay/status-report",
          "/v1/relay/status-read",
        ].includes(path)
      )
        return json({ error: "not_found" }, 404);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const input = await relayBody(request);
      if (path !== `/v1/relay/${input.operation}`)
        throw new CacheError(403, "sync_relay_operation_mismatch");
      const authority = request.headers
        .get("authorization")
        ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!authority) throw new CacheError(401, "sync_relay_authority_required");
      const initial = await this.#authorize(input, authority);
      if (input.operation === "exchange")
        return await this.#exchange(input, authority, initial.authorization, request);
      if (input.operation === "ack")
        return await this.#ack(input, authority, initial.authorization);
      if (input.operation === "receipts")
        return await this.#receipts(input, authority, initial.authorization);
      if (input.operation === "status-report" || input.operation === "status-read")
        return await this.#status(input, authority, initial.authorization);
      RelayDiscover.parse(input);
      const holders = [];
      for (const identity of initial.holders ?? []) {
        const row = this.rows<{ identity: string; metadata: string; until: number }>(
          "SELECT identity,metadata,until FROM relay_holders WHERE deviceId=?",
          identity.deviceId,
        )[0];
        const live = this.#holders.get(identity.deviceId);
        if (
          !row ||
          !live ||
          live.until <= Date.now() ||
          row.until <= Date.now() ||
          !same(live.identity, identity) ||
          !same(JSON.parse(row.identity), identity)
        )
          continue;
        const metadata = RelayRegister.parse(JSON.parse(row.metadata));
        if (metadata.sharedBotId !== input.sharedBotId || metadata.generation !== live.generation)
          continue;
        holders.push({
          identity,
          binding: metadata.binding,
          generation: metadata.generation,
          streams: metadata.streams,
          onlineUntil: live.until,
        });
      }
      const final = await this.#authorize(input, authority);
      this.#deadline(final.authorization.expiresAt);
      return json({
        version: 1,
        holders: holders.filter(
          (h) =>
            h.onlineUntil > Date.now() && (final.holders ?? []).some((i) => same(i, h.identity)),
        ),
      });
    } catch (error) {
      return failure(error, request);
    }
  }
  async #status(
    input: z.infer<typeof RelayStatusReport> | z.infer<typeof RelayStatusRead>,
    authority: string,
    auth: z.infer<typeof RelayAuthorization>,
  ) {
    const holder = JSON.stringify(auth.holder),
      reader = JSON.stringify(auth.reader);
    const final = await this.#authorize(input, authority);
    this.#deadline(final.authorization.expiresAt);
    if (input.operation === "status-report") {
      try {
        this.#ctx.storage.transactionSync(() => {
          for (const stream of input.streams) {
            const key = metadataDigest({
              registryOrigin: auth.registryOrigin,
              sharedBotId: input.sharedBotId,
              holder: auth.holder,
              receiver: auth.reader,
              binding: input.binding,
              source: stream.source,
            });
            const old = this.rows<{ snapshot: string }>(
              "SELECT snapshot FROM replica_status WHERE key=?",
              key,
            )[0];
            const previous = old ? RelayStatusSnapshot.parse(JSON.parse(old.snapshot)) : undefined;
            if (
              previous &&
              stream.received <= previous.received &&
              stream.applied <= previous.applied
            )
              continue;
            if (
              !old &&
              (this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM replica_status")[0]?.n ?? 0) >=
                8192
            )
              throw new CacheError(429, "sync_relay_status_capacity");
            const snapshot = RelayStatusSnapshot.parse({
              registryOrigin: auth.registryOrigin,
              sharedBotId: input.sharedBotId,
              holder: auth.holder,
              receiver: auth.reader,
              binding: input.binding,
              source: stream.source,
              received: Math.max(stream.received, previous?.received ?? 0),
              applied: Math.max(stream.applied, previous?.applied ?? 0),
              recordedAt: Date.now(),
            });
            this.rows(
              "INSERT OR REPLACE INTO replica_status VALUES(?,?,?,?)",
              key,
              holder,
              reader,
              JSON.stringify(snapshot),
            );
          }
        });
      } catch (cause) {
        if (
          cause instanceof CacheError ||
          cause instanceof z.ZodError ||
          cause instanceof SyntaxError
        )
          throw cause;
        throw new CacheError(503, "sync_relay_storage_failed", { cause });
      }
      this.#deadline(final.authorization.expiresAt);
      return json({ version: 1, recorded: true });
    }
    const rows = this.rows<{ snapshot: string }>(
      "SELECT snapshot FROM replica_status WHERE holder=? AND reader=? ORDER BY key LIMIT 129",
      holder,
      reader,
    );
    const snapshots = rows
      .slice(0, 128)
      .map((row) => RelayStatusSnapshot.parse(JSON.parse(row.snapshot)));
    this.#deadline(final.authorization.expiresAt);
    return json({ version: 1, snapshots, hasMore: rows.length > 128 });
  }
  async #ack(
    input: z.infer<typeof RelayAck>,
    authority: string,
    auth: z.infer<typeof RelayAuthorization>,
  ) {
    const delivery = this.rows<{
      holder: string;
      reader: string;
      binding: string;
      sessionId: string;
      objectId: string;
      source: string;
      expires: number;
    }>("SELECT * FROM relay_deliveries WHERE requestId=?", input.delivery.requestId)[0];
    if (
      !same(input.source, input.delivery.source) ||
      (delivery &&
        (!same(JSON.parse(delivery.holder), auth.holder) ||
          !same(JSON.parse(delivery.reader), auth.reader) ||
          !same(JSON.parse(delivery.binding), input.binding) ||
          delivery.sessionId !== input.delivery.sessionId ||
          delivery.objectId !== input.delivery.objectId ||
          !same(JSON.parse(delivery.source), input.source)))
    )
      throw new CacheError(403, "sync_relay_delivery_mismatch");
    const final = await this.#authorize(input, authority);
    this.#deadline(final.authorization.expiresAt);
    if (!delivery || delivery.expires <= Date.now())
      throw new CacheError(410, "sync_relay_delivery_unavailable");
    const key = metadataDigest({
      holder: auth.holder,
      reader: auth.reader,
      binding: input.binding,
      source: input.source,
    });
    const old = this.rows<{ receipt: string }>(
      "SELECT receipt FROM relay_receipts WHERE key=?",
      key,
    )[0];
    const previous = old ? RelayAck.parse(JSON.parse(old.receipt)) : undefined;
    if (previous && (input.received < previous.received || input.applied < previous.applied))
      return json({ version: 1, peerApplied: { ...previous, receiver: auth.reader } });
    if (
      !old &&
      (this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM relay_receipts")[0]?.n ?? 0) >= 8192
    )
      throw new CacheError(429, "sync_relay_receipt_capacity");
    this.rows(
      "INSERT OR REPLACE INTO relay_receipts VALUES(?,?,?,?,?)",
      key,
      JSON.stringify(auth.holder),
      JSON.stringify(auth.reader),
      JSON.stringify(input),
      Date.now(),
    );
    this.#deadline(final.authorization.expiresAt);
    return json({ version: 1, peerApplied: { ...input, receiver: auth.reader } });
  }
  async #receipts(
    input: z.infer<typeof RelayReceipts>,
    authority: string,
    auth: z.infer<typeof RelayAuthorization>,
  ) {
    const rows = this.rows<{ receipt: string; reader: string }>(
      "SELECT receipt,reader FROM relay_receipts WHERE holder=? AND reader=? ORDER BY key LIMIT 129",
      JSON.stringify(auth.holder),
      JSON.stringify(auth.reader),
    );
    if (rows.length > 128) throw new CacheError(429, "sync_relay_receipt_capacity");
    const receipts = rows.map((row) => ({
      ...RelayAck.parse(JSON.parse(row.receipt)),
      receiver: JSON.parse(row.reader),
    }));
    const final = await this.#authorize(input, authority);
    this.#deadline(final.authorization.expiresAt);
    return json({ version: 1, receipts, peerApplied: receipts.length ? "confirmed" : "unknown" });
  }
  async #exchange(
    input: z.infer<typeof RelayExchange>,
    authority: string,
    auth: z.infer<typeof RelayAuthorization>,
    request: Request,
  ) {
    const fields = context(request);
    if (input.receiverBinding.sharedBotId !== input.sharedBotId)
      throw new CacheError(403, "sync_relay_namespace_mismatch");
    if (
      Buffer.byteLength(JSON.stringify(input.payload)) >
      (input.method === "challenge" ? 8192 : 16384)
    )
      throw new CacheError(413, "sync_relay_frame_too_large");
    if (input.method === "challenge") {
      const challenge = RelayChallenge.parse(input.payload);
      if (
        challenge.sharedBotId !== input.sharedBotId ||
        challenge.readerDeviceId !== auth.reader?.deviceId
      )
        throw new CacheError(403, "sync_relay_authority_mismatch");
    } else RelayObject.parse(input.payload);
    const holder = this.#holders.get(input.peerDeviceId);
    if (!holder || holder.until <= Date.now()) throw new CacheError(503, "sync_relay_offline");
    if (holder.generation !== input.generation || !same(holder.identity, auth.holder))
      throw new CacheError(403, "sync_relay_generation_changed");
    const text = JSON.stringify({
      type: "request",
      requestId: input.requestId,
      generation: input.generation,
      method: input.method,
      payload: input.payload,
      ...fields,
    });
    const bytes = Buffer.byteLength(text);
    if (
      this.#pending.size >= 2 ||
      this.#pendingBytes + bytes > 131072 ||
      this.#pending.has(input.requestId)
    )
      throw new CacheError(429, "sync_relay_capacity");
    let cleanup = () => {};
    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CacheError(504, "sync_relay_timeout")), 10000);
      const abort = () => reject(new CacheError(409, "sync_relay_cancelled"));
      request.signal.addEventListener("abort", abort, { once: true });
      this.#pendingBytes += bytes;
      this.#pending.set(input.requestId, {
        holder,
        resolve: (value) => resolve(value as { status: number; body: unknown }),
        reject,
        bytes,
      });
      cleanup = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        this.#pending.delete(input.requestId);
        this.#pendingBytes -= bytes;
        try {
          holder.socket.send(
            JSON.stringify({
              type: "cancel",
              requestId: input.requestId,
              generation: holder.generation,
            }),
          );
        } catch {}
      };
      try {
        holder.socket.send(text);
      } catch (cause) {
        reject(new CacheError(503, "sync_relay_offline", { cause }));
      }
    }).finally(() => cleanup());
    if (result.status !== 200) {
      const refused = z
        .strictObject({
          trace: z.literal(fields.trace),
          error: z.strictObject({
            failure: z.strictObject({
              id: z.string().regex(/^f_[A-Za-z0-9_-]{1,32}$/),
              kind: z.enum([
                "auth_failed",
                "invalid_command",
                "unknown_bot",
                "internal",
                "storage_failed",
                "limit_exceeded",
              ]),
              layer: z.enum(["transport", "protocol", "core", "runtime", "pi"]),
            }),
          }),
        })
        .safeParse(result.body);
      if (
        !refused.success ||
        (result.status !== 403 && result.status !== 503) ||
        (result.status === 403) !== (refused.data.error.failure.kind === "auth_failed")
      )
        throw new CacheError(403, "sync_relay_failure_invalid");
      if (this.#holders.get(input.peerDeviceId) !== holder || holder.until <= Date.now())
        throw new CacheError(403, "sync_relay_generation_changed");
      return json(refused.data, result.status);
    }
    const final = await this.#authorize(input, authority);
    this.#deadline(final.authorization.expiresAt);
    this.#deadline(holder.until);
    if (this.#holders.get(input.peerDeviceId) !== holder)
      throw new CacheError(403, "sync_relay_generation_changed");
    if (result.status === 200 && input.method === "object") {
      const output = z.object({ carrier: Carrier }).parse(result.body),
        m = output.carrier.manifest;
      if (
        m.sharedBotId !== input.sharedBotId ||
        !same(output.carrier.envelope.issuer, auth.holder) ||
        !same(output.carrier.envelope.recipient, auth.reader)
      )
        throw new CacheError(403, "sync_relay_delivery_mismatch");
      const sessionId = z
        .object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .parse(input.payload).sessionId;
      this.rows("DELETE FROM relay_deliveries WHERE expires<=?", Date.now());
      if (
        (this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM relay_deliveries")[0]?.n ?? 0) >= 8192
      )
        throw new CacheError(429, "sync_relay_receipt_capacity");
      this.rows(
        "INSERT INTO relay_deliveries VALUES(?,?,?,?,?,?,?,?,?)",
        input.requestId,
        JSON.stringify(auth.holder),
        JSON.stringify(auth.reader),
        JSON.stringify(input.receiverBinding),
        sessionId,
        m.objectId,
        JSON.stringify(m.source),
        m.nextAfter,
        Date.now() + 72 * 60 * 60 * 1000,
      );
    }
    return json(result.body, result.status);
  }
  #connect(request: Request) {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      throw new CacheError(400, "sync_relay_upgrade_required");
    const sharedBotId = z.uuid().parse(new URL(request.url).searchParams.get("sharedBotId"));
    if (this.#connections >= 32) throw new CacheError(429, "sync_relay_capacity");
    const pair = new WebSocketPair(),
      client = pair[0],
      socket = pair[1];
    socket.accept();
    this.#connections++;
    let holder: Holder | undefined,
      busy = false,
      closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      this.#connections--;
      if (holder) {
        if (this.#holders.get(holder.identity.deviceId) === holder)
          this.#holders.delete(holder.identity.deviceId);
        for (const pending of this.#pending.values())
          if (pending.holder === holder) pending.reject(new CacheError(503, "sync_relay_offline"));
      }
    };
    const renew = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          socket.close(1000, "relay_lease_expired");
          close();
        },
        holder ? Math.max(1, holder.until - Date.now()) : 10000,
      );
    };
    renew();
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
    socket.addEventListener("message", (event) => {
      void (async () => {
        if (
          closed ||
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > MAX_RELAY_FRAME
        )
          throw new CacheError(400, "sync_relay_frame_invalid");
        const decoded = JSON.parse(event.data);
        if (holder && decoded?.type === "response") {
          if (Buffer.byteLength(event.data) > MAX_RELAY_FRAME)
            throw new CacheError(413, "sync_relay_frame_too_large");
          const response = z
            .strictObject({
              type: z.literal("response"),
              requestId: z.uuid(),
              generation: z.string(),
              status: z.number().int().min(200).max(599),
              body: z.unknown(),
            })
            .parse(decoded);
          const pending = this.#pending.get(response.requestId);
          if (!pending) return;
          if (
            pending.holder !== holder ||
            response.generation !== holder.generation ||
            this.#holders.get(holder.identity.deviceId) !== holder
          )
            throw new CacheError(403, "sync_relay_generation_changed");
          pending.resolve(response);
          return;
        }
        if (busy) throw new CacheError(409, "sync_relay_registration_busy");
        busy = true;
        try {
          const { authority, ...input } = RelayRegister.safeExtend({
            authority: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          }).parse(decoded);
          if (Buffer.byteLength(event.data) > MAX_METADATA)
            throw new CacheError(413, "sync_relay_frame_too_large");
          if (input.sharedBotId !== sharedBotId)
            throw new CacheError(403, "sync_relay_namespace_mismatch");
          const { authorization: a } = await this.#authorize(input, authority);
          if (closed) throw new CacheError(409, "sync_relay_closed");
          const previous = this.#holders.get(a.requester.deviceId);
          if (previous && previous.socket !== socket) previous.socket.close(1000, "relay_replaced");
          this.rows(
            "INSERT OR REPLACE INTO relay_holders VALUES(?,?,?,?)",
            a.requester.deviceId,
            JSON.stringify(a.requester),
            JSON.stringify(input),
            Date.now() + LEASE,
          );
          this.#deadline(a.expiresAt);
          if (previous && previous.socket === socket) {
            if (
              previous.generation !== input.generation ||
              !same(previous.identity, a.requester) ||
              !same(previous.binding, input.binding)
            )
              throw new CacheError(403, "sync_relay_generation_changed");
            previous.until = Date.now() + LEASE;
            holder = previous;
          } else
            holder = {
              socket,
              generation: input.generation,
              until: Date.now() + LEASE,
              identity: a.requester,
              binding: input.binding,
            };
          this.#holders.set(a.requester.deviceId, holder);
          renew();
          socket.send(
            JSON.stringify({
              version: 1,
              type: "registered",
              generation: holder.generation,
              onlineUntil: holder.until,
            }),
          );
        } finally {
          busy = false;
        }
      })().catch(async (error) => {
        const response = failure(error, request);
        if (!closed)
          socket.send(
            JSON.stringify({
              type: "failure",
              status: response.status,
              body: await response.json(),
            }),
          );
        socket.close(1008, "relay_refused");
        close();
      });
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}
