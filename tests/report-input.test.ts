import assert from "node:assert/strict";
import { test } from "node:test";
import { DailySettingsSchema } from "../src/shared/daily.ts";
import {
  compactHour,
  projectHour,
  utcHour,
} from "../src/shared/report-input.ts";
import { sealAiKey, unsealAiKey } from "../src/worker/ai-secret.ts";
import { complete } from "../src/worker/daily.ts";
import { report } from "./fixtures.ts";

test("UI credentials use authenticated encryption bound to their AI endpoint", async () => {
  const key = "unique-test-credential";
  const master = "isolated-encryption-master-at-least-32-characters";
  const sealed = await sealAiKey(key, master, "custom:https://ai.example/v1");
  assert(!JSON.stringify(sealed).includes(key));
  assert.equal(await unsealAiKey(sealed, master, sealed.endpoint), key);
  await assert.rejects(
    unsealAiKey(sealed, master, "custom:https://another.example/v1"),
    { name: "AIEndpointMismatchError" },
  );
  assert.notEqual(
    (await sealAiKey(key, master, sealed.endpoint)).data,
    sealed.data,
  );
  await assert.rejects(
    unsealAiKey(
      { ...sealed, endpoint: "custom:https://another.example/v1" },
      master,
      "custom:https://another.example/v1",
    ),
  );
  await assert.rejects(
    unsealAiKey(
      sealed,
      "different-encryption-master-at-least-32-characters",
      sealed.endpoint,
    ),
  );
  await assert.rejects(sealAiKey(key, undefined, sealed.endpoint));
});

test("hour inputs keep closed panes, task changes, every evidence and independent semantic times", () => {
  const first = report("start", "2026-09-19T09:01:00.000Z");
  const second = structuredClone(first);
  second.reportId = "end";
  second.capturedAt = "2026-09-19T09:59:00.000Z";
  second.spaces[0].tabs[0].panes = [];
  const input = compactHour(
    [first, second],
    [
      {
        seq: 7,
        hour: utcHour(first.capturedAt),
        value: {
          observedAt: "2026-09-19T09:17:00.000Z",
          taskId: "task-1",
          summary: "完成代码检查",
        },
      },
    ],
  );
  assert(
    input.records.some(
      (r) => r.kind === "pane" && JSON.stringify(r.value).includes("w1:p1"),
    ),
  );
  assert.equal(input.records.filter((r) => r.kind === "inventory").length, 2);
  assert.equal(input.records.filter((r) => r.kind === "semantic").length, 1);
  assert.equal(input.snapshots, 2);
  const repeated = compactHour(
    [first, { ...first, reportId: "again", capturedAt: second.capturedAt }],
    [],
  );
  const pane = repeated.records.find((r) => r.kind === "pane");
  assert.deepEqual(pane?.observations, [first.capturedAt, second.capturedAt]);
  assert.equal(repeated.records.filter((r) => r.kind === "pane").length, 1);
});

test("model input bounds terminal repetition per task without changing raw evidence or hiding closed tasks", () => {
  const reports = Array.from({ length: 120 }, (_, i) => {
    const value = report(
      `screen-${i}`,
      new Date(Date.UTC(2026, 8, 21, 0, 0, i * 30)).toISOString(),
    );
    const pane = value.spaces[0].tabs[0].panes[0];
    pane.task.id = i < 60 ? "closed-task" : "current-task";
    pane.evidence = [
      {
        kind: "summary",
        status: "unknown",
        source: "herdr:visible (current screen, not final)",
        observedAt: value.capturedAt,
        taskId: pane.task.id,
        summary: `screen ${i}: ${"terminal text ".repeat(120)}`,
      },
    ];
    if (i === 30)
      pane.evidence.push({
        kind: "test",
        status: "failure",
        source: "native:test",
        observedAt: value.capturedAt,
        taskId: pane.task.id,
        summary: "The intermediate test failed",
      });
    if (i === 59)
      pane.evidence.push({
        kind: "summary",
        status: "unknown",
        source: "codex:final-message",
        observedAt: value.capturedAt,
        taskId: pane.task.id,
        summary: "The closed task still needs verification",
      });
    return value;
  });
  const raw = compactHour(reports, [
    {
      value: {
        observedAt: reports[70].capturedAt,
        taskId: "current-task",
        summary: "Semantic change",
      },
    },
  ]);
  const original = structuredClone(raw);
  const projected = projectHour(raw.records);
  assert.deepEqual(raw, original);
  assert.equal(projected.terminalSampling.sourceRecords, 120);
  assert.equal(projected.terminalSampling.retainedRecords, 4);
  const terminal = projected.records.filter((r) =>
    JSON.parse(r.value).source?.startsWith("herdr:visible"),
  );
  assert.deepEqual(
    terminal.map((r) => JSON.parse(r.value).summary.split(":")[0]),
    ["screen 0", "screen 59", "screen 60", "screen 119"],
  );
  assert(
    projected.records.some((r) => r.value.includes("intermediate test failed")),
  );
  assert(
    projected.records.some((r) =>
      r.value.includes("closed task still needs verification"),
    ),
  );
  assert.equal(
    projected.records.filter((r) => r.kind === "semantic").length,
    1,
  );
  assert(
    projected.records.every((r) =>
      raw.records.some(
        (source) => source.id === r.id && source.value === r.value,
      ),
    ),
  );
  assert(
    JSON.stringify(projected.records).length <
      JSON.stringify(raw.records).length / 3,
  );
});

test("truncated model responses fail explicitly before partial JSON can be archived", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      id: "truncated",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: {
            role: "assistant",
            content: '{"executiveSummary":"截断的报告',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
    }),
  );
  await assert.rejects(
    complete(
      DailySettingsSchema.parse({
        provider: "custom",
        model: "test",
        baseURL: "https://api.ai.example/v1",
      }),
      { AI_API_KEY: "isolated-test-key" } as Env,
      "测试",
    ),
    { name: "AIOutputTruncatedError" },
  );
});
