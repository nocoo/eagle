import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { HerdrClient } from "../../src/tools/herdr/client.ts";
import { HERDR_TOOLS_EXTENSION } from "../../src/tools/herdr/tools.ts";
import {
  BOTS_TOOLS_EXTENSION,
  createToolRegistry,
  selectToolExtensions,
} from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

test("a shared device registry exposes no Herdr writes outside device policy", () => {
  const registry = createToolRegistry(
    { root: "/tmp" },
    {
      devices: { socketPath: "/tmp/unused.sock", botId: "test" },
      herdr: { client: {} as HerdrClient, stateDir: "/tmp", botId: "test" },
    },
  );
  const names = registry
    .snapshot()
    .tools()
    .map(({ tool }) => tool.name);
  assert.deepEqual(names.filter((name) => name.startsWith("herdr_")).sort(), [
    "herdr_list",
    "herdr_read",
    "herdr_wait",
  ]);
});

test("an injected shared device port is available to saved and new Bots without an opt-in group", () => {
  const registry = createToolRegistry(
    { root: "/tmp" },
    {
      devices: { socketPath: "/tmp/unused-device-test.sock", botId: "existing-bot" },
    },
  );
  for (const groups of [[], ["core", "coding"], ["herdr", "agents"]]) {
    const names = selectToolExtensions(registry, groups)
      .flatMap((extension) => extension.tools ?? [])
      .map((tool) => tool.name);
    assert.ok(names.includes("remote_status"));
    assert.ok(names.includes("remote_execute"));
    assert.ok(names.includes("remote_operation"));
  }
});

test("core supplies list and coding installs the original native extension without aliases", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-native-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const registry = createToolRegistry(workspace);
    const snapshot = registry.snapshot();
    assert.equal(snapshot.extension("coding-tools"), CodingTools);
    assert.deepEqual(
      selectToolExtensions(registry, [])
        .flatMap((extension) => extension.tools ?? [])
        .map((tool) => tool.name)
        .sort(),
      ["bash", "edit", "list", "note_set", "read", "write"],
    );
    assert.deepEqual(
      snapshot.extension(BOTS_TOOLS_EXTENSION)?.tools?.map((tool) => tool.name),
      ["list", "note_set"],
    );
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("core and coding install six tools and a working-directory section", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const registry = createToolRegistry(workspace);
  const snapshot = registry.snapshot();
  assert.deepEqual(
    selectToolExtensions(registry, [])
      .flatMap((extension) => (extension.tools ?? []).map((tool) => [extension.name, tool.name]))
      .sort(),
    [
      [BOTS_TOOLS_EXTENSION, "list"],
      [BOTS_TOOLS_EXTENSION, "note_set"],
      ["coding-tools", "bash"],
      ["coding-tools", "edit"],
      ["coding-tools", "read"],
      ["coding-tools", "write"],
    ],
  );
  assert.equal(snapshot.extension(BOTS_TOOLS_EXTENSION)?.hooks, undefined);
  const section = snapshot.sections().find(({ section }) => section.key === "bots-tools");
  assert.ok(section, "the model is told where its workspace is");

  const command = snapshot.tools().find(({ tool }) => tool.name === "bash");
  assert.equal(command?.tool.outputLimits?.retain, "tail");
  await rm(daemonRoot, { recursive: true, force: true });
});

test("note_set belongs to core and its section tells the model when to write it", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-note-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const calls: string[] = [];
    const registry = createToolRegistry(workspace, {
      note: {
        botId: "b_1",
        async set(text) {
          calls.push(text);
          return text.length === 0 ? {} : { note: text };
        },
      },
    });
    assert.deepEqual(
      selectToolExtensions(registry, ["core"]).map((extension) => extension.name),
      [BOTS_TOOLS_EXTENSION, "coding-tools"],
      "core adds bots-tools and nothing beyond the mandatory coding group",
    );
    assert.deepEqual(
      registry
        .snapshot()
        .extension(BOTS_TOOLS_EXTENSION)
        ?.tools?.map((tool) => tool.name),
      ["list", "note_set"],
    );
    const section = registry
      .snapshot()
      .sections()
      .find(({ section: entry }) => entry.key === "bots-tools");
    assert.ok(section);
    const text = section.section.render({ agent: {} } as never, {} as never);
    assert.equal(typeof text, "string");
    assert.match(text as string, /note_set/);
    assert.match(text as string, /sidebar/);
    assert.match(text as string, /not every turn/);
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("a bot's tool groups select from every registered built-in extension", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const herdr = { client: {} as HerdrClient, stateDir: join(daemonRoot, "bots", "a"), botId: "a" };
  const registry = createToolRegistry(workspace, { herdr });
  const coreOnly = selectToolExtensions(registry, []);
  assert.deepEqual(
    coreOnly.map((extension) => extension.name),
    [BOTS_TOOLS_EXTENSION, "coding-tools"],
  );
  assert.equal(coreOnly.flatMap((extension) => extension.tools ?? []).length, 6);
  const both = selectToolExtensions(registry, ["herdr"]);
  assert.ok(both.some((extension) => extension.name === HERDR_TOOLS_EXTENSION));
  assert.ok(both.some((extension) => extension.name === "tool-search"));
  assert.ok(registry.snapshot().extension("bots-agents"), "unselected built-ins remain registered");
  await rm(daemonRoot, { recursive: true, force: true });
});

test("the herdr extension is installed only when a client is given", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const without = createToolRegistry(workspace).snapshot();
  assert.equal(without.extension(HERDR_TOOLS_EXTENSION), undefined);

  // The tools are registered even though the fake client is never called here: this is
  // the wiring contract the runtime depends on.
  const client = {} as HerdrClient;
  const withHerdr = createToolRegistry(workspace, {
    herdr: { client, stateDir: join(daemonRoot, "bots", "a"), botId: "a" },
  }).snapshot();
  const names = withHerdr
    .tools()
    .filter(({ extension }) => extension.name === HERDR_TOOLS_EXTENSION)
    .map(({ tool }) => tool.name)
    .sort();
  assert.deepEqual(names, [
    "herdr_close_space",
    "herdr_keys",
    "herdr_list",
    "herdr_open_space",
    "herdr_read",
    "herdr_send",
    "herdr_start_controller",
    "herdr_wait",
  ]);
  assert.equal(withHerdr.extension(HERDR_TOOLS_EXTENSION)?.hooks, undefined);
  assert.ok(withHerdr.sections().some(({ section }) => section.key === "bots-herdr"));
  await rm(daemonRoot, { recursive: true, force: true });
});

test("herdr tools are deferred and the loader is installed with them", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const herdr = { client: {} as HerdrClient, stateDir: join(daemonRoot, "bots", "a"), botId: "a" };
  const snapshot = createToolRegistry(workspace, { herdr }).snapshot();
  const tools = snapshot.tools().map(({ tool }) => tool);
  const herdrTools = tools.filter((tool) => tool.name.startsWith("herdr_"));
  assert.equal(herdrTools.length, 8, "every terminal tool is registered");
  assert.deepEqual(
    herdrTools.filter((tool) => tool.deferred !== true).map((tool) => tool.name),
    [],
    "all of them load on demand",
  );
  assert.ok(
    tools.some((tool) => tool.name === "tool_search"),
    "the loader that enables deferred tools is installed",
  );
  const coreOnly = createToolRegistry(workspace).snapshot();
  assert.equal(
    coreOnly.tools().some(({ tool }) => tool.name === "tool_search"),
    false,
    "nothing is deferred, so no loader is offered",
  );
  await rm(daemonRoot, { recursive: true, force: true });
});

test("a group whose tools are not installed contributes nothing, not even its loader", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
    // Herdr is installed but no search client is, so selecting `search` must not offer the
    // loader: a tool_search that can load nothing is a lie to the model.
    const herdr = {
      client: {} as HerdrClient,
      stateDir: join(daemonRoot, "bots", "a"),
      botId: "a",
    };
    const bare = createToolRegistry(workspace, { herdr });
    const selected = selectToolExtensions(bare, ["search"])
      .flatMap((extension) =>
        (extension.tools ?? []).map((tool) => `${extension.name}:${tool.name}`),
      )
      .sort();
    assert.deepEqual(selected, [
      "bots-tools:list",
      "bots-tools:note_set",
      "coding-tools:bash",
      "coding-tools:edit",
      "coding-tools:read",
      "coding-tools:write",
    ]);
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("selection reads native registry replacement and removal rather than a startup snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-live-registry-"));
  try {
    const registry = createToolRegistry(await openWorkspace(join(root, "workspace")));
    const previous = registry.snapshot();
    const replacement = defineExtension({ name: "bots-agents", tools: [] });
    registry.install(replacement);
    assert.equal(
      selectToolExtensions(registry, ["agents"]).find(
        (extension) => extension.name === "bots-agents",
      ),
      replacement,
    );
    assert.notEqual(previous.extension("bots-agents"), replacement);
    registry.uninstall(replacement);
    assert.deepEqual(
      selectToolExtensions(registry, ["agents"]).map((extension) => extension.name),
      [BOTS_TOOLS_EXTENSION, "coding-tools"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the trigger group installs its extension and the shared loader, and nothing without a host", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-trigger-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const host = {
      botId: "b_1",
      create: async () => ({ trigger: {} as never, created: true }),
      list: async () => [],
      update: async () => ({}) as never,
      enable: async () => ({}) as never,
      remove: async () => ({ triggerId: "t_1" }),
      endpoint: (triggerId: string) => `/v1/triggers/b_1/${triggerId}`,
    };
    const registry = createToolRegistry(workspace, { trigger: host });
    const names = selectToolExtensions(registry, ["core", "coding", "trigger"]).map(
      (extension) => extension.name,
    );
    assert.deepEqual(names.sort(), ["bots-tools", "bots-trigger", "coding-tools", "tool-search"]);
    assert.deepEqual(
      registry
        .snapshot()
        .extension("bots-trigger")
        ?.tools?.map((tool) => tool.name)
        .sort(),
      ["trigger_create", "trigger_delete", "trigger_enable", "trigger_list", "trigger_update"],
    );

    // Without a host the group has no tools, so selecting it offers nothing, not even the
    // loader: a `tool_search` that can load nothing is worse than no group at all.
    const bare = createToolRegistry(workspace);
    assert.deepEqual(
      selectToolExtensions(bare, ["core", "coding", "trigger"]).map((extension) => extension.name),
      ["bots-tools", "coding-tools"],
    );
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});
