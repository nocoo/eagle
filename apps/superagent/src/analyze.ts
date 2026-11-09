// SG-003: turn evidence into one bounded suggestion, and mark what no longer holds.
// The model is asked once per Bot per cooldown; its answer is only a draft that
// `readModelSuggestion` accepts when it quotes ids this service offered.
import {
  type AnalysisStore,
  type Decision,
  MAX_SUGGESTION_CHARS,
  readModelSuggestion,
  type Suggestion,
  type Verdict,
} from "./analysis.ts";
import type { AttentionStore } from "./attention.ts";

export type AnalyzePorts = {
  readonly store: AnalysisStore;
  readonly attention: AttentionStore;
  /** The Bot's newest root page, as SG-002 reports it. */
  readonly history: (botId: string) => Promise<unknown>;
  /** One model turn, without a conversation entry. */
  readonly generate: (prompt: string) => Promise<string>;
  readonly now: () => Date;
  readonly cooldownMs: number;
};

export type AnalyzeResult =
  | { readonly suggestion: Suggestion }
  | { readonly refused: "cooldown" | "no_evidence" | "model" | "invalid" | "budget" | "duplicate" };

const MAX_ENTRY_EVIDENCE = 6;

const entriesOf = (history: unknown): readonly string[] => {
  const messages = (history as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .flatMap((message) =>
      message !== null &&
      typeof message === "object" &&
      typeof (message as { entryId?: unknown }).entryId === "string"
        ? [(message as { entryId: string }).entryId]
        : [],
    )
    .slice(-MAX_ENTRY_EVIDENCE);
};

const lastAnswer = (history: unknown): string | undefined => {
  const messages = (history as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; state?: string; blocks?: unknown };
    if (message.role !== "assistant") continue;
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const text = blocks
      .flatMap((block) =>
        block !== null && typeof block === "object" && (block as { type?: string }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : [],
      )
      .join(" ")
      .trim();
    return `${message.state ?? "unknown"}: ${text.slice(0, 160)}`;
  }
  return undefined;
};

const prompt = (input: {
  readonly botId: string;
  readonly attention: readonly { id: string; kind: string; evidence: string; count: number }[];
  readonly entries: readonly string[];
  readonly answer: string | undefined;
}): string =>
  [
    "你是 Eagle Super Bot 的分析器。只依据下面这些事实，给哥一条可执行的建议。",
    `Bot: ${input.botId}`,
    input.attention.length === 0
      ? "关注项: 无"
      : `关注项: ${input.attention
          .map((item) => `${item.id} ${item.kind} (${item.evidence} ×${item.count})`)
          .join("; ")}`,
    input.entries.length === 0 ? "最近条目: 无" : `最近条目: ${input.entries.join(", ")}`,
    input.answer === undefined ? "最近答复: 无" : `最近答复: ${input.answer}`,
    "要求：",
    `- 一条建议，不超过 ${MAX_SUGGESTION_CHARS} 字，说清下一步该做什么。`,
    "- evidence 数组只能引用上面出现过的 id（关注项 id 或条目 id），至少一条，最多 8 条。",
    "- 不要声称你执行过任何操作。",
    '只输出一个 JSON 对象：{"text": "...", "evidence": ["..."]}',
  ].join("\n");

export class Analyzer {
  readonly #ports: AnalyzePorts;

  constructor(ports: AnalyzePorts) {
    this.#ports = ports;
  }

  async #evidence(botId: string) {
    const items = (await this.#ports.attention.list({ limit: 200 })).filter(
      (item) => item.botId === botId,
    );
    const history = await this.#ports.history(botId).catch(() => null);
    return {
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        evidence: item.evidence,
        count: item.count,
      })),
      entries: entriesOf(history),
      answer: lastAnswer(history),
    };
  }

  /** One suggestion for one Bot, refused while its cooldown runs or without evidence. */
  async analyze(botId: string): Promise<AnalyzeResult> {
    const ports = this.#ports;
    const at = ports.now().toISOString();
    const last = await ports.store.lastAnalysis(botId);
    if (last !== undefined && ports.now().getTime() - Date.parse(last) < ports.cooldownMs) {
      return { refused: "cooldown" };
    }
    const evidence = await this.#evidence(botId);
    const offered = [...evidence.items.map((item) => item.id), ...evidence.entries];
    if (offered.length === 0) return { refused: "no_evidence" };
    let answer: string;
    try {
      answer = await ports.generate(
        prompt({
          botId,
          attention: evidence.items,
          entries: evidence.entries,
          answer: evidence.answer,
        }),
      );
    } catch {
      return { refused: "model" };
    }
    const draft = readModelSuggestion(answer, offered);
    if (draft === undefined) return { refused: "invalid" };
    const stored = await ports.store.add({ botId, draft, at });
    if ("refused" in stored) return { refused: stored.refused };
    return { suggestion: stored.created };
  }

  /** One Bot, as the socket reports it: the suggestion or why it was refused. */
  async analyzeFor(botId: string): Promise<{ suggestion?: Suggestion; refused?: string }> {
    const result = await this.analyze(botId);
    return "suggestion" in result ? { suggestion: result.suggestion } : { refused: result.refused };
  }

  /** The person's verdict on one open suggestion. */
  async decide(input: {
    readonly suggestionId: string;
    readonly verdict: Verdict;
    readonly reason?: string;
  }): Promise<
    | { readonly decision: Decision; readonly suggestion: Suggestion }
    | { readonly refused: "unknown_suggestion" | "decision_exists" }
  > {
    return this.#ports.store.decide({ ...input, at: this.#ports.now().toISOString() });
  }

  async decisions(
    options: { readonly botId?: string; readonly limit?: number } = {},
  ): Promise<readonly Decision[]> {
    return this.#ports.store.listDecisions(options);
  }

  /** The first Bot with evidence worth analysing, at most one per pass. */
  async analyzeOne(): Promise<Suggestion | undefined> {
    const open = await this.#ports.attention.list({ limit: 200 });
    const candidates = [...new Set(open.map((item) => item.botId))];
    for (const botId of candidates) {
      const result = await this.analyze(botId);
      if ("suggestion" in result) return result.suggestion;
    }
    return undefined;
  }

  /** Newest first, with the stale flag filled from the attention items behind each one. */
  async list(
    options: { readonly botId?: string; readonly limit?: number } = {},
  ): Promise<Suggestion[]> {
    const items = await this.#ports.attention.list({ limit: 200, includeClosed: true });
    const closed = new Set(
      items.filter((item) => item.closedAt !== undefined).map((item) => item.id),
    );
    const suggestions = await this.#ports.store.list({
      ...(options.botId === undefined ? {} : { botId: options.botId }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return suggestions.map((suggestion) => ({
      ...suggestion,
      stale: suggestion.evidence.some((entry) => closed.has(entry)),
    }));
  }
}
