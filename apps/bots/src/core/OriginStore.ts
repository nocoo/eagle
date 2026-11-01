// Admission origins on disk (docs/bots/TRIGGERS.md §6): the daemon's own record of who
// caused a user entry, because pi stores entries and not their cause, and `requestId` is
// not recoverable from an entry after a restart. Append-only; the file is the source of
// truth and memory is a rebuilt index.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MessageOrigin } from "./domain.ts";

/** Beyond this the oldest records are forgotten, so their messages render as `unknown`. */
export const MAX_ORIGIN_RECORDS = 20_000;

export type OriginRecord = {
  readonly requestId: string;
  readonly origin: MessageOrigin;
  readonly entryId?: string;
};

/** One append-only file per bot, addressed by the bot's directory. */
export const originPath = (botDir: string): string => `${botDir}/origins.jsonl`;

export class OriginStore {
  readonly #path: string;
  /** entryId → record: what every render path can look up from a committed message. */
  readonly #byEntry = new Map<string, OriginRecord>();
  /** requestId → origin: lets a live message resolve before its entry id is known. */
  readonly #byRequest = new Map<string, MessageOrigin>();
  /** Entry ids in write order, so the cap drops the oldest and not the newest. */
  readonly #order: string[] = [];
  /** Serialized appends: two admissions in one bot must not interleave bytes. */
  #queue: Promise<void> = Promise.resolve();
  /** Lines the replay could not read, reported once by the composition root. */
  readonly dropped: number;

  private constructor(path: string, dropped: number) {
    this.#path = path;
    this.dropped = dropped;
  }

  static async open(path: string): Promise<OriginStore> {
    let body = "";
    try {
      body = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const records: OriginRecord[] = [];
    let dropped = 0;
    for (const line of body.split("\n")) {
      if (line.trim().length === 0) continue;
      const record = parse(line);
      if (record === undefined) dropped += 1;
      else records.push(record);
    }
    const kept = records.slice(-MAX_ORIGIN_RECORDS);
    const store = new OriginStore(path, dropped);
    for (const record of kept) store.#remember(record);
    if (records.length > kept.length) await store.#rewrite();
    return store;
  }

  originOf(message: {
    readonly id: string;
    readonly requestId?: string;
  }): MessageOrigin | undefined {
    const byEntry = this.#byEntry.get(message.id)?.origin;
    if (byEntry !== undefined) return byEntry;
    return message.requestId === undefined ? undefined : this.#byRequest.get(message.requestId);
  }

  /** Write-ahead: an admission whose origin is not recorded is not admitted (§6.2). */
  record(input: { readonly requestId: string; readonly origin: MessageOrigin }): Promise<void> {
    this.#byRequest.set(input.requestId, input.origin);
    return this.#append({ requestId: input.requestId, origin: input.origin });
  }

  /** The entry id is only known once the submission names it; the origin is not repeated. */
  backfill(input: { readonly requestId: string; readonly entryId: string }): Promise<void> {
    const origin = this.#byRequest.get(input.requestId);
    if (origin === undefined) return Promise.resolve();
    const record = { requestId: input.requestId, origin, entryId: input.entryId };
    this.#remember(record);
    return this.#append(record);
  }

  #append(record: OriginRecord): Promise<void> {
    const write = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });
    this.#queue = write.catch(() => undefined);
    return write;
  }

  #remember(record: OriginRecord): void {
    this.#byRequest.set(record.requestId, record.origin);
    if (record.entryId === undefined) return;
    if (!this.#byEntry.has(record.entryId)) this.#order.push(record.entryId);
    this.#byEntry.set(record.entryId, record);
    while (this.#order.length > MAX_ORIGIN_RECORDS) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#byEntry.delete(oldest);
    }
  }

  /** Drops records past the cap from the file as well, so a restart reads less. */
  async #rewrite(): Promise<void> {
    const lines: string[] = [];
    for (const entryId of this.#order) {
      const record = this.#byEntry.get(entryId);
      if (record !== undefined) lines.push(JSON.stringify(record));
    }
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
  }
}

const parse = (line: string): OriginRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { requestId?: unknown; origin?: unknown; entryId?: unknown };
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return undefined;
  const origin = parseOrigin(record.origin);
  if (origin === undefined) return undefined;
  if (record.entryId !== undefined && typeof record.entryId !== "string") return undefined;
  return {
    requestId: record.requestId,
    origin,
    ...(record.entryId === undefined ? {} : { entryId: record.entryId as string }),
  };
};

const parseOrigin = (value: unknown): MessageOrigin | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const origin = value as {
    kind?: unknown;
    triggerId?: unknown;
    fromBotId?: unknown;
    exchangeId?: unknown;
    label?: unknown;
  };
  const label = typeof origin.label === "string" ? origin.label : undefined;
  switch (origin.kind) {
    case "human":
      // A named CLI credential's label is part of the record, or the next read would
      // attribute the message to a bare "human".
      return label === undefined ? { kind: "human" } : { kind: "human", label };
    case "unknown":
      return { kind: "unknown" };
    case "schedule":
    case "webhook":
      return typeof origin.triggerId === "string"
        ? { kind: origin.kind, triggerId: origin.triggerId }
        : undefined;
    case "peer":
      return typeof origin.fromBotId === "string"
        ? {
            kind: "peer",
            fromBotId: origin.fromBotId,
            ...(typeof origin.exchangeId === "string" ? { exchangeId: origin.exchangeId } : {}),
            ...(label === undefined ? {} : { label }),
          }
        : undefined;
    default:
      return undefined;
  }
};
