// What the settings page shows before a person decides (docs/bots/PROTOCOL.md, "Tool
// catalogue"): every group names the tools it would give a bot, in the daemon's own words.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
      "core-ui",
      "coding",
      "memory",
      "secrets",
      "hc",
      "agents",
      "search",
      "decision",
      "trigger",
      "peers",
    ],
  );
  const names = (group: string) =>
    catalog.find((entry) => entry.group === group)?.tools.map((tool) => tool.name) ?? [];
  assert.deepEqual(names("core"), ["list"]);
  assert.deepEqual(names("core-ui"), ["note_set", "ask_user"]);
  assert.deepEqual(names("coding"), ["read", "write", "edit", "bash", "pr_register", "pr_list"]);
  assert.deepEqual(names("memory"), [
    "memory_list",
    "memory_search",
    "memory_read",
    "memory_write",
    "memory_delete",
  ]);
  assert.deepEqual(names("secrets"), [
    "secret_request",
    "secret_list",
    "secret_read",
    "secret_delete",
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

// The documented inventory (EXTENSIONS-AND-TOOLS.md, "Tool names") is derived from the
// registry: a tool that is added, renamed or removed cannot leave the documentation behind.
test("the documented tool inventory is the registry's own surface", () => {
  const installed = new Set(
    createCatalogRegistry({ skills: () => [] })
      .snapshot()
      .installed()
      .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
  );
  const doc = readFileSync(
    new URL("../../../../docs/bots/EXTENSIONS-AND-TOOLS.md", import.meta.url),
    "utf8",
  );
  const stated = /There are \*\*(\d+) tool names\*\*/.exec(doc);
  assert.ok(stated !== null, "the doc states how many tool names there are");

  const start = doc.indexOf("### Tool names");
  assert.ok(start >= 0, "the doc lists the tool names");
  const rest = doc.slice(start);
  const end = rest.indexOf("\n### ", 1);
  const inventory = end === -1 ? rest : rest.slice(0, end);
  const rows = inventory
    .split("\n")
    .map((line) => /^\| ([^|]+?) \| (.+) \|$/.exec(line))
    .flatMap((match) => {
      if (match === null) return [];
      const names = [...(match[2] ?? "").matchAll(/`([^`]+)`/g)].map((found) => found[1] ?? "");
      return names.length === 0 ? [] : [{ group: match[1] ?? "", names }];
    });
  const documented = rows.flatMap((row) => row.names);
  assert.equal(new Set(documented).size, documented.length, "no tool is listed twice");
  assert.deepEqual(
    [...new Set(documented)].sort(),
    [...installed].sort(),
    "every installed tool is documented, and nothing else is",
  );
  assert.equal(Number(stated[1]), installed.size, "the stated count is the registry's count");
});
