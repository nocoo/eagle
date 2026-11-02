// Tool groups (docs/bots/PROTOCOL.md, "Gateway settings"): the core group is mandatory, a
// stored selection is normalized, and an unknown name never survives.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOL_GROUPS, resolveToolGroups } from "../../src/core/domain.ts";

test("core and coding cannot be turned off and unknown names are dropped", () => {
  assert.deepEqual(resolveToolGroups([]), ["core", "coding"]);
  assert.deepEqual(resolveToolGroups(["herdr"]), ["core", "coding", "herdr"]);
  assert.deepEqual(resolveToolGroups(["core"]), ["core", "coding"]);
  assert.deepEqual(resolveToolGroups(["coding"]), ["core", "coding"]);
  assert.deepEqual(resolveToolGroups(["herdr", "web"]), ["core", "coding", "herdr"]);
  assert.deepEqual(resolveToolGroups(["agents"]), ["core", "coding", "agents"]);
  assert.deepEqual(resolveToolGroups(undefined), ["core", "coding"]);
  assert.deepEqual(DEFAULT_TOOL_GROUPS, [
    "persona",
    "machine",
    "core",
    "coding",
    "memory",
    "herdr",
    "agents",
    "trigger",
  ]);
  // Memory is a default because remembering is a habit, and it is still just a group.
  assert.deepEqual(resolveToolGroups(["memory"]), ["core", "coding", "memory"]);
  assert.deepEqual(resolveToolGroups(["core", "coding"]), ["core", "coding"]);
  // The two core prompts are optional like any other group, and they lead when chosen.
  assert.deepEqual(resolveToolGroups(["persona", "machine"]), [
    "persona",
    "machine",
    "core",
    "coding",
  ]);
  assert.deepEqual(resolveToolGroups(["herdr"]), ["core", "coding", "herdr"]);
  // A judgment spends money per call, so the group is opt-in and never implied by another.
  assert.equal(DEFAULT_TOOL_GROUPS.includes("decision"), false);
  assert.deepEqual(resolveToolGroups(["decision"]), ["core", "coding", "decision"]);
  assert.deepEqual(resolveToolGroups(["decision", "search"]), [
    "core",
    "coding",
    "search",
    "decision",
  ]);
});
