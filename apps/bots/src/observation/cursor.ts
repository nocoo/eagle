// The SG-002 baseline (docs/bots/specs/SUPERAGENT-002-PROTOCOL.md §7). It is opaque to
// callers and strict on decode: a wrong source is invalid, a wrong epoch is a reset, and
// a changed incarnation or regressed generation is a reset for that Bot.
import { BASELINE_BODY_BYTES } from "./schema.ts";

export { BASELINE_BODY_BYTES };

export const BASELINE_MAX_BOTS = 200;

export type BotPosition = {
  readonly incarnation: string;
  readonly generation: {
    readonly min: string | null;
    readonly max: string | null;
    readonly count: number;
  };
  readonly state: string;
  readonly activity: string;
};

export type Baseline = {
  readonly id: string;
  readonly epoch: string;
  readonly catalog: string;
  readonly positions: Readonly<Record<string, BotPosition>>;
};

export type BaselineRejection = "cursor_invalid" | "cursor_reset";

export class BaselineError extends Error {
  readonly reason: BaselineRejection;

  constructor(reason: BaselineRejection) {
    super(reason);
    this.name = "BaselineError";
    this.reason = reason;
  }
}

const decodeBase64Url = (token: string): unknown => {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new BaselineError("cursor_invalid");
  let text: string;
  try {
    text = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new BaselineError("cursor_invalid");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BaselineError("cursor_invalid");
  }
};

const isPosition = (value: unknown): value is BotPosition => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<BotPosition>;
  if (typeof candidate.incarnation !== "string") return false;
  if (typeof candidate.state !== "string" || typeof candidate.activity !== "string") return false;
  const generation = candidate.generation;
  if (generation === null || typeof generation !== "object") return false;
  return (
    typeof generation.count === "number" &&
    (generation.min === null || typeof generation.min === "string") &&
    (generation.max === null || typeof generation.max === "string")
  );
};

export type Binding = {
  readonly source?: string;
  readonly epoch?: string;
  readonly operation?: string;
};

/** Decodes and validates a baseline; `binding` says which request presented it. */
export const decodeBaseline = (token: string, binding: Binding = {}): Baseline => {
  const value = decodeBase64Url(token);
  if (value === null || typeof value !== "object") throw new BaselineError("cursor_invalid");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "c,e,k,p,s,v") throw new BaselineError("cursor_invalid");
  if (candidate.v !== 1 || candidate.k !== "changes") throw new BaselineError("cursor_invalid");
  if (typeof candidate.s !== "string" || typeof candidate.e !== "string") {
    throw new BaselineError("cursor_invalid");
  }
  if (typeof candidate.c !== "string") throw new BaselineError("cursor_invalid");
  if (candidate.p === null || typeof candidate.p !== "object") {
    throw new BaselineError("cursor_invalid");
  }
  if (binding.operation !== undefined && binding.operation !== "changes") {
    throw new BaselineError("cursor_invalid");
  }
  if (binding.source !== undefined && binding.source !== candidate.s) {
    throw new BaselineError("cursor_invalid");
  }
  if (binding.epoch !== undefined && binding.epoch !== candidate.e) {
    throw new BaselineError("cursor_reset");
  }
  const entries = Object.entries(candidate.p as Record<string, unknown>);
  if (entries.length > BASELINE_MAX_BOTS) throw new BaselineError("cursor_invalid");
  const positions: Record<string, BotPosition> = {};
  for (const [botId, position] of entries) {
    if (!isPosition(position)) throw new BaselineError("cursor_invalid");
    positions[botId] = position;
  }
  return { id: candidate.s, epoch: candidate.e, catalog: candidate.c, positions };
};

export const encodeBaseline = (baseline: Baseline): string => {
  const payload = {
    v: 1,
    k: "changes",
    s: baseline.id,
    e: baseline.epoch,
    c: baseline.catalog,
    p: baseline.positions,
  };
  const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (Buffer.byteLength(JSON.stringify({ cursor: token, limit: 100 })) > BASELINE_BODY_BYTES) {
    throw new BaselineError("cursor_invalid");
  }
  return token;
};
