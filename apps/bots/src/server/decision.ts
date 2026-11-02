// One real System One call, as the probe a person runs from the 服务 page (docs/bots/PROTOCOL.md,
// "Providers"). A model listing cannot prove a decision provider: a relay answers it from its own
// cache, and the relays disagree on model names, keys and addresses. A single tiny choice question
// proves the address, the credential, the model name and the answer shape at once.
import { normalizeBaseUrl } from "./gateway.ts";
import type { ProviderProbe } from "./providers.ts";

/** Falcon's own deadline is 30 s; this leaves room for it to answer rather than race it. */
export const DECISION_TEST_TIMEOUT_MS = 20_000;

const SYSTEMONE_PATH = "/v1/systemone";

/**
 * The API root of a System One endpoint. A person may paste the address they use for the model
 * gateway (`…/v1`) or the full endpoint; both collapse to the root, and the result is idempotent
 * because the path is appended again rather than kept.
 */
export const decisionRoot = (value: string): string | undefined => {
  const normalized = normalizeBaseUrl(value);
  if (normalized === undefined) return undefined;
  return normalized.replace(/\/v1\/systemone$/, "").replace(/\/v1$/, "");
};

export type DecisionTarget = {
  readonly baseUrl: string;
  readonly model: string;
  /** Empty is allowed: a relay may carry its own upstream credential. */
  readonly apiKey: string;
};

const STATE = "Eagle 的连接测试：一个很小的改动还没有跑测试。";
const CRITERIA = {
  test: "Run the focused tests before merging.",
  merge: "Merge without testing.",
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * A usable answer: the question came back as a choice, its winner is one of the criteria and the
 * probabilities are a distribution over exactly those criteria. Anything else is a relay that is
 * not speaking System One, which is the failure worth reporting instead of a green check.
 */
const readAnswer = (
  body: unknown,
):
  | { readonly resolvedModel?: string; readonly choice: string; readonly probability?: number }
  | undefined => {
  if (!isObject(body)) return undefined;
  const answers = body.answers;
  if (!isObject(answers)) return undefined;
  const answer = answers.next_step;
  if (!isObject(answer)) return undefined;
  if (answer.type !== undefined && answer.type !== "choice") return undefined;
  const choice = answer.choice;
  if (typeof choice !== "string" || !(choice in CRITERIA)) return undefined;
  let probability: number | undefined;
  if (answer.probabilities !== undefined) {
    if (!isObject(answer.probabilities)) return undefined;
    const keys = Object.keys(answer.probabilities).sort();
    if (keys.join(",") !== Object.keys(CRITERIA).sort().join(",")) return undefined;
    if (!Object.values(answer.probabilities).every(isProbability)) return undefined;
    const winner = answer.probabilities[choice];
    probability = typeof winner === "number" ? winner : undefined;
  }
  const model = body.model;
  return {
    ...(typeof model === "string" && model.length > 0 ? { resolvedModel: model } : {}),
    choice,
    ...(probability === undefined ? {} : { probability }),
  };
};

/**
 * Probes one decision provider. It spends one decision, which is the point: a relay that answers
 * `/v1/models` from a cache still has to reach a model to answer this.
 */
export const probeDecision = async (
  target: DecisionTarget,
  options: { readonly timeoutMs?: number; readonly fetch?: typeof fetch } = {},
): Promise<ProviderProbe> => {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const request = options.fetch ?? fetch;
  const root = decisionRoot(target.baseUrl);
  if (root === undefined) {
    return { ok: false, message: "地址必须是 http 或 https 开头的 URL", latencyMs: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DECISION_TEST_TIMEOUT_MS);
  try {
    const response = await request(`${root}${SYSTEMONE_PATH}`, {
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
        state: STATE,
        questions: {
          next_step: { type: "choice", instructions: "Choose the next step.", criteria: CRITERIA },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        message:
          response.status === 401 || response.status === 403
            ? "服务拒绝了 API Key"
            : `服务返回 ${response.status}`,
        latencyMs: elapsed(),
      };
    }
    const body: unknown = await response.json().catch(() => undefined);
    const answer = readAnswer(body);
    if (answer === undefined) {
      return { ok: false, message: "返回内容不是 System One 决策", latencyMs: elapsed() };
    }
    const resolved = answer.resolvedModel ?? target.model;
    const probability = answer.probability === undefined ? "" : ` ${answer.probability.toFixed(2)}`;
    return {
      ok: true,
      message: `连接成功 · ${resolved} · ${answer.choice}${probability}`,
      latencyMs: elapsed(),
      model: target.model,
      resolvedModel: resolved,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      message: aborted ? "连接超时" : "无法连接服务",
      latencyMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
};
