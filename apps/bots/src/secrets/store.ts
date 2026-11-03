// The secrets store (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): one encrypted document, two
// scopes, lazy expiry and a startup sweep. This is the only module that knows the
// container's shape; the tools see a narrow port and the model never holds a value.
import { type FileHandle, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type SecretMeta,
  type SecretSave,
  type SecretScope,
  SecretsStorageError,
} from "../core/domain.ts";
import { newFailure } from "../core/failures.ts";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import {
  MAX_SECRET_PURPOSE_CHARS,
  MAX_SECRET_TTL_MINUTES,
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_TTL_MINUTES,
  MIN_SECRET_VALUE_CHARS,
  SECRET_KEY_PATTERN,
  type SecretsToolHost,
} from "../tools/types.ts";
import { SecretAudit, type SecretAuditBy } from "./audit.ts";
import { open as openContainer, seal } from "./container.ts";
import { loadOrCreateSecretKey, readSecretKey } from "./keyfile.ts";

const Events = {
  writeOk: declareEvent("core.secret.write.ok"),
  readOk: declareEvent("core.secret.read.ok"),
  deleteOk: declareEvent("core.secret.delete.ok"),
  revealOk: declareEvent("core.secret.reveal.ok"),
  expireOk: declareEvent("core.secret.expire.ok"),
  fail: declareEvent("core.secret.fail"),
} as const;

/** One stored record. The value is here and nowhere else the model can reach. */
type SecretRecord = {
  readonly key: string;
  readonly scope: SecretScope;
  readonly botId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly purpose?: string;
  readonly expiresAt?: string;
  readonly value: string;
};

/**
 * One record's identity: a shared record is one per key, a bot's own record is one per key
 * per bot. Nothing else may be used to find, reveal or delete a record, in the store or over
 * the wire.
 */
export type SecretIdentity = {
  readonly key: string;
  readonly scope: SecretScope;
  /** Required for `bot` scope; the person's page names it, and it is never taken from a model. */
  readonly botId?: string;
  /** The caller's own trace, so the ledger and the log name one command. */
  readonly trace?: string;
};

export type SecretsStoreOptions = {
  /** The directory the ciphertext and the ledger live in. */
  readonly dir: string;
  /** The key file; a missing key beside an existing ciphertext is a refusal. */
  readonly keyPath: string;
  readonly now?: () => Date;
  readonly log?: Log;
  readonly trace?: string;
  /** Called with every stored value after a change, so the log can redact them. */
  readonly onValues?: (values: readonly string[]) => void;
};

const CONTAINER_FILE = "secrets.v1.enc";
const AUDIT_FILE = "secrets.audit.jsonl";
const LOCK_FILE = "secrets.lock";
/** Two daemons on different roots share one config directory; this guards the document. */
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const isString = (value: unknown): value is string => typeof value === "string";

/** A timestamp the container must hold: anything unparsable is a refusal, never "no expiry". */
const isTimestamp = (value: unknown): value is string =>
  isString(value) && Number.isFinite(Date.parse(value));

/** The document the container holds; anything else is a refusal, never a rewrite. */
const parseDocument = (text: string): SecretRecord[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SecretsStorageError("the secrets document is not JSON", { cause: error });
  }
  if (typeof raw !== "object" || raw === null) {
    throw new SecretsStorageError("the secrets document is not an object");
  }
  const document = raw as { version?: unknown; records?: unknown };
  if (document.version !== 1) {
    throw new SecretsStorageError("the secrets document has an unknown version");
  }
  if (!Array.isArray(document.records)) {
    throw new SecretsStorageError("the secrets document holds no records");
  }
  return document.records.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new SecretsStorageError("a secrets record is not an object");
    }
    const record = entry as Record<string, unknown>;
    if (!isString(record.key) || !SECRET_KEY_PATTERN.test(record.key)) {
      throw new SecretsStorageError("a secrets record has no usable key");
    }
    if (record.scope !== "bot" && record.scope !== "shared") {
      throw new SecretsStorageError("a secrets record has an unknown scope");
    }
    if (!isString(record.botId) || record.botId.length === 0) {
      throw new SecretsStorageError("a secrets record has no owner");
    }
    if (!isString(record.value) || record.value.length === 0) {
      throw new SecretsStorageError("a secrets record holds no value");
    }
    if (!isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
      throw new SecretsStorageError("a secrets record has unusable timestamps");
    }
    if (record.purpose !== undefined && !isString(record.purpose)) {
      throw new SecretsStorageError("a secrets record has an unusable purpose");
    }
    if (record.expiresAt !== undefined && !isTimestamp(record.expiresAt)) {
      throw new SecretsStorageError("a secrets record has an unusable expiry");
    }
    return {
      key: record.key,
      scope: record.scope,
      botId: record.botId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      value: record.value,
    };
  });
};

/** The name a value reaches a command by, in the environment the Bash tool builds. */
export const secretEnvName = (key: string): string =>
  `EAGLE_SECRET_${key.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}`;

let scratches = 0;

export class SecretsStore {
  readonly #dir: string;
  readonly #file: string;
  readonly #keyPath: string;
  readonly #audit: SecretAudit;
  readonly #log: Log | undefined;
  readonly #trace: string;
  readonly #now: () => Date;
  readonly #onValues: ((values: readonly string[]) => void) | undefined;
  #records: SecretRecord[] = [];
  /** One mutation at a time inside this process. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SecretsStoreOptions) {
    this.#dir = options.dir;
    this.#file = join(options.dir, CONTAINER_FILE);
    this.#keyPath = options.keyPath;
    this.#audit = new SecretAudit({ path: join(options.dir, AUDIT_FILE) });
    this.#log = options.log;
    this.#trace = options.trace ?? "tr_secret_0001";
    this.#now = options.now ?? (() => new Date());
    this.#onValues = options.onValues;
  }

  /** Opens the store. A container that cannot be read is a refusal, not a reset. */
  static async open(options: SecretsStoreOptions): Promise<SecretsStore> {
    const store = new SecretsStore(options);
    await store.reload();
    return store;
  }

  /** Every stored value: the log redacts exactly these. */
  values(): readonly string[] {
    return this.#records.map((record) => record.value);
  }

  /**
   * The values this Bot may hand to a command, as environment variables. It reads the last
   * loaded document, so the Bash tool's synchronous prepare can answer; a name collision
   * after normalisation is dropped rather than guessed.
   */
  environment(botId: string): Record<string, string> {
    const counts = new Map<string, number>();
    for (const record of this.#records) {
      if (record.scope === "bot" && record.botId !== botId) continue;
      if (this.#expired(record)) continue;
      const name = secretEnvName(record.key);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const env: Record<string, string> = {};
    for (const record of this.#records) {
      if (record.scope === "bot" && record.botId !== botId) continue;
      if (this.#expired(record)) continue;
      const name = secretEnvName(record.key);
      if (counts.get(name) !== 1) continue;
      env[name] = record.value;
    }
    return env;
  }

  /** The environment name a record reaches a command by, or undefined when it collides. */
  envNameFor(key: string): string | undefined {
    const name = secretEnvName(key);
    const clashing = this.#records.filter(
      (record) => !this.#expired(record) && secretEnvName(record.key) === name,
    );
    return clashing.length > 1 ? undefined : name;
  }

  /** The records this Bot may see: its own first, then the shared ones. */
  async list(input: {
    readonly botId: string;
    readonly scope?: SecretScope;
    readonly limit: number;
    readonly trace?: string;
  }): Promise<{ readonly items: readonly SecretMeta[]; readonly truncated: boolean }> {
    return this.#exclusive(async () => {
      const live = this.#records;
      const uses = await this.#uses();
      const visible = this.#visible(live, input.botId, input.scope ?? undefined);
      const kept = visible.slice(0, input.limit);
      return {
        items: kept.map((record) => this.#meta(record, uses)),
        truncated: visible.length > kept.length,
      };
    }, input.trace);
  }

  /** Every record on this machine, as the settings page reads it. */
  async listAll(input: { readonly trace?: string } = {}): Promise<readonly SecretMeta[]> {
    return this.#exclusive(async () => {
      const uses = await this.#uses();
      return this.#records.map((record) => this.#meta(record, uses));
    }, input.trace);
  }

  /** The value of one record; a missing or expired record answers nothing. */
  async read(input: {
    readonly botId: string;
    readonly key: string;
    readonly scope?: SecretScope;
    readonly trace?: string;
  }): Promise<
    { readonly key: string; readonly scope: SecretScope; readonly value: string } | undefined
  > {
    return this.#exclusive(async (trace) => {
      const key = input.key.trim();
      const found = this.#resolve(key, input.scope, input.botId);
      if (found === undefined) {
        await this.#append({
          ts: this.#now().toISOString(),
          op: "read",
          scope: input.scope ?? "bot",
          key,
          botId: input.botId,
          by: "bot",
          trace,
          ok: false,
        });
        return undefined;
      }
      await this.#append({
        ts: this.#now().toISOString(),
        op: "read",
        scope: found.scope,
        key: found.key,
        botId: input.botId,
        by: "bot",
        trace,
        ok: true,
      });
      this.#emitOk(Events.readOk, found.scope, input.botId, trace);
      return { key: found.key, scope: found.scope, value: found.value };
    }, input.trace);
  }

  /** Stores what a person typed into a card. This is the only way a value arrives. */
  async save(input: SecretSave): Promise<{
    readonly scope: SecretScope;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly expiresAt?: string;
  }> {
    const key = this.#checkKey(input.key);
    const value = this.#checkValue(input.value);
    const ttl = input.ttlMinutes === undefined ? undefined : this.#checkTtl(input.ttlMinutes);
    const purpose = input.purpose === undefined ? undefined : this.#checkPurpose(input.purpose);
    return this.#exclusive(async (trace) => {
      const now = this.#now();
      const at = now.toISOString();
      const existing = this.#find(key, input.scope, input.botId);
      const record: SecretRecord = {
        key,
        scope: input.scope,
        botId: input.botId,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        ...(purpose === undefined ? {} : { purpose }),
        ...(ttl === undefined
          ? {}
          : { expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString() }),
        value,
      };
      await this.#write(this.#replace(record));
      await this.#append({
        ts: at,
        op: "write",
        scope: input.scope,
        key,
        botId: input.botId,
        by: "person",
        trace,
        ok: true,
      });
      this.#emitOk(Events.writeOk, input.scope, input.botId, trace);
      return {
        scope: input.scope,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      };
    }, input.trace);
  }

  /** Removes one record a Bot owns: its own, or a shared one it created itself. */
  async remove(input: {
    readonly botId: string;
    readonly key: string;
    readonly scope: SecretScope;
    readonly trace?: string;
  }): Promise<{ readonly key: string; readonly scope: SecretScope; readonly deleted: boolean }> {
    return this.#exclusive(async (trace) => {
      const key = input.key.trim();
      const found = this.#find(key, input.scope, input.botId);
      if (found === undefined) return { key, scope: input.scope, deleted: false };
      if (found.botId !== input.botId) {
        throw new SecretsStorageError("another bot created this shared record");
      }
      await this.#write(this.#without(found));
      await this.#append({
        ts: this.#now().toISOString(),
        op: "delete",
        scope: found.scope,
        key: found.key,
        botId: input.botId,
        by: "bot",
        trace,
        ok: true,
      });
      this.#emitOk(Events.deleteOk, found.scope, input.botId, trace);
      return { key: found.key, scope: found.scope, deleted: true };
    }, input.trace);
  }

  /** The person reads a value from the settings page; it is recorded like any read. */
  async reveal(identity: SecretIdentity): Promise<
    | {
        readonly key: string;
        readonly scope: SecretScope;
        readonly botId: string;
        readonly value: string;
      }
    | undefined
  > {
    return this.#exclusive(async (trace) => {
      const found = this.#findOwned(identity);
      if (found === undefined) {
        await this.#append({
          ts: this.#now().toISOString(),
          op: "reveal",
          scope: identity.scope,
          key: identity.key.trim(),
          botId: identity.botId ?? "",
          by: "person",
          trace,
          ok: false,
        });
        return undefined;
      }
      await this.#append({
        ts: this.#now().toISOString(),
        op: "reveal",
        scope: found.scope,
        key: found.key,
        botId: found.botId,
        by: "person",
        trace,
        ok: true,
      });
      this.#emitOk(Events.revealOk, found.scope, found.botId, trace);
      return { key: found.key, scope: found.scope, botId: found.botId, value: found.value };
    }, identity.trace);
  }

  /** The person deletes a record; only they may delete another Bot's shared record. */
  async removeAsPerson(identity: SecretIdentity): Promise<boolean> {
    return this.#exclusive(async (trace) => {
      const found = this.#findOwned(identity);
      if (found === undefined) return false;
      await this.#write(this.#without(found));
      await this.#append({
        ts: this.#now().toISOString(),
        op: "delete",
        scope: found.scope,
        key: found.key,
        botId: found.botId,
        by: "person",
        trace,
        ok: true,
      });
      this.#emitOk(Events.deleteOk, found.scope, found.botId, trace);
      return true;
    }, identity.trace);
  }

  /** The startup sweep: a record that expired while the daemon was off is gone. */
  async sweep(input: { readonly trace?: string } = {}): Promise<number> {
    return this.#exclusive(
      async (trace) => {
        const expired = this.#records.filter((record) => this.#expired(record));
        if (expired.length === 0) return 0;
        await this.#write(this.#records.filter((record) => !this.#expired(record)));
        for (const record of expired) {
          await this.#append({
            ts: this.#now().toISOString(),
            op: "expire",
            scope: record.scope,
            key: record.key,
            botId: record.botId,
            by: "bot",
            trace,
            ok: true,
          });
          this.#emitOk(Events.expireOk, record.scope, record.botId, trace);
        }
        return expired.length;
      },
      input.trace,
      false,
    );
  }

  /** The tools' host for one Bot: the model never names a bot id. */
  hostFor(botId: string): SecretsToolHost {
    return {
      botId,
      list: (input) => this.list({ botId, ...input }),
      read: (input) => this.read({ botId, ...input }),
      remove: (input) => this.remove({ botId, ...input }),
      environment: () => this.environment(botId),
      envNameFor: (key) => this.envNameFor(key),
    };
  }

  /** Reads the container. A missing file is an empty store; anything else is a refusal. */
  async load(): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readFile(this.#file);
    } catch (error) {
      if (missing(error)) {
        this.#records = [];
        return;
      }
      this.#emitFail(undefined, this.#trace);
      throw new SecretsStorageError("the secrets container could not be read", { cause: error });
    }
    let key: Uint8Array;
    try {
      key = await readSecretKey(this.#keyPath);
    } catch (error) {
      this.#emitFail(undefined, this.#trace);
      throw new SecretsStorageError(
        "the secrets key file is missing or unreadable, so the stored values cannot be read",
        { cause: error },
      );
    }
    let text: string;
    try {
      text = openContainer(key, raw);
    } catch (error) {
      this.#emitFail(undefined, this.#trace);
      throw new SecretsStorageError("the secrets container could not be decrypted", {
        cause: error,
      });
    }
    try {
      this.#records = parseDocument(text);
    } catch (error) {
      this.#emitFail(undefined, this.#trace);
      throw error;
    }
    this.#onValues?.(this.values());
  }

  /** The same read, keeping the loaded document when it fails: a refusal changes nothing. */
  async reload(): Promise<void> {
    await this.load();
  }

  /**
   * One operation at a time: this process's queue, then the file lock two daemons sharing a
   * config directory need, a fresh read, and the caller's work.
   */
  async #exclusive<T>(
    run: (trace: string) => Promise<T>,
    trace?: string,
    dropExpired = true,
  ): Promise<T> {
    const own = trace ?? this.#trace;
    const next = this.#queue.then(async () => {
      const release = await this.#lock();
      try {
        await this.load();
        if (dropExpired) await this.#dropExpired(own);
        return await run(own);
      } finally {
        await release();
      }
    });
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** An exclusive lock file; a stale one from a daemon that died is cleared, not waited on. */
  async #lock(): Promise<() => Promise<void>> {
    const path = join(this.#dir, LOCK_FILE);
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode is a request, not a proof: a directory another account can write is a
    // directory that account can swap the ciphertext in.
    const directory = await stat(this.#dir).catch(() => undefined);
    if (directory !== undefined && (directory.mode & 0o022) !== 0) {
      this.#emitFail(undefined, this.#trace);
      throw new SecretsStorageError(
        "the secrets directory is writable by another account; chmod 700 it",
      );
    }
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        return async () => {
          await rm(path, { force: true }).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          this.#emitFail(undefined, this.#trace);
          throw new SecretsStorageError("the secrets store could not be locked", { cause: error });
        }
      }
      const age = await stat(path).then(
        (stats) => Date.now() - stats.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new SecretsStorageError("another daemon is writing the secrets store");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Rewrites the whole document: a private scratch file, then a rename over the target. */
  async #write(records: readonly SecretRecord[]): Promise<void> {
    const key = await loadOrCreateSecretKey(this.#keyPath);
    const container = seal(key, JSON.stringify({ version: 1, records }));
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    scratches += 1;
    const scratch = `${this.#file}.tmp-${process.pid}-${scratches}`;
    let handle: FileHandle;
    try {
      handle = await open(scratch, "wx", 0o600);
    } catch (error) {
      this.#emitFail(undefined, this.#trace);
      throw new SecretsStorageError("the secrets container could not be written", { cause: error });
    }
    try {
      await handle.writeFile(container);
      await handle.close();
      await rename(scratch, this.#file);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(scratch, { force: true }).catch(() => undefined);
      this.#emitFail(undefined, this.#trace);
      throw new SecretsStorageError("the secrets container could not be written", { cause: error });
    }
    this.#records = [...records];
    this.#onValues?.(this.values());
  }

  /**
   * The ledger is written after the document, so a failed append cannot undo a save: it is
   * reported as a failure of the ledger, never as a failure of the password.
   */
  async #append(entry: Parameters<SecretAudit["append"]>[0]): Promise<void> {
    try {
      await this.#audit.append(entry);
    } catch {
      this.#emitFail(entry.scope, entry.trace ?? this.#trace);
    }
  }

  async #uses(): Promise<ReadonlyMap<string, { at: string; by: SecretAuditBy }>> {
    try {
      return await this.#audit.uses();
    } catch {
      return new Map();
    }
  }

  /** The record a call resolves: this Bot's own first, then the shared one; never expired. */
  #resolve(key: string, scope: SecretScope | undefined, botId: string): SecretRecord | undefined {
    if (scope !== undefined) return this.#find(key, scope, botId);
    const own = this.#find(key, "bot", botId);
    if (own !== undefined) return own;
    return this.#find(key, "shared", botId);
  }

  /** One record by its full identity; a shared lookup ignores the bot that asked. */
  #find(key: string, scope: SecretScope, botId?: string): SecretRecord | undefined {
    return this.#records.find((record) => {
      if (record.key !== key || record.scope !== scope) return false;
      if (this.#expired(record)) return false;
      if (scope === "shared") return true;
      return botId === undefined || record.botId === botId;
    });
  }

  /** One record by the identity a person's page names: a bot record needs its bot. */
  #findOwned(identity: SecretIdentity): SecretRecord | undefined {
    const key = identity.key.trim();
    if (key.length === 0) return undefined;
    if (identity.scope === "bot") {
      const botId = identity.botId;
      if (botId === undefined || botId.length === 0) return undefined;
      return this.#find(key, "bot", botId);
    }
    return this.#find(key, "shared");
  }

  /** The records a Bot may see, its own first; a shared key it shadows appears once. */
  #visible(
    records: readonly SecretRecord[],
    botId: string,
    scope: SecretScope | undefined,
  ): SecretRecord[] {
    const own = records
      .filter((record) => record.scope === "bot" && record.botId === botId)
      .sort((left, right) => (left.key < right.key ? -1 : 1));
    if (scope === "bot") return own;
    const shared = records
      .filter((record) => record.scope === "shared")
      .sort((left, right) => (left.key < right.key ? -1 : 1));
    if (scope === "shared") return shared;
    // Without a scope the bot's own record shadows a shared one with the same name.
    return [...own, ...shared.filter((record) => !own.some((entry) => entry.key === record.key))];
  }

  /** One record's metadata; the value is never part of it. */
  #meta(
    record: SecretRecord,
    uses: ReadonlyMap<string, { at: string; by: SecretAuditBy }>,
  ): SecretMeta {
    const use = uses.get(this.#identityOf(record));
    return {
      key: record.key,
      scope: record.scope,
      botId: record.botId,
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      ...(use === undefined ? {} : { lastUsedAt: use.at, lastUsedBy: use.by }),
    };
  }

  /** A record's ledger identity, matching `SecretAudit.uses` exactly. */
  #identityOf(record: SecretRecord): string {
    return `${record.scope}:${record.scope === "bot" ? record.botId : ""}:${record.key}`;
  }

  /** Removes every expired record in one write, so a read cannot expire one at a time. */
  async #dropExpired(trace: string): Promise<void> {
    const expired = this.#records.filter((record) => this.#expired(record));
    if (expired.length === 0) return;
    await this.#write(this.#records.filter((record) => !this.#expired(record)));
    for (const record of expired) {
      await this.#append({
        ts: this.#now().toISOString(),
        op: "expire",
        scope: record.scope,
        key: record.key,
        botId: record.botId,
        by: "bot",
        trace,
        ok: true,
      });
      this.#emitOk(Events.expireOk, record.scope, record.botId, trace);
    }
  }

  /** The records without one; the replacement keeps the order of the rest. */
  #without(record: SecretRecord): readonly SecretRecord[] {
    return this.#records.filter((entry) => entry !== record);
  }

  /** One record replaced by a new one; a shared key and a Bot's own key are one record. */
  #replace(record: SecretRecord): readonly SecretRecord[] {
    return [
      ...this.#records.filter(
        (entry) =>
          !(
            entry.key === record.key &&
            entry.scope === record.scope &&
            (record.scope === "shared" || entry.botId === record.botId)
          ),
      ),
      record,
    ];
  }

  #expired(record: SecretRecord): boolean {
    if (record.expiresAt === undefined) return false;
    const at = Date.parse(record.expiresAt);
    return !Number.isFinite(at) || at <= this.#now().getTime();
  }

  #checkKey(raw: string): string {
    const key = raw.trim();
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new SecretsStorageError(
        "a secret key starts with a lowercase letter or digit and holds lowercase letters, digits, dot, dash or underscore, at most 64 characters",
      );
    }
    return key;
  }

  #checkValue(raw: string): string {
    if (raw.length < MIN_SECRET_VALUE_CHARS) {
      throw new SecretsStorageError(
        `a secret value is at least ${MIN_SECRET_VALUE_CHARS} characters, so the log can scrub it`,
      );
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new SecretsStorageError(`a secret value is at most ${MAX_SECRET_VALUE_BYTES} bytes`);
    }
    return raw;
  }

  #checkPurpose(raw: string): string {
    const purpose = raw.trim();
    if (purpose.length > MAX_SECRET_PURPOSE_CHARS) {
      throw new SecretsStorageError(
        `a secret purpose is at most ${MAX_SECRET_PURPOSE_CHARS} characters`,
      );
    }
    return purpose;
  }

  #checkTtl(minutes: number): number {
    if (
      !Number.isInteger(minutes) ||
      minutes < MIN_SECRET_TTL_MINUTES ||
      minutes > MAX_SECRET_TTL_MINUTES
    ) {
      throw new SecretsStorageError(
        `a secret lifetime is ${MIN_SECRET_TTL_MINUTES}-${MAX_SECRET_TTL_MINUTES} minutes`,
      );
    }
    return minutes;
  }

  #emitOk(
    evt:
      | typeof Events.writeOk
      | typeof Events.readOk
      | typeof Events.deleteOk
      | typeof Events.revealOk
      | typeof Events.expireOk,
    scope: SecretScope,
    botId: string | undefined,
    trace: string,
  ): void {
    this.#log?.emit("info", "core", evt, {
      trace,
      ...(botId === undefined || botId.length === 0 ? {} : { botId }),
      detail: { scope },
    });
  }

  /** A storage failure: the record carries the scope and nothing else. */
  #emitFail(scope: SecretScope | undefined, trace: string): void {
    this.#log?.emit("error", "core", Events.fail, {
      trace,
      failure: newFailure("storage_failed", "core"),
      origin: true,
      ...(scope === undefined ? {} : { detail: { scope } }),
    });
  }
}
