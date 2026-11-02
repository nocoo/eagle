// Typed judgments as bot tools (docs/bots/EXTENSIONS-AND-TOOLS.md, "decision"): every tool is one
// System One request, the tools are deferred so a bot that never decides never carries them, and
// each performed call is booked in the usage statistics.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { UsageMeter } from "../usage.ts";
import type {
  DecisionAnswer,
  DecisionClient,
  DecisionEntry,
  DecisionQuestion,
  DecisionReply,
} from "./client.ts";

export const DECISION_TOOLS_EXTENSION = "bots-decision";

/** A state larger than this cannot fit the model's per-question context anyway. */
export const MAX_STATE_CHARS = 20_000;
export const MAX_OPTIONS = 255;
export const MAX_LABELS = 64;
export const MAX_LEVELS = 20;
export const MAX_JUDGE_QUESTIONS = 32;
export const MAX_INSTRUCTIONS_CHARS = 2_000;
export const MAX_CRITERION_CHARS = 400;
/** TypeSafe's own starting confidence floor: below this the model is telling you it is unsure. */
export const LOW_CONFIDENCE = 0.5;
export const NOUL_UNSURE_LOW = 0.3;
export const NOUL_UNSURE_HIGH = 0.7;
/** The documented starting point for a yes/no label in a multi-label classification. */
export const DEFAULT_CLASSIFY_THRESHOLD = 0.7;

const QUESTION_ID = "next_step";
/** A name the criteria map would not hold as an own key, or would shadow. */
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
/** A conservative bound on the bytes an answer costs in the tool result: 4 bytes per character
 *  plus punctuation, so an answer the harness would clip is refused before it is paid for. */
const ANSWER_HEADROOM = 12 * 1024;

export type DecisionToolOptions = {
  readonly client: DecisionClient;
  readonly botId: string;
  /** Where a performed judgment is counted; absent in a test build. */
  readonly meter?: UsageMeter;
};

type QuestionInput = {
  readonly id: string;
  readonly type: "choice" | "noul" | "score";
  readonly instructions: unknown;
  readonly criteria?: unknown;
};

const stateParameter = () =>
  Type.Union(
    [
      Type.String({ maxLength: MAX_STATE_CHARS }),
      Type.Object({}, { additionalProperties: true }),
      Type.Array(Type.Any()),
    ],
    {
      description:
        "What the model judges: text, a JSON object or an array. A structure lets a question name one field by path, like `ticket.messages[0].text`.",
    },
  );

const questionParameter = (description: string) =>
  Type.String({ minLength: 1, maxLength: MAX_INSTRUCTIONS_CHARS, description });

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

/** What a tool reports beside its text: JSON values only, so the transcript can store it. */
type DecisionToolDetails = Record<string, string | number | string[]>;

/** Only what actually happened: a missing token count is left out rather than sent as zero. */
const detailsOf = (
  reply_: DecisionReply,
  extra: DecisionToolDetails = {},
): DecisionToolDetails => ({
  ...(reply_.model === undefined ? {} : { model: reply_.model }),
  ...(reply_.inputTokens === undefined ? {} : { inputTokens: reply_.inputTokens }),
  ...extra,
});

const reply = (text: string, details: DecisionToolDetails) => ({
  output: [{ type: "text" as const, text }],
  details,
});

const failure = (message: string) => ({
  output: [{ type: "text" as const, text: `决策失败：${message}` }],
  isError: true,
  details: {} as DecisionToolDetails,
});

const refusal = (message: string) => ({
  output: [{ type: "text" as const, text: message }],
  isError: true,
  details: {} as DecisionToolDetails,
});

/** A state that is neither text nor a structure cannot be judged, and must not cost a call. */
const readState = (value: unknown): DecisionEntry | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_STATE_CHARS) return undefined;
    return value;
  }
  if (typeof value === "object" && value !== null) return value as DecisionEntry;
  return undefined;
};

/** A question the model can answer: not blank, and not something the criteria map cannot hold. */
const readQuestion = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length === 0 ? undefined : text;
};

/** What TypeSafe accepts where text goes: a string, JSON, or null. Not a number, not a boolean. */
const isEntry = (value: unknown): boolean =>
  typeof value === "string" ||
  value === null ||
  (typeof value === "object" && !Array.isArray(value)) ||
  Array.isArray(value);

/** Every label must be its own key in the criteria map, so a reserved name is refused. */
const reservedLabel = (labels: readonly string[]): string | undefined =>
  labels.find((label) => RESERVED_NAMES.has(label.trim()));

/**
 * Would the answer fit the text this tool can return? A label costs its own characters twice
 * (key and probability) plus punctuation, so a legal but huge request is refused here instead
 * of arriving as a clipped JSON line the model cannot parse.
 */
const answerFits = (labels: readonly string[]): boolean => {
  const characters = labels.reduce((total, label) => total + label.length + 24, 0);
  return characters * 4 <= ANSWER_HEADROOM;
};

const readLabels = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const labels = value.map((label) => (typeof label === "string" ? label.trim() : ""));
  if (labels.length < 2 || labels.length > MAX_LABELS) return undefined;
  if (labels.some((label) => label.length === 0)) return undefined;
  if (new Set(labels).size !== labels.length) return undefined;
  return labels;
};

const readLevels = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const levels = value.map((level) => (typeof level === "string" ? level.trim() : ""));
  if (levels.length < 2 || levels.length > MAX_LEVELS) return undefined;
  if (levels.some((level) => level.length === 0)) return undefined;
  return levels;
};

/** The reply's own words: one JSON value per answer, so a number is never rounded into prose. */
const answerJSON = (answer: DecisionAnswer): string => JSON.stringify(answer);

const unsureNote = (answer: DecisionAnswer): string | undefined => {
  if (answer.type === "noul") {
    return answer.noul > NOUL_UNSURE_LOW && answer.noul < NOUL_UNSURE_HIGH
      ? `不确定（${answer.noul.toFixed(2)}）：0.5 附近表示模型判断不了 yes/no，不要当成 yes。`
      : undefined;
  }
  if (answer.confidence !== undefined && answer.confidence < LOW_CONFIDENCE) {
    return `低置信度 ${answer.confidence.toFixed(2)}：不要据此直接执行有副作用的动作；必要时用 ask_user 确认或补充证据。`;
  }
  return undefined;
};

const compose = (lines: readonly (string | undefined)[]): string =>
  lines.filter((line): line is string => line !== undefined && line.length > 0).join("\n");

const readJudgeQuestions = (
  value: unknown,
): Readonly<Record<string, DecisionQuestion>> | string => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_JUDGE_QUESTIONS) {
    return `questions 需要 1-${MAX_JUDGE_QUESTIONS} 道题。`;
  }
  const questions: [string, DecisionQuestion][] = [];
  const budget: string[] = [];
  const seen = new Set<string>();
  for (const entry of value as readonly QuestionInput[]) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (id.length === 0 || id.length > 64) return "每道题需要一个 1-64 字符的 id。";
    if (RESERVED_NAMES.has(id)) return `题号 ${id} 是保留名，请换一个。`;
    if (seen.has(id)) return `题号 ${id} 重复了。`;
    seen.add(id);
    if (entry.type !== "choice" && entry.type !== "noul" && entry.type !== "score") {
      return `题 ${id} 的 type 只能是 choice、noul 或 score。`;
    }
    if (entry.instructions === undefined || textOf(entry.instructions).trim().length === 0) {
      return `题 ${id} 缺少 instructions。`;
    }
    if (entry.type === "choice") {
      const criteria = entry.criteria;
      if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        return `题 ${id} 是 choice，criteria 需要是 选项→描述 的对象。`;
      }
      const labels = Object.keys(criteria);
      if (labels.length < 2 || labels.length > MAX_OPTIONS) {
        return `题 ${id} 需要 2-${MAX_OPTIONS} 个选项。`;
      }
      if (labels.some((label) => RESERVED_NAMES.has(label))) {
        return `题 ${id} 的选项名里有保留名。`;
      }
      if (!Object.values(criteria).every(isEntry)) {
        return `题 ${id} 的选项描述只能是文本、JSON 或 null。`;
      }
      for (const label of labels) budget.push(label);
      questions.push([
        id,
        {
          type: "choice",
          instructions: entry.instructions as DecisionEntry,
          criteria: criteria as Readonly<Record<string, DecisionEntry>>,
        },
      ]);
      continue;
    }
    if (entry.type === "score") {
      const criteria = entry.criteria;
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > MAX_LEVELS) {
        return `题 ${id} 是 score，criteria 需要是 2-${MAX_LEVELS} 个等级的数组。`;
      }
      if (!criteria.every(isEntry)) {
        return `题 ${id} 的等级描述只能是文本、JSON 或 null。`;
      }
      for (const level of criteria) budget.push(typeof level === "string" ? level : "");
      questions.push([
        id,
        {
          type: "score",
          instructions: entry.instructions as DecisionEntry,
          criteria: criteria as readonly DecisionEntry[],
        },
      ]);
      continue;
    }
    const criteria = entry.criteria;
    if (criteria !== undefined) {
      if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        return `题 ${id} 是 noul，criteria 需要是 {true, false} 的对象或省略。`;
      }
      if (!Object.values(criteria).every(isEntry)) {
        return `题 ${id} 的 criteria 只能是文本、JSON 或 null。`;
      }
      if (Object.keys(criteria).some((key) => !["true", "false"].includes(key))) {
        return `题 ${id} 的 noul criteria 只认 true 与 false。`;
      }
    }
    questions.push([
      id,
      {
        type: "noul",
        instructions: entry.instructions as DecisionEntry,
        ...(criteria === undefined
          ? {}
          : { criteria: criteria as { true?: DecisionEntry; false?: DecisionEntry } }),
      },
    ]);
  }
  if (!answerFits(budget)) {
    return "答案会超过工具输出上限，请减少题目、选项或缩短文字。";
  }
  return Object.fromEntries(questions);
};

export const createDecisionTools = (options: DecisionToolOptions) => {
  /** One request, one booking: every tool ends here. */
  const ask = async (
    state: DecisionEntry,
    questions: Readonly<Record<string, DecisionQuestion>>,
    context: { readonly abortSignal?: AbortSignal | undefined },
  ) => {
    try {
      const reply_ = await options.client.ask({ state, questions }, context.abortSignal);
      // Jev bills input only and a relay's price is unknown, so nothing is invented; a call
      // without a usable token count is still one call, not an invisible one.
      try {
        options.meter?.record(
          reply_.inputTokens === undefined || reply_.inputTokens === 0
            ? { botId: options.botId, source: "decision", calls: 1 }
            : {
                botId: options.botId,
                source: "decision",
                tokens: reply_.inputTokens,
                costUsd: 0,
              },
        );
      } catch {
        // The statistics are a side channel: a failed booking must not discard a paid answer.
      }
      return reply_;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  return [
    defineTool({
      name: "decide",
      description:
        "Ask which of several options fits a state, and get the option plus the full probability distribution and a confidence. Use it for one routing or selection judgment; to ask several things about the same state, use judge instead of calling this repeatedly.",
      parameters: Type.Object({
        state: stateParameter(),
        question: questionParameter("One atomic judgment, phrased as a question about the state."),
        options: Type.Array(
          Type.Object({
            label: Type.String({ minLength: 1, maxLength: 80 }),
            description: Type.Optional(
              Type.String({
                maxLength: MAX_CRITERION_CHARS,
                description: "What this option covers, so the options are distinguishable.",
              }),
            ),
          }),
          { minItems: 2, maxItems: MAX_OPTIONS },
        ),
        allowNone: Type.Optional(
          Type.Boolean({
            description:
              "Also offer a `none` option, for a label set that may not cover the input.",
          }),
        ),
      }),
      replay: "unsafe",
      deferred: true,
      outputLimits: { maxBytes: 16 * 1024, maxLines: 2_000, retain: "head" },
      execute: async (args, _api, context) => {
        const state = readState(args.state);
        if (state === undefined) return refusal("state 需要是非空文本或一个 JSON 结构。");
        const question = readQuestion(args.question);
        if (question === undefined) return refusal("question 不能为空。");
        const options_ = args.options ?? [];
        const labels = options_.map((option) => option.label.trim());
        if (labels.length < 2 || labels.length > MAX_OPTIONS) {
          return refusal(`options 需要 2-${MAX_OPTIONS} 个。`);
        }
        if (labels.some((label) => label.length === 0) || new Set(labels).size !== labels.length) {
          return refusal("options 的 label 不能为空或重复。");
        }
        const reserved = reservedLabel(labels);
        if (reserved !== undefined) return refusal(`label ${reserved} 是保留名，请换一个。`);
        if (args.allowNone === true && labels.includes("none")) {
          return refusal("label 里已经有 none，不要再开 allowNone。");
        }
        if (!answerFits(labels)) {
          return refusal("答案会超过工具输出上限，请减少选项或缩短 label。");
        }
        const criteria: Record<string, string> = {};
        for (const option of options_) {
          criteria[option.label.trim()] = option.description?.trim() ?? option.label.trim();
        }
        if (args.allowNone === true) criteria.none = "The state does not fit any of the options.";
        try {
          const reply_ = await ask(
            state,
            {
              [QUESTION_ID]: {
                type: "choice",
                instructions: question,
                criteria,
              },
            },
            context,
          );
          const answer = reply_.answers[QUESTION_ID] as DecisionAnswer;
          return reply(
            compose([answerJSON(answer), reply_.model, unsureNote(answer)]),
            detailsOf(reply_),
          );
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineTool({
      name: "classify",
      description:
        "Assign a state to one of a label set. mode single picks one label with probabilities; mode multi scores every label independently in one request and keeps those above threshold. Use it for categories; use assess for a single yes/no.",
      parameters: Type.Object({
        state: stateParameter(),
        labels: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
          minItems: 2,
          maxItems: MAX_LABELS,
          description: "The candidate categories, at most 64.",
        }),
        mode: Type.Optional(
          Type.Union([Type.Literal("single"), Type.Literal("multi")], {
            description: "single: the state is exactly one of them (default). multi: any subset.",
          }),
        ),
        allowNone: Type.Optional(
          Type.Boolean({
            description: "single only: also offer a `none` label for an uncovered input.",
          }),
        ),
        threshold: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 1,
            description: `multi only: keep labels at or above this probability (default ${DEFAULT_CLASSIFY_THRESHOLD}).`,
          }),
        ),
      }),
      replay: "unsafe",
      deferred: true,
      outputLimits: { maxBytes: 16 * 1024, maxLines: 2_000, retain: "head" },
      execute: async (args, _api, context) => {
        const state = readState(args.state);
        if (state === undefined) return refusal("state 需要是非空文本或一个 JSON 结构。");
        const labels = readLabels(args.labels);
        if (labels === undefined)
          return refusal(`labels 需要 2-${MAX_LABELS} 个不重复的非空标签。`);
        const reserved = reservedLabel(labels);
        if (reserved !== undefined) return refusal(`label ${reserved} 是保留名，请换一个。`);
        const mode = args.mode ?? "single";
        if (args.allowNone === true && mode === "single" && labels.includes("none")) {
          return refusal("labels 里已经有 none，不要再开 allowNone。");
        }
        if (!answerFits(labels)) {
          return refusal("答案会超过工具输出上限，请减少标签或缩短 label。");
        }
        try {
          if (mode === "single") {
            const criteria: Record<string, string> = {};
            for (const label of labels) criteria[label] = `The state belongs to "${label}".`;
            if (args.allowNone === true) {
              criteria.none = "The state does not fit any of the labels.";
            }
            const reply_ = await ask(
              state,
              {
                [QUESTION_ID]: {
                  type: "choice",
                  instructions: "Which label fits the state?",
                  criteria,
                },
              },
              context,
            );
            const answer = reply_.answers[QUESTION_ID] as DecisionAnswer;
            return reply(
              compose([answerJSON(answer), reply_.model, unsureNote(answer)]),
              detailsOf(reply_),
            );
          }
          const questions: Record<string, DecisionQuestion> = {};
          for (const [index, label] of labels.entries()) {
            questions[`label_${index}`] = {
              type: "noul",
              instructions: `Does the state belong to the category "${label}"?`,
            };
          }
          const reply_ = await ask(state, questions, context);
          const threshold = args.threshold ?? DEFAULT_CLASSIFY_THRESHOLD;
          const scored = labels.map((label, index) => {
            const answer = reply_.answers[`label_${index}`] as DecisionAnswer;
            return { label, probability: answer.type === "noul" ? answer.noul : 0 };
          });
          const ranked = [...scored].sort((left, right) => right.probability - left.probability);
          const kept = ranked.filter((entry) => entry.probability >= threshold);
          return reply(
            compose([
              JSON.stringify(scored),
              kept.length === 0
                ? `没有标签达到阈值 ${threshold}：按标签集不覆盖输入处理。`
                : `阈值 ${threshold}：${kept.map((entry) => entry.label).join(", ")}`,
              reply_.model,
            ]),
            detailsOf(reply_, { labels: kept.map((entry) => entry.label) }),
          );
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineTool({
      name: "assess",
      description:
        "Ask for the probability that one clear yes/no statement is true. Use it for gates and triage: a value near 1 is a strong yes, near 0 a strong no, near 0.5 means the model cannot tell. It returns a probability, not a boolean.",
      parameters: Type.Object({
        state: stateParameter(),
        statement: questionParameter(
          "A statement to judge, with any condition pinned down explicitly; do not ask for a level here.",
        ),
      }),
      replay: "unsafe",
      deferred: true,
      outputLimits: { maxBytes: 16 * 1024, maxLines: 2_000, retain: "head" },
      execute: async (args, _api, context) => {
        const state = readState(args.state);
        if (state === undefined) return refusal("state 需要是非空文本或一个 JSON 结构。");
        const statement = args.statement.trim();
        if (statement.length === 0) return refusal("statement 不能为空。");
        try {
          const reply_ = await ask(
            state,
            { [QUESTION_ID]: { type: "noul", instructions: statement } },
            context,
          );
          const answer = reply_.answers[QUESTION_ID] as DecisionAnswer;
          return reply(
            compose([answerJSON(answer), reply_.model, unsureNote(answer)]),
            detailsOf(reply_),
          );
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineTool({
      name: "rate",
      description:
        "Place a state on an ordered scale you define and get the position, the probabilities and a confidence. The score may fall between two levels; read the legend to know what each number means.",
      parameters: Type.Object({
        state: stateParameter(),
        question: questionParameter("What is being rated, as one question about the state."),
        levels: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CRITERION_CHARS }), {
          minItems: 2,
          maxItems: MAX_LEVELS,
          description: "Ordered from lowest to highest, 2-20 levels, each described concretely.",
        }),
      }),
      replay: "unsafe",
      deferred: true,
      outputLimits: { maxBytes: 16 * 1024, maxLines: 2_000, retain: "head" },
      execute: async (args, _api, context) => {
        const state = readState(args.state);
        if (state === undefined) return refusal("state 需要是非空文本或一个 JSON 结构。");
        const question = readQuestion(args.question);
        if (question === undefined) return refusal("question 不能为空。");
        const levels = readLevels(args.levels);
        if (levels === undefined) return refusal(`levels 需要 2-${MAX_LEVELS} 个非空等级。`);
        if (!answerFits(levels)) {
          return refusal("答案会超过工具输出上限，请减少等级或缩短描述。");
        }
        try {
          const reply_ = await ask(
            state,
            {
              [QUESTION_ID]: {
                type: "score",
                instructions: question,
                criteria: levels,
              },
            },
            context,
          );
          const answer = reply_.answers[QUESTION_ID] as DecisionAnswer;
          return reply(
            compose([answerJSON(answer), reply_.model, unsureNote(answer)]),
            detailsOf(reply_),
          );
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    defineTool({
      name: "judge",
      description:
        "Ask several typed questions about one state in a single request. All questions see the same state and run in parallel, so this costs barely more latency than one: prefer it over repeated decide/assess/rate calls. Questions may mix choice, noul and score.",
      parameters: Type.Object({
        state: stateParameter(),
        questions: Type.Array(
          Type.Object({
            id: Type.String({
              minLength: 1,
              maxLength: 64,
              description: "The key this answer comes back under, chosen by you.",
            }),
            type: Type.Union(
              [Type.Literal("choice"), Type.Literal("noul"), Type.Literal("score")],
              { description: "choice: one of criteria. noul: yes/no probability. score: a level." },
            ),
            instructions: Type.String({
              minLength: 1,
              maxLength: MAX_INSTRUCTIONS_CHARS,
              description: "One atomic judgment about the state.",
            }),
            criteria: Type.Optional(
              Type.Any({
                description:
                  "choice: an object of option → description. score: an ordered array of 2-20 levels. noul: optional {true, false} descriptions.",
              }),
            ),
          }),
          { minItems: 1, maxItems: MAX_JUDGE_QUESTIONS },
        ),
      }),
      replay: "unsafe",
      deferred: true,
      outputLimits: { maxBytes: 32 * 1024, maxLines: 4_000, retain: "head" },
      execute: async (args, _api, context) => {
        const state = readState(args.state);
        if (state === undefined) return refusal("state 需要是非空文本或一个 JSON 结构。");
        const questions = readJudgeQuestions(args.questions);
        if (typeof questions === "string") return refusal(questions);
        try {
          const reply_ = await ask(state, questions, context);
          const notes = Object.values(reply_.answers)
            .map(unsureNote)
            .filter((note): note is string => note !== undefined);
          return reply(
            compose([JSON.stringify(reply_.answers), reply_.model, ...notes]),
            detailsOf(reply_),
          );
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
};

export const decisionSection = (): string =>
  [
    "You can ask a System One decision model for typed, calibrated judgments: decide for one choice, classify for a label set, assess for a yes/no probability, rate for a position on a scale, and judge for several questions about one state.",
    'None is loaded yet: call tool_search with a query like "decision" to enable them.',
    "Prefer judge over several decide calls: questions in one request see the same state, run in parallel, and barely add latency. Ask one atomic judgment per question and pin the wording down; combine the answers in your own logic instead of asking for a compound judgment.",
    "Every answer is a value from the options you supplied plus the probability distribution, never generated text. Below confidence 0.5 (or a noul between 0.3 and 0.7) the model is unsure: do not take a side-effecting action on that answer without confirming with the person.",
  ].join("\n");

export const decisionExtension = (options: DecisionToolOptions) =>
  defineExtension({
    name: DECISION_TOOLS_EXTENSION,
    tools: createDecisionTools(options),
    sections: [section("bots-decision", () => decisionSection())],
  });
