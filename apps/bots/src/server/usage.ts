// Usage statistics (docs/bots/PROTOCOL.md, "Usage statistics"): one row per bot, local day
// and source, kept for 90 days so Settings can show today, a week, a month, who spends the
// most and where it went. The store lives beside the token, not in a bot's session, so
// deleting a bot keeps history.
//
// Everything that spends something reports through `UsageMeter`: models report tokens,
// search reports calls, a future provider reports whatever it bills. A source is a string,
// so a new one needs no schema change.
import { DatabaseSync } from "node:sqlite";
import type { Usage } from "../core/domain.ts";

export const RETENTION_DAYS = 90;

export const USAGE_SOURCES = ["model", "search"] as const;

export type UsageSource = (typeof USAGE_SOURCES)[number] | (string & {});

/** One increment: what a bot spent on one source right now. */
export type UsageEntry = {
  readonly botId: string;
  readonly source: UsageSource;
  readonly tokens?: number;
  readonly calls?: number;
  readonly costUsd?: number;
  readonly counter?: string;
};

/** The seam the daemon and its tools report through, so a new source needs no new store. */
export interface UsageMeter {
  record(entry: UsageEntry): void;
}

export type UsageTotals = {
  readonly totalTokens: number;
  readonly calls: number;
  readonly costUsd: number;
};

export type UsageDay = UsageTotals & { readonly day: string };

export type UsageBot = UsageTotals & { readonly botId: string };

export type UsageSourceTotals = UsageTotals & { readonly source: string };

export type UsageReport = {
  readonly retentionDays: number;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  readonly month: UsageTotals;
  /** The requested window, oldest first, with a zero row for a day nothing ran. */
  readonly days: readonly UsageDay[];
  /** The busiest bots inside the retention window, busiest first. */
  readonly bots: readonly UsageBot[];
  /** Where the work went, busiest first. */
  readonly sources: readonly UsageSourceTotals[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

type MutableTotals = { totalTokens: number; calls: number; costUsd: number };

const emptyTotals = (): MutableTotals => ({ totalTokens: 0, calls: 0, costUsd: 0 });

/** `YYYY-MM-DD` in the machine's own zone: a day is what the person experienced. */
export const dayOf = (at: Date): string => {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dayBefore = (at: Date, days: number): string => dayOf(new Date(at.getTime() - days * DAY_MS));

type Row = {
  bot_id: string;
  day: string;
  source: string;
  tokens: number;
  calls: number;
  cost_usd: number;
};

export class UsageStore implements UsageMeter {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #retention: number;

  constructor(
    path: string,
    options: { readonly now?: () => Date; readonly retentionDays?: number } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#retention = options.retentionDays ?? RETENTION_DAYS;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      create table if not exists usage_daily (
        bot_id text not null,
        day text not null,
        source text not null,
        tokens integer not null,
        calls integer not null,
        cost_usd real not null,
        primary key (bot_id, day, source)
      );
      create table if not exists last_seen (
        bot_id text primary key,
        total_tokens integer not null,
        cost_usd real not null
      );
      create table if not exists usage_counters (
        bot_id text not null,
        source text not null,
        counter_key text not null,
        tokens integer not null,
        calls integer not null,
        cost_usd real not null,
        primary key (bot_id, source, counter_key)
      );
    `);
    this.#migrateModelOnlyDays();
    this.prune();
  }

  /** The first schema counted tokens per bot and day, with no source and no call count. */
  #migrateModelOnlyDays(): void {
    const legacy = this.#db
      .prepare("select name from sqlite_master where type = 'table' and name = 'daily'")
      .get();
    if (legacy === undefined) return;
    this.#db.exec(`
      insert into usage_daily (bot_id, day, source, tokens, calls, cost_usd)
      select bot_id, day, 'model', total_tokens, 0, cost_usd from daily
      where true
      on conflict(bot_id, day, source) do update set
        tokens = tokens + excluded.tokens,
        cost_usd = cost_usd + excluded.cost_usd;
      drop table daily;
    `);
  }

  record(entry: UsageEntry): void {
    let tokens = Math.max(0, Math.round(entry.tokens ?? 0));
    let calls = Math.max(0, Math.round(entry.calls ?? 0));
    let costUsd = Math.max(0, entry.costUsd ?? 0);
    const counter = entry.counter;
    if (counter !== undefined) this.#db.exec("begin immediate");
    try {
      if (counter !== undefined) {
        const previous = this.#db
          .prepare(
            "select tokens, calls, cost_usd from usage_counters where bot_id = ? and source = ? and counter_key = ?",
          )
          .get(entry.botId, entry.source, counter) as
          | { tokens: number; calls: number; cost_usd: number }
          | undefined;
        this.#db
          .prepare(
            `insert into usage_counters (bot_id, source, counter_key, tokens, calls, cost_usd)
           values (?, ?, ?, ?, ?, ?)
           on conflict(bot_id, source, counter_key) do update set
             tokens = max(tokens, excluded.tokens), calls = max(calls, excluded.calls),
             cost_usd = max(cost_usd, excluded.cost_usd)`,
          )
          .run(entry.botId, entry.source, counter, tokens, calls, costUsd);
        tokens = Math.max(0, tokens - (previous?.tokens ?? 0));
        calls = Math.max(0, calls - (previous?.calls ?? 0));
        costUsd = Math.max(0, costUsd - (previous?.cost_usd ?? 0));
      }
      if (tokens !== 0 || calls !== 0 || costUsd !== 0) {
        this.#db
          .prepare(
            `insert into usage_daily (bot_id, day, source, tokens, calls, cost_usd)
             values (?, ?, ?, ?, ?, ?)
             on conflict(bot_id, day, source) do update set
               tokens = tokens + excluded.tokens,
               calls = calls + excluded.calls,
               cost_usd = cost_usd + excluded.cost_usd`,
          )
          .run(entry.botId, dayOf(this.#now()), entry.source, tokens, calls, costUsd);
      }
      if (counter !== undefined) this.#db.exec("commit");
    } catch (error) {
      if (counter !== undefined) {
        try {
          this.#db.exec("rollback");
        } catch {
          // Preserve the original storage error.
        }
      }
      throw error;
    }
    this.prune();
  }

  /**
   * The runtime reports cumulative spend, so the day books the difference. A lower total (a
   * reset conversation) books nothing rather than a negative row.
   */
  recordModelUsage(botId: string, usage: Usage): void {
    const seen = this.#db
      .prepare("select total_tokens, cost_usd from last_seen where bot_id = ?")
      .get(botId) as { total_tokens: number; cost_usd: number } | undefined;
    const previousTokens = seen?.total_tokens ?? 0;
    const previousCost = seen?.cost_usd ?? 0;
    const tokens = Math.max(0, usage.totalTokens - previousTokens);
    const costUsd = Math.max(0, (usage.costUsd ?? 0) - previousCost);
    this.#db
      .prepare(
        `insert into last_seen (bot_id, total_tokens, cost_usd) values (?, ?, ?)
         on conflict(bot_id) do update set
           total_tokens = excluded.total_tokens,
           cost_usd = excluded.cost_usd`,
      )
      .run(botId, usage.totalTokens, usage.costUsd ?? 0);
    this.record({ botId, source: "model", tokens, costUsd });
  }

  /** Drops what fell out of the retention window; cheap, so it runs on boot and on write. */
  prune(): void {
    this.#db
      .prepare("delete from usage_daily where day < ?")
      .run(dayBefore(this.#now(), this.#retention));
  }

  report(days = 30): UsageReport {
    const at = this.#now();
    const window = Math.min(Math.max(days, 1), this.#retention);
    const rows = this.#db
      .prepare(
        "select bot_id, day, source, tokens, calls, cost_usd from usage_daily where day >= ?",
      )
      .all(dayBefore(at, window - 1)) as Row[];
    const byDay = new Map<string, Row[]>();
    for (const row of rows) {
      const list = byDay.get(row.day);
      if (list === undefined) byDay.set(row.day, [row]);
      else list.push(row);
    }
    const totalsOf = (list: readonly Row[]): UsageTotals => {
      const totals = emptyTotals();
      for (const row of list) {
        totals.totalTokens += row.tokens;
        totals.calls += row.calls;
        totals.costUsd += row.cost_usd;
      }
      return totals;
    };
    const series: UsageDay[] = [];
    for (let offset = window - 1; offset >= 0; offset -= 1) {
      const day = dayBefore(at, offset);
      series.push({ day, ...totalsOf(byDay.get(day) ?? []) });
    }
    const within = (from: number): UsageTotals =>
      totalsOf(rows.filter((row) => row.day >= dayBefore(at, from - 1)));
    const retentionRows = this.#db
      .prepare(
        "select bot_id, day, source, tokens, calls, cost_usd from usage_daily where day >= ?",
      )
      .all(dayBefore(at, this.#retention - 1)) as Row[];
    const perBot = new Map<string, MutableTotals>();
    const perSource = new Map<string, MutableTotals>();
    for (const row of retentionRows) {
      const bot = perBot.get(row.bot_id) ?? emptyTotals();
      bot.totalTokens += row.tokens;
      bot.calls += row.calls;
      bot.costUsd += row.cost_usd;
      perBot.set(row.bot_id, bot);
      const source = perSource.get(row.source) ?? emptyTotals();
      source.totalTokens += row.tokens;
      source.calls += row.calls;
      source.costUsd += row.cost_usd;
      perSource.set(row.source, source);
    }
    const byWork = (left: UsageTotals, right: UsageTotals) =>
      right.totalTokens + right.calls - (left.totalTokens + left.calls);
    return {
      retentionDays: this.#retention,
      today: within(1),
      week: within(7),
      month: within(30),
      days: series,
      bots: [...perBot.entries()]
        .map(([botId, totals]) => ({ botId, ...totals }))
        .sort(byWork)
        .slice(0, 10),
      sources: [...perSource.entries()]
        .map(([source, totals]) => ({ source, ...totals }))
        .sort(byWork),
    };
  }

  close(): void {
    this.#db.close();
  }
}
