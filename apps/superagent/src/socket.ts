import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AttentionItem, AttentionStore } from "./attention.ts";
import { MAX_FRAME, ServiceError } from "./domain.ts";
import { type Identity, serverProof } from "./identity.ts";
import type { ObservationClient } from "./observation.ts";
import { authentication, command, hello } from "./protocol.ts";
import type { ChatRuntime } from "./runtime.ts";
import type { WatchMode } from "./watch.ts";

export const allowedRequest = (request: IncomingMessage) =>
  request.headers.origin === undefined &&
  /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? "");

export function attachSockets(
  server: Server,
  options: {
    token: string;
    identity: Identity;
    port: number;
    runtime: ChatRuntime;
    /** SG-002 observation; the service always supplies one, configured or not. */
    observation: ObservationClient;
    /** SG-004: what the watcher noticed, and the switch that lets it act. */
    proactive?: {
      readonly store: AttentionStore;
      readonly mode: () => WatchMode;
      readonly setMode: (mode: WatchMode) => void;
    };
  },
) {
  const { runtime, identity, token, port } = options;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  const active = new Set<Promise<void>>();
  let closing = false;
  let revision = 0;
  let snapshot: unknown;
  const subscribers = new Set<(value: unknown) => void>();
  const detach = runtime.observe((value) => {
    snapshot = { type: "snapshot", instance: identity.instance, rev: ++revision, value };
    for (const sink of subscribers) sink(snapshot);
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      closing ||
      !allowedRequest(request) ||
      request.url !== "/v1/chat" ||
      sockets.clients.size >= 16
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (socket) => {
    let stage: "hello" | "authenticate" | "ready" = "hello";
    let nonce = "";
    const serverNonce = randomBytes(16).toString("hex");
    let queue: Promise<void> = Promise.resolve();
    let queued = 0;
    let pending: unknown;
    let blockedAt: number | undefined;
    const deadline = setTimeout(() => socket.close(4001, "authentication_timeout"), 5000);
    const send = (value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > MAX_FRAME) {
        socket.close(1009, "frame_limit");
        return;
      }
      if (socket.bufferedAmount > MAX_FRAME * 4) {
        socket.close(1013, "slow_consumer");
        return;
      }
      socket.send(encoded);
    };
    const publish = (value: unknown) => {
      if (socket.bufferedAmount > MAX_FRAME) {
        pending = value;
        blockedAt ??= Date.now();
      } else {
        pending = undefined;
        blockedAt = undefined;
        send(value);
      }
    };
    const flush = setInterval(() => {
      if (blockedAt !== undefined && Date.now() - blockedAt > 10000)
        socket.close(1013, "slow_consumer");
      else if (pending !== undefined && socket.bufferedAmount <= MAX_FRAME) publish(pending);
    }, 100);
    flush.unref();
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(deadline);
      clearInterval(flush);
      subscribers.delete(publish);
    });
    socket.on("message", (bytes, binary) => {
      if (queued >= 32) {
        socket.close(1008, "command_limit");
        return;
      }
      queued += 1;
      const handle = async () => {
        if (closing || socket.readyState !== WebSocket.OPEN) return;
        if (binary) {
          socket.close(1008, "text_required");
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString());
        } catch {
          socket.close(1008, "invalid_json");
          return;
        }
        if (stage === "hello") {
          const parsed = hello.safeParse(raw);
          if (!parsed.success) {
            socket.close(1008, "hello_required");
            return;
          }
          nonce = parsed.data.nonce;
          stage = "authenticate";
          send({
            type: "challenge",
            identity,
            serverNonce,
            proof: serverProof(token, `${nonce}\n${serverNonce}`, port, identity),
          });
          return;
        }
        if (stage === "authenticate") {
          const parsed = authentication.safeParse(raw);
          if (!parsed.success) {
            socket.close(4001, "authentication_failed");
            return;
          }
          const expected = createHmac("sha256", token)
            .update(`client\n${nonce}\n${serverNonce}\n${identity.instance}`)
            .digest();
          if (!timingSafeEqual(expected, Buffer.from(parsed.data.proof, "hex"))) {
            socket.close(4001, "authentication_failed");
            return;
          }
          clearTimeout(deadline);
          stage = "ready";
          send({ type: "ready" });
          subscribers.add(publish);
          publish(snapshot);
          return;
        }
        const parsed = command.safeParse(raw);
        const id =
          typeof raw === "object" &&
          raw !== null &&
          "id" in raw &&
          typeof raw.id === "string" &&
          /^[A-Za-z0-9_-]{8,64}$/.test(raw.id)
            ? raw.id
            : undefined;
        if (!parsed.success) {
          send({ type: "error", ...(id ? { id } : {}), code: "invalid_command" });
          return;
        }
        const input = parsed.data;
        try {
          let value: unknown;
          switch (input.type) {
            case "state":
              value = snapshot;
              break;
            case "configure": {
              const { apiKey, ...configuration } = input.configuration;
              value = await runtime.configure({
                ...configuration,
                ...(apiKey === undefined ? {} : { apiKey }),
              });
              break;
            }
            case "send":
              value = await runtime.submit(input.requestId, input.text);
              break;
            case "submission":
              value = await runtime.submission(input.requestId);
              break;
            case "history":
              value = await runtime.history(input.before, input.limit);
              break;
            case "abort":
              await runtime.abort();
              value = { stopped: true };
              break;
            case "observe-snapshot":
              value = await options.observation.snapshot();
              break;
            case "observe-history":
              value = await options.observation.history({
                botId: input.botId,
                scope: input.scope,
                before: input.before,
                limit: input.limit,
              });
              break;
            case "observe-changes":
              value = await options.observation.changes(input.limit);
              break;
            case "attention": {
              const proactive = options.proactive;
              if (proactive === undefined) throw new ServiceError("invalid_command");
              const state = await proactive.store.snapshot();
              value = {
                items: (await proactive.store.list(
                  input.limit === undefined ? {} : { limit: input.limit },
                )) as AttentionItem[],
                provider: {
                  state: state.lastError === undefined ? "ready" : state.lastError,
                  lastTickAt: state.lastTickAt ?? null,
                },
              };
              break;
            }
            case "attention-ack": {
              const proactive = options.proactive;
              if (proactive === undefined) throw new ServiceError("invalid_command");
              const item = await proactive.store.ack(input.itemId, new Date().toISOString());
              if (item === undefined) throw new ServiceError("invalid_command");
              value = { item };
              break;
            }
            case "manage-mode": {
              const proactive = options.proactive;
              if (proactive === undefined) throw new ServiceError("invalid_command");
              if (input.mode !== undefined) proactive.setMode(input.mode);
              value = { mode: proactive.mode() };
              break;
            }
          }
          send({ type: "result", id: input.id, value });
        } catch (error) {
          send({
            type: "error",
            id: input.id,
            code:
              error instanceof ServiceError
                ? error.code
                : runtime.snapshot().failure?.code === "storage_failed"
                  ? "storage_failed"
                  : "internal",
          });
        }
      };
      const operation = queue.then(handle, handle);
      const tracked = operation.catch(() => socket.close(1011, "internal"));
      queue = tracked;
      active.add(tracked);
      void tracked.finally(() => {
        active.delete(tracked);
        queued -= 1;
      });
    });
  });
  return async () => {
    closing = true;
    detach();
    for (const socket of sockets.clients) socket.terminate();
    await Promise.all([...active]);
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  };
}
