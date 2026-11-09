// SG-004: the Superagent's own loop. It watches the worker Bots through SG-002's read
// contract, decides what needs attention, and — inside an explicit mode — reports to the
// person or nudges the Bot. Nothing here touches a worker's runtime; a nudge is the same
// client write the person makes.
import type { ActionResult, AttentionItem, AttentionStore, Candidate } from "./attention.ts";
import type { ProviderReport } from "./observation.ts";

export type WatchMode = "off" | "notify" | "act";

type Change = {
  readonly kind: string;
  readonly botId?: string;
  readonly state?: string;
  readonly activity?: string;
  readonly scopeId?: string;
};

type HistoryMessage = {
  readonly role?: string;
  readonly state?: string;
  readonly kind?: string;
};

export type WatchObservation = {
  /** Establishes the baseline the first `changes` read needs after a start or a reset. */
  snapshot(): Promise<{ provider: ProviderReport; snapshot: unknown }>;
  changes(limit?: number): Promise<{ provider: ProviderReport; changes: unknown }>;
  history(request: { readonly botId: string; readonly limit?: number }): Promise<{
    provider: ProviderReport;
    history: unknown;
  }>;
};

export type WatchPorts = {
  readonly observation: WatchObservation;
  readonly store: AttentionStore;
  readonly now: () => Date;
  readonly intervalMs: number;
  readonly stallAfterMs: number;
  readonly reopenAfterMs: number;
  readonly reportBudgetMs: number;
  readonly actionCooldownMs: number;
  readonly maxActionsPerHour: number;
  readonly mode: WatchMode;
  /** One proactive model turn in the Super Bot's own conversation, when a mode allows it. */
  readonly report?: (prompt: string) => Promise<void>;
  /** SG-003: asked after a pass, so analysis follows evidence instead of a second timer. */
  readonly afterTick?: () => Promise<void>;
  /** One management write toward a worker, through the person's own surface. */
  readonly manage?: (input: {
    readonly botId: string;
    readonly verb: "nudge" | "abort";
    readonly text: string;
  }) => Promise<{ readonly result: ActionResult; readonly detail?: string }>;
};

export type TickResult = {
  readonly provider: ProviderReport | undefined;
  readonly raised: readonly AttentionItem[];
};

const ACTIVITIES = new Set(["queued", "running"]);

const changeList = (body: unknown): readonly Change[] => {
  const changes = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const change = entry as Change;
    return typeof change.kind === "string" ? [change] : [];
  });
};

/**
 * The newest answer decides whether a Bot ended badly. Only the root scope's newest message
 * is read, so a child agent's failure does not raise the Bot itself.
 */
export const classifyTail = (history: unknown): Candidate["kind"] | undefined => {
  const messages = (history as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as HistoryMessage;
    if (message.role !== "assistant") continue;
    return message.state === "error" || message.state === "aborted" ? "worker_error" : undefined;
  }
  return undefined;
};

const NUDGE = {
  worker_error:
    "内部巡检：你上一次运行以错误结束。请先用一两句话说明原因，再继续；需要我做什么就说。",
  worker_stalled:
    "内部巡检：你执行任务已经很久没有结果了。请报告当前进度；如果卡住了，说明卡在哪一步。",
} as const;

const reportText = (items: readonly AttentionItem[]): string => {
  const lines = items
    .slice(0, 3)
    .map(
      (item) => `- Bot ${item.botId}：${item.kind}（证据 ${item.evidence}，第 ${item.count} 次）`,
    )
    .join("\n");
  return [
    "内部巡检（你会收到这条消息，是因为超管观察到了下面的情况；请只依据这些事实回答）：",
    lines,
    "请用不超过三句话向哥说明你看到了什么、建议怎么处理，不要声称你执行过任何命令。",
  ].join("\n");
};

const hourAgo = (now: number): number => now - 3_600_000;

export class Watcher {
  readonly #ports: WatchPorts;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<TickResult> | undefined;

  constructor(ports: WatchPorts) {
    this.#ports = ports;
  }

  get mode(): WatchMode {
    return this.#ports.mode;
  }

  start(): void {
    if (this.#ports.mode === "off" || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.#ports.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One pass. Overlapping calls share the pass in flight instead of reading twice. */
  async tick(): Promise<TickResult> {
    if (this.#ticking !== undefined) return this.#ticking;
    this.#ticking = this.#pass().finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  async #pass(): Promise<TickResult> {
    const ports = this.#ports;
    const at = ports.now().toISOString();
    const read = await ports.observation.changes();
    if (read.changes === null && read.provider.detail === "no_baseline") {
      // A fresh watcher has no cursor yet: one snapshot primes it, and the next tick compares.
      const primed = await ports.observation.snapshot();
      await ports.store.finishTick(at, primed.provider.state);
      return { provider: primed.provider, raised: [] };
    }
    if (read.changes === null) {
      // An unconfigured or unreachable provider is not a worker failure: keep what is known
      // and say why this tick saw nothing.
      await ports.store.finishTick(at, read.provider.state);
      return { provider: read.provider, raised: [] };
    }
    const candidates: Candidate[] = [];
    const healed = new Set<string>();
    let changes = changeList(read.changes);
    if (changes.some((change) => change.kind === "catalog_changed")) {
      // A Bot created or removed since the baseline is only visible after a snapshot read, and
      // that read is also what carries the new Bot's state for the next comparison.
      const refreshed = await ports.observation.snapshot();
      if (refreshed.snapshot !== null) {
        await ports.store.finishTick(at, refreshed.provider.state);
        return { provider: refreshed.provider, raised: [] };
      }
      changes = changes.filter((change) => change.kind !== "catalog_changed");
    }
    for (const change of changes) {
      const botId = change.botId;
      if (botId === undefined) continue;
      if (change.kind === "store_state_changed" && change.state !== undefined) {
        if (change.state === "available") healed.add(`${botId}\u0000worker_unavailable`);
        else
          candidates.push({
            botId,
            kind: "worker_unavailable",
            severity: "high",
            evidence: `store:${change.state}`,
          });
      }
      if (change.kind === "activity_changed" && change.activity !== undefined) {
        const current = (await ports.store.snapshot()).activities[botId];
        if (ACTIVITIES.has(change.activity)) {
          if (current === undefined || current.activity !== change.activity) {
            await ports.store.setActivity(botId, { activity: change.activity, since: at }, at);
          }
        } else {
          await ports.store.setActivity(botId, undefined, at);
          healed.add(`${botId}\u0000worker_stalled`);
          // A run that ends is when its answer becomes a fact: the entry was appended while it
          // was still streaming, so only the settled tail says whether it ended badly.
          const ended = await ports.observation.history({ botId, limit: 3 });
          if (ended.history !== null && classifyTail(ended.history) === "worker_error") {
            candidates.push({
              botId,
              kind: "worker_error",
              severity: "medium",
              evidence: "answer:error",
            });
          }
        }
      }
      if (change.kind === "history_appended") {
        const tail = await ports.observation.history({ botId, limit: 3 });
        const kind = tail.history === null ? undefined : classifyTail(tail.history);
        if (kind === undefined) healed.add(`${botId}\u0000worker_error`);
        else
          candidates.push({
            botId,
            kind,
            severity: "medium",
            evidence: `answer:${tail.history === null ? "unknown" : "error"}`,
          });
      }
    }

    const now = ports.now().getTime();
    const state = await ports.store.snapshot();
    // A mark that outlives the stall window is checked against the provider before it is
    // believed: a missed `activity_changed` must not turn an idle Bot into a stuck one, and
    // in `act` mode that difference is a nudge or an abort.
    const overdue = Object.entries(state.activities).filter(
      ([, mark]) =>
        ACTIVITIES.has(mark.activity) && now - Date.parse(mark.since) >= this.#ports.stallAfterMs,
    );
    if (overdue.length > 0) {
      const current = await ports.observation.snapshot();
      const live = new Map<string, string>();
      const bots = (current.snapshot as { bots?: unknown } | null)?.bots;
      if (Array.isArray(bots)) {
        for (const bot of bots) {
          if (bot === null || typeof bot !== "object") continue;
          const entry = bot as { botId?: unknown; activity?: unknown };
          if (typeof entry.botId === "string" && typeof entry.activity === "string") {
            live.set(entry.botId, entry.activity);
          }
        }
      }
      for (const [botId] of overdue) {
        const activity = live.get(botId);
        if (activity !== undefined && ACTIVITIES.has(activity)) continue;
        await ports.store.setActivity(botId, undefined, at);
        healed.add(`${botId}\u0000worker_stalled`);
      }
    }
    for (const [botId, mark] of Object.entries((await ports.store.snapshot()).activities)) {
      if (!ACTIVITIES.has(mark.activity)) continue;
      if (now - Date.parse(mark.since) < this.#ports.stallAfterMs) continue;
      candidates.push({
        botId,
        kind: "worker_stalled",
        severity: "medium",
        evidence: `activity:${mark.activity}`,
      });
    }

    const raised = await ports.store.observe({
      candidates,
      healed,
      at,
      reopenAfterMs: ports.reopenAfterMs,
    });
    // Every tick re-reads what is still open: an item noticed while a report budget was spent
    // must still be reported later, and a nudge must survive a tick that found nothing new.
    await this.#handle(raised, at);
    await this.#ports.store.finishTick(at);
    // SG-003 runs after the evidence is stored: one suggestion per pass at most.
    await this.#ports.afterTick?.().catch(() => undefined);
    return { provider: read.provider, raised };
  }

  async #handle(_raised: readonly AttentionItem[], at: string): Promise<void> {
    const ports = this.#ports;
    if (ports.mode === "off") return;
    const open = await ports.store.list({ limit: 200 });
    const unreported = open.filter((item) => item.reportedAt === undefined);
    if (open.length === 0) return;
    const state = await ports.store.snapshot();
    const reportedAt = state.budgets.reportedAt;
    const first = unreported[0];
    const reportDue =
      ports.report !== undefined &&
      first !== undefined &&
      (reportedAt === undefined || Date.parse(at) - Date.parse(reportedAt) >= ports.reportBudgetMs);
    if (reportDue && first !== undefined) {
      try {
        await ports.report?.(reportText(unreported));
        await ports.store.markReported(at);
        for (const item of unreported.slice(0, 3)) await ports.store.markReportedItem(item.id, at);
        await ports.store.record({
          at,
          itemId: first.id,
          botId: first.botId,
          verb: "report",
          result: "sent",
          text: "巡检报告（3 项以内）",
        });
      } catch {
        await ports.store.record({
          at,
          itemId: first.id,
          botId: first.botId,
          verb: "report",
          result: "failed",
        });
      }
    }
    if (ports.mode !== "act" || ports.manage === undefined) return;
    const fresh = await ports.store.snapshot();
    const recent = fresh.budgets.actions.filter(
      (entry) => Date.parse(entry) >= hourAgo(Date.parse(at)),
    );
    let budget = this.#ports.maxActionsPerHour - recent.length;
    // One management write per item; an item re-created after the reopen window is a new one,
    // and the hourly budget is the outer bound.
    const openNow = await ports.store.list({ limit: 200 });
    for (const item of openNow) {
      if (budget <= 0) break;
      if (item.kind === "worker_unavailable") continue;
      if (item.actedVerb === "abort") continue;
      // One bot is not written to twice inside the cooldown, whatever the kinds say.
      const pestered = fresh.audit.some(
        (record) =>
          record.botId === item.botId &&
          record.verb !== "report" &&
          record.result !== "skipped" &&
          Date.parse(at) - Date.parse(record.at) < ports.actionCooldownMs,
      );
      if (pestered) continue;
      // A stall that outlives its own window twice is not a nudge anymore: the run is stuck,
      // and the honest management write is to withdraw it. `abort` carries no text.
      const stalledTooLong =
        item.kind === "worker_stalled" &&
        Date.parse(at) - Date.parse(item.firstSeenAt) >= 2 * ports.stallAfterMs;
      // One nudge, then only the withdrawal: a stalled run gets a second write that ends it.
      if (item.actedAt !== undefined && !(stalledTooLong && item.actedVerb === "nudge")) continue;
      const verb = stalledTooLong ? "abort" : "nudge";
      const text = stalledTooLong
        ? ""
        : NUDGE[item.kind === "worker_error" ? "worker_error" : "worker_stalled"];
      try {
        const outcome = await ports.manage({ botId: item.botId, verb, text });
        await ports.store.record({
          at,
          itemId: item.id,
          botId: item.botId,
          verb,
          result: outcome.result,
          ...(verb === "nudge" ? { text } : {}),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        });
        await ports.store.markActed(item.id, at, verb);
        if (outcome.result === "sent") {
          await ports.store.markAction(at);
          budget -= 1;
        }
      } catch {
        await ports.store.record({
          at,
          itemId: item.id,
          botId: item.botId,
          verb,
          result: "failed",
          ...(verb === "nudge" ? { text } : {}),
        });
        await ports.store.markActed(item.id, at, verb);
      }
    }
  }
}
