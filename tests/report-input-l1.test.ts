import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactHour,
  projectHour,
} from "../packages/contracts/src/report-input.ts";
import { evidence, report, telemetry } from "./fixtures.ts";

const terminalEvidence = (
  id: string,
  at: string,
  taskId: string,
  summary: string,
) => ({
  id,
  kind: "evidence",
  observations: [at],
  value: JSON.stringify({
    source: "herdr:visible (current screen, not final)",
    spaceId: "s",
    tabId: "t",
    paneId: "p",
    taskId,
    status: "unknown",
    summary,
  }),
});

test("projectHour ignores non-evidence and non-visible records", () => {
  const records = [
    { id: "P1", kind: "pane", observations: ["t"], value: "{}" },
    {
      id: "E1",
      kind: "evidence",
      observations: ["t"],
      value: JSON.stringify({ source: "codex:final", summary: "skip" }),
    },
    terminalEvidence("E2", "t", "task", "keep"),
  ];
  const projected = projectHour(records);
  assert.deepEqual(
    projected.records.map((record) => record.id).sort(),
    ["E1", "E2", "P1"],
  );
});

test("projectHour keeps first and latest duplicates ordered by observation time", () => {
  const projected = projectHour([
    terminalEvidence("E1", "2026-01-01T00:00:00.000Z", "task", "first"),
    terminalEvidence("E2", "2026-01-01T00:30:00.000Z", "task", "middle"),
    terminalEvidence("E3", "2026-01-01T01:00:00.000Z", "task", "latest"),
  ]);
  assert.equal(projected.terminalSampling.retainedRecords, 2);
  assert.deepEqual(
    projected.records
      .filter((record) => record.kind === "evidence")
      .map((record) => JSON.parse(record.value).summary),
    ["first", "latest"],
  );
});

test("compactHour exposes null bounds without snapshots", () => {
  assert.deepEqual(compactHour([]), {
    records: [],
    snapshots: 0,
    firstObservedAt: null,
    lastObservedAt: null,
  });
});

test("projectHour tolerates missing observation timestamps in a group", () => {
  const projected = projectHour([
    {
      ...terminalEvidence("E1", "", "task", "first"),
      observations: [],
    },
    terminalEvidence("E2", "2026-01-01T01:00:00.000Z", "task", "last"),
  ]);
  assert.equal(projected.terminalSampling.retainedRecords, 2);
});

test("compactHour records pane and evidence facts with stable canonical keys", () => {
  const value = report("input-l1", "2026-09-19T11:00:00.000Z");
  value.machine.telemetry = telemetry(value.capturedAt) as typeof value.machine.telemetry;
  const pane = value.spaces[0].tabs[0].panes[0];
  pane.evidence = [evidence("goal", "running", { observedAt: value.capturedAt })];
  const first = compactHour([value]);
  const second = compactHour([value, value]);
  assert.equal(first.records.filter((record) => record.kind === "evidence").length, 1);
  assert.equal(second.snapshots, 2);
  assert.equal(
    first.records.find((record) => record.kind === "pane")?.observations.length,
    1,
  );
});
