import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changesBetween,
  summarize,
} from "../packages/contracts/src/assessment.ts";
import { canonical, digest } from "../packages/contracts/src/canonical.ts";
import {
  onboardingPrompt,
  type Registration,
} from "../packages/contracts/src/connect.ts";
import {
  approvalPayload,
  canonicalDeviceJSON,
  deviceBase64,
  deviceBytes,
  OperationRequest,
  verifyDeviceSignature,
} from "../packages/contracts/src/devices.ts";
import {
  parseTerminalScreen,
  terminalColor,
} from "../packages/contracts/src/terminal.ts";
import { compactRenderedFrame } from "../packages/contracts/src/terminal-display.ts";
import { evidence, report } from "./fixtures.ts";

test("canonical JSON and digest stay deterministic", async () => {
  const value = { z: 1, a: [2, { b: 3 }] };
  assert.equal(canonical(value), '{"a":[2,{"b":3}],"z":1}');
  const hash = await digest(value);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(await digest(value), hash);
});

test("terminal styling covers reset codes and color tables", () => {
  const screen = parseTerminalScreen(
    "\u001b[1;31mA\u001b[22mB\u001b[3mC\u001b[23mD\u001b[4mE\u001b[24mF\u001b[7mG\u001b[27mH\u001b[39mI\u001b[49mJ\u001b[38;5;196mK\u001b[48;2;1;2;3mL\u001b[0m",
  );
  assert.equal(screen.runs.map((run) => run.text).join(""), screen.text);
  assert.equal(
    parseTerminalScreen("\u001b[=bad\u001b[38;5m\u001b[0m").text,
    "ad",
  );
  for (const color of [0, 8, 15, 196, 231, 255] as const)
    assert.match(terminalColor(color) ?? "", /^(var\(|rgb\()/);
  assert.equal(terminalColor([10, 20, 30]), "rgb(10, 20, 30)");
});

test("compactRenderedFrame falls back when edited text no longer aligns", () => {
  const frame = {
    type: "frame" as const,
    spaceId: "s",
    subscriptionId: "sub",
    paneId: "p",
    terminalId: "t",
    revision: 1,
    observedAt: new Date().toISOString(),
    text: "line1\n› Ask Codex to do anything\n\n  gpt-test · /tmp\n",
    runs: [{ text: "line1", fg: 2 }],
  };
  const compact = compactRenderedFrame(frame);
  assert.notEqual(compact.text, frame.text);
  assert.equal(
    compact.runs?.some((run) => run.text.includes("line1")),
    true,
  );
});

test("device helpers round-trip and validation stays strict", async () => {
  const bytes = new Uint8Array([1, 2, 254]);
  const encoded = deviceBase64(bytes);
  assert.deepEqual(deviceBytes(encoded), bytes);
  const json = canonicalDeviceJSON({ b: 1, a: [2] });
  assert.equal(json, '{"a":[2],"b":1}');
  assert.equal(
    OperationRequest.safeParse({
      action: "run",
      requestId: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000002",
      targetDeviceId: "00000000-0000-4000-8000-000000000003",
    }).success,
    false,
  );
  const badKey = deviceBase64(new Uint8Array(8));
  assert.equal(
    await verifyDeviceSignature(
      badKey,
      "payload",
      deviceBase64(new Uint8Array(64)),
    ),
    false,
  );
  assert.match(
    approvalPayload({
      operationId: "op",
      sourceDeviceId: "a",
      targetDeviceId: "b",
      digest: "d".repeat(64),
      policyVersion: 1,
      expiresAt: 1,
    }),
    /^eagle-device-approval-v1/,
  );
});

test("assessment history captures topology and availability transitions", () => {
  const base = report();
  assert.match(changesBetween(null, base).join(" "), /首次接入/);
  const unavailable = report("report-2");
  unavailable.spaces[0].availability = "unavailable";
  assert.match(changesBetween(base, unavailable).join(" "), /Session 已停止/);
  const restored = report("report-3");
  restored.spaces[0].objective = "新目标";
  restored.spaces[0].tabs[0].panes[0].task = {
    ...restored.spaces[0].tabs[0].panes[0].task,
    title: "重命名",
  };
  const withSpace = report("report-4");
  withSpace.spaces.push({
    ...structuredClone(withSpace.spaces[0]),
    id: "space:new",
    name: "New Space",
  });
  const withPane = report("report-5");
  withPane.spaces[0].tabs[0].panes.push({
    ...structuredClone(withPane.spaces[0].tabs[0].panes[0]),
    id: "pane:new",
    agent: "worker",
  });
  const reasonShift = report("report-reason");
  const followUp = report("report-reason-2");
  followUp.spaces[0].tabs[0].panes[0].evidence = [
    evidence("process", "running"),
  ];
  const moved = report("report-6");
  moved.spaces[0].tabs[0].panes[0].rect = {
    x: 9,
    y: 9,
    width: 1,
    height: 1,
  };
  const changes = [
    ...changesBetween(base, unavailable),
    ...changesBetween(unavailable, restored),
    ...changesBetween(restored, withSpace),
    ...changesBetween(withSpace, withPane),
    ...changesBetween(reasonShift, followUp),
    ...changesBetween(withPane, moved),
  ];
  assert.ok(changes.length > 3);
  const verified = report("verified");
  const pane = verified.spaces[0].tabs[0].panes[0];
  pane.hint = "done";
  pane.evidence = [
    {
      kind: "summary",
      status: "success",
      summary: "ok",
      source: "test",
      observedAt: verified.capturedAt,
      taskId: pane.task.id,
    },
    {
      kind: "goal",
      status: "success",
      summary: "ok",
      source: "test",
      observedAt: verified.capturedAt,
      taskId: pane.task.id,
    },
    {
      kind: "git",
      status: "success",
      summary: "ok",
      source: "test",
      observedAt: verified.capturedAt,
      taskId: pane.task.id,
      revision: "abc",
    },
    {
      kind: "test",
      status: "success",
      summary: "ok",
      source: "test",
      observedAt: verified.capturedAt,
      taskId: pane.task.id,
      revision: "abc",
    },
    {
      kind: "deployment",
      status: "success",
      summary: "ok",
      source: "test",
      observedAt: verified.capturedAt,
      taskId: pane.task.id,
      revision: "abc",
    },
  ];
  assert.equal(summarize(verified).spaces[0].state, "verified");
  assert.equal(summarize(restored).spaces[0].state, "unverified");
});

test("onboarding notes dev hosts explicitly", () => {
  const machine: Registration = {
    id: "dev",
    name: "Dev",
    enabled: true,
    source: "managed",
    credentialId: "c",
    createdAt: null,
    rotatedAt: null,
    expiresAt: null,
    watchPorts: [],
  };
  const prompt = onboardingPrompt(
    machine,
    "token",
    "https://eagle.dev.hexly.ai",
    [],
    "1.0.0",
  );
  assert.match(prompt, /本地开发环境/);
});
