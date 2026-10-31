import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import type { ReadyReplica } from "./core/BotRegistry.ts";
import type { DeviceSyncPort } from "./core/DeviceSyncPort.ts";
import {
  type RelayOperation,
  RelayRegister,
  type RelayRequest,
  relayDirectory,
} from "./core/DeviceSyncRelay.ts";
import { nonce } from "./sync-crypto.ts";
import { MAX_OBJECT_FRAME, metadataDigest } from "./sync-objects.ts";

const MAX_RELAY_FRAME = MAX_OBJECT_FRAME + 8192;
type Fields = { trace: string; botId: string };
export type RelayContext = { generation: string; replica: ReadyReplica; guard(): void };
type Exchange = (
  path: string,
  input: unknown,
  fields: Fields,
  authority: string,
  signal?: AbortSignal,
) => Promise<unknown>;
type Serve = (
  method: "challenge" | "object",
  input: unknown,
  fields: Fields,
  context: RelayContext,
) => Promise<{ status: number; body: unknown }>;
type Connection = {
  socket: WebSocket;
  generation: string;
  replica: ReadyReplica;
  requests: Map<string, AbortController>;
  guard(): void;
  timer?: ReturnType<typeof setTimeout>;
};
/** Outbound sockets carry only the existing bounded per-page exchange. */
export class SyncRelay {
  readonly #origin: string;
  readonly #device: DeviceSyncPort;
  readonly #exchange: (
    path: string,
    input: unknown,
    fields: Fields,
    authority: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  readonly #serve: (
    method: "challenge" | "object",
    input: unknown,
    fields: Fields,
    context: RelayContext,
  ) => Promise<{ status: number; body: unknown }>;
  readonly #refused: (status: number, body: unknown) => Error;
  readonly #epochs = new Map<string, { botId: string }>();
  readonly #connections = new Map<string, Connection>();
  readonly #opening = new Map<string, Promise<unknown>>();
  #closed = false;
  constructor(
    origin: string,
    device: DeviceSyncPort,
    exchange: Exchange,
    serve: Serve,
    refused: (status: number, body: unknown) => Error,
  ) {
    this.#origin = origin;
    this.#device = device;
    this.#exchange = exchange;
    this.#serve = serve;
    this.#refused = refused;
  }
  live(generation: string) {
    return (
      !this.#closed &&
      [...this.#connections.values()].some(
        (c) => c.generation === generation && c.socket.readyState === WebSocket.OPEN,
      )
    );
  }
  stop(botId: string) {
    for (const [id, e] of this.#epochs) if (e.botId === botId) this.#epochs.delete(id);
    for (const [id, c] of this.#connections)
      if (c.replica.botId === botId) {
        this.#connections.delete(id);
        this.#epochs.delete(id);
        clearTimeout(c.timer);
        for (const r of c.requests.values()) r.abort();
        c.socket.terminate();
      }
  }
  close() {
    this.#closed = true;
    for (const c of this.#connections.values()) {
      clearTimeout(c.timer);
      for (const request of c.requests.values()) request.abort();
      c.socket.terminate();
    }
    this.#connections.clear();
    this.#epochs.clear();
  }
  async authority(
    input: {
      operation: z.infer<typeof RelayOperation>;
      sharedBotId: string;
      peerDeviceId?: string;
    },
    body: unknown,
    fields: Fields,
  ) {
    if (this.#closed || !this.#device.relayAuthority) throw new Error("sync_unconfigured");
    const result = await this.#device.relayAuthority(
      {
        version: 1,
        operation: input.operation,
        sharedBotId: input.sharedBotId,
        ...(input.peerDeviceId === undefined ? {} : { peerDeviceId: input.peerDeviceId }),
        requestDigest: metadataDigest(body),
      },
      fields,
    );
    if (this.#closed) throw new Error("sync_generation_changed");
    return result.authority;
  }
  async metadata(
    input: Extract<
      z.infer<typeof RelayRequest>,
      { operation: "ack" | "receipts" | "status-report" | "status-read" }
    >,
    fields: Fields,
    signal?: AbortSignal,
    beforeSend?: () => Promise<void>,
  ) {
    const authority = await this.authority(input, input, fields);
    if (beforeSend) await beforeSend();
    return this.#exchange(`/v1/relay/${input.operation}`, input, fields, authority, signal);
  }
  async directory(sharedBotId: string, fields: Fields, signal?: AbortSignal) {
    const input = { version: 1, operation: "discover" as const, sharedBotId };
    const authority = await this.authority(input, input, fields);
    return relayDirectory.parse(
      await this.#exchange("/v1/relay/discover", input, fields, authority, signal),
    );
  }
  async exchange(
    receiverBinding: ReadyReplica["binding"],
    sharedBotId: string,
    peerDeviceId: string,
    generation: string,
    method: "challenge" | "object",
    payload: unknown,
    fields: Fields,
    signal?: AbortSignal,
  ) {
    const input = {
      version: 1,
      operation: "exchange" as const,
      sharedBotId,
      peerDeviceId,
      generation,
      method,
      payload,
      receiverBinding,
      requestId: randomUUID(),
    };
    const authority = await this.authority(input, input, fields);
    const result = await this.#exchange("/v1/relay/exchange", input, fields, authority, signal);
    return method === "object"
      ? { ...z.record(z.string(), z.unknown()).parse(result), relayRequestId: input.requestId }
      : result;
  }
  register(replica: ReadyReplica, fields: Fields, guard: () => void = () => {}): Promise<unknown> {
    guard();
    const opening = this.#opening.get(replica.sharedBotId);
    if (opening) return opening;
    if (this.#opening.size >= 32) throw new Error("sync_relay_capacity");
    const epoch = { botId: replica.botId };
    this.#epochs.set(replica.sharedBotId, epoch);
    const work = this.#register(replica, fields, epoch, guard).finally(() =>
      this.#opening.delete(replica.sharedBotId),
    );
    this.#opening.set(replica.sharedBotId, work);
    return work;
  }
  async #register(replica: ReadyReplica, fields: Fields, epoch: object, guard: () => void) {
    const live = () => {
      guard();
      if (this.#closed || this.#epochs.get(replica.sharedBotId) !== epoch)
        throw new Error("sync_generation_changed");
    };
    await replica.check();
    live();
    const current = this.#connections.get(replica.sharedBotId);
    if (current && JSON.stringify(current.replica.binding) !== JSON.stringify(replica.binding)) {
      clearTimeout(current.timer);
      current.socket.terminate();
      this.#connections.delete(replica.sharedBotId);
    }
    let c = this.#connections.get(replica.sharedBotId);
    const status = z
      .object({
        streams: z.array(
          z.object({
            source: z.unknown(),
            received: z.number(),
            applied: z.number(),
            available: z.array(z.unknown()),
          }),
        ),
      })
      .parse(await replica.command("status", {}));
    live();
    const generation = c?.generation ?? nonce();
    const input = RelayRegister.parse({
      version: 1,
      operation: "register",
      sharedBotId: replica.sharedBotId,
      binding: replica.binding,
      generation,
      streams: status.streams,
    });
    const authority = await this.authority(input, input, fields);
    live();
    await replica.check();
    live();
    if (this.#closed) throw new Error("sync_generation_changed");
    if (!c) {
      const url = new URL("/v1/relay/connect", this.#origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("sharedBotId", replica.sharedBotId);
      const socket = new WebSocket(url, {
        maxPayload: MAX_RELAY_FRAME,
        handshakeTimeout: 10000,
        headers: { "x-bots-sync-trace": fields.trace, "x-bots-sync-bot": fields.botId },
      });
      c = { socket, generation, replica, requests: new Map(), guard };
      const connection = c;
      this.#connections.set(replica.sharedBotId, c);
      socket.on("close", () => {
        clearTimeout(connection.timer);
        for (const r of connection.requests.values()) r.abort();
        if (this.#connections.get(replica.sharedBotId) === connection)
          this.#connections.delete(replica.sharedBotId);
      });
      socket.on("error", () => undefined);
      socket.on("message", (data) => {
        void this.#message(connection, data.toString(), fields).catch(() =>
          socket.close(1008, "relay_refused"),
        );
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("sync_relay_timeout")), 10000);
        const done = (error?: Error) => {
          clearTimeout(timer);
          socket.off("open", open);
          socket.off("error", fail);
          socket.off("close", closed);
          error ? reject(error) : resolve();
        };
        const open = () => done(),
          fail = (e: Error) => done(e),
          closed = () => done(new Error("sync_relay_offline"));
        socket.once("open", open);
        socket.once("error", fail);
        socket.once("close", closed);
      }).catch((error) => {
        socket.terminate();
        throw error;
      });
    }
    const connection = c;
    await replica.check();
    live();
    if (this.#closed || !this.live(generation)) throw new Error("sync_generation_changed");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("sync_relay_timeout")), 10000);
      const message = (data: unknown) => {
        try {
          const result = JSON.parse(String(data));
          if (result.type === "registered" && result.generation === generation) done();
          else if (result.type === "failure")
            done(this.#refused(Number(result.status), result.body));
        } catch (error) {
          done(error as Error);
        }
      };
      const done = (error?: Error) => {
        clearTimeout(timer);
        connection.socket.off("message", message);
        error ? reject(error) : resolve();
      };
      connection.socket.on("message", message);
      connection.socket.send(JSON.stringify({ ...input, authority }));
    });
    live();
    clearTimeout(c.timer);
    c.timer = setTimeout(async () => {
      try {
        await this.register(replica, fields, guard);
      } catch {
        connection.socket.close();
      }
    }, 15000);
    c.timer.unref();
    return { version: 1, registered: true, generation };
  }
  async #message(c: Connection, text: string, fields: Fields) {
    const data = JSON.parse(text);
    if (data.type === "registered" || data.type === "failure") return;
    if (data.type === "cancel") {
      c.requests.get(data.requestId)?.abort();
      return;
    }
    const input = z
      .strictObject({
        type: z.literal("request"),
        requestId: z.uuid(),
        generation: z.string(),
        method: z.enum(["challenge", "object"]),
        payload: z.unknown(),
        trace: z.string().regex(/^tr_[A-Za-z0-9_-]{1,128}$/),
        botId: z
          .string()
          .regex(/^b_[A-Za-z0-9_-]{1,128}$/)
          .optional(),
      })
      .parse(data);
    if (
      input.generation !== c.generation ||
      !this.live(c.generation) ||
      [...this.#connections.values()].reduce((n, v) => n + v.requests.size, 0) >= 2 ||
      c.requests.has(input.requestId)
    )
      throw new Error("sync_relay_capacity");
    const cancel = new AbortController();
    c.requests.set(input.requestId, cancel);
    const guard = () => {
      c.guard();
      if (
        cancel.signal.aborted ||
        !this.live(c.generation) ||
        this.#connections.get(c.replica.sharedBotId) !== c
      )
        throw new Error("sync_generation_changed");
    };
    try {
      guard();
      const result = await this.#serve(
        input.method,
        input.payload,
        { trace: input.trace, botId: fields.botId },
        { generation: c.generation, replica: c.replica, guard },
      );
      guard();
      const output = JSON.stringify({
        type: "response",
        requestId: input.requestId,
        generation: c.generation,
        ...result,
      });
      if (
        Buffer.byteLength(output) > MAX_RELAY_FRAME ||
        c.socket.bufferedAmount + Buffer.byteLength(output) > MAX_RELAY_FRAME
      )
        throw new Error("sync_frame_too_large");
      c.socket.send(output);
    } finally {
      c.requests.delete(input.requestId);
    }
  }
}
