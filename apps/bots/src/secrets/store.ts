// The secrets store (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): one encrypted document, two
// scopes, lazy expiry and a startup sweep. This is the only module that knows the
// container's shape; the tools see a narrow port and the model never holds a value.
import { type FileHandle, mkdir, open, readFile, rename, rm } from "node:fs/promises";
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

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const isString = (value: unknown): value is string => typeof value === "string";

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
    if (!isString(record.key) || record.key.length === 0 || record.key.length > 64) {
      throw new SecretsStorageError("a secrets record has no usable key");
    }
    if (record.scope !== "bot" && record.scope !== "shared") {
      throw new SecretsStorageError("a secrets record has an unknown scope");
    }
    if (!isString(record.botId) || !isString(record.value)) {
      throw new SecretsStorageError("a secrets record is missing its owner or its value");
    }
    if (!isString(record.createdAt) || !isString(record.updatedAt)) {
      throw new SecretsStorageError("a secrets record has no timestamps");
    }
    if (record.purpose !== undefined && !isString(record.purpose)) {
      throw new SecretsStorageError("a secrets record has an unusable purpose");
    }
    if (record.expiresAt !== undefined && !isString(record.expiresAt)) {
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
  /** One mutation at a time, so two calls cannot lose each other's records. */
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
    await store.load();
    return store;
  }

  /** Every stored value: the log redacts exactly these. */
  values(): readonly string[] {
    return this.#records.map((record) => record.value);
  }

  /** The records this Bot may see: its own first, then the shared ones. */
  async list(input: {
    readonly botId: string;
    readonly scope?: SecretScope;
    readonly limit: number;
  }): Promise<{ readonly items: readonly SecretMeta[]; readonly truncated: boolean }> {
    return this.#serial(async () => {
      await this.load();
      const live = await this.#dropExpired(input.scope);
      const uses = await this.#audit.uses();
      const visible = this.#visible(live, input.botId, input.scope);
      const kept = visible.slice(0, input.limit);
      return {
        items: kept.map((record) => this.#meta(record, uses)),
        truncated: visible.length > kept.length,
      };
    });
  }

  /** Every record on this machine, as the settings page reads it. */
  async listAll(): Promise<readonly SecretMeta[]> {
    return this.#serial(async () => {
      await this.load();
      const live = await this.#dropExpired(undefined);
      const uses = await this.#audit.uses();
      return live.map((record) => this.#meta(record, uses));
    });
  }

  /** The value of one record; a missing or expired record answers nothing. */
  async read(input: {
    readonly botId: string;
    readonly key: string;
    readonly scope?: SecretScope;
  }): Promise<
    { readonly key: string; readonly scope: SecretScope; readonly value: string } | undefined
  > {
    return this.#serial(async () => {
      await this.load();
      const key = input.key.trim();
      const found = this.#resolve(this.#records, key, input.scope, input.botId);
      if (found === undefined) {
        await this.#audit.append({
          ts: this.#now().toISOString(),
          op: "read",
          scope: input.scope ?? "bot",
          key,
          botId: input.botId,
          by: "bot",
          trace: this.#trace,
          ok: false,
        });
        return undefined;
      }
      if (this.#expired(found)) {
        await this.#expire(found);
        return undefined;
      }
      await this.#audit.append({
        ts: this.#now().toISOString(),
        op: "read",
        scope: found.scope,
        key: found.key,
        botId: input.botId,
        by: "bot",
        trace: this.#trace,
        ok: true,
      });
      this.#emitOk(Events.readOk, found.scope, input.botId);
      return { key: found.key, scope: found.scope, value: found.value };
    });
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
    return this.#serial(async () => {
      await this.load();
      const now = this.#now();
      const at = now.toISOString();
      const existing = this.#find(this.#records, key, input.scope, input.botId);
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
      await this.#write(this.#replace(this.#records, record));
      await this.#audit.append({
        ts: at,
        op: "write",
        scope: input.scope,
        key,
        botId: input.botId,
        by: "person",
        ...(input.trace === undefined ? {} : { trace: input.trace }),
        ok: true,
      });
      this.#emitOk(Events.writeOk, input.scope, input.botId);
      return {
        scope: input.scope,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      };
    });
  }

  /** Removes one record for a Bot: its own, or a shared record it created. */
  async remove(input: {
    readonly botId: string;
    readonly key: string;
    readonly scope?: SecretScope;
  }): Promise<{ readonly key: string; readonly scope: SecretScope; readonly deleted: boolean }> {
    return this.#serial(async () => {
      await this.load();
      const key = input.key.trim();
      const found = this.#resolve(this.#records, key, input.scope, input.botId);
      if (found === undefined) {
        return { key, scope: input.scope ?? "bot", deleted: false };
      }
      if (found.botId !== input.botId) {
        throw new SecretsStorageError("another bot created this shared record");
      }
      await this.#write(this.#without(this.#records, found));
      await this.#audit.append({
        ts: this.#now().toISOString(),
        op: "delete",
        scope: found.scope,
        key: found.key,
        botId: input.botId,
        by: "bot",
        trace: this.#trace,
        ok: true,
      });
      this.#emitOk(Events.deleteOk, found.scope, input.botId);
      return { key: found.key, scope: found.scope, deleted: true };
    });
  }

  /** The person reads a value from the settings page; it is recorded like any read. */
  async reveal(input: {
    readonly key: string;
    readonly scope: SecretScope;
  }): Promise<
    { readonly key: string; readonly scope: SecretScope; readonly value: string } | undefined
  > {
    return this.#serial(async () => {
      await this.load();
      const key = input.key.trim();
      const found = this.#find(this.#records, key, input.scope);
      if (found === undefined) {
        await this.#audit.append({
          ts: this.#now().toISOString(),
          op: "reveal",
          scope: input.scope,
          key,
          botId: "",
          by: "person",
          trace: this.#trace,
          ok: false,
        });
        return undefined;
      }
      if (this.#expired(found)) {
        await this.#expire(found);
        return undefined;
      }
      await this.#audit.append({
        ts: this.#now().toISOString(),
        op: "reveal",
        scope: found.scope,
        key: found.key,
        botId: found.botId,
        by: "person",
        trace: this.#trace,
        ok: true,
      });
      this.#emitOk(Events.revealOk, found.scope, found.botId);
      return { key: found.key, scope: found.scope, value: found.value };
    });
  }

  /** The person deletes a record; only they may delete another Bot's shared record. */
  async removeAsPerson(input: {
    readonly key: string;
    readonly scope: SecretScope;
  }): Promise<boolean> {
    return this.#serial(async () => {
      await this.load();
      const key = input.key.trim();
      const found = this.#find(this.#records, key, input.scope);
      if (found === undefined) return false;
      await this.#write(this.#without(this.#records, found));
      await this.#audit.append({
        ts: this.#now().toISOString(),
        op: "delete",
        scope: found.scope,
        key: found.key,
        botId: found.botId,
        by: "person",
        trace: this.#trace,
        ok: true,
      });
      this.#emitOk(Events.deleteOk, found.scope, found.botId);
      return true;
    });
  }

  /** The startup sweep: a record that expired while the daemon was off is gone. */
  async sweep(): Promise<number> {
    return this.#serial(async () => {
      await this.load();
      const expired = this.#records.filter((record) => this.#expired(record));
      if (expired.length === 0) return 0;
      const kept = this.#records.filter((record) => !this.#expired(record));
      await this.#write(kept);
      for (const record of expired) {
        await this.#audit.append({
          ts: this.#now().toISOString(),
          op: "expire",
          scope: record.scope,
          key: record.key,
          botId: record.botId,
          by: "bot",
          trace: this.#trace,
          ok: true,
        });
        this.#emitOk(Events.expireOk, record.scope, record.botId);
      }
      return expired.length;
    });
  }

  /** The tools' host for one Bot: the model never names a bot id. */
  hostFor(botId: string): SecretsToolHost {
    return {
      botId,
      list: (input) => this.list({ botId, ...input }),
      read: (input) => this.read({ botId, ...input }),
      remove: (input) => this.remove({ botId, ...input }),
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
      this.#emitFail(undefined);
      throw new SecretsStorageError("the secrets container could not be read", { cause: error });
    }
    let key: Uint8Array;
    try {
      key = await readSecretKey(this.#keyPath);
    } catch (error) {
      this.#emitFail(undefined);
      throw new SecretsStorageError(
        "the secrets key file is missing or unreadable, so the stored values cannot be read",
        { cause: error },
      );
    }
    let text: string;
    try {
      text = openContainer(key, raw);
    } catch (error) {
      this.#emitFail(undefined);
      throw new SecretsStorageError("the secrets container could not be decrypted", {
        cause: error,
      });
    }
    this.#records = parseDocument(text);
  }

  /** One mutation at a time: a read-modify-write under a queue, then an atomic replace. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
      this.#emitFail(undefined);
      throw new SecretsStorageError("the secrets container could not be written", { cause: error });
    }
    try {
      await handle.writeFile(container);
      await handle.close();
      await rename(scratch, this.#file);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(scratch, { force: true }).catch(() => undefined);
      this.#emitFail(undefined);
      throw new SecretsStorageError("the secrets container could not be written", { cause: error });
    }
    this.#records = [...records];
    this.#onValues?.(this.values());
  }

  /** The record a call resolves: this Bot's own first, then the shared one. */
  #resolve(
    records: readonly SecretRecord[],
    key: string,
    scope: SecretScope | undefined,
    botId: string,
  ): SecretRecord | undefined {
    if (scope !== undefined) return this.#find(records, key, scope, botId);
    const own = this.#find(records, key, "bot", botId);
    if (own !== undefined) return own;
    return this.#find(records, key, "shared");
  }

  /** One record by its identity: a shared key, or a Bot's own key. */
  #find(
    records: readonly SecretRecord[],
    key: string,
    scope: SecretScope,
    botId?: string,
  ): SecretRecord | undefined {
    return records.find((record) => {
      if (record.key !== key || record.scope !== scope) return false;
      if (scope === "shared") return true;
      return botId === undefined || record.botId === botId;
    });
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
    const use = uses.get(`${record.scope}:${record.key}`);
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

  /** Removes the expired records and says how many went. */
  async #dropExpired(scope: SecretScope | undefined): Promise<readonly SecretRecord[]> {
    const expired = this.#records.filter(
      (record) => this.#expired(record) && (scope === undefined || record.scope === scope),
    );
    if (expired.length === 0) return this.#records;
    for (const record of expired) await this.#expire(record);
    return this.#records;
  }

  /** Deletes one expired record: the call that would have read it removes it. */
  async #expire(record: SecretRecord): Promise<void> {
    await this.#write(this.#without(this.#records, record));
    await this.#audit.append({
      ts: this.#now().toISOString(),
      op: "expire",
      scope: record.scope,
      key: record.key,
      botId: record.botId,
      by: "bot",
      trace: this.#trace,
      ok: true,
    });
    this.#emitOk(Events.expireOk, record.scope, record.botId);
  }

  /** The records without one; the replacement keeps the order of the rest. */
  #without(records: readonly SecretRecord[], record: SecretRecord): readonly SecretRecord[] {
    return records.filter((entry) => entry !== record);
  }

  /** One record replaced by a new one; a shared key and a Bot's own key are one record. */
  #replace(records: readonly SecretRecord[], record: SecretRecord): readonly SecretRecord[] {
    return [
      ...records.filter(
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
    return Number.isFinite(at) && at <= this.#now().getTime();
  }

  #checkKey(raw: string): string {
    const key = raw.trim();
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new SecretsStorageError(
        "a secret key is lowercase letters, digits, dot, dash or underscore, at most 64 characters",
      );
    }
    return key;
  }

  #checkValue(raw: string): string {
    if (raw.length === 0) throw new SecretsStorageError("a secret value cannot be empty");
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
    botId?: string,
  ): void {
    this.#log?.emit("info", "core", evt, {
      trace: this.#trace,
      ...(botId === undefined || botId.length === 0 ? {} : { botId }),
      detail: { scope },
    });
  }

  /** A storage failure: the record carries the scope and nothing else. */
  #emitFail(scope: SecretScope | undefined): void {
    this.#log?.emit("error", "core", Events.fail, {
      trace: this.#trace,
      failure: newFailure("storage_failed", "core"),
      origin: true,
      ...(scope === undefined ? {} : { detail: { scope } }),
    });
  }
}
