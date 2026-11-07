// `changes` compares a baseline with the current state (SG-002 protocol §5). It is a
// comparison, not an event log: one commit can write several entries and tasks are
// updated in place, so a range plus the store incarnation is the stable identity.
import { DatabaseSync } from "node:sqlite";
import type { Baseline, BotPosition } from "./cursor.ts";
import { TABLES } from "./schema.ts";
import { inspectStore, readSnapshotFacts } from "./store.ts";

export type Change =
  | {
      readonly kind: "history_appended";
      readonly botId: string;
      readonly scopeId: string;
      readonly from: string;
      readonly to: string;
      readonly entries: number;
    }
  | { readonly kind: "storage_replaced"; readonly botId: string }
  | { readonly kind: "store_state_changed"; readonly botId: string; readonly state: string }
  | { readonly kind: "activity_changed"; readonly botId: string; readonly activity: string }
  | { readonly kind: "catalog_changed"; readonly bots: number };

export type BotFacts = {
  readonly botId: string;
  readonly position: BotPosition;
};

export type Comparison = {
  readonly changes: readonly Change[];
  readonly next: Readonly<Record<string, BotPosition>>;
  readonly pageLimitReached: boolean;
};

export type BotSource = {
  readonly botId: string;
  readonly sessionPath: string;
};

/** Appended entry ranges per scope, above the baseline's newest entry. */
export const readAppendedRanges = async (
  path: string,
  after: string | null,
): Promise<readonly { scopeId: string; from: string; to: string; entries: number }[]> => {
  const state = await inspectStore(path);
  if (state.state !== "available") return [];
  const afterNumber = after === null ? 0 : Number(after.replace(/^e_/, ""));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT conversation_id AS scope, MIN(id) AS low, MAX(id) AS high, COUNT(*) AS total
         FROM ${TABLES.entries} WHERE id > ? GROUP BY conversation_id ORDER BY conversation_id`,
      )
      .all(afterNumber) as { scope: number; low: number; high: number; total: number }[];
    return rows.map((row) => ({
      scopeId: `c_${row.scope}`,
      from: `e_${row.low}`,
      to: `e_${row.high}`,
      entries: row.total,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
};

export const readBotPosition = async (source: BotSource): Promise<BotFacts> => {
  const state = await inspectStore(source.sessionPath);
  if (state.state !== "available") {
    return {
      botId: source.botId,
      position: {
        incarnation: state.state,
        generation: { min: null, max: null, count: 0 },
        state: state.state,
        activity: "unknown",
      },
    };
  }
  const facts = await readSnapshotFacts(source.sessionPath);
  return {
    botId: source.botId,
    position: {
      incarnation: state.incarnation ?? "",
      generation: facts.generation,
      state: "available",
      activity: facts.activity,
    },
  };
};

const regressed = (before: BotPosition, current: BotPosition): boolean => {
  const previous =
    before.generation.max === null ? 0 : Number(before.generation.max.replace(/^e_/, ""));
  const now =
    current.generation.max === null ? 0 : Number(current.generation.max.replace(/^e_/, ""));
  return now < previous || current.generation.count < before.generation.count;
};

/**
 * Compares the baseline with the current fleet. `limit` bounds the number of changes; a
 * cut page advances only the Bots whose changes were fully delivered, so nothing is lost.
 */
export const compareFleet = async (options: {
  readonly baseline: Baseline;
  readonly sources: readonly BotSource[];
  readonly catalog: string;
  readonly limit: number;
}): Promise<Comparison> => {
  const current = new Map<string, BotFacts>();
  for (const source of options.sources) {
    current.set(source.botId, await readBotPosition(source));
  }
  const candidates: { change: Change; botId: string | null; position?: BotPosition }[] = [];

  if (options.catalog !== options.baseline.catalog) {
    candidates.push({
      change: { kind: "catalog_changed", bots: options.sources.length },
      botId: null,
    });
  }

  for (const facts of current.values()) {
    const before = options.baseline.positions[facts.botId];
    if (before === undefined) {
      candidates.push({
        change: { kind: "store_state_changed", botId: facts.botId, state: facts.position.state },
        botId: facts.botId,
        position: facts.position,
      });
      continue;
    }
    if (before.incarnation !== facts.position.incarnation) {
      candidates.push({
        change: { kind: "storage_replaced", botId: facts.botId },
        botId: facts.botId,
        position: facts.position,
      });
      continue;
    }
    if (regressed(before, facts.position)) {
      candidates.push({
        change: { kind: "storage_replaced", botId: facts.botId },
        botId: facts.botId,
        position: facts.position,
      });
      continue;
    }
    if (before.state !== facts.position.state) {
      candidates.push({
        change: {
          kind: "store_state_changed",
          botId: facts.botId,
          state: facts.position.state,
        },
        botId: facts.botId,
        position: facts.position,
      });
      continue;
    }
    if (before.activity !== facts.position.activity) {
      candidates.push({
        change: {
          kind: "activity_changed",
          botId: facts.botId,
          activity: facts.position.activity,
        },
        botId: facts.botId,
        position: facts.position,
      });
      continue;
    }
    const source = options.sources.find((candidate) => candidate.botId === facts.botId);
    if (source === undefined) continue;
    const ranges = await readAppendedRanges(source.sessionPath, before.generation.max);
    if (ranges.length === 0 && before.generation.max !== facts.position.generation.max) {
      candidates.push({
        change: { kind: "storage_replaced", botId: facts.botId },
        botId: facts.botId,
        position: facts.position,
      });
      continue;
    }
    for (const range of ranges) {
      candidates.push({
        change: { kind: "history_appended", botId: facts.botId, ...range },
        botId: facts.botId,
        position: facts.position,
      });
    }
  }

  const pageLimitReached = candidates.length > options.limit;
  const delivered = candidates.slice(0, options.limit);
  const settled = new Set(
    delivered.filter((candidate) => candidate.botId !== null).map((candidate) => candidate.botId),
  );
  const next: Record<string, BotPosition> = {};
  for (const facts of current.values()) {
    const settledHere = settled.has(facts.botId) && !pageLimitReached;
    const usable = facts.position.state === "available" || settled.has(facts.botId);
    if (usable) next[facts.botId] = facts.position;
    else if (!settledHere) {
      const before = options.baseline.positions[facts.botId];
      if (before !== undefined) next[facts.botId] = before;
    }
  }
  return {
    changes: delivered.map((candidate) => candidate.change),
    next,
    pageLimitReached,
  };
};
