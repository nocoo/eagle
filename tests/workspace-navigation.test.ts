import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceTabs } from "../src/web/workspace-navigation.ts";

test("workspace tabs reserve overflow space and always retain the active item", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(workspaceTabs([], "", 0), { visible: [], hidden: [] });
  assert.deepEqual(workspaceTabs(["a"], "a", 0), {
    visible: ["a"],
    hidden: [],
  });
  assert.deepEqual(workspaceTabs(ids, "d", 812), { visible: ids, hidden: [] });
  assert.deepEqual(workspaceTabs(ids, "d", 811), {
    visible: ["a", "b", "d"],
    hidden: ["c"],
  });
  assert.deepEqual(workspaceTabs(ids, "d", 512), {
    visible: ["a", "d"],
    hidden: ["b", "c"],
  });
  assert.deepEqual(workspaceTabs(ids, "d", 511), {
    visible: ["d"],
    hidden: ["a", "b", "c"],
  });
  assert.deepEqual(workspaceTabs(ids, "d", -1), {
    visible: ["d"],
    hidden: ["a", "b", "c"],
  });
  assert.deepEqual(workspaceTabs(ids, "gone", 512), {
    visible: ["a", "b"],
    hidden: ["c", "d"],
  });
});
