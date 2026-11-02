// The daemon's log files (docs/bots/OBSERVABILITY.md, "Record shape"): one JSON object per
// line, `<root>/logs/daemon-YYYYMMDD.jsonl`, rotated at 10 MB with five files kept, and a
// `flush()` barrier so a test can assert absence instead of racing a sleep.
import { type FileHandle, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { LEVELS, type Level, type LogRecord, type LogSink } from "./log.ts";

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const KEEP_LOG_FILES = 5;

const rank = (level: Level): number => LEVELS.indexOf(level);

/** `daemon-YYYYMMDD.jsonl` and its rotations: the only files the sink deletes. */
const FILE_PATTERN = /^daemon-\d{8}\.jsonl(?:\.\d+)?$/;

/** Sort key: day first, then rotation index, so the oldest file is the smallest rank. */
const rankOf = (name: string): number => {
  const match = /^daemon-(\d{8})\.jsonl(?:\.(\d+))?$/.exec(name);
  const day = Number(match?.[1] ?? 0);
  const rotation = Number(match?.[2] ?? 0);
  return day * 100 + rotation;
};

export type FileSinkOptions = {
  readonly root: string;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly keep?: number;
  /** Records below this level are dropped before they reach the file. */
  readonly minimum?: Level;
};

export class FileLogSink {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #minimum: Level;
  #handle: FileHandle | undefined;
  #day = "";
  #bytes = 0;
  #queue: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(options: FileSinkOptions) {
    this.#dir = join(options.root, "logs");
    this.#now = options.now ?? (() => new Date());
    this.#maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.#keep = options.keep ?? KEEP_LOG_FILES;
    this.#minimum = options.minimum ?? "debug";
  }

  /** The sink the daemon hands to `Log`. */
  readonly sink: LogSink = (record) => this.write(record);

  /** Never throws into a caller: a broken log file must not fail a request. */
  write(record: LogRecord): void {
    if (this.#closing !== undefined || rank(record.level) < rank(this.#minimum)) return;
    const line = `${JSON.stringify(record)}\n`;
    this.#queue = this.#queue.then(() => this.#append(line)).catch(() => undefined);
  }

  /** Resolves once every record written so far is on disk. */
  async flush(): Promise<void> {
    await this.#queue;
    await this.#handle?.sync().catch(() => undefined);
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.flush();
      const handle = this.#handle;
      this.#handle = undefined;
      await handle?.close().catch(() => undefined);
    })();
    return this.#closing;
  }

  async #append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    const day = this.#dayOf(this.#now());
    if (this.#handle === undefined || day !== this.#day) await this.#open(day);
    else if (this.#bytes + bytes > this.#maxBytes) await this.#open(day, true);
    if (this.#handle === undefined) return;
    await this.#handle.write(line);
    this.#bytes += bytes;
  }

  /** Opens the day's file, rotating the full previous one when asked. */
  async #open(day: string, rotate = false): Promise<void> {
    await this.#handle?.close().catch(() => undefined);
    this.#handle = undefined;
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const current = join(this.#dir, `daemon-${day}.jsonl`);
    if (rotate) await this.#shift(current);
    this.#day = day;
    this.#handle = await open(current, "a", 0o600);
    this.#bytes = (await this.#handle.stat()).size;
    // Rotation alone keeps five files within one day; a new day starts a sixth unless
    // the oldest days go (OBSERVABILITY.md, "Record shape").
    await this.#prune(current);
  }

  async #prune(current: string): Promise<void> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    const logs = names
      .filter((name) => FILE_PATTERN.test(name))
      .map((name) => ({ name, rank: rankOf(name) }))
      .sort((left, right) => left.rank - right.rank);
    if (logs.length <= this.#keep) return;
    const doomed = logs.slice(0, logs.length - this.#keep);
    for (const file of doomed) {
      const path = join(this.#dir, file.name);
      if (path === current) continue;
      await unlink(path).catch(() => undefined);
    }
  }

  async #shift(current: string): Promise<void> {
    const last = `${current}.${this.#keep - 1}`;
    await unlink(last).catch(() => undefined);
    for (let index = this.#keep - 2; index >= 1; index -= 1) {
      await rename(`${current}.${index}`, `${current}.${index + 1}`).catch(() => undefined);
    }
    await rename(current, `${current}.1`).catch(() => undefined);
  }

  #dayOf(date: Date): string {
    const iso = date.toISOString();
    return iso.slice(0, 10).replaceAll("-", "");
  }
}
