import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DailySettingsSchema,
  dailyCutoff,
  dailyDate,
  dailyStart,
  dueDate,
  parseDailyReport,
  sampleHour,
  validDate,
} from "../src/shared/daily.ts";
import { completeReport } from "../src/worker/daily.ts";

test("daily generation retries a transient model error once and never retries authentication failures", async (t) => {
  let calls = 0;
  let status = 500;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("Unavailable", { status });
  });
  const settings = DailySettingsSchema.parse({
    provider: "custom",
    model: "test",
    baseURL: "https://api.ai.example/v1",
  });
  const env = { AI_API_KEY: "isolated-test-key" } as Env;
  await assert.rejects(
    completeReport(settings, env, "测试", [], AbortSignal.timeout(1000)),
  );
  assert.equal(calls, 2);
  status = 401;
  await assert.rejects(
    completeReport(settings, env, "测试", [], AbortSignal.timeout(1000)),
  );
  assert.equal(calls, 3);
});

test("one daily cron starts at 23:59 Beijing and preserves calendar boundaries", () => {
  assert.equal(dailyDate("2026-09-27T16:00:00Z"), "2026-09-28");
  assert.equal(dailyStart("2026-09-27"), "2026-09-26T16:00:00.000Z");
  assert.equal(dailyCutoff("2026-09-27"), "2026-09-27T15:59:00.000Z");
  assert.equal(dueDate(Date.parse("2026-09-27T15:58:59Z")), "2026-09-26");
  assert.equal(dueDate(Date.parse("2026-09-27T15:59:00Z")), "2026-09-27");
  assert.equal(dueDate(Date.parse("2026-09-27T16:00:00Z")), "2026-09-27");
  assert(!validDate("2026-02-30"));
  assert(!validDate("2026-9-27"));
  assert.equal(
    DailySettingsSchema.safeParse({ intervalHours: 24 }).success,
    false,
  );
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  assert.deepEqual(config.triggers.crons, ["59 15 * * *"]);
});

const ids = Array.from(
  { length: 24 },
  (_, hour) => new Set(hour === 9 ? ["H09-F1"] : []),
);
const content = () => ({
  overview: "今日完成检查，部署仍待核实。",
  hours: ids.map((evidence, hour) => ({
    hour,
    summary: evidence.size ? "检查通过，部署待核实。" : "无采集数据。",
    evidenceIds: [...evidence],
  })),
  nextSteps: ["核对生产部署。"],
});

test("daily output enforces exact shape, 24 ordered hours, Chinese and every length budget", () => {
  const valid = content();
  assert.deepEqual(parseDailyReport(JSON.stringify(valid), ids), valid);
  for (const change of [
    { overview: "字".repeat(161) },
    { nextSteps: ["字".repeat(61)] },
    { nextSteps: ["一", "二", "三", "四"] },
    { extra: "多余字段" },
    { overview: "English only" },
    { hours: valid.hours.slice(1) },
    { hours: valid.hours.toReversed() },
    {
      hours: valid.hours.map((h) =>
        h.hour === 9 ? { ...h, summary: "字".repeat(81) } : h,
      ),
    },
  ])
    assert.throws(() =>
      parseDailyReport(JSON.stringify({ ...valid, ...change }), ids),
    );
});

test("daily citations cannot cross hours, invent sources or call missing data inactivity", () => {
  for (const change of [
    { evidenceIds: ["H10-F1"] },
    { evidenceIds: [] },
    { summary: "已经发布。[H09-F999]" },
  ]) {
    const value = content();
    Object.assign(value.hours[9], change);
    assert.throws(() => parseDailyReport(JSON.stringify(value), ids));
  }
  const value = content();
  value.hours[0].summary = "本小时没有工作。";
  assert.throws(() => parseDailyReport(JSON.stringify(value), ids));
});

test("bounded input prioritizes semantic evidence and discloses omissions without mutating sources", () => {
  const records = Array.from({ length: 150 }, (_, i) => ({
    id: `F${i + 1}`,
    kind: "pane",
    observations: ["2026-09-27T01:00:00.000Z"],
    value: JSON.stringify({
      summary: "素材".repeat(2000),
      taskId: `task-${i}`,
    }),
  }));
  records.push({
    id: "S1",
    kind: "semantic",
    observations: ["2026-09-27T01:30:00.000Z"],
    value: JSON.stringify({ summary: "Manager 声称检查通过，仍待核实。" }),
  });
  const original = structuredClone(records);
  const sampled = sampleHour(records, 9);
  assert(JSON.stringify(sampled.records).length <= 4000);
  assert(sampled.records.some((r) => r.id === "H09-S1"));
  assert(sampled.omittedRecords > 0);
  assert(sampled.excerptedRecords > 0);
  assert.deepEqual(records, original);
  assert(sampled.records.every((r) => r.id.startsWith("H09-")));
});

test("semantic sampling keeps task identity and progress ahead of bulky evidence metadata", () => {
  const value = JSON.stringify({
    contentHash: "hash",
    value: {
      basis: Array.from({ length: 30 }, () => "a".repeat(64)),
      evidence: Array.from({ length: 30 }, () => ({
        summary: "原始材料".repeat(200),
      })),
      spaceId: "space-one",
      paneId: "pane-one",
      taskId: "task-one",
      observedAt: "2026-09-27T01:00:00Z",
      summary: {
        task: "日报改造",
        phase: "verify",
        progress: "接口校验通过，生产尚未部署",
        outcomes: [],
        blocker: null,
        nextStep: "检查生产",
        rationale: "管理器声称",
        evidenceRefs: [],
      },
    },
  });
  const sampled = sampleHour(
    [
      {
        id: "S1",
        kind: "semantic",
        observations: ["2026-09-27T01:00:00Z"],
        value,
      },
    ],
    9,
  );
  assert(sampled.records[0].value.includes("task-one"));
  assert(sampled.records[0].value.includes("接口校验通过，生产尚未部署"));
  assert.equal(sampled.excerptedRecords, 1);
});

test("daily retry receives every populated hour mistaken for missing data with its real citations", async (t) => {
  const inputIds = Array.from(
    { length: 24 },
    (_, hour) => new Set(hour < 8 ? [`H0${hour}-F1`] : []),
  );
  const valid = {
    overview: "夜间有采集，尚无新进展证据。",
    hours: inputIds.map((ids, hour) => ({
      hour,
      summary: ids.size ? "仅采集到旧状态，暂无新进展证据。" : "无采集数据。",
      evidenceIds: [...ids],
    })),
    nextSteps: [],
  };
  const bad = {
    ...valid,
    hours: valid.hours.map((h) => ({
      ...h,
      summary: "无采集数据。",
      evidenceIds: [],
    })),
  };
  const prompts: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      prompts.push(JSON.stringify(JSON.parse(String(init?.body))));
      return Response.json({
        id: "daily-retry",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(prompts.length === 1 ? bad : valid),
            },
          },
        ],
      });
    },
  );
  const result = await completeReport(
    DailySettingsSchema.parse({
      provider: "custom",
      model: "test",
      baseURL: "https://api.ai.example/v1",
    }),
    { AI_API_KEY: "isolated-test-key" } as Env,
    "测试日报",
    inputIds,
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(result, valid);
  assert.equal(prompts.length, 2);
  for (let hour = 0; hour < 8; hour++)
    assert(prompts[1].includes(`H0${hour}-F1`));
});
