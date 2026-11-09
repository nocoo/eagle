// SG-002 consumer side: the Superagent reads the daemon's observation routes and keeps
// its own baseline. Failures are values, never socket errors, and a reset drops the stale
// baseline instead of continuing from it.
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ObservationState =
  | "ready"
  | "refused"
  | "unreachable"
  | "reset"
  | "unconfigured"
  | "internal";

export type Baseline = {
  readonly source: { readonly id: string; readonly epoch: string };
  readonly catalog: string;
  readonly positions: Readonly<Record<string, unknown>>;
  readonly cursor: string;
};

export type ProviderReport = {
  readonly reachable: boolean;
  readonly state: ObservationState;
  /** Null when this consumer has never completed a read. */
  readonly lastReadAt: string | null;
  readonly unavailable: number;
  /** The provider's error code, never its text; null when nothing failed. */
  readonly detail: string | null;
};

export type ObservationOptions = {
  readonly root: string;
  readonly endpoint: string;
  readonly tokenFile: string;
  /**
   * This consumer's own baseline. The App's `observe-changes` and the SG-004 watcher must not
   * advance each other's cursor, so each keeps its own file.
   */
  readonly stateFile?: string;
};

const STATE_FILE = "observation-state.json";

type StoredState = {
  readonly baseline: Baseline | null;
  readonly lastReadAt: string | null;
  readonly state: ObservationState;
  readonly unavailable: number;
};

const emptyState = (): StoredState => ({
  baseline: null,
  lastReadAt: null,
  state: "unconfigured",
  unavailable: 0,
});

/** The token, under the daemon's own rules: regular file, mode 0600, at least 32 chars. */
export const readObservationToken = async (path: string): Promise<string | undefined> => {
  const entry = await lstat(path).catch(() => undefined);
  if (entry === undefined || !entry.isFile()) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    // The descriptor was opened from a regular file above; only the mode is left to check.
    if (((await handle.stat()).mode & 0o777) !== 0o600) return undefined;
    const token = (await handle.readFile("utf8")).trim();
    return token.length >= 32 ? token : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export class ObservationClient {
  readonly #options: ObservationOptions;
  #state: StoredState = emptyState();
  #loaded = false;

  constructor(options: ObservationOptions) {
    this.#options = options;
  }

  /** This instance's baseline file; two consumers of one daemon need two of them. */
  path(): string {
    return join(this.#options.root, this.#options.stateFile ?? STATE_FILE);
  }

  async #load(): Promise<StoredState> {
    if (this.#loaded) return this.#state;
    this.#loaded = true;
    try {
      const value = JSON.parse(await readFile(this.path(), "utf8")) as unknown;
      if (value !== null && typeof value === "object") {
        const candidate = value as Partial<StoredState>;
        this.#state = {
          baseline: candidate.baseline ?? null,
          lastReadAt: candidate.lastReadAt ?? null,
          state: candidate.state ?? "ready",
          unavailable: typeof candidate.unavailable === "number" ? candidate.unavailable : 0,
        };
      }
    } catch {
      this.#state = emptyState();
    }
    return this.#state;
  }

  /** Writes only after the reader has the value; a failure never advances the baseline. */
  async #save(next: StoredState): Promise<boolean> {
    const temporary = `${this.path()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path());
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
    this.#state = next;
    this.#loaded = true;
    return true;
  }

  #report(state: ObservationState, detail: string | null = null): ProviderReport {
    return {
      reachable: state === "ready" || state === "reset",
      state,
      lastReadAt: this.#state.lastReadAt,
      unavailable: this.#state.unavailable,
      detail,
    };
  }

  #mapFailure(code: string): ObservationState {
    if (code === "unauthenticated" || code === "credential_kind") return "refused";
    if (code === "cursor_invalid" || code === "cursor_reset" || code === "stale_page") {
      return "reset";
    }
    if (code === "host_refused" || code === "origin_refused") return "unreachable";
    return "internal";
  }

  async #call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; state: ObservationState; detail: string }
  > {
    if (this.#options.endpoint === "" || this.#options.tokenFile === "") {
      return { ok: false, state: "unconfigured", detail: "no_provider" };
    }
    const token = await readObservationToken(this.#options.tokenFile);
    if (token === undefined) return { ok: false, state: "unconfigured", detail: "no_credential" };
    let response: Response;
    try {
      response = await fetch(`${this.#options.endpoint}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { ok: false, state: "unreachable", detail: "unreachable" };
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, body };
    const code =
      typeof body.error === "object" && body.error !== null
        ? String((body.error as Record<string, unknown>).code ?? "internal")
        : "internal";
    return { ok: false, state: this.#mapFailure(code), detail: code };
  }

  async snapshot(): Promise<{ provider: ProviderReport; snapshot: unknown }> {
    await this.#load();
    const result = await this.#call("/v1/observe/snapshot");
    if (!result.ok) {
      if (result.state === "reset")
        await this.#save({ ...this.#state, baseline: null, state: "reset" });
      return { provider: this.#report(result.state, result.detail), snapshot: null };
    }
    if (result.body.kind !== "snapshot") {
      return { provider: this.#report("internal", "shape"), snapshot: null };
    }
    const source = result.body.source as { id: string; epoch: string } | undefined;
    const cursor = typeof result.body.cursor === "string" ? result.body.cursor : undefined;
    const catalog = (result.body.catalog as { revision?: string } | undefined)?.revision;
    const bots = Array.isArray(result.body.bots)
      ? (result.body.bots as Record<string, unknown>[])
      : [];
    const unavailable = bots.filter(
      (bot) => (bot.store as Record<string, unknown> | undefined)?.state !== "available",
    ).length;
    const stored = await this.#save({
      baseline:
        source === undefined || cursor === undefined || catalog === undefined
          ? null
          : { source, catalog, positions: {}, cursor },
      lastReadAt: new Date().toISOString(),
      state: "ready",
      unavailable,
    });
    if (!stored) return { provider: this.#report("internal", "state_unwritable"), snapshot: null };
    return { provider: this.#report("ready"), snapshot: result.body };
  }

  async history(request: {
    readonly botId: string;
    readonly scope?: string | undefined;
    readonly before?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ provider: ProviderReport; history: unknown }> {
    await this.#load();
    const params = new URLSearchParams({ botId: request.botId });
    if (request.scope !== undefined) params.set("scope", request.scope);
    if (request.before !== undefined) params.set("before", request.before);
    if (request.limit !== undefined) params.set("limit", String(request.limit));
    const result = await this.#call(`/v1/observe/history?${params.toString()}`);
    if (!result.ok) return { provider: this.#report(result.state, result.detail), history: null };
    if (result.body.kind !== "history") {
      return { provider: this.#report("internal", "shape"), history: null };
    }
    return { provider: this.#report("ready"), history: result.body };
  }

  async changes(limit?: number): Promise<{ provider: ProviderReport; changes: unknown }> {
    await this.#load();
    const baseline = this.#state.baseline;
    if (baseline === null) {
      return { provider: this.#report("reset", "no_baseline"), changes: null };
    }
    const result = await this.#call("/v1/observe/changes", {
      method: "POST",
      body: { cursor: baseline.cursor, ...(limit === undefined ? {} : { limit }) },
    });
    if (!result.ok) {
      if (result.state === "reset") {
        await this.#save({ ...this.#state, baseline: null, state: "reset" });
      }
      return { provider: this.#report(result.state, result.detail), changes: null };
    }
    if (result.body.kind !== "changes") {
      return { provider: this.#report("internal", "shape"), changes: null };
    }
    const next = (result.body.next as { cursor?: string } | undefined)?.cursor;
    const stored = await this.#save({
      baseline: next === undefined ? null : { ...baseline, cursor: next },
      lastReadAt: new Date().toISOString(),
      state: "ready",
      unavailable: this.#state.unavailable,
    });
    if (!stored) {
      return { provider: this.#report("internal", "state_unwritable"), changes: null };
    }
    return { provider: this.#report("ready"), changes: result.body };
  }
}
