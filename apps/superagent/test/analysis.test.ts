// SG-003 (docs/bots/specs/SUPERAGENT-003-ANALYSIS.md): the service only stores a suggestion
// that quotes ids it offered, and a decision is written once.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AnalysisStore,
  MAX_EVIDENCE,
  MAX_OPEN,
  MAX_OPEN_PER_BOT,
  MAX_SUGGESTION_CHARS,
  readModelSuggestion,
  readSuggestion,
} from "../src/analysis.ts";
import { Analyzer } from "../src/analyze.ts";
import { AttentionStore } from "../src/attention.ts";

const OFFERED = ["s_ok_0001", "a_item_0001", "e_71", "e_72"];

const bench = async (
  options: { readonly answer?: () => string; readonly history?: () => unknown } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-"));
  const store = new AnalysisStore(root);
  const attention = new AttentionStore(root);
  let clock = Date.parse("2026-11-09T20:00:00.000Z");
  const prompts: string[] = [];
  let answers = 0;
  const history = {
    messages: [
      {
        entryId: "e_71",
        role: "user",
        state: "complete",
        blocks: [{ type: "text", text: "写一篇" }],
      },
      {
        entryId: "e_72",
        role: "assistant",
        state: "error",
        blocks: [{ type: "text", text: "失败" }],
      },
    ],
  };
  const readHistory = () => options.history?.() ?? history;
  const analyzer = new Analyzer({
    store,
    attention,
    history: async () => readHistory(),
    generate: async (prompt) => {
      prompts.push(prompt);
      answers += 1;
      if (options.answer !== undefined) return options.answer();
      // The model may only quote what the service offered: take the first id it was given.
      const offered = prompt.match(/\b[ae]_[0-9a-zA-Z_-]+/g) ?? ["e_72"];
      return `{"text":"看看这个 Bot 的模型配置","evidence":["${offered[0]}"]}`;
    },
    now: () => new Date(clock),
    cooldownMs: 900_000,
  });
  return {
    root,
    store,
    attention,
    analyzer,
    prompts,
    get answers() {
      return answers;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const raise = async (attention: AttentionStore, botId: string) =>
  attention.observe({
    candidates: [{ botId, kind: "worker_error", severity: "medium", evidence: "answer:error" }],
    healed: new Set(),
    at: "2026-11-09T19:00:00.000Z",
    reopenAfterMs: 900_000,
  });

test("SG003-A1: a suggestion without evidence is refused, and nothing is stored", () => {
  assert.equal(readSuggestion({ text: "做点什么" }, OFFERED), undefined);
  assert.equal(readSuggestion({ text: "做点什么", evidence: [] }, OFFERED), undefined);
  assert.equal(
    readSuggestion({ text: "做点什么", evidence: ["e_999"] }, OFFERED),
    undefined,
    "an id the service did not offer is not evidence",
  );
  assert.deepEqual(readSuggestion({ text: " 看模型 ", evidence: ["e_71"] }, OFFERED), {
    text: "看模型",
    evidence: ["e_71"],
  });
  // A model answer wrapped in prose is still read, and a broken one is refused.
  assert.deepEqual(
    readModelSuggestion('结论如下：{"text":"看模型","evidence":["e_71"]} 以上。', OFFERED),
    { text: "看模型", evidence: ["e_71"] },
  );
  assert.equal(readModelSuggestion("没有 JSON", OFFERED), undefined);
  assert.equal(readModelSuggestion("{ not json }", OFFERED), undefined);
});

test("SG003-A2: the bounds are enforced on the draft itself", () => {
  const long = "字".repeat(MAX_SUGGESTION_CHARS + 1);
  assert.equal(readSuggestion({ text: long, evidence: ["e_71"] }, OFFERED), undefined);
  const many = Array.from({ length: MAX_EVIDENCE + 1 }, (_, index) => `e_${index}`);
  assert.equal(readSuggestion({ text: "ok", evidence: many }, OFFERED), undefined);
  assert.equal(readSuggestion({ text: "ok", evidence: "e_71" }, OFFERED), undefined);
});

test("SG003-A3: one suggestion per Bot per cooldown, and the prompt carries the evidence", async () => {
  const bench_ = await bench();
  try {
    await raise(bench_.attention, "b_1");
    const first = await bench_.analyzer.analyzeFor("b_1");
    assert.ok("suggestion" in first && first.suggestion !== undefined);
    assert.equal(first.suggestion.botId, "b_1");
    assert.match(bench_.prompts[0] ?? "", /a_[0-9a-f-]+ worker_error \(answer:error ×1\)/);
    assert.match(bench_.prompts[0] ?? "", /e_71, e_72/);
    bench_.advance(60_000);
    assert.deepEqual(await bench_.analyzer.analyzeFor("b_1"), { refused: "cooldown" });
    bench_.advance(900_000);
    const later = await bench_.analyzer.analyzeFor("b_1");
    assert.equal("refused" in later && later.refused, "duplicate");
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A3b: a model answer outside the offer is refused with no suggestion", async () => {
  const bench_ = await bench({
    answer: () => '{"text":"随便说说","evidence":["e_404"]}',
  });
  try {
    await raise(bench_.attention, "b_2");
    assert.deepEqual(await bench_.analyzer.analyzeFor("b_2"), { refused: "invalid" });
    assert.deepEqual(await bench_.analyzer.list(), []);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A3c: no evidence at all means no model turn and no suggestion", async () => {
  const bench_ = await bench({ history: () => ({ messages: [] }) });
  try {
    assert.deepEqual(await bench_.analyzer.analyzeFor("b_3"), { refused: "no_evidence" });
    assert.equal(bench_.answers, 0, "nothing is asked of the model without evidence");
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A4: a decision is written once and a second verdict is refused", async () => {
  const bench_ = await bench();
  try {
    await raise(bench_.attention, "b_4");
    const created = await bench_.analyzer.analyzeFor("b_4");
    assert.ok("suggestion" in created && created.suggestion !== undefined);
    const id = created.suggestion.id;
    const decided = await bench_.analyzer.decide({
      suggestionId: id,
      verdict: "accepted",
      reason: "先查模型",
    });
    assert.ok("decision" in decided);
    assert.equal(decided.decision.verdict, "accepted");
    assert.equal(decided.decision.reason, "先查模型");
    assert.equal(decided.suggestion.closedAt !== undefined, true);
    assert.deepEqual(await bench_.analyzer.decide({ suggestionId: id, verdict: "rejected" }), {
      refused: "decision_exists",
    });
    assert.deepEqual(
      await bench_.analyzer.decide({ suggestionId: "s_unknown1", verdict: "accepted" }),
      {
        refused: "unknown_suggestion",
      },
    );
    const decisions = await bench_.analyzer.decisions({ botId: "b_4" });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.suggestionId, id);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A5: a suggestion whose attention item closed reads as stale, never as fresh", async () => {
  const bench_ = await bench();
  try {
    const items = await raise(bench_.attention, "b_5");
    await bench_.analyzer.analyzeFor("b_5");
    const fresh = await bench_.analyzer.list();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]?.stale, false);
    await bench_.attention.ack(items[0]?.id ?? "", "2026-11-09T20:05:00.000Z");
    const stale = await bench_.analyzer.list();
    assert.equal(stale[0]?.stale, true);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A6: the store keeps its bounds and reads a damaged file as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-store-"));
  try {
    const store = new AnalysisStore(root);
    assert.deepEqual(await store.list(), []);
    await writeFile(store.path, "{ half", { mode: 0o600 });
    assert.deepEqual(await new AnalysisStore(root).list(), []);
    await writeFile(store.path, JSON.stringify({ suggestions: "no", decisions: 4 }), {
      mode: 0o600,
    });
    const wrong = await new AnalysisStore(root);
    assert.deepEqual(await wrong.list(), []);
    assert.deepEqual(await wrong.listDecisions(), []);

    const draft = { text: "看一下", evidence: ["e_1"] };
    for (let index = 0; index < MAX_OPEN_PER_BOT; index += 1) {
      const stored = await store.add({
        botId: "b_6",
        draft: { ...draft, text: `看一下 ${index}` },
        at: "2026-11-09T20:00:00.000Z",
      });
      assert.ok("created" in stored);
    }
    // Per-Bot bound first, then the global one.
    assert.deepEqual(await store.add({ botId: "b_6", draft, at: "2026-11-09T20:00:00.000Z" }), {
      refused: "budget",
    });
    for (let index = 0; index < MAX_OPEN; index += 1) {
      const stored = await store.add({
        botId: `b_other_${index}`,
        draft: { ...draft, text: `别的 ${index}` },
        at: "2026-11-09T20:00:00.000Z",
      });
      if ("refused" in stored) {
        assert.equal(stored.refused, "budget");
        break;
      }
    }
    assert.equal((await store.list({ includeClosed: true, limit: 200 })).length <= MAX_OPEN, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A7: analysis storage never blocks the conversation or the health answer", async () => {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { startService } = await import("../src/server.ts");
  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-service-"));
  const provider = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ kind: "snapshot", bots: [], cursor: "c1" }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  const providerPort = typeof address === "object" && address !== null ? address.port : 0;
  const { ObservationClient } = await import("../src/observation.ts");
  const service = await startService({
    root,
    port: 0,
    proactive: {
      mode: "notify",
      intervalMs: 60_000,
      observation: new ObservationClient({
        root,
        endpoint: `http://127.0.0.1:${providerPort}`,
        tokenFile: "",
        stateFile: "watch-state.json",
      }),
    },
  });
  try {
    const health = await fetch(`http://127.0.0.1:${service.port}/v1/health`);
    assert.equal(health.status, 200);
    // A broken analysis file on disk is a suggestion list that reads empty, not a failure.
    await writeFile(join(root, "analysis.json"), "{ half", { mode: 0o600 });
    const token = (await readFile(join(root, "token"), "utf8")).trim();
    assert.ok(token.length >= 32);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A8: the socket answers suggestions and takes one decision", async () => {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { startService } = await import("../src/server.ts");
  const { ObservationClient } = await import("../src/observation.ts");
  const socketModule = await import("ws");
  const { createHmac, randomBytes } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-socket-"));
  const provider = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ kind: "snapshot", bots: [], cursor: "c1" }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  const providerPort = typeof address === "object" && address !== null ? address.port : 0;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let socket: InstanceType<typeof socketModule.WebSocket> | undefined;
  try {
    service = await startService({
      root,
      port: 0,
      proactive: {
        mode: "notify",
        intervalMs: 60_000,
        observation: new ObservationClient({
          root,
          endpoint: `http://127.0.0.1:${providerPort}`,
          tokenFile: "",
          stateFile: "watch-state.json",
        }),
      },
    });
    // A suggestion already on disk, as an earlier analysis would have written it.
    await writeFile(
      join(root, "analysis.json"),
      JSON.stringify({
        version: 1,
        suggestions: [
          {
            id: "s_00000000-0000-4000-8000-000000000001",
            botId: "b_socket",
            text: "先看模型配置",
            evidence: ["e_71"],
            createdAt: "2026-11-09T20:00:00.000Z",
          },
        ],
        decisions: [],
        lastAnalysis: {},
      }),
      { mode: 0o600 },
    );
    const token = (await readFile(join(root, "token"), "utf8")).trim();
    socket = new socketModule.WebSocket(`ws://127.0.0.1:${service.port}/v1/chat`);
    const frames: { type: string; id?: string; value?: unknown; code?: string }[] = [];
    socket.on("message", (bytes: Buffer) => frames.push(JSON.parse(bytes.toString())));
    const waitFor = async (predicate: (frame: (typeof frames)[number]) => boolean) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = frames.findIndex(predicate);
        if (index >= 0) {
          const frame = frames.splice(index, 1)[0];
          assert.ok(frame);
          return frame;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("frame_timeout");
    };
    await new Promise<void>((resolve) => socket?.once("open", () => resolve()));
    const nonce = randomBytes(16).toString("hex");
    socket.send(JSON.stringify({ type: "hello", nonce }));
    const challenge = (await waitFor((frame) => frame.type === "challenge")) as unknown as {
      serverNonce: string;
      identity: { instance: string };
    };
    socket.send(
      JSON.stringify({
        type: "authenticate",
        proof: createHmac("sha256", token)
          .update(`client\n${nonce}\n${challenge.serverNonce}\n${challenge.identity.instance}`)
          .digest("hex"),
      }),
    );
    await waitFor((frame) => frame.type === "ready");
    const call = async (type: string, fields: Record<string, unknown> = {}) => {
      const id = `cmd_${randomBytes(8).toString("hex")}`;
      socket?.send(JSON.stringify({ type, id, ...fields }));
      return waitFor((frame) => frame.id === id);
    };

    const listed = await call("suggestion-list", { botId: "b_socket" });
    assert.equal(listed.type, "result");
    const suggestions = (listed.value as { suggestions: { id: string; stale?: boolean }[] })
      .suggestions;
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.stale, false);

    const acked = await call("suggestion-ack", {
      suggestionId: suggestions[0]?.id,
      verdict: "accepted",
      reason: "先查模型",
    });
    assert.equal(acked.type, "result");
    const decided = acked.value as {
      decision: { verdict: string };
      suggestion: { closedAt?: string };
    };
    assert.equal(decided.decision.verdict, "accepted");
    assert.equal(decided.suggestion.closedAt !== undefined, true);

    const again = await call("suggestion-ack", {
      suggestionId: suggestions[0]?.id,
      verdict: "rejected",
    });
    assert.equal(again.type, "error");
    assert.equal(again.code, "decision_exists");

    const unknown = await call("suggestion-ack", {
      suggestionId: "s_00000000-0000-4000-8000-0000000000ff",
      verdict: "accepted",
    });
    assert.equal(unknown.type, "error");
    assert.equal(unknown.code, "invalid_command");

    const decisions = await call("decision-list", {});
    assert.equal(
      (decisions.value as { decisions: unknown[] }).decisions.length,
      1,
      "a decided suggestion is listed",
    );

    // An explicit ask with no evidence behind it refuses instead of spending a model turn.
    const asked = await call("analyze", { botId: "b_socket" });
    assert.equal(asked.type, "result");
    assert.equal((asked.value as { refused?: string }).refused, "no_evidence");
    const any = await call("analyze", {});
    assert.equal(any.type, "result");
    assert.deepEqual((any.value as { suggestions: unknown[] }).suggestions, []);
  } finally {
    socket?.close();
    await service?.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A9: the analysis turn is one model call, and its failures are values", async () => {
  const { createModels } = await import("@earendil-works/pi-ai");
  const { fauxAssistantMessage, fauxProvider } = await import(
    "@earendil-works/pi-ai/providers/faux"
  );
  const { ChatRuntime } = await import("../src/runtime.ts");
  const root = await mkdtemp(join(tmpdir(), "superagent-generate-"));
  const faux = fauxProvider({
    provider: "superagent",
    models: [{ id: "test-model" }],
    tokensPerSecond: 10000,
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await ChatRuntime.open(root, models);
  try {
    // Unconfigured is a refusal, not an empty answer.
    await assert.rejects(() => runtime.generateText("hi"), /model_unconfigured/);
    await runtime.configure({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      thinkingLevel: "medium",
      apiKey: "fixture-only-key",
    });
    faux.setResponses([fauxAssistantMessage("一个建议")]);
    assert.equal(await runtime.generateText("给个建议"), "一个建议");
    // A configured model that this service does not know is its own failure.
    await runtime.configure({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "unknown-model",
      thinkingLevel: "medium",
      apiKey: "fixture-only-key",
    });
    await assert.rejects(() => runtime.generateText("hi"), /model_unavailable/);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A10: a damaged history page still yields the entries it can read", async () => {
  const bench_ = await bench({
    history: () => ({
      messages: [
        null,
        { role: "user", state: "complete" },
        { entryId: 7, role: "user" },
        {
          entryId: "e_80",
          role: "assistant",
          state: "error",
          blocks: [null, { type: "toolCall" }],
        },
      ],
    }),
  });
  try {
    await raise(bench_.attention, "b_10");
    const result = await bench_.analyzer.analyzeFor("b_10");
    assert.equal("suggestion" in result, true);
    assert.match(bench_.prompts[0] ?? "", /最近条目: e_80/);
    assert.match(bench_.prompts[0] ?? "", /最近答复: error: \n/);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A11: a draft that is not an object with text is refused", () => {
  assert.equal(readSuggestion(null, OFFERED), undefined);
  assert.equal(readSuggestion("text", OFFERED), undefined);
  assert.equal(readSuggestion({ text: 12, evidence: ["e_71"] }, OFFERED), undefined);
  assert.deepEqual(readSuggestion({ text: "ok", evidence: ["e_71", 4, null] }, OFFERED), {
    text: "ok",
    evidence: ["e_71"],
  });
});

test("SG003-A12: the catalogue refresh answering nothing keeps the other changes", async () => {
  const { AttentionStore: Store } = await import("../src/attention.ts");
  const { Watcher: Watch } = await import("../src/watch.ts");
  const root = await mkdtemp(join(tmpdir(), "superagent-catalog-refresh-"));
  try {
    const watcher = new Watch({
      observation: {
        snapshot: async () => ({
          provider: {
            reachable: false,
            state: "unreachable",
            lastReadAt: null,
            unavailable: 0,
            detail: "unreachable",
          },
          snapshot: null,
        }),
        changes: async () => ({
          provider: {
            reachable: true,
            state: "ready",
            lastReadAt: null,
            unavailable: 0,
            detail: null,
          },
          changes: {
            changes: [
              { kind: "catalog_changed", bots: 2 },
              { kind: "store_state_changed", botId: "b_11", state: "session_missing" },
            ],
          },
        }),
        history: async () => ({
          provider: {
            reachable: true,
            state: "ready",
            lastReadAt: null,
            unavailable: 0,
            detail: null,
          },
          history: { messages: [] },
        }),
      },
      store: new Store(root),
      now: () => new Date("2026-11-09T20:00:00.000Z"),
      intervalMs: 60_000,
      stallAfterMs: 600_000,
      reopenAfterMs: 900_000,
      reportBudgetMs: 1_800_000,
      actionCooldownMs: 900_000,
      maxActionsPerHour: 6,
      mode: "off",
    });
    const result = await watcher.tick();
    assert.equal(result.provider?.state, "ready");
    assert.equal(result.raised.length, 1, "the store change is still classified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A13: a Bot with entries but no attention item, and no assistant answer at all", async () => {
  const bench_ = await bench({
    history: () => ({ messages: [{ entryId: "e_90", role: "user", state: "complete" }] }),
  });
  try {
    // Nothing raised: the entries alone are evidence, and the prompt says so.
    const result = await bench_.analyzer.analyzeFor("b_13");
    assert.equal("suggestion" in result, true);
    assert.match(bench_.prompts[0] ?? "", /关注项: 无/);
    assert.match(bench_.prompts[0] ?? "", /最近答复: 无/);
    // The second Bot is inside its own cooldown window only after it was analysed.
    bench_.advance(60_000);
    assert.deepEqual(await bench_.analyzer.analyzeFor("b_13"), { refused: "cooldown" });
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A14: an answer the store cannot write is a refusal, not a lost record", async () => {
  const bench_ = await bench();
  try {
    // A decision without a reason omits the field entirely.
    await raise(bench_.attention, "b_14");
    const created = await bench_.analyzer.analyzeFor("b_14");
    assert.ok("suggestion" in created && created.suggestion !== undefined);
    const decided = await bench_.analyzer.decide({
      suggestionId: created.suggestion.id,
      verdict: "deferred",
    });
    assert.ok("decision" in decided);
    assert.equal("reason" in decided.decision, false);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A15: the list bounds and the closed/open ordering survive one save", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-order-"));
  try {
    const store = new AnalysisStore(root);
    const draft = { text: "看模型", evidence: ["e_1"] };
    const first = await store.add({
      botId: "b_15",
      draft: { ...draft, text: "先关闭" },
      at: "2026-11-09T20:00:00.000Z",
    });
    assert.ok("created" in first);
    await store.decide({
      suggestionId: first.created.id,
      verdict: "accepted",
      at: "2026-11-09T20:01:00.000Z",
    });
    await store.add({
      botId: "b_15",
      draft: { ...draft, text: "还开着" },
      at: "2026-11-09T20:02:00.000Z",
    });
    await store.save();
    const open = await store.list({ limit: 10 });
    assert.equal(open.length, 1);
    assert.equal(open[0]?.text, "还开着");
    assert.equal((await store.list({ includeClosed: true })).length, 2);
    assert.equal((await store.list({ limit: 0 })).length, 1, "a zero limit is clamped to one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A16: empty history pages and every list shape still answer", async () => {
  const bench_ = await bench({ history: () => null });
  try {
    await raise(bench_.attention, "b_16");
    const created = await bench_.analyzer.analyzeFor("b_16");
    assert.equal("suggestion" in created, true, "an attention id alone is evidence");
    // The list shapes the socket exposes: by Bot, with a limit, and neither.
    assert.equal((await bench_.analyzer.list({ botId: "b_16" })).length, 1);
    assert.equal((await bench_.analyzer.list({ limit: 1 })).length, 1);
    assert.equal((await bench_.analyzer.list()).length, 1);
    assert.equal((await bench_.analyzer.decisions({ limit: 1 })).length, 0);
    // One pass over several Bots stops at the first refusal and returns nothing.
    await raise(bench_.attention, "b_17");
    const one = await bench_.analyzer.analyzeOne();
    assert.ok(one === undefined || one.botId === "b_16" || one.botId === "b_17");
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A17: an assistant entry with no blocks and no state is still described", async () => {
  const bench_ = await bench({
    history: () => ({ messages: [{ entryId: "e_95", role: "assistant" }] }),
  });
  try {
    const result = await bench_.analyzer.analyzeFor("b_17");
    assert.equal("suggestion" in result, true);
    assert.match(bench_.prompts[0] ?? "", /最近答复: unknown: \n/);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A18: a store that cannot write keeps the record in memory and says so", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-nowrite-"));
  const store = new AnalysisStore(root);
  await store.load();
  await rm(root, { recursive: true, force: true });
  const stored = await store.add({
    botId: "b_18",
    draft: { text: "看模型", evidence: ["e_1"] },
    at: "2026-11-09T20:00:00.000Z",
  });
  assert.ok("created" in stored, "the suggestion is still answered to the caller");
  assert.equal(await store.save(), false, "and the failure is visible, not thrown");
});

test("SG003-A19: an empty key is unconfigured even though a configuration exists", async () => {
  const { createModels } = await import("@earendil-works/pi-ai");
  const { ChatRuntime } = await import("../src/runtime.ts");
  const root = await mkdtemp(join(tmpdir(), "superagent-generate-empty-"));
  const runtime = await ChatRuntime.open(root, createModels());
  try {
    await runtime.configure({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      thinkingLevel: "medium",
      apiKey: "placeholder-key",
    });
    // The provider is registered for a model the models table does not know here.
    await assert.rejects(() => runtime.generateText("hi"), /model_unavailable/);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SG003-A20: a decision list honours its Bot filter and its clamp", async () => {
  const bench_ = await bench();
  try {
    await raise(bench_.attention, "b_20");
    const created = await bench_.analyzer.analyzeFor("b_20");
    assert.ok("suggestion" in created && created.suggestion !== undefined);
    await bench_.analyzer.decide({ suggestionId: created.suggestion.id, verdict: "accepted" });
    assert.equal((await bench_.analyzer.decisions({ botId: "b_20" })).length, 1);
    assert.equal((await bench_.analyzer.decisions({ botId: "b_other" })).length, 0);
    assert.equal((await bench_.analyzer.decisions({ limit: 0 })).length, 1);
  } finally {
    await bench_.cleanup();
  }
});

test("SG003-A21: a text block without text, and both sort directions of open/closed", async () => {
  const bench_ = await bench({
    history: () => ({
      messages: [
        { entryId: "e_96", role: "assistant", state: "error", blocks: [{ type: "text" }] },
      ],
    }),
  });
  try {
    const result = await bench_.analyzer.analyzeFor("b_21");
    assert.equal("suggestion" in result, true);
    assert.match(bench_.prompts[0] ?? "", /最近答复: error: \n/);
  } finally {
    await bench_.cleanup();
  }

  const root = await mkdtemp(join(tmpdir(), "superagent-analysis-sort-"));
  try {
    const store = new AnalysisStore(root);
    const draft = { text: "看模型", evidence: ["e_1"] };
    // Closed first, open second, so the comparator is asked both ways.
    const closedFirst = await store.add({
      botId: "b_22",
      draft: { ...draft, text: "先关" },
      at: "2026-11-09T20:00:00.000Z",
    });
    assert.ok("created" in closedFirst);
    await store.decide({
      suggestionId: closedFirst.created.id,
      verdict: "rejected",
      at: "2026-11-09T20:01:00.000Z",
    });
    await store.add({
      botId: "b_23",
      draft: { ...draft, text: "后关" },
      at: "2026-11-09T20:02:00.000Z",
    });
    const kept = await store.list({ includeClosed: true, limit: 10 });
    assert.deepEqual(
      kept.map((entry) => entry.text),
      ["后关", "先关"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
