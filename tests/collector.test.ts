import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSnapshot,
  redact,
  sendReport,
} from "../packages/agent/collector.ts";
import { report } from "./fixtures.ts";

test("normalizes all workspaces including nonfocused tabs and rects, never trusts done", () => {
  const snapshot = {
    workspaces: [
      { workspace_id: "w1", label: "Build" },
      { workspace_id: "w2", label: "Other" },
    ],
    tabs: [
      { workspace_id: "w1", tab_id: "t1", label: "one" },
      { workspace_id: "w1", tab_id: "t2", label: "two" },
    ],
    panes: [
      {
        workspace_id: "w1",
        tab_id: "t2",
        pane_id: "p1",
        agent: "codex",
        agent_status: "done",
        terminal_title_stripped: "Ship",
      },
    ],
    layouts: [
      {
        tab_id: "t2",
        area: { x: 0, y: 0, width: 100, height: 50 },
        panes: [
          { pane_id: "p1", rect: { x: 50, y: 0, width: 50, height: 50 } },
        ],
      },
    ],
  };
  const spaces = normalizeSnapshot(snapshot, "work");
  assert.equal(spaces.length, 2);
  assert.equal(spaces[0].tabs.length, 2);
  const pane = spaces[0].tabs[1].panes[0];
  assert.deepEqual(pane.rect, { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.equal(pane.hint, "done");
  assert.equal(pane.evidence.length, 0);
  assert.equal(spaces[0].id, "work:w1");
  snapshot.panes[0].agent = "grok";
  const before = normalizeSnapshot(snapshot, "work")[0].tabs[1].panes[0].task
    .id;
  snapshot.panes[0].terminal_title_stripped = "Thinking · 12s";
  assert.equal(
    normalizeSnapshot(snapshot, "work")[0].tabs[1].panes[0].task.id,
    before,
    "Animated titles must not manufacture a new task",
  );
});
test("redacts tokens, Authorization, env secrets and PEM before reports leave a machine", () => {
  const text =
    'Authorization: Bearer abcdef123456\nAPI_KEY=some-secret\nPASSWORD="hello world"\nsk-proj-123456789abcdefghijklmn\nknown-secret\n-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----';
  const clean = redact(text, ["known-secret"]);
  for (const secret of [
    "abcdef123456",
    "some-secret",
    "hello world",
    "sk-proj-123456789abcdefghijklmn",
    "known-secret",
    "ABC",
  ])
    assert(!clean.includes(secret));
  assert.equal(
    redact("Copied eag1.header.payload.signature"),
    "Copied [REDACTED]",
  );
});
test("upload retries reuse the identical ID/body; permanent auth failures stop; redirects never forward credentials", async () => {
  const value = report();
  const bodies: string[] = [];
  let attempts = 0;
  await sendReport(
    "https://eagle.test",
    "secret",
    value,
    async (_url, init) => {
      bodies.push(String(init?.body));
      assert.equal(init?.redirect, "error");
      return Response.json(
        { accepted: true, duplicate: false, seq: 1 },
        { status: ++attempts < 2 ? 503 : 201 },
      );
    },
    0,
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  attempts = 0;
  await assert.rejects(
    sendReport(
      "https://eagle.test",
      "secret",
      value,
      async () => {
        attempts++;
        return new Response("{}", { status: 401 });
      },
      0,
    ),
    /401/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    sendReport("http://remote.test", "secret", value),
    /HTTPS/,
  );
});

test("Codex transcript adapter uses final messages and explicit turn events, never tool/analysis text", async () => {
  const { transcriptEvidence } = await import("../packages/agent/collector.ts");
  const events = [
    {
      timestamp: "2026-09-19T05:00:00Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn1" },
    },
    {
      timestamp: "2026-09-19T05:01:00Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "analysis",
        content: [{ text: "secret reasoning" }],
      },
    },
    {
      timestamp: "2026-09-19T05:02:00Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final",
        content: [{ text: "已发布 Eagle，但仍需线上验证" }],
      },
    },
    {
      timestamp: "2026-09-19T05:02:01Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    },
  ];
  const result = transcriptEvidence(
    events.map((e) => JSON.stringify(e)).join("\n"),
    "task1",
  );
  assert(
    result.some((e) => e.kind === "summary" && e.summary.includes("已发布")),
  );
  assert(!JSON.stringify(result).includes("secret reasoning"));
  assert(!result.some((e) => e.kind === "process" && e.status === "running"));
  events.push({
    timestamp: "2026-09-19T05:03:00Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn2" },
  });
  const next = transcriptEvidence(
    events.map((e) => JSON.stringify(e)).join("\n"),
    "task1",
  );
  assert(!next.some((e) => e.kind === "summary"));
  assert(next.some((e) => e.kind === "process" && e.status === "running"));
});

test("native final_answer phase emitted by installed Codex is recognized", async () => {
  const { transcriptEvidence } = await import("../packages/agent/collector.ts");
  const line = JSON.stringify({
    timestamp: "2026-09-19T05:00:00Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "部署已完成，真实浏览器验证通过。" }],
    },
  });
  assert.equal(transcriptEvidence(line, "task")[0]?.kind, "summary");
});

test("bounded transcript tails still recognize actual tool execution without a pane badge", async () => {
  const { transcriptEvidence } = await import("../packages/agent/collector.ts");
  const line = JSON.stringify({
    timestamp: "2026-09-19T05:00:00Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input: "private arguments",
    },
  });
  const ev = transcriptEvidence(line, "task");
  assert.equal(ev[0]?.status, "running");
  assert(!JSON.stringify(ev).includes("private arguments"));
});

test("a new native turn changes task identity, including a bounded tail with only item events", async () => {
  const { transcriptContext } = await import("../packages/agent/collector.ts");
  const one = JSON.stringify({
    timestamp: "2026-09-19T05:00:00Z",
    type: "event_msg",
    payload: { type: "item_completed", turn_id: "turn-one" },
  });
  const two = JSON.stringify({
    timestamp: "2026-09-19T05:01:00Z",
    type: "event_msg",
    payload: { type: "item_completed", turn_id: "turn-two" },
  });
  assert.equal(transcriptContext(one)?.turnId, "turn-one");
  assert.equal(transcriptContext(`${one}\n${two}`)?.turnId, "turn-two");
});

test("stopped sessions retain last known topology and are explicitly unavailable", async () => {
  const { preserveStopped } = await import("../packages/agent/collector.ts");
  const prior = report();
  const result = preserveStopped([], prior.spaces, ["default"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].availability, "unavailable");
});

test("portable conversation identity changes with the latest real user prompt", async () => {
  const { conversationTaskId } = await import("../packages/agent/collector.ts");
  const first = JSON.stringify({ type: "user", content: [{ text: "Ship A" }] });
  const second = JSON.stringify({
    type: "user",
    content: [{ text: "Ship B" }],
  });
  assert.notEqual(
    conversationTaskId(first, "session"),
    conversationTaskId(`${first}\n${second}`, "session"),
  );
});

test("native Grok/Pi finals belong only to the latest real user task and never certify tests", async () => {
  const { conversationEvidence } = await import(
    "../packages/agent/collector.ts"
  );
  const at = "2026-09-19T10:00:00.000Z";
  const grok = [
    { type: "user", content: "Ship A" },
    { type: "assistant", content: "Tests passed, deploy pending" },
    { type: "user", synthetic_reason: "context", content: "reminder" },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  const found = conversationEvidence(grok, "grok", "task-a", at);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "unknown");
  assert.equal(found[0].source, "grok:final-message");
  assert.equal(
    conversationEvidence(
      `${grok}\n${JSON.stringify({ type: "user", content: "Ship B" })}`,
      "grok",
      "task-b",
      at,
    ).length,
    0,
  );
  const pi = [
    { type: "message", message: { role: "user", content: "Ship A" } },
    {
      type: "message",
      timestamp: at,
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Implemented A" },
        ],
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  assert.equal(
    conversationEvidence(pi, "pi", "task-a", at)[0].summary,
    "Implemented A",
  );
});
