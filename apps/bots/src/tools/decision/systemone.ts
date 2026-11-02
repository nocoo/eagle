// The System One transport a decision provider is asked for (docs/bots/PROTOCOL.md, "Providers"):
// one POST of a documented request, one validated reply. The settings probe and every tool call
// go through here, so a relay that answers something else is refused in one place.
import { ADDRESS_REFUSED, decisionRoot } from "./address.ts";
import type { DecisionAnswer, DecisionEntry, DecisionReply, DecisionRequest } from "./client.ts";

export { decisionRoot };

/** Falcon's own deadline is 30 s; this leaves room for it to answer rather than race it. */
export const DECISION_TEST_TIMEOUT_MS = 20_000;

const SYSTEMONE_PATH = "/v1/systemone";
/** The documented rounding tolerance for a probability distribution. */
const DISTRIBUTION_TOLERANCE = 0.02;

export type DecisionTarget = {
  readonly baseUrl: string;
  readonly model: string;
  /** Empty is allowed: a relay may carry its own upstream credential. */
  readonly apiKey: string;
};

export type DecisionFailureReason = "address" | "auth" | "status" | "network" | "timeout" | "shape";

/** Why a judgment could not be made, in words a person and a bot can both read. */
export class DecisionFailure extends Error {
  readonly reason: DecisionFailureReason;
  readonly status?: number;

  constructor(reason: DecisionFailureReason, message: string, status?: number) {
    super(message);
    this.name = "DecisionFailure";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

export type SystemOneOptions = {
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const sumsToOne = (values: readonly number[]): boolean =>
  Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= DISTRIBUTION_TOLERANCE;

function shapeRefused(): never {
  throw new DecisionFailure("shape", "返回内容不是 System One 决策");
}

const readChoice = (
  answer: Record<string, unknown>,
  criteria: Readonly<Record<string, DecisionEntry>>,
): DecisionAnswer => {
  const choice = answer.choice;
  // Own keys only: a prototype name such as `toString` is not one of the criteria.
  if (typeof choice !== "string" || !Object.hasOwn(criteria, choice)) shapeRefused();
  if (!isObject(answer.probabilities)) shapeRefused();
  const keys = Object.keys(answer.probabilities).sort();
  if (keys.join(",") !== Object.keys(criteria).sort().join(",")) shapeRefused();
  const values = Object.values(answer.probabilities);
  if (!values.every(isProbability)) shapeRefused();
  if (!sumsToOne(values as number[])) shapeRefused();
  if (answer.confidence !== undefined && !isProbability(answer.confidence)) shapeRefused();
  return {
    type: "choice",
    choice,
    probabilities: answer.probabilities as Record<string, number>,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence as number }),
  };
};

const readNoul = (answer: Record<string, unknown>): DecisionAnswer => {
  if (!isProbability(answer.noul)) shapeRefused();
  return { type: "noul", noul: answer.noul };
};

const readScore = (
  answer: Record<string, unknown>,
  criteria: readonly DecisionEntry[],
): DecisionAnswer => {
  const score = answer.score;
  if (typeof score !== "number" || !Number.isFinite(score)) shapeRefused();
  if (score < 0 || score > criteria.length - 1) shapeRefused();
  const legend = answer.legend;
  if (!Array.isArray(legend) || legend.length !== criteria.length) shapeRefused();
  if (!legend.every((entry) => typeof entry === "string")) shapeRefused();
  const probabilities = answer.probabilities;
  if (!Array.isArray(probabilities) || probabilities.length !== criteria.length) shapeRefused();
  if (!probabilities.every(isProbability)) shapeRefused();
  if (!sumsToOne(probabilities as number[])) shapeRefused();
  if (answer.confidence !== undefined && !isProbability(answer.confidence)) shapeRefused();
  return {
    type: "score",
    score,
    legend: legend as string[],
    probabilities: probabilities as number[],
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence as number }),
  };
};

const readTokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * A usable reply: every requested question answered under its own id, of the requested type, and
 * a value constrained to the options that were supplied. Anything else is a relay that is not
 * speaking System One, which is the failure worth reporting instead of a green check.
 */
const readReply = (body: unknown, questions: DecisionRequest["questions"]): DecisionReply => {
  if (!isObject(body) || !isObject(body.answers)) shapeRefused();
  const answered = Object.keys(body.answers);
  const asked = Object.keys(questions);
  if (answered.length !== asked.length || answered.some((id) => !Object.hasOwn(questions, id))) {
    shapeRefused();
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id];
    if (!isObject(answer) || answer.type !== question.type) shapeRefused();
    answers[id] =
      question.type === "choice"
        ? readChoice(answer, question.criteria)
        : question.type === "noul"
          ? readNoul(answer)
          : readScore(answer, question.criteria);
  }
  const usage = isObject(body.usage) ? body.usage : undefined;
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
  const inputTokens = readTokens(usage?.input_tokens);
  const outputTokens = readTokens(usage?.output_tokens);
  return {
    answers,
    ...(model === undefined ? {} : { model }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
};

/**
 * One judgment request. It never retries: an answer may already have been paid for, so a failed
 * call is reported to the caller with the innermost reason.
 */
export const systemOne = async (
  target: DecisionTarget,
  request: DecisionRequest,
  options: SystemOneOptions = {},
): Promise<DecisionReply> => {
  const root = decisionRoot(target.baseUrl);
  if (root === undefined) throw new DecisionFailure("address", ADDRESS_REFUSED);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DECISION_TEST_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const request_ = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request_(`${root}${SYSTEMONE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(target.apiKey.trim().length === 0
          ? {}
          : { authorization: `Bearer ${target.apiKey.trim()}` }),
      },
      body: JSON.stringify({
        model: target.model,
        state: request.state,
        questions: request.questions,
      }),
      signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    if (aborted && options.signal?.aborted === true) {
      throw new DecisionFailure("timeout", "请求已取消");
    }
    throw new DecisionFailure(
      aborted ? "timeout" : "network",
      aborted ? "连接超时" : "无法连接服务",
    );
  }
  if (!response.ok) {
    const refused = response.status === 401 || response.status === 403;
    throw new DecisionFailure(
      refused ? "auth" : "status",
      refused ? "服务拒绝了 API Key" : `服务返回 ${response.status}`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  return readReply(body, request.questions);
};

const PROBE_STATE = "Eagle 的连接测试：一个很小的改动还没有跑测试。";
const PROBE_CRITERIA = {
  test: "Run the focused tests before merging.",
  merge: "Merge without testing.",
} as const;

export type DecisionProbe = {
  readonly ok: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly model?: string;
  readonly resolvedModel?: string;
};

/**
 * Probes one decision provider with a real, minimal choice. It spends one decision, which is the
 * point: a relay that answers `/v1/models` from a cache still has to reach a model to answer this.
 */
export const probeDecision = async (
  target: DecisionTarget,
  options: SystemOneOptions = {},
): Promise<DecisionProbe> => {
  const started = performance.now();
  try {
    const reply = await systemOne(
      target,
      {
        state: PROBE_STATE,
        questions: {
          next_step: {
            type: "choice",
            instructions: "Choose the next step.",
            criteria: PROBE_CRITERIA,
          },
        },
      },
      options,
    );
    const answer = reply.answers.next_step;
    if (answer?.type !== "choice")
      throw new DecisionFailure("shape", "返回内容不是 System One 决策");
    const probability = ` ${answer.probabilities[answer.choice]?.toFixed(2) ?? ""}`;
    const resolved = reply.model;
    return {
      ok: true,
      message:
        resolved === undefined
          ? `连接成功 · ${answer.choice}${probability}`
          : `连接成功 · ${resolved} · ${answer.choice}${probability}`,
      latencyMs: Math.round(performance.now() - started),
      model: target.model,
      ...(resolved === undefined ? {} : { resolvedModel: resolved }),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "无法连接服务",
      latencyMs: Math.round(performance.now() - started),
    };
  }
};
