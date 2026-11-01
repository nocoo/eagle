// The Bot's own sidebar note (docs/bots/EXTENSIONS-AND-TOOLS.md, core group): one line the
// model writes about itself, normalized and bounded by the daemon, cleared by empty text.
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BOT_NOTE_CHARS } from "../../src/core/domain.ts";
import { createNoteHost, createNoteSetTool } from "../../src/tools/note.ts";
import type { NoteToolHost } from "../../src/tools/types.ts";

type Outcome = { output: string; isError?: boolean };

const api = { taskId: "t_42" } as never;
const context = {} as never;

const bench = (overrides: Partial<NoteToolHost> = {}) => {
  const calls: string[] = [];
  const host: NoteToolHost = {
    botId: "b_self",
    async set(text) {
      calls.push(text);
      return text.length === 0 ? {} : { note: text };
    },
    current: () => ({}),
    ...overrides,
  };
  const tool = createNoteSetTool(host);
  const run = async (text: unknown): Promise<Outcome> => {
    const result = await tool.execute({ text } as never, api, context);
    return {
      output: (result.output ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n"),
      ...(result.isError === true ? { isError: true as const } : {}),
    };
  };
  return { tool, calls, run };
};

test("note_set is a safe core tool with one required text field", () => {
  const { tool } = bench();
  assert.equal(tool.name, "note_set");
  assert.equal(tool.replay, "safe");
  const parameters = tool.parameters as {
    required?: readonly string[];
    properties?: Record<string, { type?: string }>;
  };
  assert.deepEqual(parameters.required, ["text"]);
  assert.equal(parameters.properties?.text?.type, "string");
});

test("setting a note writes the normalized line and answers in one sentence", async () => {
  const { calls, run } = bench();
  const result = await run("  在核对   10-24 的报告\n");
  assert.equal(result.isError, undefined);
  assert.equal(result.output, "note set: 在核对 10-24 的报告");
  assert.deepEqual(calls, ["在核对 10-24 的报告"], "the host receives one normalized line");
});

test("an empty text clears the note", async () => {
  const { calls, run } = bench();
  const result = await run("   ");
  assert.equal(result.isError, undefined);
  assert.equal(result.output, "note cleared");
  assert.deepEqual(calls, [""]);
});

test("a note over the limit is refused, never truncated, and not written", async () => {
  const { calls, run } = bench();
  const result = await run("字".repeat(MAX_BOT_NOTE_CHARS + 1));
  assert.equal(result.isError, true);
  assert.match(result.output, new RegExp(`${MAX_BOT_NOTE_CHARS}`));
  assert.equal(result.output.includes("…"), false);
  assert.deepEqual(calls, []);
});

test("a host failure is a readable error result", async () => {
  const { run } = bench({
    set: async () => {
      throw new Error("catalog is busy");
    },
  });
  const result = await run("work");
  assert.equal(result.isError, true);
  assert.match(result.output, /catalog is busy/);
});

test("the host writes, answers and then announces the catalog, in that order", async () => {
  const order: string[] = [];
  const host = createNoteHost({
    botId: "b_1",
    async write(text) {
      order.push(`write:${text}`);
      return text.length === 0 ? {} : { note: text };
    },
    current: () => ({ note: "在等 PR 审核", at: "2026-10-25T03:00:00.000Z" }),
    changed: () => order.push("changed"),
  });
  assert.deepEqual(host.current(), {
    note: "在等 PR 审核",
    at: "2026-10-25T03:00:00.000Z",
  });
  assert.deepEqual(await host.set("在等合并"), { note: "在等合并" });
  assert.deepEqual(
    order,
    ["write:在等合并", "changed"],
    "no client hears about a line that failed",
  );
  order.length = 0;
  assert.deepEqual(await host.set(""), {}, "a cleared line has nothing to report");
  assert.deepEqual(order, ["write:", "changed"]);
});
