// The decision tools (docs/bots/EXTENSIONS-AND-TOOLS.md, "decision"): one System One request per
// call, typed answers the model can act on, and every judgment booked in the usage statistics.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  DecisionAnswer,
  DecisionClient,
  DecisionRequest,
} from "../../src/tools/decision/client.ts";
import { DecisionFailure } from "../../src/tools/decision/systemone.ts";
import {
  createDecisionTools,
  DECISION_TOOLS_EXTENSION,
  decisionSection,
  MAX_JUDGE_QUESTIONS,
} from "../../src/tools/decision/tools.ts";
import type { UsageEntry } from "../../src/tools/usage.ts";

const choiceAnswer = (
  probabilities: Record<string, number> = { merge: 0.4, test: 0.6 },
  choice = "test",
): DecisionAnswer => ({
  type: "choice",
  choice,
  probabilities,
  confidence: 0.2,
});

const fixture = (reply: (request: DecisionRequest) => DecisionAnswer | DecisionAnswer[]) => {
  const requests: DecisionRequest[] = [];
  const bookings: UsageEntry[] = [];
  const client: DecisionClient = {
    async ask(request) {
      requests.push(request);
      const answer = reply(request);
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((id, index) => [
          id,
          Array.isArray(answer) ? (answer[index] as DecisionAnswer) : answer,
        ]),
      );
      return { answers, model: "jev-1.14.0", inputTokens: 319, outputTokens: 31 };
    },
  };
  const tools = createDecisionTools({
    client,
    botId: "b_1",
    meter: { record: (entry) => bookings.push(entry) },
  });
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, `no ${name} tool`);
    return found;
  };
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await tool(name).execute(args as never, {} as never, {} as never);
    const text = ((result.output?.[0] ?? {}) as { text?: string }).text ?? "";
    return { result, text };
  };
  return { requests, bookings, tool, run };
};

const json = (text: string): unknown => JSON.parse(text.split("\n")[0] as string);

test("every decision tool loads on demand and the section teaches the batch", () => {
  const { tool } = fixture(() => choiceAnswer());
  assert.deepEqual(tool("decide") && [tool("decide").name], ["decide"]);
  assert.deepEqual(
    ["decide", "classify", "assess", "rate", "judge"].map((name) => [
      name,
      tool(name).deferred === true,
    ]),
    [
      ["decide", true],
      ["classify", true],
      ["assess", true],
      ["rate", true],
      ["judge", true],
    ],
    "a bot that never decides never carries them",
  );
  assert.equal(DECISION_TOOLS_EXTENSION, "bots-decision");
  const section = decisionSection();
  assert.match(section, /tool_search/);
  assert.match(section, /judge/);
  assert.match(section, /confidence/);
});

test("decide turns options into criteria and returns the typed answer", async () => {
  const { requests, run, bookings } = fixture(() => choiceAnswer());
  const { result, text } = await run("decide", {
    state: "一个很小的改动还没有跑测试。",
    question: "下一步做什么？",
    options: [
      { label: "test", description: "先跑聚焦的测试" },
      { label: "merge", description: "不跑测试直接合并" },
    ],
  });
  assert.equal(result.isError, undefined);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.state, "一个很小的改动还没有跑测试。");
  assert.deepEqual(request.questions.next_step, {
    type: "choice",
    instructions: "下一步做什么？",
    criteria: { test: "先跑聚焦的测试", merge: "不跑测试直接合并" },
  });
  assert.deepEqual(json(text), {
    type: "choice",
    choice: "test",
    probabilities: { merge: 0.4, test: 0.6 },
    confidence: 0.2,
  });
  assert.match(text, /jev-1\.14\.0/);
  assert.match(text, /低置信度/, "a 0.2 confidence is called out");
  assert.deepEqual(bookings, [{ botId: "b_1", source: "decision", tokens: 319, costUsd: 0 }]);
  assert.equal(requests.length, 1, "one call is one request");
});

test("decide accepts a structured state and passes it through untouched", async () => {
  const { requests, run } = fixture(() => choiceAnswer({ ok: 0.9, bad: 0.1 }, "ok"));
  const state = { ticket: { messages: [{ from: "customer", text: "重复扣款了" }] } };
  await run("decide", {
    state,
    question: "Does `ticket.messages[0].text` request a refund?",
    options: [{ label: "ok" }, { label: "bad" }],
  });
  assert.deepEqual(requests[0]?.state, state, "a structured state is not serialized here");
});

test("classify multi asks one noul per label in a single request", async () => {
  const { requests, run } = fixture((request) =>
    Object.keys(request.questions).map((_, index) => ({
      type: "noul" as const,
      noul: index === 0 ? 0.82 : 0.21,
    })),
  );
  const { text } = await run("classify", {
    state: "PR 里改了一个拼写错误。",
    labels: ["文档", "重构"],
    mode: "multi",
  });
  assert.equal(requests.length, 1, "labels are one request, not one call each");
  assert.deepEqual(
    Object.values(requests[0]?.questions ?? {}).map((q) => q.type),
    ["noul", "noul"],
  );
  assert.deepEqual(json(text), [
    { label: "文档", probability: 0.82 },
    { label: "重构", probability: 0.21 },
  ]);
  assert.match(text, /阈值 0\.7：文档/, "the kept labels are named for the model");
});

test("classify single is a choice, and allowNone adds the escape hatch", async () => {
  const { requests, run } = fixture(() => choiceAnswer({ bug: 0.3, none: 0.7 }, "none"));
  const { text } = await run("classify", {
    state: "只是打招呼。",
    labels: ["bug", "feature"],
    mode: "single",
    allowNone: true,
  });
  const question = requests[0]?.questions.next_step;
  assert.equal(question?.type, "choice");
  assert.deepEqual(Object.keys((question as { criteria: object }).criteria), [
    "bug",
    "feature",
    "none",
  ]);
  assert.equal((json(text) as { choice: string }).choice, "none");
});

test("assess returns a probability and says what an unsure value means", async () => {
  const { run } = fixture(() => ({ type: "noul", noul: 0.5 }));
  const { text } = await run("assess", {
    state: "客户说“也许下周再看”。",
    statement: "客户已经确认要购买",
  });
  assert.deepEqual(json(text), { type: "noul", noul: 0.5 });
  assert.match(text, /不确定|0\.5/, "an even split is called out instead of read as a yes");
});

test("rate keeps a score between levels and repeats the legend", async () => {
  const { requests, run } = fixture(() => ({
    type: "score",
    score: 1.4,
    legend: ["平静", "不满", "愤怒"],
    probabilities: [0.1, 0.6, 0.3],
    confidence: 0.2,
  }));
  const { text } = await run("rate", {
    state: "你们已经第三次没有回复我了。",
    question: "客户有多不满？",
    levels: ["平静", "不满", "愤怒"],
  });
  const asked = requests[0]?.questions.next_step as { criteria: readonly string[] };
  assert.deepEqual(asked.criteria, ["平静", "不满", "愤怒"]);
  assert.deepEqual(json(text), {
    type: "score",
    score: 1.4,
    legend: ["平静", "不满", "愤怒"],
    probabilities: [0.1, 0.6, 0.3],
    confidence: 0.2,
  });
});

test("judge sends mixed question types in one request", async () => {
  const { requests, run } = fixture((request) =>
    Object.keys(request.questions).map((id) =>
      id === "urgency"
        ? { type: "noul" as const, noul: 0.88 }
        : {
            type: "choice" as const,
            choice: "refund",
            probabilities: { refund: 0.8, sales: 0.2 },
            confidence: 0.6,
          },
    ),
  );
  const { text } = await run("judge", {
    state: { ticket: { text: "我要退款" } },
    questions: [
      { id: "urgency", type: "noul", instructions: "这条消息是否紧急？" },
      {
        id: "intent",
        type: "choice",
        instructions: "客户想要什么？",
        criteria: { refund: "要退款", sales: "问报价" },
      },
    ],
  });
  assert.equal(requests.length, 1, "one state, one request");
  assert.deepEqual(Object.keys(requests[0]?.questions ?? {}), ["urgency", "intent"]);
  assert.deepEqual(json(text), {
    urgency: { type: "noul", noul: 0.88 },
    intent: {
      type: "choice",
      choice: "refund",
      probabilities: { refund: 0.8, sales: 0.2 },
      confidence: 0.6,
    },
  });
});

// The transport (server/decision.ts) refuses a malformed answer; a client that raises it must
// reach the model as a refusal, never as an answer and never as a booked call.
test("a refused answer is an error result, not a fabricated decision", async () => {
  const tools = createDecisionTools({
    client: {
      async ask() {
        throw new DecisionFailure("shape", "返回内容不是 System One 决策");
      },
    },
    botId: "b_1",
    meter: { record: () => assert.fail("a failed call must not be booked") },
  });
  const decide = tools.find((tool) => tool.name === "decide");
  assert.ok(decide);
  const result = await decide.execute(
    {
      state: "x",
      question: "?",
      options: [{ label: "test" }, { label: "merge" }],
    } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError, true);
  const text = ((result.output?.[0] ?? {}) as { text?: string }).text ?? "";
  assert.match(text, /决策失败.*System One/);
});

test("bad arguments are refused before anything is sent", async () => {
  const { requests, run } = fixture(() => choiceAnswer());
  for (const [name, args] of [
    ["decide", { state: "x", question: "?", options: [{ label: "only" }] }],
    ["decide", { state: "", question: "?", options: [{ label: "a" }, { label: "b" }] }],
    ["classify", { state: "x", labels: ["one"], mode: "single" }],
    ["assess", { state: "x", statement: "   " }],
    ["rate", { state: "x", question: "?", levels: ["only"] }],
    ["judge", { state: "x", questions: [] }],
  ] as const) {
    const { result } = await run(name, args as unknown as Record<string, unknown>);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(requests, [], "nothing invalid reaches the provider");
  const tooMany = await run("judge", {
    state: "x",
    questions: Array.from({ length: MAX_JUDGE_QUESTIONS + 1 }, (_, index) => ({
      id: `q${index}`,
      type: "noul",
      instructions: "?",
    })),
  });
  assert.equal(tooMany.result.isError, true);
});

test("the answer must fit the output the tool can return", async () => {
  const { requests, run } = fixture(() => choiceAnswer({ test: 1, merge: 0 }, "test"));
  const options = Array.from({ length: 200 }, (_, index) => ({
    label: `选项${index}`.padEnd(64, "网"),
  }));
  const { result, text } = await run("decide", {
    state: "x",
    question: "?",
    options: options.map((option) => ({ label: option.label })),
  });
  assert.equal(result.isError, true);
  assert.match(text, /输出|选项/);
  assert.deepEqual(requests, [], "an oversized answer is refused before it is paid for");
});

test("a label the criteria map cannot hold is refused, not dropped", async () => {
  const { requests, run } = fixture(() => choiceAnswer());
  const reserved = await run("decide", {
    state: "x",
    question: "?",
    options: [{ label: "__proto__" }, { label: "ok" }],
  });
  assert.equal(reserved.result.isError, true);
  assert.match(reserved.text, /保留|__proto__/);

  const duplicateNone = await run("classify", {
    state: "x",
    labels: ["none", "bug"],
    allowNone: true,
  });
  assert.equal(duplicateNone.result.isError, true, "an existing `none` label is not overwritten");
  assert.deepEqual(requests, []);
});

test("a blank question and an untyped criterion are refused", async () => {
  const { requests, run } = fixture(() => choiceAnswer());
  const blank = await run("decide", {
    state: "x",
    question: "   ",
    options: [{ label: "a" }, { label: "b" }],
  });
  assert.equal(blank.result.isError, true);
  const blankRate = await run("rate", { state: "x", question: "\t", levels: ["a", "b"] });
  assert.equal(blankRate.result.isError, true);
  const numberCriterion = await run("judge", {
    state: "x",
    questions: [{ id: "q", type: "choice", instructions: "?", criteria: { a: 42, b: null } }],
  });
  assert.equal(numberCriterion.result.isError, true, "a criterion must be text, JSON or null");
  const arrayNoul = await run("judge", {
    state: "x",
    questions: [{ id: "q", type: "noul", instructions: "?", criteria: ["a", "b"] }],
  });
  assert.equal(arrayNoul.result.isError, true, "noul criteria is a true/false map, not a list");
  assert.deepEqual(requests, []);
});

test("a successful call is booked even when the usage write or the token count fails", async () => {
  const booked: UsageEntry[] = [];
  const tools = createDecisionTools({
    client: {
      async ask(request) {
        return {
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, choiceAnswer()]),
          ),
          inputTokens: 0,
        };
      },
    },
    botId: "b_1",
    meter: { record: (entry) => booked.push(entry) },
  });
  const decide = tools.find((tool) => tool.name === "decide");
  assert.ok(decide);
  const args = { state: "x", question: "?", options: [{ label: "a" }, { label: "b" }] };
  const ok = await decide.execute(args as never, {} as never, {} as never);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(
    booked,
    [{ botId: "b_1", source: "decision", calls: 1 }],
    "a zero-token count is still one call, not an invisible one",
  );
});

test("a usage write that throws does not discard a paid answer", async () => {
  const tools = createDecisionTools({
    client: {
      async ask() {
        return { answers: { next_step: choiceAnswer() }, inputTokens: 12 };
      },
    },
    botId: "b_1",
    meter: {
      record() {
        throw new Error("the statistics table is full");
      },
    },
  });
  const decide = tools.find((tool) => tool.name === "decide");
  assert.ok(decide);
  const result = await decide.execute(
    { state: "x", question: "?", options: [{ label: "a" }, { label: "b" }] } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError, undefined, "the answer is the product; the meter is a side channel");
});

test("a missing provider becomes an error the model can read", async () => {
  const tools = createDecisionTools({
    client: {
      async ask() {
        throw new Error("请先在服务中选择一个决策服务商");
      },
    },
    botId: "b_1",
  });
  const decide = tools.find((tool) => tool.name === "decide");
  assert.ok(decide);
  const result = await decide.execute(
    {
      state: "x",
      question: "?",
      options: [{ label: "a" }, { label: "b" }],
    } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError, true);
  const text = ((result.output?.[0] ?? {}) as { text?: string }).text ?? "";
  assert.match(text, /决策服务商/);
});

test("judge refuses a question it cannot send, naming the question", async () => {
  const { requests, run } = fixture(() => ({ type: "noul", noul: 0.5 }));
  const cases: { questions: unknown[]; reason: RegExp }[] = [
    {
      questions: [{ id: "a", type: "choice", instructions: "?", criteria: { only: "one" } }],
      reason: /2-255/,
    },
    {
      questions: [{ id: "a", type: "score", instructions: "?", criteria: ["one"] }],
      reason: /2-20/,
    },
    { questions: [{ id: "a", type: "noul" }], reason: /instructions/ },
    { questions: [{ id: "a", type: "sort", instructions: "?" }], reason: /type/ },
    {
      questions: [
        { id: "a", type: "noul", instructions: "?" },
        { id: "a", type: "noul", instructions: "?" },
      ],
      reason: /重复/,
    },
    { questions: [{ id: "__proto__", type: "noul", instructions: "?" }], reason: /保留名/ },
  ];
  for (const { questions, reason } of cases) {
    const { result, text } = await run("judge", { state: "x", questions });
    assert.equal(result.isError, true, JSON.stringify(questions));
    assert.match(text, reason, JSON.stringify(questions));
  }
  assert.deepEqual(requests, [], "an unbuildable question never reaches the provider");
});

test("a label set nothing reaches the threshold for says so", async () => {
  const { run } = fixture((request) =>
    Object.keys(request.questions).map(() => ({ type: "noul" as const, noul: 0.4 })),
  );
  const { text } = await run("classify", {
    state: "既不像文档也不像重构。",
    labels: ["文档", "重构"],
    mode: "multi",
  });
  assert.match(text, /没有标签达到阈值 0\.7/);
});

test("a rejection that is not an Error still becomes readable text", async () => {
  const tools = createDecisionTools({
    client: {
      async ask() {
        throw "upstream fell over";
      },
    },
    botId: "b_1",
  });
  const assess = tools.find((tool) => tool.name === "assess");
  assert.ok(assess);
  const result = await assess.execute(
    { state: "x", statement: "?" } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError, true);
  const text = ((result.output?.[0] ?? {}) as { text?: string }).text ?? "";
  assert.match(text, /upstream fell over/);
});

test("the defaults are single-label and a 0.7 threshold when nothing is asked for", async () => {
  const { requests, run } = fixture((request) =>
    Object.keys(request.questions).map((_, index) => ({
      type: "noul" as const,
      noul: index === 0 ? 0.65 : 0.9,
    })),
  );
  const single = await run("classify", { state: "x", labels: ["a", "b"] });
  assert.equal(requests[0]?.questions.next_step?.type, "choice", "single is the default mode");
  assert.equal(single.result.isError, undefined);

  const multi = await run("classify", {
    state: "x",
    labels: ["a", "b"],
    mode: "multi",
    threshold: 0.8,
  });
  assert.match(multi.text, /阈值 0\.8：b/, "a custom threshold keeps only what reaches it");
  const details = multi.result.details as { labels?: readonly string[] };
  assert.deepEqual(details.labels, ["b"]);
});
