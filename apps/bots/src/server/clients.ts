// Named CLI credentials (docs/bots/PROTOCOL.md "CLI clients and scopes"). The App's own
// token in `<root>/token` stays the only credential with every right; this file adds a set
// of revocable bearers, each with its own scopes, so a person can hand one to another agent
// and take it away again. Only a salted hash is stored, so a copied file yields no bearer.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLIENT_SCOPES = ["read", "write", "admin"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

/** The secret half of `<id>.<secret>`: 32 random bytes, base64url. */
export const CLIENT_SECRET_BYTES = 32;
/** `lastUsedAt` moves at most this often, so a chatty client does not rewrite the file. */
export const LAST_USED_INTERVAL_MS = 60_000;
export const MAX_CLIENT_NAME_CHARS = 32;
const CLIENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const CLIENT_ID = /^c_[A-Za-z0-9-]+$/;

/** A client as the wire shows it; the salt and the hash never leave the store. */
export type Client = {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly ClientScope[];
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
};

/** One stored record: the wire view plus the secret's hash and its salt. */
export type ClientRecord = Client & { readonly salt: string; readonly hash: string };

export type IssuedClient = { readonly client: Client; readonly token: string };

/** What a presented bearer resolves to; the scope set decides every route. */
export type ClientCredential = {
  readonly client: Client;
  readonly scopes: ReadonlySet<ClientScope>;
};

export type ClientErrorReason =
  | "invalid_name"
  | "invalid_scopes"
  | "duplicate_name"
  | "unknown_client"
  | "client_active";

export class ClientError extends Error {
  readonly reason: ClientErrorReason;

  constructor(reason: ClientErrorReason, message: string) {
    super(message);
    this.name = "ClientError";
    this.reason = reason;
  }
}

const digest = (salt: string, secret: string): string =>
  createHash("sha256").update(salt).update(secret).digest("hex");

/** Constant-time equality over two hex digests. */
const sameDigest = (expected: string, actual: string): boolean => {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** The digest a missing id is compared against, so an unknown id costs what a wrong one does. */
const NO_RECORD_DIGEST = digest("", "");

const publicView = (record: ClientRecord): Client => ({
  id: record.id,
  name: record.name,
  scopes: record.scopes,
  createdAt: record.createdAt,
  ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
  ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
});

/** `{ name, scopes }` per the CLI rules: a name is 1–32 trimmed characters, scopes non-empty. */
const parseCreate = (body: unknown): { readonly name: string; readonly scopes: ClientScope[] } => {
  if (typeof body !== "object" || body === null) {
    throw new ClientError("invalid_name", "a client needs a name and its scopes");
  }
  const raw = body as { readonly name?: unknown; readonly scopes?: unknown };
  if (typeof raw.name !== "string") {
    throw new ClientError("invalid_name", "a client needs a name and its scopes");
  }
  const name = raw.name.trim();
  if (name.length === 0 || name.length > MAX_CLIENT_NAME_CHARS) {
    throw new ClientError(
      "invalid_name",
      `a name is 1-${MAX_CLIENT_NAME_CHARS} characters after trimming`,
    );
  }
  if (!CLIENT_NAME.test(name)) {
    throw new ClientError(
      "invalid_name",
      "a name is lowercase letters, digits, - and _, and starts with a letter or digit",
    );
  }
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
    throw new ClientError("invalid_scopes", "at least one scope is required");
  }
  const scopes: ClientScope[] = [];
  for (const scope of raw.scopes as readonly unknown[]) {
    if (typeof scope !== "string" || !(CLIENT_SCOPES as readonly string[]).includes(scope)) {
      throw new ClientError("invalid_scopes", `a scope is one of ${CLIENT_SCOPES.join(", ")}`);
    }
    if (!scopes.includes(scope as ClientScope)) scopes.push(scope as ClientScope);
  }
  return { name, scopes };
};

const parseRecord = (value: unknown): ClientRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { id, name, scopes, salt, hash, createdAt, lastUsedAt, revokedAt } = raw;
  if (typeof id !== "string" || !CLIENT_ID.test(id)) return undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (!Array.isArray(scopes) || scopes.length === 0) return undefined;
  if (scopes.some((scope) => !(CLIENT_SCOPES as readonly unknown[]).includes(scope))) {
    return undefined;
  }
  if (typeof salt !== "string" || typeof hash !== "string") return undefined;
  if (typeof createdAt !== "string") return undefined;
  if (lastUsedAt !== undefined && typeof lastUsedAt !== "string") return undefined;
  if (revokedAt !== undefined && typeof revokedAt !== "string") return undefined;
  return {
    id,
    name,
    scopes: scopes as ClientScope[],
    salt,
    hash,
    createdAt,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
};

export type ClientStoreOptions = {
  /** Tests inject a clock: `lastUsedAt` is a throttle and must be deterministic. */
  readonly now?: () => Date;
};

/**
 * `<root>/clients.json`, mode 0600, beside the token. Records are held in memory and the
 * file is rewritten whole, so a reader never sees a half-written credential.
 */
export class ClientStore {
  readonly #path: string;
  readonly #now: () => Date;
  #records: readonly ClientRecord[] = [];

  constructor(root: string, options: ClientStoreOptions = {}) {
    this.#path = join(root, "clients.json");
    this.#now = options.now ?? (() => new Date());
  }

  static async open(root: string, options: ClientStoreOptions = {}): Promise<ClientStore> {
    const store = new ClientStore(root, options);
    await store.#load();
    return store;
  }

  list(): readonly Client[] {
    return this.#records.map(publicView);
  }

  async create(body: unknown): Promise<IssuedClient> {
    const input = parseCreate(body);
    if (this.#records.some((record) => record.name === input.name)) {
      throw new ClientError("duplicate_name", `the name ${input.name} is already used`);
    }
    const secret = randomBytes(CLIENT_SECRET_BYTES).toString("base64url");
    const salt = randomBytes(16).toString("base64url");
    const record: ClientRecord = {
      id: `c_${randomUUID()}`,
      name: input.name,
      scopes: input.scopes,
      salt,
      hash: digest(salt, secret),
      createdAt: this.#now().toISOString(),
    };
    await this.#commit([...this.#records, record]);
    return { client: publicView(record), token: `${record.id}.${secret}` };
  }

  /** A new secret for the same client; the previous bearer stops working immediately. */
  async rotate(id: string): Promise<IssuedClient> {
    const current = this.#find(id);
    const secret = randomBytes(CLIENT_SECRET_BYTES).toString("base64url");
    const salt = randomBytes(16).toString("base64url");
    const rotated: ClientRecord = { ...current, salt, hash: digest(salt, secret) };
    await this.#commit(this.#records.map((record) => (record.id === id ? rotated : record)));
    return { client: publicView(rotated), token: `${id}.${secret}` };
  }

  /** Cuts the credential off and keeps the record, so the App can show who was cut off. */
  async revoke(id: string): Promise<Client> {
    const current = this.#find(id);
    if (current.revokedAt !== undefined) return publicView(current);
    const revoked: ClientRecord = { ...current, revokedAt: this.#now().toISOString() };
    await this.#commit(this.#records.map((record) => (record.id === id ? revoked : record)));
    return publicView(revoked);
  }

  /** Revoke first, delete second: a live credential is refused rather than silently cut. */
  async remove(id: string): Promise<void> {
    const current = this.#find(id);
    if (current.revokedAt === undefined) {
      throw new ClientError("client_active", "revoke the client before deleting it");
    }
    await this.#commit(this.#records.filter((record) => record.id !== id));
  }

  /** A presented `<id>.<secret>`, or undefined when it names no live credential. */
  async authenticate(presented: string | undefined): Promise<ClientCredential | undefined> {
    if (presented === undefined) return undefined;
    const dot = presented.indexOf(".");
    if (dot <= 0 || dot === presented.length - 1) return undefined;
    const id = presented.slice(0, dot);
    const secret = presented.slice(dot + 1);
    const record = this.#records.find((candidate) => candidate.id === id);
    // An unknown id is compared too, so a guess costs the same whether or not it exists.
    const matches = sameDigest(
      record?.hash ?? NO_RECORD_DIGEST,
      digest(record?.salt ?? "", secret),
    );
    if (record === undefined || !matches || record.revokedAt !== undefined) return undefined;
    await this.#touch(record);
    return { client: publicView(record), scopes: new Set(record.scopes) };
  }

  #find(id: string): ClientRecord {
    const record = this.#records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new ClientError("unknown_client", "no such client");
    return record;
  }

  /** At most once per minute: a chatty client must not rewrite the file per request. */
  async #touch(record: ClientRecord): Promise<void> {
    const now = this.#now().getTime();
    const last = record.lastUsedAt === undefined ? 0 : Date.parse(record.lastUsedAt);
    if (now - last < LAST_USED_INTERVAL_MS) return;
    const touched: ClientRecord = { ...record, lastUsedAt: new Date(now).toISOString() };
    await this.#commit(
      this.#records.map((candidate) => (candidate.id === record.id ? touched : candidate)),
    );
  }

  async #commit(records: readonly ClientRecord[]): Promise<void> {
    await this.#write(records);
    this.#records = records;
  }

  /** A temporary sibling published whole: `link` for a first write, `rename` to replace. */
  async #write(records: readonly ClientRecord[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: 1, clients: records }, null, 2)}\n`;
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    try {
      await link(temporary, this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A replace cannot be a link, so the swap is a rename: the old file stays readable
      // until the new one is whole.
      await rename(temporary, this.#path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    // 0600 is the contract, so a file someone loosened is tightened again.
    await chmod(this.#path, 0o600);
  }

  async #load(): Promise<void> {
    let body: string;
    try {
      body = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await chmod(this.#path, 0o600);
    // A file that does not parse is a daemon defect, not a reason to serve a partial
    // credential set: reading it strictly fails closed instead of dropping records.
    const parsed = JSON.parse(body) as { readonly clients?: unknown };
    const records = Array.isArray(parsed.clients) ? parsed.clients : [];
    this.#records = records.map(parseRecord).filter((record) => record !== undefined);
  }
}
