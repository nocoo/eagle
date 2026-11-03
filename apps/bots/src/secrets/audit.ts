// The secrets audit ledger (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5 "Audit"): one JSON
// object per line beside the ciphertext, the newest 2000 kept, and never a value. It is a
// ledger a person can read, not a log record: it names the key, the scope and who used it.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretScope } from "../core/domain.ts";

/** What happened to one record. */
export type SecretAuditOp = "write" | "read" | "delete" | "reveal" | "expire";

/** Who caused it: a bot asked for the value, or a person did. */
export type SecretAuditBy = "bot" | "person";

export type SecretAuditEntry = {
  readonly ts: string;
  readonly op: SecretAuditOp;
  readonly scope: SecretScope;
  readonly key: string;
  readonly botId: string;
  readonly by: SecretAuditBy;
  readonly trace?: string;
  readonly ok: boolean;
};

/** The ledger keeps this many rows; the oldest fall off the end. */
export const SECRET_AUDIT_LIMIT = 2000;

const OPS: readonly SecretAuditOp[] = ["write", "read", "delete", "reveal", "expire"];
const BYS: readonly SecretAuditBy[] = ["bot", "person"];

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const parse = (line: string): SecretAuditEntry | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const op = OPS.find((candidate) => candidate === row.op);
  const by = BYS.find((candidate) => candidate === row.by);
  if (
    op === undefined ||
    by === undefined ||
    typeof row.ts !== "string" ||
    typeof row.key !== "string" ||
    typeof row.botId !== "string" ||
    (row.scope !== "bot" && row.scope !== "shared")
  ) {
    return undefined;
  }
  return {
    ts: row.ts,
    op,
    scope: row.scope,
    key: row.key,
    botId: row.botId,
    by,
    ...(typeof row.trace === "string" ? { trace: row.trace } : {}),
    ok: row.ok === true,
  };
};

let scratches = 0;

export class SecretAudit {
  readonly #path: string;
  readonly #limit: number;
  /** How many rows the file holds; the ledger is trimmed when it passes the limit. */
  #rows = 0;
  #counted = false;

  constructor(options: { readonly path: string; readonly limit?: number }) {
    this.#path = options.path;
    this.#limit = options.limit ?? SECRET_AUDIT_LIMIT;
  }

  /** Appends one row, and trims the ledger when it grows past its limit. */
  async append(entry: SecretAuditEntry): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    if (!this.#counted) {
      this.#rows = (await this.#lines()).length;
      this.#counted = true;
    }
    const handle = await open(this.#path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    this.#rows += 1;
    if (this.#rows > this.#limit) await this.#trim();
  }

  /** The ledger, oldest first; a limit answers only the newest rows. */
  async entries(options: { readonly limit?: number } = {}): Promise<readonly SecretAuditEntry[]> {
    const lines = await this.#lines();
    const kept = options.limit === undefined ? lines : lines.slice(-options.limit);
    const parsed: SecretAuditEntry[] = [];
    for (const line of kept) {
      const row = parse(line);
      if (row !== undefined) parsed.push(row);
    }
    return parsed;
  }

  /** When the record was last used, and by whom: the settings page reads this. */
  async lastUse(
    key: string,
    scope: SecretScope,
  ): Promise<{ readonly at: string; readonly by: SecretAuditBy } | undefined> {
    const rows = await this.entries();
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row === undefined) continue;
      if (row.key !== key || row.scope !== scope) continue;
      if (row.op !== "read" && row.op !== "reveal") continue;
      if (!row.ok) continue;
      return { at: row.ts, by: row.by };
    }
    return undefined;
  }

  /** When every record was last used, and by whom: the settings page reads this. */
  async uses(): Promise<ReadonlyMap<string, { readonly at: string; readonly by: SecretAuditBy }>> {
    const map = new Map<string, { at: string; by: SecretAuditBy }>();
    for (const row of await this.entries()) {
      if (row.op !== "read" && row.op !== "reveal") continue;
      if (!row.ok) continue;
      map.set(`${row.scope}:${row.key}`, { at: row.ts, by: row.by });
    }
    return map;
  }

  async #lines(): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    return text.split("\n").filter((line) => line.trim().length > 0);
  }

  /** Keeps the newest rows and rewrites the ledger through a private scratch file. */
  async #trim(): Promise<void> {
    const lines = await this.#lines();
    const kept = lines.slice(-this.#limit);
    scratches += 1;
    const scratch = `${this.#path}.tmp-${process.pid}-${scratches}`;
    const handle = await open(scratch, "wx", 0o600);
    try {
      await handle.writeFile(kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
      await handle.close();
      await rename(scratch, this.#path);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(scratch, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#rows = kept.length;
  }
}
