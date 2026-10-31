// Structured layer logging (docs/bots/OBSERVABILITY.md). One JSON record per line,
// every record carries its layer and trace, and both message content and credentials
// are removed before anything is written.

import type { ErrorKind, Failure } from "../core/domain.ts";
import { type DeclaredEvent, type EventName, isEventName, type Layer } from "./events.ts";

export const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

export type LogRecord = {
  readonly ts: string;
  readonly level: Level;
  readonly layer: Layer;
  readonly evt: EventName;
  readonly trace: string;
  readonly botId?: string;
  readonly connId?: string;
  readonly reqId?: string;
  readonly rev?: number;
  readonly durMs?: number;
  readonly err?: { readonly kind: ErrorKind; readonly failure: string; readonly origin?: true };
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type LogSink = (record: LogRecord) => void;

// Every allowed detail key has a declared type. An unknown key or a wrong type is a
// shape error at the emit site, not something the sink silently drops.
const DETAIL_TYPES = {
  count: "number",
  bytes: "number",
  len: "number",
  reason: "string",
  kind: "string",
  role: "string",
  state: "string",
  messageId: "string",
  finished: "string",
  evt: "string",
  providerCode: "string",
  reattach: "boolean",
  quarantined: "boolean",
  queued: "boolean",
  propagated: "boolean",
} as const;

const redact = (value: string, secrets: readonly string[] = []): string => {
  let text = value;
  for (const secret of [process.env.BOTS_API_KEY, process.env.AGENT_SIGNING_KEY, ...secrets]) {
    if (secret && secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/[A-Za-z0-9_-]{0,2}sk-[A-Za-z0-9_-]{16,}/g, "[redacted]");
  const home = process.env.HOME;
  if (home && home.length > 1) text = text.split(home).join("~");
  return text;
};

// Per-event detail whitelist. An event without an entry carries only framework keys,
// so a record can never borrow another event's fields.
const DETAIL_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  "runtime.sync.fail": ["reason", "providerCode"],
  "core.sync.fail": ["propagated"],
  "transport.auth.fail": ["reason"],
  "transport.conn.open.ok": ["count"],
  "transport.conn.open.fail": ["reason"],
  "transport.conn.open.reject": ["reason", "count"],
  "transport.conn.close.ok": ["count"],
  "transport.conn.close.end": ["reason"],
  "transport.frame.recv.ok": ["bytes", "evt"],
  "transport.frame.recv.fail": ["reason"],
  "transport.frame.send.ok": ["bytes", "evt"],
  "transport.frame.send.drop": ["evt", "bytes"],
  "protocol.decode.fail": ["reason"],
  "protocol.encode.fail": ["reason"],
  "protocol.limit.fail": ["reason", "len"],
  "protocol.version.fail": ["reason"],
  "protocol.command.start": ["kind"],
  "protocol.command.ok": ["kind"],
  "protocol.command.fail": ["kind", "reason"],
  "core.catalog.write.ok": ["count"],
  "core.group.write.ok": ["count"],
  "runtime.task.retry.ok": ["finished"],
  "runtime.task.abort.ok": ["finished"],
  "core.bot.open.ok": ["count"],
  "core.bot.open.fail": ["reason"],
  "core.bot.close.fail": ["reason"],
  "core.subscribe.ok": ["count"],
  "core.subscribe.fail": ["reason"],
  "core.submit.fail": ["reason"],
  "core.history.fail": ["reason"],
  "core.singleton.start": ["reason"],
  "core.singleton.fail": ["reason"],
  "core.hub.publish.ok": ["count", "bytes", "kind", "messageId"],
  "core.hub.coalesce.ok": ["count", "bytes"],
  "core.hub.degrade": ["reason", "count"],
  "core.bot.close.degrade": ["reason", "quarantined"],
  "core.catalog.load.ok": ["count"],
  "core.reconcile.ok": ["count"],
  "core.recovery.start": ["count"],
  "core.recovery.bot.ok": ["finished"],
  "core.recovery.bot.fail": ["reason"],
  "core.recovery.ok": ["count"],
  "core.bot.close.ok": ["quarantined"],
  "core.delete.ok": ["count", "finished"],
  "core.delete.fail": ["reason"],
  "core.submit.ok": ["queued", "count"],
  "core.history.ok": ["count"],
  "runtime.subscribe.ok": ["reattach"],
  "runtime.submit.ok": ["queued", "count"],
  "runtime.abort.ok": ["finished"],
  "runtime.recover.ok": ["count"],
  "runtime.close.ok": ["quarantined"],
  "runtime.close.fail": ["reason"],
  "runtime.failure.classify": ["providerCode", "reason"],
  "runtime.submit.fail": ["providerCode", "reason"],
  "runtime.watch.end.ok": ["reason"],
  "pi.report": ["kind", "reason"],
};
const FRAMEWORK_DETAIL = new Set(["propagated"]);
const COUNT_KEYS = new Set(["count", "bytes", "len"]);

// `reason` and `providerCode` are the only string details that are not ids, so they
// must be codes, never prose: free text there would be a content channel around the
// per-event whitelist.
const REASONS = new Set([
  "listener_error",
  "queue_overflow",
  "retired",
  "stopped",
  "cancelled",
  "session_closed",
  "session_failed",
  "timeout",
  "invalid",
  "upstream",
  "shutdown",
  "delete",
  "startup",
  "quarantine",
]);
const PROVIDER_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

const redactDetail = (
  evt: EventName,
  detail: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Record<string, unknown> => {
  const allowed = DETAIL_SCHEMA[evt] ?? [];
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!FRAMEWORK_DETAIL.has(key) && !allowed.includes(key)) {
      throw new Error(`log detail ${key} is not declared for ${evt}`);
    }
    const expected = (DETAIL_TYPES as Record<string, string | undefined>)[key];
    if (expected === undefined) throw new Error(`undeclared log detail key: ${key}`);
    if (typeof value !== expected) throw new Error(`log detail ${key} must be a ${expected}`);
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`log detail ${key} must be a finite number`);
    }
    if (
      COUNT_KEYS.has(key) &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`log detail ${key} must be a non-negative integer`);
    }
    if (key === "reason" && !REASONS.has(value as string)) {
      throw new Error("log detail reason must be a known code");
    }
    if (key === "providerCode" && !PROVIDER_CODE.test(value as string)) {
      throw new Error("log detail providerCode must be a short code");
    }
    clean[key] = expected === "string" ? redact(value as string, secrets) : value;
  }
  return clean;
};

export type EmitFields = {
  readonly trace: string;
  readonly botId?: string;
  readonly connId?: string;
  readonly reqId?: string;
  readonly rev?: number;
  readonly durMs?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Required for `*.fail`, `*.degrade` and `*.reject`. */
  readonly failure?: Failure;
  /** Set by the originating layer only; layers above record `propagated`. */
  readonly origin?: boolean;
  readonly propagated?: boolean;
};

export type LogOptions = {
  /** Credentials known only at runtime, such as the daemon bearer token. */
  readonly secrets?: () => readonly string[];
};

export class Log {
  readonly #sink: LogSink;
  readonly #now: () => Date;
  readonly #secrets: () => readonly string[];

  constructor(sink: LogSink, now: () => Date = () => new Date(), options: LogOptions = {}) {
    this.#sink = sink;
    this.#now = now;
    this.#secrets = options.secrets ?? (() => []);
  }

  emit(level: Level, layer: Layer, evt: DeclaredEvent, fields: EmitFields): LogRecord {
    // The event argument is an `EventName`, so a literal typo fails typecheck as well.
    if (!isEventName(evt)) throw new Error(`undeclared log event: ${String(evt)}`);
    // `DeclaredEvent` is a brand: a literal or an aliased string cannot reach here.
    if (!evt.startsWith(`${layer}.`)) {
      throw new Error(`event ${evt} does not belong to layer ${layer}`);
    }
    const needsFailure = /\.(fail|degrade|reject|classify)$/.test(evt) || level === "error";
    if (needsFailure && fields.failure === undefined) {
      throw new Error(`event ${evt} requires a failure`);
    }
    if (fields.failure !== undefined && fields.failure.id.trim().length === 0) {
      throw new Error(`event ${evt} needs a non-empty failure identity`);
    }
    // Claiming origin is checked at every level, not only for error records: a warn
    // or info record must not attribute a failure to another layer either.
    if (fields.origin === true && fields.failure?.layer !== layer) {
      throw new Error(
        `an origin record for ${evt} must come from ${String(fields.failure?.layer ?? "the failure layer")}`,
      );
    }
    if (level === "error" && fields.origin !== true) {
      throw new Error(`only the originating layer logs at error (${evt})`);
    }

    const record: LogRecord = {
      ts: this.#now().toISOString(),
      level,
      layer,
      evt,
      trace: redact(fields.trace, this.#secrets()),
      ...(fields.botId === undefined ? {} : { botId: redact(fields.botId, this.#secrets()) }),
      ...(fields.connId === undefined ? {} : { connId: redact(fields.connId, this.#secrets()) }),
      ...(fields.reqId === undefined ? {} : { reqId: redact(fields.reqId, this.#secrets()) }),
      ...(fields.rev === undefined ? {} : { rev: fields.rev }),
      ...(fields.durMs === undefined ? {} : { durMs: fields.durMs }),
      ...(fields.failure === undefined
        ? {}
        : {
            err: {
              kind: fields.failure.kind,
              failure: redact(fields.failure.id, this.#secrets()),
              ...(fields.origin === true ? { origin: true as const } : {}),
            },
          }),
      ...(fields.detail === undefined && fields.propagated === undefined
        ? {}
        : {
            detail: redactDetail(
              evt,
              {
                ...(fields.detail ?? {}),
                ...(fields.propagated === true ? { propagated: true } : {}),
              },
              this.#secrets(),
            ),
          }),
    };
    this.#sink(record);
    return record;
  }
}

/** Collects records for assertions; never used in production paths. */
export const captureLog = (
  now: () => Date = () => new Date(),
  options: LogOptions = {},
): { log: Log; records: LogRecord[] } => {
  const records: LogRecord[] = [];
  return { log: new Log((record) => records.push(record), now, options), records };
};
