import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../packages/contracts/src/assessment.ts";
import { parseDailyReport } from "../packages/contracts/src/daily.ts";
import { projectHour } from "../packages/contracts/src/report-input.ts";
import { compactRenderedFrame } from "../packages/contracts/src/terminal-display.ts";
import { terminalLinkParts } from "../packages/contracts/src/terminal-links.ts";
import {
  parseTerminalScreen,
  restyleRedactedText,
  terminalColor,
} from "../packages/contracts/src/terminal.ts";
import { report } from "./fixtures.ts";

const dailyHours = () =>
  Array.from({ length: 24 }, (_, hour) => ({
    hour,
    summary: "无采集数据。",
    evidenceIds: [] as string[],
  }));

test("parseDailyReport separates missing-data and stale-state failures", () => {
  const idsForStale = Array.from({ length: 24 }, () => new Set<string>());
  idsForStale[3] = new Set(["H03-F1"]);
  assert.throws(
    () =>
      parseDailyReport(
        JSON.stringify({
          overview: "夜间仅有旧状态，需要引用证据。",
          hours: dailyHours().map((hour) =>
            hour.hour === 3
              ? { hour: 3, summary: "无采集数据。", evidenceIds: [] }
              : hour,
          ),
          nextSteps: [],
        }),
        idsForStale,
      ),
    { name: "DailyEvidenceError" },
  );
  const idsForMissing = Array.from({ length: 24 }, () => new Set<string>());
  idsForMissing[5] = new Set(["H05-F1"]);
  assert.throws(
    () =>
      parseDailyReport(
        JSON.stringify({
          overview: "上午缺失引用需要足够长度的概述文本。",
          hours: dailyHours().map((hour) =>
            hour.hour === 5
              ? { hour: 5, summary: "仅见旧状态，尚无新进展证据。", evidenceIds: [] }
              : hour,
          ),
          nextSteps: [],
        }),
        idsForMissing,
      ),
    { name: "DailyEvidenceError" },
  );
  assert.throws(
    () =>
      parseDailyReport(
        JSON.stringify({
          overview: "引用未知证据 [H08-F9] 的概述文本。",
          hours: dailyHours(),
          nextSteps: [],
        }),
        Array.from({ length: 24 }, () => new Set<string>()),
      ),
    /Invalid overview evidence/,
  );
});

test("projectHour breaks ties when observations are missing", () => {
  const evidence = (id: string, observations: string[]) => ({
    id,
    kind: "evidence",
    observations,
    value: JSON.stringify({
      source: "herdr:visible (current screen, not final)",
      spaceId: "s",
      tabId: "t",
      paneId: "p",
      taskId: "task",
      status: "unknown",
      summary: id,
    }),
  });
  const projected = projectHour([
    evidence("A", []),
    evidence("B", ["2026-01-01T00:00:00.000Z"]),
  ]);
  assert.equal(projected.records.length, 2);
});

test("summarize marks unavailable spaces as unverified", () => {
  const value = report();
  value.spaces[0].availability = "unavailable";
  assert.equal(summarize(value).spaces[0].state, "unverified");
});

test("summarize escalates attention and active panes", () => {
  const empty = report();
  empty.spaces[0].tabs[0].panes = [];
  assert.equal(summarize(empty).spaces[0].state, "unverified");
  const active = report("active");
  active.spaces[0].tabs[0].panes[0].evidence = [
    {
      kind: "goal",
      status: "running",
      summary: "running",
      source: "test",
      observedAt: active.capturedAt,
      taskId: active.spaces[0].tabs[0].panes[0].task.id,
    },
  ];
  assert.equal(summarize(active).spaces[0].state, "active");
  const attention = report("attention");
  attention.spaces[0].tabs[0].panes[0].evidence = [
    {
      kind: "test",
      status: "failure",
      summary: "failed",
      source: "test",
      observedAt: attention.capturedAt,
      taskId: attention.spaces[0].tabs[0].panes[0].task.id,
    },
  ];
  assert.equal(summarize(attention).spaces[0].state, "attention");
});

test("terminal rendering preserves unmatched edited lines and styled redaction", () => {
  const aligned = compactRenderedFrame({
    type: "frame",
    spaceId: "s",
    subscriptionId: "sub",
    paneId: "p",
    terminalId: "t",
    revision: 1,
    observedAt: new Date().toISOString(),
    text: "plain\nbody",
    runs: [{ text: "plain", bold: true }],
  });
  const rebuilt = compactRenderedFrame({
    ...aligned,
    text: "rebuilt\nbody",
  });
  assert.equal(rebuilt.text, "rebuilt\nbody");
  const restyled = restyleRedactedText(
    [{ text: "prefix ", fg: 2 }, { text: "suffix", fg: 3 }],
    "prefix [REDACTED] suffix",
  );
  assert.equal(restyled.map((run) => run.text).join(""), "prefix [REDACTED] suffix");
  for (const color of [0, 8, 15, 200, 232, 255] as const)
    assert.match(terminalColor(color) ?? "", /^(var\(|rgb\()/);
  for (const value of [
    "\u001b[2mdim\u001b[0m",
    "\u001b[8mhidden\u001b[28mshown\u001b[0m",
    "\u001b[38;99;1mignored\u001b[0m",
    "\u001b[38;5;300mout-of-range\u001b[0m",
    "\u001b[38;2;1;2mincomplete\u001b[0m",
    "\u001b[48;5;12mbackground\u001b[0m",
    "\u001b[100mbright-bg\u001b[0m",
  ]) {
    const screen = parseTerminalScreen(value);
    assert.equal(screen.runs.map((run) => run.text).join(""), screen.text);
  }
});

test("terminal links trim unmatched trailing braces", () => {
  const text = "see https://example.test/foo}";
  const parts = terminalLinkParts(text);
  assert.equal(parts.find((part) => part.href)?.href, "https://example.test/foo");
});
