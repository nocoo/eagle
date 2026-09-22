import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessPane,
  changesBetween,
  summarize,
} from "../src/shared/assessment.ts";
import { evidence, NOW, report } from "./fixtures.ts";

test("a working hint supplies activity when native execution evidence has not arrived", () => {
  const pane = report().spaces[0].tabs[0].panes[0];
  pane.hint = "working";
  pane.evidence = [evidence("process", "unknown")];
  const assessment = assessPane(pane, NOW);
  assert.equal(assessment.state, "active");
  assert.match(assessment.reason, /Herdr/);
  assert.match(assessment.reason, /未验证|待核对/);
  pane.evidence.push(evidence("test", "failure"));
  assert.equal(assessPane(pane, NOW).state, "attention");
});

for (const hint of ["done", "idle", "blocked"] as const) {
  test(`a ${hint} pane is not a task conclusion`, () => {
    const pane = report().spaces[0].tabs[0].panes[0];
    pane.hint = hint;
    assert.equal(assessPane(pane, NOW).state, "unverified");
  });
}
test("verified completion requires final summary, goal, Git, tests and required live evidence", () => {
  const pane = report().spaces[0].tabs[0].panes[0];
  pane.evidence = [
    evidence("summary", "success"),
    evidence("goal", "success"),
    evidence("git", "success", { revision: "abc" }),
    evidence("test", "success", { revision: "abc" }),
  ];
  assert.equal(assessPane(pane, NOW).state, "unverified");
  pane.evidence.push(evidence("deployment", "success", { revision: "abc" }));
  assert.equal(assessPane(pane, NOW).state, "verified");
  pane.evidence.push(
    evidence("test", "failure", { observedAt: "2026-09-19T05:51:00.000Z" }),
  );
  assert.equal(assessPane(pane, "2026-09-19T05:52:00.000Z").state, "attention");
});
test("active goal/process override done; another task, stale and mismatched revision evidence cannot certify", () => {
  const pane = report().spaces[0].tabs[0].panes[0];
  pane.evidence = [evidence("goal", "running")];
  assert.equal(assessPane(pane, NOW).state, "active");
  pane.evidence = [evidence("goal", "failure", { taskId: "old-task" })];
  assert.equal(assessPane(pane, NOW).state, "unverified");
  pane.evidence = [
    evidence("goal", "failure", { observedAt: "2026-09-01T00:00:00.000Z" }),
  ];
  assert.equal(assessPane(pane, NOW).state, "unverified");
  pane.evidence = [
    evidence("summary", "success"),
    evidence("goal", "success"),
    evidence("git", "success", { revision: "new" }),
    evidence("test", "success", { revision: "old" }),
    evidence("deployment", "success", { revision: "old" }),
  ];
  assert.equal(assessPane(pane, NOW).state, "unverified");
});
test("executive summary and history report meaningful task changes including closed spaces", () => {
  const before = report();
  const after = report("report-2");
  after.spaces[0].tabs[0].panes[0].evidence = [evidence("goal", "running")];
  assert.equal(summarize(after).counts.active, 1);
  assert.match(changesBetween(before, after).join(" "), /Eagle/);
  after.spaces = [];
  assert.match(changesBetween(before, after).join(" "), /关闭|移除/);
});

test("contradictory evidence at an identical time does not become verified by array order", () => {
  const pane = report().spaces[0].tabs[0].panes[0];
  pane.evidence = [evidence("test", "failure"), evidence("test", "success")];
  assert.equal(assessPane(pane, NOW).state, "attention");
});

test("an explicit failed process cannot be masked by completion claims", () => {
  const pane = report().spaces[0].tabs[0].panes[0];
  pane.evidence = [
    evidence("summary", "success"),
    evidence("goal", "success"),
    evidence("git", "success", { revision: "abc" }),
    evidence("test", "success", { revision: "abc" }),
    evidence("deployment", "success", { revision: "abc" }),
    evidence("process", "failure"),
  ];
  assert.equal(assessPane(pane, NOW).state, "attention");
});
