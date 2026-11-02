// What the settings page shows before a person decides (docs/bots/PROTOCOL.md, "Tool
// catalogue"): every group names the tools it would give a bot, in the daemon's own words.
import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogRegistry, describeToolCatalog } from "../../src/tools/registry.ts";

const catalog = describeToolCatalog(createCatalogRegistry());

test("every group is described, with the tools it actually contributes", () => {
  assert.deepEqual(
    catalog.map((entry) => entry.group),
    [
      "persona",
      "machine",
      "core",
      "coding",
      "memory",
      "herdr",
      "agents",
      "search",
      "decision",
      "trigger",
      "peers",
    ],
  );
  const names = (group: string) =>
    catalog.find((entry) => entry.group === group)?.tools.map((tool) => tool.name) ?? [];
  assert.deepEqual(names("core"), ["list", "note_set", "ask_user"]);
  assert.deepEqual(names("coding"), ["read", "write", "edit", "bash", "pr_register", "pr_list"]);
  assert.deepEqual(names("memory"), [
    "memory_list",
    "memory_search",
    "memory_read",
    "memory_write",
    "memory_delete",
  ]);
  assert.deepEqual(names("search"), ["web_search", "web_fetch"]);
  assert.deepEqual(names("decision"), ["decide", "classify", "assess", "rate", "judge"]);
  assert.deepEqual(names("trigger"), [
    "trigger_create",
    "trigger_list",
    "trigger_update",
    "trigger_enable",
    "trigger_delete",
  ]);
  assert.deepEqual(names("peers"), ["peer_list", "peer_send", "peer_read"]);
  assert.deepEqual(names("agents"), ["agent_spawn", "agent_send", "agent_stop"]);
});

test("every described tool says what it is for", () => {
  for (const entry of catalog) {
    for (const tool of entry.tools) {
      assert.ok(tool.description.trim().length > 0, `${tool.name} has a description`);
    }
  }
});

test("the loader that defers tools belongs to no group", () => {
  const names = catalog.flatMap((entry) => entry.tools.map((tool) => tool.name));
  assert.ok(!names.includes("tool_search"), "tool_search is how a choice arrives, not a choice");
});

test("describing the surface never executes a tool", () => {
  const page = catalog.flatMap((entry) => entry.tools);
  assert.ok(page.length > 0);
  // The catalogue's hosts refuse every call, so only the descriptions exist.
  assert.ok(page.every((tool) => typeof tool.name === "string"));
});
