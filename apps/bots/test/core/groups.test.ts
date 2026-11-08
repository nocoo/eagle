// Tool groups (docs/bots/PROTOCOL.md, "Gateway settings"): the core, core-ui and coding
// groups are mandatory, a stored selection is normalized, and an unknown name never survives.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOL_GROUPS, resolveToolGroups } from "../../src/core/domain.ts";

test("core, core-ui and coding cannot be turned off and unknown names are dropped", () => {
  const mandatory = ["core", "core-ui", "coding"];
  assert.deepEqual(resolveToolGroups([]), mandatory);
  assert.deepEqual(resolveToolGroups(["hc"]), [...mandatory, "hc"]);
  assert.deepEqual(resolveToolGroups(["core"]), mandatory);
  assert.deepEqual(resolveToolGroups(["core-ui"]), mandatory);
  assert.deepEqual(resolveToolGroups(["coding"]), mandatory);
  assert.deepEqual(resolveToolGroups(["hc", "web"]), [...mandatory, "hc"]);
  assert.deepEqual(resolveToolGroups(["agents"]), [...mandatory, "agents"]);
  assert.deepEqual(resolveToolGroups(undefined), mandatory);
  assert.deepEqual(DEFAULT_TOOL_GROUPS, [
    "persona",
    "machine",
    "core",
    "core-ui",
    "coding",
    "memory",
    "secrets",
    "agents",
    "trigger",
  ]);

  // Memory is a default because remembering is a habit, and it is still just a group.
  assert.deepEqual(resolveToolGroups(["memory"]), [...mandatory, "memory"]);
  // Secrets are a default because the card is the only way a password reaches a bot.
  assert.deepEqual(resolveToolGroups(["secrets"]), [...mandatory, "secrets"]);
  // The two core prompts are optional like any other group, and they lead when chosen.
  assert.deepEqual(resolveToolGroups(["persona", "machine"]), ["persona", "machine", ...mandatory]);
  // A judgment spends money per call, so the group is opt-in and never implied by another.
  assert.equal(DEFAULT_TOOL_GROUPS.includes("decision"), false);
  assert.deepEqual(resolveToolGroups(["decision"]), [...mandatory, "decision"]);
  assert.deepEqual(resolveToolGroups(["decision", "search"]), [...mandatory, "search", "decision"]);
});
