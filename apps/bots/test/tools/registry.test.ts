import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { SharedDevicePort } from "../../src/tools/devices/port.ts";
import { DEVICE_EXTENSION, deviceExtension } from "../../src/tools/devices/tools.ts";
import type { HerdrClient } from "../../src/tools/herdr/client.ts";
import { HERDR_TOOLS_EXTENSION } from "../../src/tools/herdr/tools.ts";
import {
  BOTS_TOOLS_EXTENSION,
  CORE_UI_EXTENSION,
  createToolRegistry,
  selectToolExtensions,
} from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

/** One section as the model would read it, with the tools this conversation offers. */
const renderSection = (
  registry: ReturnType<typeof createToolRegistry>,
  key: string,
  offered: readonly string[] = ["list", "note_set", "ask_user", "read", "write", "edit", "bash"],
): string | undefined => {
  const entry = registry
    .snapshot()
    .sections()
    .find(({ section }) => section.key === key);
  assert.ok(entry, `${key} is installed`);
  const text = entry.section.render(
    { agent: { tools: offered.map((name) => ({ name })) } } as never,
    {} as never,
  );
  return typeof text === "string" ? text : undefined;
};

/** The section of the group that holds the bot's own line, as the model reads it. */
const coreUISection = (
  registry: ReturnType<typeof createToolRegistry>,
  offered: readonly string[] = ["list", "note_set", "ask_user"],
): string => {
  const text = renderSection(registry, "bots-core-ui", offered);
  assert.equal(typeof text, "string");
  return text as string;
};

const botsToolsSection = (registry: ReturnType<typeof createToolRegistry>): string => {
  const text = renderSection(registry, "bots-tools");
  assert.equal(typeof text, "string");
  return text as string;
};

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

test("remote tools are selected only for a configured shared device", () => {
  assert.equal(DEVICE_EXTENSION, "bots-shared-devices-v1");
  const registry = createToolRegistry(
    { root: "/tmp" },
    {
      devices: { socketPath: "/tmp/unused-device-test.sock", botId: "existing-bot" },
    },
  );
  for (const groups of [[], ["core", "core-ui", "coding"], ["herdr", "agents"]]) {
    const disabled = selectToolExtensions(registry, groups)
      .flatMap((extension) => extension.tools ?? [])
      .map((tool) => tool.name);
    assert.equal(
      disabled.some((name) => name.startsWith("remote_")),
      false,
    );
    const enabled = selectToolExtensions(registry, groups, true)
      .flatMap((extension) => extension.tools ?? [])
      .map((tool) => tool.name);
    assert.ok(enabled.includes("remote_status"));
    assert.ok(enabled.includes("remote_execute"));
    assert.ok(enabled.includes("remote_operation"));
  }
});

test("remote prompts assign other computers and stay free of local comparison", () => {
  const extension = deviceExtension({ botId: "test", port: {} as SharedDevicePort });
  const section = extension.sections?.find((entry) => entry.key === "shared-devices-v1");
  assert.ok(section);
  const text = section.render({ agent: {} } as never, {} as never) as string;
  assert.equal(
    text.split("\n")[0],
    "These tools control other computers. Use bash for this computer.",
  );
  for (const name of ["remote_status", "remote_execute", "remote_operation"]) {
    assert.ok(text.includes(name));
    const tool = extension.tools?.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.doesNotMatch(tool.description, /do not|never|must not|only when/i);
  }
});

test("the local prompt omits remote setup and names only the local protection failure", () => {
  let capability: "unconfigured" | "unavailable" | "configured" = "unconfigured";
  const registry = createToolRegistry(
    { root: "/tmp" },
    {
      devices: {
        socketPath: "/tmp/unused.sock",
        botId: "test",
        remoteCapability: () => capability,
      },
    },
  );
  for (const current of ["unconfigured", "configured", "unavailable"] as const) {
    capability = current;
    const text = botsToolsSection(registry);
    assert.doesNotMatch(text, /remote_status|remote_execute|remote_operation|Remote access/);
  }
  capability = "unavailable";
  assert.match(botsToolsSection(registry), /awaiting recovery/);
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
      ["ask_user", "bash", "edit", "list", "note_set", "read", "write"],
    );
    assert.deepEqual(
      snapshot.extension(BOTS_TOOLS_EXTENSION)?.tools?.map((tool) => tool.name),
      ["list"],
    );
    assert.deepEqual(
      selectToolExtensions(registry, [])
        .filter((extension) => extension.name === CORE_UI_EXTENSION)
        .flatMap((extension) => extension.tools ?? [])
        .map((tool) => tool.name)
        .sort(),
      ["ask_user", "note_set"],
      "the person-facing tools are their own mandatory group",
    );
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("core and coding install seven tools and a working-directory section", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const workspace = await openWorkspace(join(daemonRoot, "bots", "a", "workspace"));
  const registry = createToolRegistry(workspace);
  const snapshot = registry.snapshot();
  assert.deepEqual(
    selectToolExtensions(registry, [])
      .flatMap((extension) => (extension.tools ?? []).map((tool) => [extension.name, tool.name]))
      .sort(),
    [
      [CORE_UI_EXTENSION, "ask_user"],
      [CORE_UI_EXTENSION, "note_set"],
      [BOTS_TOOLS_EXTENSION, "list"],
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

test("note_set belongs to core-ui and its section tells the model when to write it", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-note-registry-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const calls: string[] = [];
    const now = Date.parse("2026-10-25T06:00:00.000Z");
    const registry = createToolRegistry(workspace, {
      now: () => now,
      note: {
        botId: "b_1",
        async set(text) {
          calls.push(text);
          return text.length === 0 ? {} : { note: text };
        },
        current: () => ({ note: "在等 PR 审核", at: "2026-10-25T03:00:00.000Z" }),
      },
    });
    assert.deepEqual(
      selectToolExtensions(registry, ["core"]).map((extension) => extension.name),
      [BOTS_TOOLS_EXTENSION, CORE_UI_EXTENSION, "coding-tools"],
      "the mandatory groups are the whole selection, in install order",
    );
    assert.deepEqual(
      registry
        .snapshot()
        .extension(CORE_UI_EXTENSION)
        ?.tools?.map((tool) => tool.name),
      ["note_set", "ask_user"],
    );
    const text = coreUISection(registry);
    assert.match(text, /note_set/);
    assert.match(text, /sidebar/);
    assert.match(text, /not every turn/);
    assert.match(text, /at most 10 characters/, "the line is asked to stay short");
    assert.match(text, /在等 PR 审核/, "the model sees its own line");
    assert.match(text, /3 hours ago/, "and how stale it is");
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("a bot with no note is told the line is empty rather than left guessing", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-note-empty-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const registry = createToolRegistry(workspace, {
      note: {
        botId: "b_1",
        set: async (text) => (text.length === 0 ? {} : { note: text }),
        current: () => ({}),
      },
    });
    const text = coreUISection(registry);
    assert.match(text, /sidebar/);
    assert.match(text, /empty/);
    assert.equal(text.includes("ago"), false);
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});

test("a conversation without note_set is not told to write the sidebar line", async () => {
  const daemonRoot = await mkdtemp(join(tmpdir(), "bots-note-absent-"));
  try {
    const workspace = await openWorkspace(join(daemonRoot, "workspace"));
    const registry = createToolRegistry(workspace, {
      note: {
        botId: "b_1",
        set: async (text) => (text.length === 0 ? {} : { note: text }),
        current: () => ({ note: "在等 PR 审核", at: "2026-10-25T03:00:00.000Z" }),
      },
    });
    // `bots-tools` never mentions the note; `bots-core-ui` omits its section when the
    // conversation filtered `note_set` away, so neither text asks for a missing tool.
    const tools = botsToolsSection(registry);
    assert.match(tools, /default working directory/);
    assert.match(tools, /Use list to discover files/);
    assert.doesNotMatch(tools, /note_set|sidebar/);
    assert.equal(
      renderSection(registry, "bots-core-ui", ["list", "read", "write", "edit", "bash"]),
      undefined,
      "a conversation without note_set gets no note section",
    );
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
    [BOTS_TOOLS_EXTENSION, CORE_UI_EXTENSION, "coding-tools"],
  );
  assert.equal(coreOnly.flatMap((extension) => extension.tools ?? []).length, 7);
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
      "bots-core-ui:ask_user",
      "bots-core-ui:note_set",
      "bots-tools:list",
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
      [BOTS_TOOLS_EXTENSION, CORE_UI_EXTENSION, "coding-tools"],
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
    const names = selectToolExtensions(registry, ["core", "core-ui", "coding", "trigger"]).map(
      (extension) => extension.name,
    );
    assert.deepEqual(names.sort(), [
      "bots-core-ui",
      "bots-tools",
      "bots-trigger",
      "coding-tools",
      "tool-search",
    ]);
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
      selectToolExtensions(bare, ["core", "core-ui", "coding", "trigger"]).map(
        (extension) => extension.name,
      ),
      ["bots-tools", "bots-core-ui", "coding-tools"],
    );
  } finally {
    await rm(daemonRoot, { recursive: true, force: true });
  }
});
