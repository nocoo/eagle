// The WebSocket transport (docs/bots/PROTOCOL.md): one bot per connection, `hello` first,
// close codes for every refusal, and a frame budget measured on the encoded text.
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { BotRegistry } from "../core/BotRegistry.ts";
import type { ConversationService } from "../core/ConversationService.ts";
import type { ErrorDisposition } from "../core/domain.ts";
import { ClassifiedFailure } from "../core/domain.ts";
import { type HubEvent, SubscriberTooSlow } from "../core/EventHub.ts";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import { encodeServerEvent, serializeFrame } from "../protocol/encode.ts";
import {
  type ClientCommand,
  decodeCommand,
  FrameError,
  parseJson,
  type ServerEvent,
} from "../protocol/frames.ts";
import { TRACE_ID } from "../protocol/limits.ts";
import { assertFrameBudget, assertInboundBytes, validateCommand } from "../protocol/validate.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";
import { serverFailure } from "./failures.ts";

const Events = {
  openOk: declareEvent("transport.conn.open.ok"),
  closeOk: declareEvent("transport.conn.close.ok"),
  closeEnd: declareEvent("transport.conn.close.end"),
  frameRecvOk: declareEvent("transport.frame.recv.ok"),
  frameSendOk: declareEvent("transport.frame.send.ok"),
  frameSendDrop: declareEvent("transport.frame.send.drop"),
  decodeFail: declareEvent("protocol.decode.fail"),
  encodeFail: declareEvent("protocol.encode.fail"),
  limitFail: declareEvent("protocol.limit.fail"),
  versionFail: declareEvent("protocol.version.fail"),
  commandStart: declareEvent("protocol.command.start"),
  commandOk: declareEvent("protocol.command.ok"),
  commandFail: declareEvent("protocol.command.fail"),
} as const;

export const CLOSE = {
  normal: 1000,
  internal: 1011,
  auth: 4001,
  protocol: 1008,
  idle: 4000,
  unknownBot: 4004,
  version: 4009,
  quarantined: 4090,
  shutdown: 4010,
} as const;

/** Commands that only make sense on a connection that already subscribed. */
const NEEDS_SUBSCRIPTION = new Set(["send", "abort", "recover", "resync", "history"]);

/** A connection that sends no frame for this long is closed with 4000. */
export const IDLE_FRAME_MS = 60_000;
/** Unsent bytes on one socket before its subscriber is downgraded (PROTOCOL.md, limits). */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
export const MAX_CONNECTIONS = 16;

export type ConnectionDeps = {
  readonly log: Log;
  readonly service: ConversationService;
  readonly registry: BotRegistry;
  readonly server: { readonly version: string; readonly instance: string; readonly pid: number };
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly connId: string;
  readonly register: (socket: WebSocket) => void;
  readonly unregister: (socket: WebSocket) => void;
  readonly idleMs?: number;
  /** How many bytes may sit unsent before the subscriber is treated as not reading. */
  readonly maxBufferedBytes?: number;
};

/** Maps a runtime event the hub numbered onto its wire event. */
export const toServerEvent = (event: HubEvent): ServerEvent => {
  switch (event.type) {
    case "snapshot":
      return { type: "snapshot", rev: event.rev, trace: event.trace, value: event.value };
    case "append":
      return {
        type: "append",
        rev: event.rev,
        trace: event.trace,
        message: event.message,
        ...(event.replaces === undefined ? {} : { replaces: event.replaces }),
      };
    case "delta":
      return {
        type: "delta",
        rev: event.rev,
        trace: event.trace,
        messageId: event.messageId,
        changes: event.changes,
      };
    case "usage":
      return { type: "usage", rev: event.rev, trace: event.trace, usage: event.usage };
    case "agent":
      return { type: "agent", rev: event.rev, trace: event.trace, agent: event.agent };
    case "tasks":
      return { type: "tasks", rev: event.rev, trace: event.trace, tasks: event.tasks };
    case "triggers":
      return { type: "triggers", rev: event.rev, trace: event.trace, triggers: event.triggers };
    case "pulls":
      return { type: "pulls", rev: event.rev, trace: event.trace, pulls: event.pulls };
    case "status":
      return {
        type: "status",
        rev: event.rev,
        trace: event.trace,
        running: event.running,
        streaming: event.streaming,
        inbox: event.inbox,
      };
    case "submission":
      return { type: "submission", rev: event.rev, trace: event.trace, record: event.record };
    case "error":
      return {
        type: "error",
        rev: event.rev,
        trace: event.trace,
        kind: event.failure.kind === "version_mismatch" ? "internal" : event.failure.kind,
        disposition: "runtime",
        failure: event.failure.id,
        message: event.message,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      };
  }
};

/**
 * One connection. It answers `hello`, then routes commands to the service and encodes the
 * events the service publishes. Every refusal has one close code so the client can decide
 * whether to reconnect. Returns the connection's frame writer, so a daemon-wide event
 * (the catalog) goes through the same encoder, budget and record as the rest.
 */
export const attachConnection = (
  socket: WebSocket,
  deps: ConnectionDeps,
): ((event: ServerEvent) => void) => {
  const { log, service, registry, connId } = deps;
  // The connection's own trace, used until a command supplies one (OBSERVABILITY.md,
  // "Trace ownership": `tr_conn_<n>`).
  const connTrace = `tr_conn_${connId.replace(/^c_/, "")}`;
  const idleMs = deps.idleMs ?? IDLE_FRAME_MS;
  const maxBufferedBytes = deps.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  let helloSent = false;
  let subscribed = false;
  /** Set synchronously when a `subscribe` is dispatched, cleared when it settles. */
  let subscribing = false;
  let closed = false;
  let idleTimer: NodeJS.Timeout | undefined;

  type WriteOutcome = "sent" | "backlog" | "closed";
  const emit = (event: ServerEvent): WriteOutcome => {
    if (closed) return "closed";
    const trace = "trace" in event && event.trace !== undefined ? event.trace : connTrace;
    let wire: Record<string, unknown>;
    let text: string;
    try {
      wire = encodeServerEvent(event);
      text = serializeFrame(wire);
    } catch {
      // A frame this daemon cannot encode is a daemon defect, not a client mistake: the
      // socket closes with 1011 so the client reconnects instead of waiting forever.
      log.emit("error", "protocol", Events.encodeFail, {
        trace,
        connId,
        failure: serverFailure("internal", "protocol"),
        origin: true,
        detail: { reason: "invalid" },
      });
      close(CLOSE.internal, "encode failed");
      return "closed";
    }
    try {
      assertFrameBudget(wire);
    } catch {
      log.emit("warn", "transport", Events.frameSendDrop, {
        trace,
        connId,
        detail: { evt: event.type, bytes: Buffer.byteLength(text) },
      });
      // A single frame over the transport cap is a protocol violation even when this
      // daemon produced it: the client cannot decode it (PROTOCOL.md, "Close codes").
      close(CLOSE.protocol, "frame exceeds the transport cap");
      return "closed";
    }
    if (socket.bufferedAmount > maxBufferedBytes) {
      // Every path is bounded, not only the hub's: a client that is not reading cannot
      // make the daemon buffer command replies or catalog events without a limit.
      log.emit("warn", "transport", Events.frameSendDrop, {
        trace,
        connId,
        detail: { evt: event.type, bytes: text.length },
      });
      return "backlog";
    }
    socket.send(text);
    log.emit("trace", "transport", Events.frameSendOk, {
      trace,
      connId,
      detail: { evt: event.type, bytes: Buffer.byteLength(text) },
    });
    return "sent";
  };

  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    socket.close(code, reason.slice(0, 120));
    log.emit("info", "transport", Events.closeOk, { trace: connTrace, connId });
  };

  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close(CLOSE.idle, "idle"), idleMs);
    idleTimer.unref?.();
  };

  socket.on("close", () => {
    closed = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    service.unsubscribe(deps.connId);
    if (subscribed && leased) registry.release(connectionBot);
    deps.unregister(socket);
    log.emit("info", "transport", Events.closeEnd, { trace: connTrace, connId });
  });
  socket.on("error", () => close(CLOSE.normal, "socket error"));

  // Filled in by `subscribe`; the close handler uses it to release the idle hold.
  let connectionBot = "";
  /** Whether this connection actually holds a lease (a deleting bot grants none). */
  let leased = false;

  socket.on("message", (data, isBinary) => {
    if (closed) return;
    armIdle();
    const text = isBinary ? undefined : data.toString();
    if (text === undefined) {
      log.emit("error", "protocol", Events.decodeFail, {
        trace: connTrace,
        connId,
        failure: { id: `f_${connId}`, kind: "invalid_command", layer: "protocol" },
        origin: true,
        detail: { reason: "invalid" },
      });
      close(CLOSE.protocol, "binary frame");
      return;
    }
    log.emit("trace", "transport", Events.frameRecvOk, {
      trace: connTrace,
      connId,
      detail: { bytes: Buffer.byteLength(text) },
    });
    let command: ClientCommand;
    try {
      assertInboundBytes(text);
      command = decodeCommand(parseJson(text));
    } catch (error) {
      const frame = error instanceof FrameError ? error : undefined;
      const kind = frame?.reason === "limit_exceeded" ? "limit_exceeded" : "invalid_command";
      const evt = frame?.reason === "limit_exceeded" ? Events.limitFail : Events.decodeFail;
      // One refusal, one identity: the record and the frame a client matches on it share
      // this failure (PROTOCOL.md, "Client commands").
      const refusal = serverFailure(kind, "protocol");
      log.emit("error", "protocol", evt, {
        trace: frameTrace(text, connId),
        connId,
        failure: refusal,
        origin: true,
        detail: { reason: "invalid" },
      });
      // The handshake comes first: a frame that is not `hello` closes the connection, and
      // nothing — not even an error — is written before `welcome` (PROTOCOL.md, "Handshake").
      if (helloSent && frame?.reason === "invalid_command") {
        // A command this version does not know is refused, and the connection stays: the
        // client can carry on (PROTOCOL.md, "Client commands").
        emit({
          type: "error",
          trace: frameTrace(text, connId),
          kind: "invalid_command",
          disposition: "not_admitted",
          failure: refusal.id,
          message: "the command was refused",
        });
        return;
      }
      close(
        CLOSE.protocol,
        helloSent ? (frame?.reason ?? "bad frame") : "hello must be the first frame",
      );
      return;
    }
    void dispatch(command, text);
  });

  const dispatch = async (command: ClientCommand, text: string): Promise<void> => {
    // A client-supplied trace is used only once it is a legal trace: an invalid one is
    // user text and must never reach a log record (OBSERVABILITY.md, "Redaction").
    const trace =
      "trace" in command && typeof command.trace === "string" && TRACE_ID.test(command.trace)
        ? command.trace
        : connTrace;
    if (!helloSent) {
      if (command.type !== "hello") {
        close(CLOSE.protocol, "hello must be the first frame");
        return;
      }
      helloSent = true;
      if (command.protocolVersion !== PROTOCOL_VERSION) {
        log.emit("error", "protocol", Events.versionFail, {
          trace,
          connId,
          failure: { id: `f_${connId}`, kind: "version_mismatch", layer: "protocol" },
          origin: true,
          detail: { reason: "invalid" },
        });
        emit({
          type: "error",
          kind: "version_mismatch",
          message: "this daemon does not speak that protocol version",
          server: { protocolVersion: PROTOCOL_VERSION },
        });
        close(CLOSE.version, "version mismatch");
        return;
      }
      emit({
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        server: deps.server,
        capabilities: deps.capabilities,
        bots: registry.summaries(),
        ...(typeof registry.groups === "function" ? { groups: registry.groups() } : {}),
      });
      return;
    }
    if (command.type === "hello") {
      close(CLOSE.protocol, "hello twice");
      return;
    }
    if (command.type === "ping") {
      emit({ type: "pong" });
      return;
    }
    let checked: ClientCommand;
    try {
      // Wire limits live here, after the handshake: a version mismatch must still reach
      // its own final frame and close code.
      checked = validateCommand(command);
    } catch (error) {
      const reason = error instanceof FrameError ? error.reason : "invalid_command";
      const kind = reason === "limit_exceeded" ? "limit_exceeded" : "invalid_command";
      const refusal = serverFailure(kind, "protocol");
      log.emit(
        "error",
        "protocol",
        reason === "limit_exceeded" ? Events.limitFail : Events.decodeFail,
        {
          trace,
          connId,
          failure: refusal,
          origin: true,
          detail: { reason: "invalid" },
        },
      );
      emit({
        type: "error",
        trace,
        kind,
        disposition: "not_admitted",
        failure: refusal.id,
        message: "the command was refused",
        ...(command.type === "send" ? { requestId: command.requestId } : {}),
      });
      return;
    }
    command = checked;
    if (command.type === "hello" || command.type === "ping") return;
    log.emit("debug", "protocol", Events.commandStart, {
      trace,
      connId,
      detail: { kind: command.type },
    });
    // `ok` means decoded, validated and dispatched — not "succeeded" (OBSERVABILITY.md).
    log.emit("debug", "protocol", Events.commandOk, {
      trace,
      connId,
      detail: { kind: command.type },
    });
    if (!subscribed && NEEDS_SUBSCRIPTION.has(command.type)) {
      // A command that cannot reach any bot is refused here, with its own identity.
      const refusal = serverFailure("invalid_command", "protocol");
      log.emit("error", "protocol", Events.commandFail, {
        trace,
        connId,
        failure: refusal,
        origin: true,
        detail: { kind: command.type, reason: "invalid" },
      });
      emit({
        type: "error",
        trace,
        kind: "invalid_command",
        disposition: "not_admitted",
        failure: refusal.id,
        message: "the connection has no subscription",
        ...(command.type === "send" ? { requestId: command.requestId } : {}),
      });
      return;
    }
    try {
      await run(command, trace);
    } catch (error) {
      // Only the subscribe that failed clears the guard: an unrelated command's failure
      // must not let a second subscribe through while the first is still rendering.
      if (command.type === "subscribe") subscribing = false;
      await refuse(error, command, trace);
    }
    void text;
  };

  const run = async (
    command: Exclude<ClientCommand, { type: "hello" | "ping" }>,
    trace: string,
  ): Promise<void> => {
    if (command.type === "subscribe") {
      // The flag is set before the first await, so a second subscribe that arrives while
      // the baseline is still being rendered is a protocol violation, not a race.
      if (subscribed || subscribing) {
        close(CLOSE.protocol, "already subscribed");
        return;
      }
      subscribing = true;
      if (registry.state(command.botId) === "quarantined") {
        close(CLOSE.quarantined, "quarantined");
        return;
      }
      const { rev, snapshot } = await service.subscribe(
        connId,
        command.botId,
        trace,
        (event) => {
          // A client that stopped reading must not make the daemon buffer without a bound:
          // the hub downgrades this subscriber to snapshot-only instead (PROTOCOL.md). An
          // oversized frame is not backlog: the writer already closed 1008 for it.
          if (emit(toServerEvent(event)) === "backlog") throw new SubscriberTooSlow();
        },
        command.contextId,
      );
      subscribed = true;
      connectionBot = command.botId;
      leased = registry.touch(command.botId);
      // The hub already published this baseline to the sink, numbered: sending it again
      // would paint an older snapshot over anything that arrived since (PROTOCOL I1/I3).
      subscribing = false;
      void rev;
      void snapshot;
      return;
    }
    if (command.type === "send") {
      const record = await service.send(connId, {
        requestId: command.requestId,
        text: command.text,
        ...(command.contextId === undefined ? {} : { contextId: command.contextId }),
        ...(command.resourceHead === undefined ? {} : { resourceHead: command.resourceHead }),
        whenBusy: command.whenBusy,
        trace,
      });
      emit({ type: "submission", trace, record });
      return;
    }
    if (command.type === "abort") {
      await service.abort(connId, trace);
      return;
    }
    if (command.type === "recover") {
      await service.recover(connId, trace);
      return;
    }
    if (command.type === "resync") {
      service.resync(connId, trace);
      return;
    }
    const history = await service.history(
      connId,
      { beforeEntryId: command.before, limit: command.limit },
      trace,
    );
    emit({ type: "history", trace, messages: history.messages, hasMore: history.hasMore });
  };

  const refuse = async (error: unknown, command: ClientCommand, trace: string): Promise<void> => {
    // A failure no layer classified is this daemon's own defect: it is recorded here, at
    // error, with an identity of its own, so the client's frame names it too.
    const unclassified = !(error instanceof ClassifiedFailure);
    const classified =
      error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(
            serverFailure("internal", "protocol"),
            "runtime",
            "the command failed",
            { cause: error },
          );
    const kind = classified.failure.kind;
    const disposition: ErrorDisposition = classified.disposition;
    const requestId = command.type === "send" ? command.requestId : undefined;
    // A classified failure was recorded below: this layer records only that it handed it
    // on. An unclassified one has no other record, so this is its origin.
    log.emit(unclassified ? "error" : "warn", "protocol", Events.commandFail, {
      trace,
      connId,
      ...(requestId === undefined ? {} : { reqId: requestId }),
      failure: classified.failure,
      ...(unclassified
        ? { origin: true as const }
        : { detail: { kind: command.type, reason: "upstream", propagated: true } }),
    });
    if (kind === "unknown_bot" && disposition === "not_admitted") {
      // A bot that became quarantined while the subscription waited for its close is not
      // gone: the client must retry (PROTOCOL.md, close codes 4090 vs 4004).
      if (command.type === "subscribe" && registry.state(command.botId) === "quarantined") {
        close(CLOSE.quarantined, "quarantined");
        return;
      }
      close(CLOSE.unknownBot, "unknown bot");
      return;
    }
    emit({
      type: "error",
      trace,
      kind: kind === "version_mismatch" ? "internal" : kind,
      disposition,
      failure: classified.failure.id,
      message: safeMessage(classified.message),
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (command.type === "subscribe" && disposition === "runtime") {
      close(CLOSE.internal, "subscription failed");
    }
  };

  armIdle();
  deps.register(socket);
  log.emit("info", "transport", Events.openOk, { trace: connTrace, connId });
  // The daemon-wide catalog event waits for the handshake: `welcome` already carries the
  // catalog as it is at hello time, so a change before it needs no separate frame
  // (PROTOCOL.md, "Handshake" — nothing precedes welcome).
  return (event: ServerEvent): void => {
    if (!helloSent) return;
    emit(event);
  };
};

/** A rejection message is bounded and never carries model or provider content. */
const safeMessage = (message: string): string =>
  message.length > 200 ? `${message.slice(0, 197)}…` : message;

/** The trace of a refused frame: the client's own when the JSON parsed, else the connection. */
const frameTrace = (text: string, connId: string): string => {
  try {
    const raw = JSON.parse(text) as { trace?: unknown };
    if (typeof raw.trace === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw.trace)) return raw.trace;
  } catch {
    // not JSON: fall through
  }
  return `tr_conn_${connId.replace(/^c_/, "")}`;
};

/** Rejects authentication and connection-count limits before any upgrade happens. */
export const refuseUpgrade = (socket: Duplex, code: number, message: string): void => {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};
