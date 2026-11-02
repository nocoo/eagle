// Memory v1 (docs/bots/EXTENSIONS-AND-TOOLS.md §6.1): two markdown scopes a person can edit,
// five tools, keyword search, and a file format scripts write. The store is the only module
// that knows the format, so every assertion here is about the contract, not the implementation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  botMemoryFile,
  fileMemoryHost,
  globalMemoryFile,
  parseMemory,
  renderMemory,
} from "../../src/memory/fileHost.ts";
import {
  createMemoryTools,
  MEMORY_TOOLS_EXTENSION,
  memoryExtension,
} from "../../src/tools/memory/tools.ts";
import { createToolRegistry, selectToolExtensions } from "../../src/tools/registry.ts";
import {
  MAX_MEMORY_CONTENT,
  MAX_MEMORY_KEY,
  MAX_MEMORY_LINES,
  type MemoryToolHost,
} from "../../src/tools/types.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

const bench = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-memory-"));
  return {
    dir,
    host: fileMemoryHost({ dir, botId: "b_self" }),
    done: () => rm(dir, { recursive: true, force: true }),
  };
};

type Outcome = { output: string; isError?: boolean };
const api = { taskId: "t_memory" } as never;
const context = {} as never;

const call = async (
  host: MemoryToolHost,
  name: string,
  args: Record<string, unknown>,
): Promise<Outcome> => {
  const tool = createMemoryTools(host).find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} is registered`);
  const result = await tool.execute(args as never, api, context);
  return {
    output: (result.output ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n"),
    ...(result.isError === true ? { isError: true as const } : {}),
  };
};

test("a record is one heading section and the preamble survives a rewrite", () => {
  const text = [
    "# Memory",
    "",
    "说明：这是给我自己看的。",
    "",
    "## deploy",
    "先连 VPN。",
    "",
    "## oncall",
    "周三甲。",
    "周四乙。",
    "",
  ].join("\n");
  const parsed = parseMemory(text);
  assert.equal(
    parsed.preamble,
    "# Memory\n\n说明：这是给我自己看的。\n",
    "the preamble is kept byte for byte, up to the first heading",
  );
  assert.deepEqual([...parsed.records.keys()], ["deploy", "oncall"]);
  assert.equal(parsed.records.get("oncall"), "周三甲。\n周四乙。");

  const again = parseMemory(renderMemory(parsed.preamble, parsed.records));
  assert.deepEqual(again.records, parsed.records, "parsing what we render is the same file");
  assert.match(renderMemory(parsed.preamble, parsed.records), /^# Memory/);
});

test("a body may hold its own level-2 headings without becoming another record", async () => {
  const { host, done } = await bench();
  try {
    const body = "## 步骤\n先连 VPN。\n\n## 回滚\n`make rollback`。\n\n\\## 这不是标题\n普通一行。";
    await host.write({ scope: "bot", key: "deploy", content: body });
    await host.write({ scope: "bot", key: "zulu", content: "别的内容" });

    assert.deepEqual(
      (await host.list({ scope: "bot", limit: 20 })).items.map((item) => item.key),
      ["deploy", "zulu"],
      "a heading inside a body is not a new record",
    );
    assert.equal((await host.read({ scope: "bot", key: "deploy" }))?.content, body);
    assert.equal((await host.read({ scope: "bot", key: "zulu" }))?.content, "别的内容");

    // Writing a second record must not damage the first one's body.
    await host.write({ scope: "bot", key: "alpha", content: "新的" });
    assert.equal((await host.read({ scope: "bot", key: "deploy" }))?.content, body);
  } finally {
    await done();
  }
});

test("an indented title and CRLF are read without losing the preamble", async () => {
  const { dir, host, done } = await bench();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(
      botMemoryFile(dir, "b_self"),
      "    # Memory\r\n\r\n  保留缩进。\r\n\r\n## k\r\none\r\ntwo\r\n",
      "utf8",
    );
    const parsed = parseMemory(await readFile(botMemoryFile(dir, "b_self"), "utf8"));
    assert.equal(parsed.preamble, "    # Memory\n\n  保留缩进。\n");
    assert.equal(
      await host.read({ scope: "bot", key: "k" }).then((one) => one?.content),
      "one\ntwo",
    );
    await host.write({ scope: "bot", key: "later", content: "x" });
    const written = await readFile(botMemoryFile(dir, "b_self"), "utf8");
    assert.match(written, /^ {4}# Memory\n\n {2}保留缩进。\n/);
    assert.equal(written.includes("\r"), false, "the daemon stores LF");
  } finally {
    await done();
  }
});

test("a hand edit and another bot's file are read, not assumed", async () => {
  const { dir, host, done } = await bench();
  try {
    await writeFile(botMemoryFile(dir, "b_other"), "## theirs\n别的 Bot 的笔记。\n", "utf8");
    assert.deepEqual((await host.list({ scope: "bot", limit: 20 })).items, []);
    await host.write({ scope: "bot", key: "mine", content: "自己的" });
    assert.deepEqual(
      (await host.list({ scope: "bot", limit: 20 })).items.map((item) => item.key),
      ["mine"],
      "scope bot is this bot's file only",
    );
    assert.equal(await host.read({ scope: "bot", key: "theirs" }), undefined);

    const { appendFile } = await import("node:fs/promises");
    await appendFile(globalMemoryFile(dir), "\n## 手写\n脚本写的。\n", "utf8");
    assert.equal((await host.read({ scope: "global", key: "手写" }))?.content, "脚本写的。");
  } finally {
    await done();
  }
});

test("the host creates its directory private and its files private", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-memory-mode-"));
  try {
    const dir = join(root, "nested", "memory");
    const host = fileMemoryHost({ dir, botId: "b_self" });
    await host.write({ scope: "global", key: "k", content: "x" });
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(globalMemoryFile(dir))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeated heading is last-one-wins and rendering keeps one section per key", () => {
  const parsed = parseMemory("## deploy\n旧\n\n## deploy\n新\n");
  assert.equal(parsed.records.get("deploy"), "新");
  const rendered = renderMemory("", parsed.records);
  assert.equal(rendered.match(/## deploy/g)?.length, 1);
});

test("an empty or missing file is an empty scope, not an error", async () => {
  const { dir, host, done } = await bench();
  try {
    assert.deepEqual(await host.list({ scope: "bot", limit: 20 }), { items: [] });
    assert.deepEqual(await host.search({ scope: "global", query: "anything", limit: 20 }), {
      items: [],
      truncated: false,
    });
    assert.equal(await host.read({ scope: "bot", key: "deploy" }), undefined);
    await writeFile(globalMemoryFile(dir), "", "utf8");
    assert.deepEqual(await host.list({ scope: "global", limit: 20 }), { items: [] });
  } finally {
    await done();
  }
});

test("writing one key keeps the rest of the file and the scope files stay apart", async () => {
  const { dir, host, done } = await bench();
  try {
    await host.write({ scope: "global", key: "oncall", content: "周三甲。" });
    await host.write({ scope: "global", key: "deploy", content: "先连 VPN。" });
    await host.write({ scope: "bot", key: "oncall", content: "我这边周三乙。" });

    assert.deepEqual(
      (await host.list({ scope: "global", limit: 20 })).items.map((item) => item.key),
      ["deploy", "oncall"],
      "records come back in key order",
    );
    assert.equal((await host.read({ scope: "global", key: "deploy" }))?.content, "先连 VPN。");
    assert.equal((await host.read({ scope: "bot", key: "oncall" }))?.content, "我这边周三乙。");

    const written = await readFile(globalMemoryFile(dir), "utf8");
    assert.match(written, /^## deploy$/m);
    assert.equal((await stat(globalMemoryFile(dir))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.match(botMemoryFile(dir, "b_self"), /b_self\.md$/);
  } finally {
    await done();
  }
});

test("a record whose key starts with # is a record like any other", async () => {
  const { host, done } = await bench();
  try {
    assert.deepEqual(await host.write({ scope: "bot", key: "#tag", content: "ok" }), {
      key: "#tag",
      bytes: 2,
      created: true,
    });
    assert.equal((await host.read({ scope: "bot", key: "#tag" }))?.content, "ok");
    await host.write({ scope: "bot", key: "a#b", content: "ok" });
    assert.deepEqual(
      (await host.list({ scope: "bot", limit: 20 })).items.map((item) => item.key),
      ["#tag", "a#b"],
    );
  } finally {
    await done();
  }
});

test("a replayed write converges on its own content, not on the newer one", async () => {
  const { host, done } = await bench();
  try {
    await host.write({ scope: "bot", key: "k", content: "old" });
    await host.write({ scope: "bot", key: "k", content: "new" });
    const replayed = await host.write({ scope: "bot", key: "k", content: "old" });
    assert.deepEqual(replayed, { key: "k", bytes: 3, created: false });
    assert.equal((await host.read({ scope: "bot", key: "k" }))?.content, "old");
    assert.equal(
      (await host.remove({ scope: "bot", key: "k" })).deleted,
      true,
      "a delete replay removes whatever is there",
    );
  } finally {
    await done();
  }
});

test("a returned record counts its bytes and says whether it was new", async () => {
  const { host, done } = await bench();
  try {
    assert.deepEqual(await host.write({ scope: "bot", key: "deploy", content: "abc" }), {
      key: "deploy",
      bytes: 3,
      created: true,
    });
    assert.deepEqual(await host.write({ scope: "bot", key: "deploy", content: "abcd" }), {
      key: "deploy",
      bytes: 4,
      created: false,
    });
    assert.deepEqual(await host.remove({ scope: "bot", key: "deploy" }), { deleted: true });
    assert.deepEqual(await host.remove({ scope: "bot", key: "deploy" }), { deleted: false });
  } finally {
    await done();
  }
});

test("keywords match with AND semantics and answer with a bounded excerpt", async () => {
  const { host, done } = await bench();
  try {
    await host.write({
      scope: "global",
      key: "deploy",
      content: `${"填充".repeat(400)}needle 之后还有话。`,
    });
    await host.write({ scope: "global", key: "oncall", content: "周三甲值班，需要 needle。" });
    await host.write({ scope: "bot", key: "needle-log", content: "另一条不含关键词的记录。" });

    const both = await host.search({ scope: "global", query: "NEEDLE", limit: 20 });
    assert.deepEqual(
      both.items.map((item) => item.key),
      ["deploy", "oncall"],
      "a key match ranks at least as high as a body match",
    );
    for (const item of both.items) {
      assert.ok(item.excerpt.length <= 201, `${item.key} excerpt is bounded`);
      assert.match(item.excerpt, /needle/i);
    }
    assert.equal(both.truncated, false);

    assert.deepEqual(
      (await host.search({ scope: "bot", query: "needle 记录", limit: 20 })).items.map(
        (item) => item.key,
      ),
      ["needle-log"],
      "every token has to occur",
    );
    assert.deepEqual(
      (await host.search({ scope: "bot", query: "needle 值班", limit: 20 })).items,
      [],
    );
  } finally {
    await done();
  }
});

test("excerpts stay inside their budget and survive Unicode case folding", async () => {
  const { host, done } = await bench();
  try {
    const far = `${"x".repeat(300)}needle${"x".repeat(300)}`;
    await host.write({ scope: "bot", key: "far", content: far });
    const twoSided = (await host.search({ scope: "bot", query: "needle", limit: 20 })).items[0];
    assert.ok(twoSided, "the far record matched");
    assert.ok(twoSided.excerpt.length <= 200, `${twoSided.excerpt.length} characters`);
    assert.match(twoSided.excerpt, /^….*…$/s);
    assert.match(twoSided.excerpt, /needle/);

    // İ lowercases to two code points: the window must still come from the original text.
    await host.write({
      scope: "bot",
      key: "turkish",
      content: `${"İ".repeat(300)}needle`,
    });
    const folded = (await host.search({ scope: "bot", query: "needle", limit: 20 })).items.find(
      (item) => item.key === "turkish",
    );
    assert.ok(folded, "the match is found");
    assert.match(folded.excerpt, /needle/);
    assert.ok(folded.excerpt.length <= 200);
  } finally {
    await done();
  }
});

test("a key hit outranks a body hit, and a key-only match still has an excerpt", async () => {
  const { host, done } = await bench();
  try {
    await host.write({ scope: "bot", key: "needle", content: "a" });
    await host.write({ scope: "bot", key: "z", content: "needle 只出现在正文 needle needle" });
    const ranked = (await host.search({ scope: "bot", query: "needle", limit: 20 })).items;
    assert.equal(ranked[0]?.key, "needle", "a key hit is weighted above body hits");
    assert.equal(ranked[0]?.excerpt.includes("needle"), false, "a key-only match has no body hit");
    assert.ok((ranked[0]?.excerpt.length ?? 0) > 0);
  } finally {
    await done();
  }
});

test("a large search answer stays valid JSON and says what it dropped", async () => {
  const { host, done } = await bench();
  try {
    for (let index = 0; index < 100; index += 1) {
      await host.write({
        scope: "bot",
        key: `k${String(index).padStart(3, "0")}`,
        content: `针${"界".repeat(500)}`,
      });
    }
    const answer = await call(host, "memory_search", { scope: "bot", query: "针", limit: 100 });
    assert.equal(answer.isError, undefined, answer.output);
    assert.ok(Buffer.byteLength(answer.output, "utf8") < 50 * 1024, "under the tool-result cap");
    const parsed = JSON.parse(answer.output) as { items: unknown[]; truncated: boolean };
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.items.length > 0 && parsed.items.length < 100);
  } finally {
    await done();
  }
});

test("search is bounded and says when it dropped matches", async () => {
  const { host, done } = await bench();
  try {
    for (const key of ["a", "b", "c"]) {
      await host.write({ scope: "bot", key, content: "same word" });
    }
    const page = await host.search({ scope: "bot", query: "word", limit: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.truncated, true);
  } finally {
    await done();
  }
});

test("listing pages from the last key it returned", async () => {
  const { host, done } = await bench();
  try {
    for (const key of ["a", "b", "c"]) await host.write({ scope: "bot", key, content: "x" });
    const first = await host.list({ scope: "bot", limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.key),
      ["a", "b"],
    );
    assert.equal(first.nextCursor, "b");
    const second = await host.list({ scope: "bot", limit: 2, cursor: first.nextCursor });
    assert.deepEqual(
      second.items.map((item) => item.key),
      ["c"],
    );
    assert.equal(second.nextCursor, undefined);
  } finally {
    await done();
  }
});

test("the store refuses a key or a body it cannot keep", async () => {
  const { host, done } = await bench();
  try {
    await assert.rejects(
      host.write({ scope: "bot", key: "  ", content: "x" }),
      /key .*empty|empty key/,
    );
    await assert.rejects(
      host.write({ scope: "bot", key: "a".repeat(MAX_MEMORY_KEY + 1), content: "x" }),
      new RegExp(`${MAX_MEMORY_KEY}`),
    );
    await assert.rejects(host.write({ scope: "bot", key: "a\nb", content: "x" }), /key/);
    await assert.rejects(
      host.write({ scope: "bot", key: "lines", content: "x\n".repeat(MAX_MEMORY_LINES + 1) }),
      new RegExp(`${MAX_MEMORY_LINES}`),
      "a body too tall to be read back in one result is refused",
    );
    await assert.rejects(
      host.write({ scope: "bot", key: "ok", content: "   \n" }),
      /memory_delete/,
    );
    await assert.rejects(
      host.write({ scope: "bot", key: "ok", content: "x".repeat(MAX_MEMORY_CONTENT + 1) }),
      /32/,
    );
    assert.equal(await host.read({ scope: "bot", key: "ok" }), undefined, "nothing was written");
  } finally {
    await done();
  }
});

test("two writes in one run both survive", async () => {
  const { host, done } = await bench();
  try {
    await Promise.all([
      host.write({ scope: "bot", key: "a", content: "一" }),
      host.write({ scope: "bot", key: "b", content: "二" }),
      host.write({ scope: "bot", key: "c", content: "三" }),
    ]);
    assert.deepEqual(
      (await host.list({ scope: "bot", limit: 20 })).items.map((item) => item.key),
      ["a", "b", "c"],
    );
  } finally {
    await done();
  }
});

test("an unreadable scope surfaces the operating system's own refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-memory-dir-"));
  try {
    // A directory where a file belongs: not "missing", so it must not read as an empty scope.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(globalMemoryFile(dir), { recursive: true });
    const host = fileMemoryHost({ dir, botId: "b_self" });
    await assert.rejects(host.list({ scope: "global", limit: 20 }), /EISDIR|illegal operation/);
    // The tools turn the same failure into a model-visible refusal, for reads and writes alike.
    for (const [name, args] of [
      ["memory_list", { scope: "global" }],
      ["memory_delete", { scope: "global", key: "k" }],
      ["memory_write", { scope: "global", key: "k", content: "x" }],
    ] as const) {
      const answer = await call(host, name, args);
      assert.equal(answer.isError, true, name);
      assert.match(answer.output, /EISDIR|illegal operation/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a search with no words, and a delete of a record that is gone, both answer", async () => {
  const { host, done } = await bench();
  try {
    const empty = await call(host, "memory_search", { scope: "bot", query: "   " });
    assert.equal(empty.isError, true);
    assert.match(empty.output, /word/);
    await host.write({ scope: "bot", key: "k", content: "x" });
    const again = await call(host, "memory_read", { scope: "bot", key: "  k  " });
    assert.equal(again.output, "x", "a key is trimmed on the way in");
  } finally {
    await done();
  }
});

test("the group offers exactly five tools and no loader", async () => {
  const { host, done } = await bench();
  try {
    const tools = createMemoryTools(host);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_write",
    ]);
    for (const tool of tools) assert.ok(tool.description.trim().length > 0, tool.name);
    assert.deepEqual(
      tools.map((tool) => tool.replay),
      ["safe", "safe", "safe", "safe", "safe"],
    );
  } finally {
    await done();
  }
});

test("the scope is required and there is no combined one", async () => {
  const { host, done } = await bench();
  try {
    for (const name of ["memory_list", "memory_search", "memory_read", "memory_write"]) {
      const args: Record<string, unknown> = { key: "k", query: "q", content: "c" };
      const answer = await call(host, name, { ...args, scope: "all" });
      assert.equal(answer.isError, true, name);
      assert.match(answer.output, /global/);
      assert.match(answer.output, /bot/);
    }
  } finally {
    await done();
  }
});

test("the tools answer in JSON, except a read, which is the record itself", async () => {
  const { host, done } = await bench();
  try {
    const content = "先连 VPN。\n再发版。";
    const bytes = Buffer.byteLength(content, "utf8");
    const written = await call(host, "memory_write", {
      scope: "global",
      key: "deploy",
      content,
    });
    assert.equal(written.isError, undefined);
    assert.deepEqual(JSON.parse(written.output), { key: "deploy", bytes, created: true });

    const explicit = await call(host, "memory_list", { scope: "global", limit: 5 });
    assert.deepEqual(JSON.parse(explicit.output).items.length, 1, "an explicit limit is honoured");

    const listed = await call(host, "memory_list", { scope: "global" });
    assert.deepEqual(JSON.parse(listed.output), { items: [{ key: "deploy", bytes }] });

    const read = await call(host, "memory_read", { scope: "global", key: "deploy" });
    assert.equal(read.output, content);

    const searched = await call(host, "memory_search", { scope: "global", query: "VPN" });
    assert.deepEqual(JSON.parse(searched.output), {
      items: [{ key: "deploy", excerpt: "先连 VPN。 再发版。" }],
      truncated: false,
    });

    const removed = await call(host, "memory_delete", { scope: "global", key: "deploy" });
    assert.deepEqual(JSON.parse(removed.output), { key: "deploy", deleted: true });
  } finally {
    await done();
  }
});

test("a hand-written record too large to return whole is refused, not cut", async () => {
  const { dir, done } = await bench();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(
      botMemoryFile(dir, "b_self"),
      `## huge\n${"x".repeat(MAX_MEMORY_CONTENT + 10)}\n`,
      "utf8",
    );
    const host = fileMemoryHost({ dir, botId: "b_self" });
    const answer = await call(host, "memory_read", { scope: "bot", key: "huge" });
    assert.equal(answer.isError, true);
    assert.match(answer.output, /read the file directly/);
  } finally {
    await done();
  }
});

test("a missing record points the model at its own list instead of guessing", async () => {
  const { host, done } = await bench();
  try {
    const read = await call(host, "memory_read", { scope: "bot", key: "absent" });
    assert.equal(read.isError, true);
    assert.match(read.output, /absent/);
    assert.match(read.output, /memory_list/);
  } finally {
    await done();
  }
});

test("the tool surface carries the bounds the contract promises", async () => {
  const { host, done } = await bench();
  try {
    assert.match(
      (await call(host, "memory_search", { scope: "bot", query: "x".repeat(2_049) })).output,
      /2048/,
    );
    for (const limit of [0, 101]) {
      const answer = await call(host, "memory_list", { scope: "bot", limit });
      assert.equal(answer.isError, true, `limit ${limit}`);
      assert.match(answer.output, /100/);
    }
    for (const [key, pattern] of [
      ["  ", /empty/],
      ["k".repeat(121), /120/],
    ] as const) {
      const answer = await call(host, "memory_read", { scope: "bot", key });
      assert.equal(answer.isError, true, key);
      assert.match(answer.output, pattern);
    }
    const blank = await call(host, "memory_write", { scope: "bot", key: "k", content: " " });
    assert.equal(blank.isError, true);
    assert.match(blank.output, /memory_delete/);
  } finally {
    await done();
  }
});

test("selecting the group installs it alone, and without a host it contributes nothing", async () => {
  const workspace = await openWorkspace(
    join(await mkdtemp(join(tmpdir(), "bots-memory-ws-")), "w"),
  );
  const { host, done } = await bench();
  try {
    const registry = createToolRegistry(workspace, { memory: host });
    const selected = selectToolExtensions(registry, ["memory"]);
    assert.deepEqual(
      selected.map((extension) => extension.name),
      ["bots-tools", "coding-tools", MEMORY_TOOLS_EXTENSION],
      "the mandatory pair plus memory, and no tool_search: memory is eager",
    );
    const names = selected.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
    assert.deepEqual(names.filter((name) => name.startsWith("memory_")).sort(), [
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_write",
    ]);
    assert.equal(names.includes("tool_search"), false, "no loader for an eager group");

    const bare = selectToolExtensions(createToolRegistry(workspace), ["memory"]);
    assert.deepEqual(
      bare.map((extension) => extension.name),
      ["bots-tools", "coding-tools"],
      "a group whose extension is not installed contributes nothing",
    );
    assert.equal(
      bare
        .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name))
        .includes("memory_list"),
      false,
    );
  } finally {
    await done();
  }
});

test("the group's section says when to read and when to write", async () => {
  const workspace = await openWorkspace(
    join(await mkdtemp(join(tmpdir(), "bots-memory-ws-")), "w"),
  );
  const { host, done } = await bench();
  try {
    const registry = createToolRegistry(workspace, { memory: host });
    const entry = registry
      .snapshot()
      .sections()
      .find(({ section }) => section.key === MEMORY_TOOLS_EXTENSION);
    assert.ok(entry, "the memory group has a prompt section");
    const text = entry.section.render({ agent: {} } as never, {} as never) as string;
    assert.match(text, /memory_search/);
    assert.match(text, /memory_write/);
    assert.match(text, /global/);
    assert.match(text, /bot/);
    assert.match(text, /replace/i);
    assert.match(text, /not .*instruction/i);
  } finally {
    await done();
  }
});

test("the extension is the same object the group names", async () => {
  const { host, done } = await bench();
  try {
    assert.equal(memoryExtension(host).name, MEMORY_TOOLS_EXTENSION);
  } finally {
    await done();
  }
});
