// SG-003: what the Super Bot thinks the evidence supports, and what the person decided.
// A suggestion that cannot name evidence is not stored at all; a decision is immutable once
// written. Nothing here writes toward a worker.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Verdict = "accepted" | "rejected" | "deferred";

export type Suggestion = {
  readonly id: string;
  readonly botId: string;
  readonly text: string;
  /** Entry ids, attention item ids or provider facts this suggestion rests on. */
  readonly evidence: readonly string[];
  readonly createdAt: string;
  closedAt?: string;
  /** Computed on read: an attention item behind it closed, or the Bot left the catalogue. */
  stale?: boolean;
};

export type Decision = {
  readonly id: string;
  readonly suggestionId: string;
  readonly botId: string;
  readonly verdict: Verdict;
  readonly reason?: string;
  readonly at: string;
};

export type AnalysisState = {
  readonly version: 1;
  suggestions: Suggestion[];
  decisions: Decision[];
  /** The last time a suggestion was asked of the model, per Bot. */
  lastAnalysis: Record<string, string>;
};

export const MAX_SUGGESTION_CHARS = 240;
export const MAX_EVIDENCE = 8;
export const MAX_OPEN_PER_BOT = 3;
export const MAX_OPEN = 50;
export const MAX_KEPT = 200;
const STATE_FILE = "analysis.json";

const emptyState = (): AnalysisState => ({
  version: 1,
  suggestions: [],
  decisions: [],
  lastAnalysis: {},
});

export type SuggestionDraft = { readonly text: string; readonly evidence: readonly string[] };

/**
 * The one gate between a model answer and a stored suggestion: bounded text, and every quote
 * must be an id the service itself offered. Free prose is refused here, not discouraged.
 */
export const readSuggestion = (
  value: unknown,
  offered: readonly string[],
): SuggestionDraft | undefined => {
  const text =
    value !== null &&
    typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string"
      ? ((value as { text: string }).text ?? "").trim()
      : "";
  if (text.length === 0 || text.length > MAX_SUGGESTION_CHARS) return undefined;
  const raw = (value as { evidence?: unknown }).evidence;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set(offered);
  const evidence = [...new Set(raw.filter((entry): entry is string => typeof entry === "string"))];
  if (evidence.length === 0 || evidence.length > MAX_EVIDENCE) return undefined;
  if (evidence.some((entry) => !allowed.has(entry))) return undefined;
  return { text, evidence };
};

/** The model may answer in prose around its JSON; the first object is the answer. */
export const readModelSuggestion = (
  answer: string,
  offered: readonly string[],
): SuggestionDraft | undefined => {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return readSuggestion(JSON.parse(answer.slice(start, end + 1)), offered);
  } catch {
    return undefined;
  }
};

export class AnalysisStore {
  readonly #path: string;
  #state: AnalysisState = emptyState();
  #loaded = false;

  constructor(root: string) {
    this.#path = join(root, STATE_FILE);
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<AnalysisState> {
    if (this.#loaded) return this.#state;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<AnalysisState>;
      this.#state = {
        version: 1,
        suggestions: Array.isArray(parsed.suggestions) ? (parsed.suggestions as Suggestion[]) : [],
        decisions: Array.isArray(parsed.decisions) ? (parsed.decisions as Decision[]) : [],
        lastAnalysis:
          parsed.lastAnalysis !== null &&
          typeof parsed.lastAnalysis === "object" &&
          !Array.isArray(parsed.lastAnalysis)
            ? (parsed.lastAnalysis as Record<string, string>)
            : {},
      };
    } catch {
      this.#state = emptyState();
    }
    return this.#state;
  }

  async save(): Promise<boolean> {
    const open = (suggestion: Suggestion) => suggestion.closedAt === undefined;
    const suggestions = [...this.#state.suggestions]
      .sort((left, right) => {
        if (open(left) !== open(right)) return open(left) ? 1 : -1;
        return left.createdAt.localeCompare(right.createdAt);
      })
      .slice(-MAX_KEPT)
      .map(({ stale: _ignored, ...rest }) => rest);
    const next: AnalysisState = {
      ...this.#state,
      suggestions,
      decisions: this.#state.decisions.slice(-MAX_KEPT),
    };
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

  async add(input: {
    readonly botId: string;
    readonly draft: SuggestionDraft;
    readonly at: string;
  }): Promise<{ readonly created: Suggestion } | { readonly refused: "budget" | "duplicate" }> {
    const state = await this.load();
    const open = state.suggestions.filter((entry) => entry.closedAt === undefined);
    if (open.length >= MAX_OPEN) return { refused: "budget" };
    if (open.filter((entry) => entry.botId === input.botId).length >= MAX_OPEN_PER_BOT) {
      return { refused: "budget" };
    }
    // The same text for the same Bot is the same suggestion; a re-ask must not pile up.
    if (open.some((entry) => entry.botId === input.botId && entry.text === input.draft.text)) {
      return { refused: "duplicate" };
    }
    const suggestion: Suggestion = {
      id: `s_${randomUUID()}`,
      botId: input.botId,
      text: input.draft.text,
      evidence: [...input.draft.evidence],
      createdAt: input.at,
    };
    state.suggestions.push(suggestion);
    state.lastAnalysis[input.botId] = input.at;
    await this.save();
    return { created: suggestion };
  }

  /** Newest first; `stale` is filled by the caller that can check the evidence. */
  async list(
    options: {
      readonly botId?: string;
      readonly limit?: number;
      readonly includeClosed?: boolean;
    } = {},
  ): Promise<Suggestion[]> {
    const state = await this.load();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_KEPT);
    return state.suggestions
      .filter((entry) => options.botId === undefined || entry.botId === options.botId)
      .filter((entry) => options.includeClosed === true || entry.closedAt === undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async suggestions(): Promise<readonly Suggestion[]> {
    return (await this.load()).suggestions;
  }

  async decisionsFor(suggestionId: string): Promise<Decision | undefined> {
    const state = await this.load();
    return state.decisions.find((entry) => entry.suggestionId === suggestionId);
  }

  async listDecisions(
    options: { readonly botId?: string; readonly limit?: number } = {},
  ): Promise<Decision[]> {
    const state = await this.load();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_KEPT);
    return state.decisions
      .filter((entry) => options.botId === undefined || entry.botId === options.botId)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  /** One decision per suggestion, for good: a second verdict is a refusal, not an overwrite. */
  async decide(input: {
    readonly suggestionId: string;
    readonly verdict: Verdict;
    readonly reason?: string;
    readonly at: string;
  }): Promise<
    | { readonly decision: Decision; readonly suggestion: Suggestion }
    | { readonly refused: "unknown_suggestion" | "decision_exists" }
  > {
    const state = await this.load();
    const suggestion = state.suggestions.find((entry) => entry.id === input.suggestionId);
    if (suggestion === undefined) return { refused: "unknown_suggestion" };
    if (state.decisions.some((entry) => entry.suggestionId === input.suggestionId)) {
      return { refused: "decision_exists" };
    }
    const decision: Decision = {
      id: `d_${randomUUID()}`,
      suggestionId: suggestion.id,
      botId: suggestion.botId,
      verdict: input.verdict,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      at: input.at,
    };
    state.decisions.push(decision);
    suggestion.closedAt = input.at;
    await this.save();
    return { decision, suggestion: { ...suggestion } };
  }

  async lastAnalysis(botId: string): Promise<string | undefined> {
    return (await this.load()).lastAnalysis[botId];
  }

  async markAnalyzed(botId: string, at: string): Promise<void> {
    const state = await this.load();
    state.lastAnalysis[botId] = at;
    await this.save();
  }
}
