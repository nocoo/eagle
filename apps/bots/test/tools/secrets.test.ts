// The secrets tools (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): four tools, one card, and no
// path on which the model holds a value.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretsStore } from "../../src/secrets/store.ts";
import { createToolRegistry, selectToolExtensions } from "../../src/tools/registry.ts";
import {
  createSecretsTools,
  SECRETS_TOOLS_EXTENSION,
  secretsExtension,
} from "../../src/tools/secrets/tools.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

const api = { taskId: "t_secret" } as never;
const context = {} as never;

type Outcome = { output: string; isError?: boolean };

const bench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-tools-"));
  let clock = Date.parse("2026-11-03T01:10:00.000Z");
  const store = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
    now: () => new Date(clock),
  });
  return {
    root,
    store,
    host: store.hostFor("b_1"),
    advance: (minutes: number) => {
      clock += minutes * 60_000;
    },
    done: () => rm(root, { recursive: true, force: true }),
  };
};

const call = async (
  host: ReturnType<SecretsStore["hostFor"]>,
  name: string,
  args: Record<string, unknown>,
): Promise<Outcome> => {
  const tool = createSecretsTools(host).find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} is registered`);
  const result = await tool.execute(args as never, api, context);
  return {
    output: (result.output ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n"),
    ...(result.isError === true ? { isError: true as const } : {}),
  };
};

test("the group offers exactly four tools and no loader", async () => {
  const { host, done } = await bench();
  try {
    const tools = createSecretsTools(host);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "secret_delete",
      "secret_list",
      "secret_read",
      "secret_request",
    ]);
    for (const tool of tools) assert.ok(tool.description.trim().length > 0, tool.name);
    assert.deepEqual(
      tools.map((tool) => tool.replay),
      ["safe", "safe", "safe", "safe"],
    );
    assert.equal(
      tools.some((tool) => tool.name === "secret_write"),
      false,
      "the model never holds a value, so there is no write",
    );

    const workspace = await openWorkspace(
      join(await mkdtemp(join(tmpdir(), "bots-secret-ws-")), "w"),
    );
    const registry = createToolRegistry(workspace, { secrets: host });
    const selected = selectToolExtensions(registry, ["secrets"]);
    assert.deepEqual(
      selected.map((extension) => extension.name),
      ["bots-tools", "bots-core-ui", "coding-tools", SECRETS_TOOLS_EXTENSION],
      "the mandatory groups plus secrets, and no tool_search: the group is eager",
    );
    const names = selected.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
    assert.deepEqual(names.filter((name) => name.startsWith("secret_")).sort(), [
      "secret_delete",
      "secret_list",
      "secret_read",
      "secret_request",
    ]);
    assert.equal(names.includes("tool_search"), false);

    const bare = selectToolExtensions(createToolRegistry(workspace), ["secrets"]);
    assert.deepEqual(
      bare.map((extension) => extension.name),
      ["bots-tools", "bots-core-ui", "coding-tools"],
      "a group whose extension is not installed contributes nothing",
    );
  } finally {
    await done();
  }
});

test("the request puts a card in front of the person and returns at once", async () => {
  const { host, done } = await bench();
  try {
    const answer = await call(host, "secret_request", {
      key: "github-pat",
      purpose: "发布 Eagle 用",
      scope: "shared",
      ttlMinutes: 60,
    });
    assert.equal(answer.isError, undefined, answer.output);
    assert.match(answer.output, /card/i);
    assert.match(answer.output, /github-pat/);
    const request = createSecretsTools(host).find((tool) => tool.name === "secret_request");
    const properties =
      (request?.parameters as { readonly properties?: Record<string, unknown> } | undefined)
        ?.properties ?? {};
    assert.equal("value" in properties, false, "the model cannot pass a value: it never holds one");
  } finally {
    await done();
  }
});

test("a request the contract cannot keep is refused by name", async () => {
  const { host, done } = await bench();
  try {
    const key = await call(host, "secret_request", { key: "Bad Key", purpose: "p" });
    assert.equal(key.isError, true);
    assert.match(key.output, /key/);

    const purpose = await call(host, "secret_request", {
      key: "k",
      purpose: "x".repeat(241),
    });
    assert.equal(purpose.isError, true);
    assert.match(purpose.output, /240/);

    const ttl = await call(host, "secret_request", { key: "k", purpose: "p", ttlMinutes: 1441 });
    assert.equal(ttl.isError, true);
    assert.match(ttl.output, /1440/);

    const scope = await call(host, "secret_request", { key: "k", purpose: "p", scope: "all" });
    assert.equal(scope.isError, true);
    assert.match(scope.output, /bot/);
    assert.match(scope.output, /shared/);
  } finally {
    await done();
  }
});

test("the list names every record and never a value", async () => {
  const { host, store, done } = await bench();
  try {
    await store.save({
      botId: "b_1",
      key: "github-pat",
      value: "ghp_example",
      scope: "bot",
      purpose: "发布用",
    });
    await store.save({ botId: "b_2", key: "shared-one", value: "other", scope: "shared" });

    const answer = await call(host, "secret_list", {});
    assert.equal(answer.isError, undefined, answer.output);
    const parsed = JSON.parse(answer.output) as {
      items: { key: string; scope: string; botId: string }[];
      truncated: boolean;
    };
    assert.deepEqual(
      parsed.items.map((item) => item.key),
      ["github-pat", "shared-one"],
    );
    assert.deepEqual(
      parsed.items.map((item) => item.scope),
      ["bot", "shared"],
    );
    assert.equal(parsed.items[0]?.botId, "b_1");
    assert.equal(parsed.truncated, false);
    assert.equal(answer.output.includes("ghp_example"), false, "a list never carries a value");

    const over = await call(host, "secret_list", { limit: 101 });
    assert.equal(over.isError, true);
    assert.match(over.output, /100/);
  } finally {
    await done();
  }
});

test("a read describes the record and never prints the value", async () => {
  const { host, store, done } = await bench();
  try {
    await store.save({ botId: "b_1", key: "github-pat", value: "ghp_example", scope: "bot" });
    const read = await call(host, "secret_read", { key: "github-pat" });
    assert.equal(read.isError, undefined, read.output);
    const described = JSON.parse(read.output) as Record<string, unknown>;
    assert.equal(described.key, "github-pat");
    assert.equal(described.scope, "bot");
    assert.equal(described.environment, "EAGLE_SECRET_GITHUB_PAT");
    // A tool result is persisted into the transcript, so the value must not be in it.
    assert.equal(read.output.includes("ghp_example"), false);

    const missing = await call(host, "secret_read", { key: "absent" });
    assert.equal(missing.isError, true);
    assert.match(missing.output, /absent/);
    assert.match(missing.output, /bot/);
    assert.match(missing.output, /shared/);
  } finally {
    await done();
  }
});

test("an explicit shared read never advertises the bot's shadowing value", async () => {
  const { host, store, done } = await bench();
  try {
    await store.save({ botId: "b_1", key: "account", value: "private-value", scope: "bot" });
    await store.save({ botId: "b_2", key: "account", value: "shared-value", scope: "shared" });
    const shared = await call(host, "secret_read", { key: "account", scope: "shared" });
    assert.equal(shared.isError, true, "the exported variable resolves to a different scope");
    assert.match(shared.output, /not exported/);
    const own = await call(host, "secret_read", { key: "account", scope: "bot" });
    assert.equal(own.isError, undefined);
    assert.equal(JSON.parse(own.output).environment, "EAGLE_SECRET_ACCOUNT");
    assert.equal((await host.environment()).EAGLE_SECRET_ACCOUNT, "private-value");
    assert.equal(shared.output.includes("shared-value"), false);
  } finally {
    await done();
  }
});

test("an expired record reads exactly like a missing one", async () => {
  const { host, store, advance, done } = await bench();
  try {
    await store.save({
      botId: "b_1",
      key: "github-pat",
      value: "ghp_example",
      scope: "bot",
      ttlMinutes: 60,
    });
    advance(61);
    const read = await call(host, "secret_read", { key: "github-pat" });
    assert.equal(read.isError, true);
    assert.equal(read.output.includes("ghp_example"), false, "a stale value is never returned");
  } finally {
    await done();
  }
});

test("a delete answers what it removed, and an absent record is success", async () => {
  const { host, store, done } = await bench();
  try {
    await store.save({ botId: "b_1", key: "github-pat", value: "ghp_example", scope: "bot" });
    const removed = await call(host, "secret_delete", { key: "github-pat", scope: "bot" });
    assert.equal(removed.isError, undefined, removed.output);
    assert.deepEqual(JSON.parse(removed.output), {
      key: "github-pat",
      scope: "bot",
      deleted: true,
    });

    const again = await call(host, "secret_delete", { key: "github-pat", scope: "bot" });
    assert.equal(again.isError, undefined, again.output);
    assert.deepEqual(JSON.parse(again.output), {
      key: "github-pat",
      scope: "bot",
      deleted: false,
    });
  } finally {
    await done();
  }
});

test("the section says the card is the way, and never the chat", async () => {
  const { host, done } = await bench();
  try {
    const workspace = await openWorkspace(
      join(await mkdtemp(join(tmpdir(), "bots-secret-ws-")), "w"),
    );
    const registry = createToolRegistry(workspace, { secrets: host });
    const entry = registry
      .snapshot()
      .sections()
      .find(({ section }) => section.key === SECRETS_TOOLS_EXTENSION);
    assert.ok(entry, "the secrets group has a prompt section");
    const text = entry.section.render({ agent: {} } as never, {} as never) as string;
    assert.match(text, /secret_request/);
    assert.match(text, /secret_read/);
    assert.match(text, /card/i);
    assert.match(text, /never .*(chat|conversation)/i);
    assert.equal(secretsExtension(host).name, SECRETS_TOOLS_EXTENSION);
  } finally {
    await done();
  }
});

test("a delete must name the scope, so a retry cannot fall through to another record", async () => {
  const { host, store, done } = await bench();
  try {
    await store.save({ botId: "b_1", key: "k", value: "own-value", scope: "bot" });
    await store.save({ botId: "b_1", key: "k", value: "shared-value", scope: "shared" });
    const unnamed = await call(host, "secret_delete", { key: "k" });
    assert.equal(unnamed.isError, true, "the scope is not a guess");
    assert.match(unnamed.output, /scope/);
    assert.equal((await store.read({ botId: "b_1", key: "k", scope: "bot" }))?.value, "own-value");

    const removed = await call(host, "secret_delete", { key: "k", scope: "bot" });
    assert.equal(removed.isError, undefined, removed.output);
    assert.equal(
      (await store.read({ botId: "b_1", key: "k", scope: "shared" }))?.value,
      "shared-value",
    );
  } finally {
    await done();
  }
});
