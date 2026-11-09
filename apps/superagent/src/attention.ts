// SG-004: what the Superagent noticed about a worker, and the audit of what it did about it.
// Items are values the person can read: a kind, the evidence, a count and when it was seen.
// Nothing here reads a worker directly; the watcher feeds it changes from SG-002.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AttentionKind = "worker_unavailable" | "worker_error" | "worker_stalled";
export type Severity = "high" | "medium";
export type ActionVerb = "report" | "nudge" | "abort";
export type ActionResult = "sent" | "refused" | "failed" | "skipped";

export type AttentionItem = {
  readonly id: string;
  readonly botId: string;
  readonly kind: AttentionKind;
  readonly severity: Severity;
  /** A short machine fact: `store:session_missing`, `answer:error`, `activity:running`. */
  readonly evidence: string;
  count: number;
  readonly firstSeenAt: string;
  lastSeenAt: string;
  closedAt?: string;
  /** When this item was last included in a proactive report. */
  reportedAt?: string;
  /** When this item last drew a management write. */
  actedAt?: string;
};

export type AuditRecord = {
  readonly at: string;
  readonly itemId: string;
  readonly botId: string;
  readonly verb: ActionVerb;
  readonly result: ActionResult;
  /** The template or the report prompt, bounded; never a worker's own text. */
  readonly text?: string;
  readonly detail?: string;
};

/** One bot's activity as the previous tick saw it, so a stall needs no guess. */
export type ActivityMark = { readonly activity: string; readonly since: string };

export type Budgets = {
  /** When the last proactive report was asked of the model. */
  reportedAt?: string;
  /** When each management write happened, oldest first, bounded. */
  actions: string[];
};

export type AttentionState = {
  readonly version: 1;
  items: AttentionItem[];
  audit: AuditRecord[];
  activities: Record<string, ActivityMark>;
  budgets: Budgets;
  lastTickAt?: string;
  lastError?: string;
};

export type Candidate = {
  readonly botId: string;
  readonly kind: AttentionKind;
  readonly severity: Severity;
  readonly evidence: string;
};

export const MAX_ITEMS = 200;
export const MAX_AUDIT = 200;
const STATE_FILE = "attention.json";

const emptyState = (): AttentionState => ({
  version: 1,
  items: [],
  audit: [],
  activities: {},
  budgets: { actions: [] },
});

const severityOf = (kind: AttentionKind): Severity =>
  kind === "worker_unavailable" ? "high" : "medium";

/** A change this tick no longer supports: the bot answered, came back, or stopped running. */
const isHealed = (item: AttentionItem, healed: ReadonlySet<string>): boolean =>
  healed.has(`${item.botId}\u0000${item.kind}`);

export class AttentionStore {
  readonly #path: string;
  #state: AttentionState = emptyState();
  #loaded = false;

  constructor(root: string) {
    this.#path = join(root, STATE_FILE);
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<AttentionState> {
    if (this.#loaded) return this.#state;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<AttentionState>;
      this.#state = {
        version: 1,
        items: Array.isArray(parsed.items) ? (parsed.items as AttentionItem[]) : [],
        audit: Array.isArray(parsed.audit) ? (parsed.audit as AuditRecord[]) : [],
        activities:
          parsed.activities !== null &&
          typeof parsed.activities === "object" &&
          !Array.isArray(parsed.activities)
            ? (parsed.activities as Record<string, ActivityMark>)
            : {},
        budgets: {
          actions: Array.isArray(parsed.budgets?.actions) ? parsed.budgets.actions : [],
          ...(parsed.budgets?.reportedAt === undefined
            ? {}
            : { reportedAt: parsed.budgets.reportedAt }),
        },
        ...(parsed.lastTickAt === undefined ? {} : { lastTickAt: parsed.lastTickAt }),
        ...(parsed.lastError === undefined ? {} : { lastError: parsed.lastError }),
      };
    } catch {
      this.#state = emptyState();
    }
    return this.#state;
  }

  async save(): Promise<boolean> {
    // Closed items are kept until the cap, newest last, so a person can still read what was
    // noticed today; the audit keeps the actions that mattered.
    const items = [...this.#state.items]
      .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
      .slice(-MAX_ITEMS);
    const audit = this.#state.audit.slice(-MAX_AUDIT);
    const next: AttentionState = { ...this.#state, items, audit };
    const temporary = `${this.#path}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
    this.#state = next;
    return true;
  }

  /** Newest first, closed items only when asked for. */
  async list(options: { readonly limit?: number; readonly includeClosed?: boolean } = {}) {
    const state = await this.load();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_ITEMS);
    return state.items
      .filter((item) => options.includeClosed === true || item.closedAt === undefined)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit)
      .map((item) => ({ ...item }));
  }

  /**
   * Records what this tick found: one item per (bot, kind), raised in place rather than
   * duplicated, and heals the items the evidence no longer supports.
   */
  async observe(input: {
    readonly candidates: readonly Candidate[];
    readonly healed: ReadonlySet<string>;
    readonly at: string;
    readonly reopenAfterMs: number;
  }): Promise<AttentionItem[]> {
    const state = await this.load();
    const touched: AttentionItem[] = [];
    for (const candidate of input.candidates) {
      const open = state.items.find(
        (item) =>
          item.botId === candidate.botId &&
          item.kind === candidate.kind &&
          item.closedAt === undefined,
      );
      if (open !== undefined) {
        open.count += 1;
        open.lastSeenAt = input.at;
        touched.push(open);
        continue;
      }
      const previous = state.items
        .filter((item) => item.botId === candidate.botId && item.kind === candidate.kind)
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
      if (
        previous !== undefined &&
        Date.parse(input.at) - Date.parse(previous.lastSeenAt) < input.reopenAfterMs
      ) {
        continue;
      }
      const item: AttentionItem = {
        id: `a_${randomUUID()}`,
        botId: candidate.botId,
        kind: candidate.kind,
        severity: severityOf(candidate.kind),
        evidence: candidate.evidence,
        count: 1,
        firstSeenAt: input.at,
        lastSeenAt: input.at,
      };
      state.items.push(item);
      touched.push(item);
    }
    for (const item of state.items) {
      if (item.closedAt !== undefined) continue;
      if (!isHealed(item, input.healed)) continue;
      item.closedAt = input.at;
    }
    await this.save();
    return touched;
  }

  async ack(itemId: string, at: string): Promise<AttentionItem | undefined> {
    const state = await this.load();
    const item = state.items.find((entry) => entry.id === itemId);
    if (item === undefined) return undefined;
    if (item.closedAt === undefined) item.closedAt = at;
    await this.save();
    return { ...item };
  }

  async markReportedItem(itemId: string, at: string): Promise<void> {
    const state = await this.load();
    const item = state.items.find((entry) => entry.id === itemId);
    if (item === undefined) return;
    item.reportedAt = at;
    await this.save();
  }

  async markActed(itemId: string, at: string): Promise<void> {
    const state = await this.load();
    const item = state.items.find((entry) => entry.id === itemId);
    if (item === undefined) return;
    item.actedAt = at;
    await this.save();
  }

  async record(record: AuditRecord): Promise<void> {
    const state = await this.load();
    state.audit.push(record);
    await this.save();
  }

  async setActivity(botId: string, mark: ActivityMark | undefined, at: string): Promise<void> {
    const state = await this.load();
    if (mark === undefined) delete state.activities[botId];
    else state.activities[botId] = mark;
    state.lastTickAt = at;
    await this.save();
  }

  async snapshot(): Promise<AttentionState> {
    return { ...(await this.load()) };
  }

  async finishTick(at: string, error?: string): Promise<void> {
    const state = await this.load();
    state.lastTickAt = at;
    if (error === undefined) delete state.lastError;
    else state.lastError = error;
    await this.save();
  }

  async markReported(at: string): Promise<void> {
    const state = await this.load();
    state.budgets.reportedAt = at;
    await this.save();
  }

  async markAction(at: string): Promise<void> {
    const state = await this.load();
    state.budgets.actions = [...state.budgets.actions, at].slice(-MAX_AUDIT);
    await this.save();
  }
}
