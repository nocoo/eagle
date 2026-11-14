import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../packages/contracts/src/assessment.ts";
import {
  parseTerminalScreen,
  restyleRedactedText,
  terminalColor,
} from "../packages/contracts/src/terminal.ts";
import { compactRenderedFrame } from "../packages/contracts/src/terminal-display.ts";
import { terminalLinkParts } from "../packages/contracts/src/terminal-links.ts";
import { report } from "./fixtures.ts";

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
    [
      { text: "prefix ", fg: 2 },
      { text: "suffix", fg: 3 },
    ],
    "prefix [REDACTED] suffix",
  );
  assert.equal(
    restyled.map((run) => run.text).join(""),
    "prefix [REDACTED] suffix",
  );
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
  assert.equal(
    parts.find((part) => part.href)?.href,
    "https://example.test/foo",
  );
});
