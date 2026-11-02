// Memory through a real Harness (docs/bots/EXTENSIONS-AND-TOOLS.md §6.1): the tool the model
// calls writes a person's file, the next request sees the record, and a new runtime reads what
// the previous one left behind. The file is the durability, not the conversation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { fileMemoryHost, globalMemoryFile } from "../../src/memory/fileHost.ts";
import { assistant, type Bench, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

const memoryDir = async () => mkdtemp(join(tmpdir(), "bots-memory-runtime-"));

const results = (events: readonly RuntimeEvent[]) =>
  events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .flatMap((block) => (block.type === "toolResult" ? [block] : []));

type Responses = Parameters<NonNullable<Bench["faux"]>["setResponses"]>[0];

const run = async (dir: string, responses: Responses) => {
  const bench = await createBench({
    memory: (spec) => fileMemoryHost({ dir, botId: spec.id }),
    toolGroups: ["core", "memory"],
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses(responses);
    await handle.submit({
      requestId: "r_memory_1",
      text: "记一下发版流程",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
  return results(events);
};

test("a write reaches the file and the next model request can search it", async () => {
  const dir = await memoryDir();
  try {
    const written = await run(dir, [
      assistant(
        [toolCall("memory_write", { scope: "global", key: "deploy", content: "先连 VPN。" })],
        {
          stopReason: "toolUse",
        },
      ),
      assistant([toolCall("memory_search", { scope: "global", query: "VPN" })], {
        stopReason: "toolUse",
      }),
      assistant("记下了。"),
    ]);

    const write = written.find((block) => block.name === "memory_write");
    assert.ok(write, `memory_write ran (${written.map((block) => block.name).join(",")})`);
    assert.equal(write.isError, false, write.text);
    assert.deepEqual(JSON.parse(write.text), {
      key: "deploy",
      bytes: Buffer.byteLength("先连 VPN。", "utf8"),
      created: true,
    });

    const search = written.find((block) => block.name === "memory_search");
    assert.ok(search, "the record is searchable inside the same run");
    assert.equal(search.isError, false, search.text);
    assert.deepEqual(JSON.parse(search.text), {
      items: [{ key: "deploy", excerpt: "先连 VPN。" }],
      truncated: false,
    });

    assert.match(await readFile(globalMemoryFile(dir), "utf8"), /^## deploy\n先连 VPN。$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new runtime reads what the previous one wrote", async () => {
  const dir = await memoryDir();
  try {
    await run(dir, [
      assistant(
        [toolCall("memory_write", { scope: "bot", key: "deploy", content: "先连 VPN。" })],
        {
          stopReason: "toolUse",
        },
      ),
      assistant("记下了。"),
    ]);
    const events = await run(dir, [
      assistant([toolCall("memory_read", { scope: "bot", key: "deploy" })], {
        stopReason: "toolUse",
      }),
      assistant("好的。"),
    ]);
    const read = events.find((block) => block.name === "memory_read");
    assert.ok(read, "memory_read ran");
    assert.equal(read.isError, false, read.text);
    assert.equal(read.text, "先连 VPN。");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bot without the group has no memory tool and the files stay as they are", async () => {
  const dir = await memoryDir();
  const bench = await createBench({ memory: (spec) => fileMemoryHost({ dir, botId: spec.id }) });
  try {
    const events: RuntimeEvent[] = [];
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core"] });
    await handle.subscribe(trace, (event) => events.push(event));
    // The offered list is what the model actually receives, not what the registry holds.
    bench.faux.setResponses([
      (context) =>
        assistant(JSON.stringify(getCurrentTools(context.messages).map((tool) => tool.name))),
    ]);
    await handle.submit({
      requestId: "r_memory_off",
      text: "hi",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
    const answer = events
      .filter((event) => event.type === "append" && event.message.role === "assistant")
      .at(-1);
    assert.ok(answer?.type === "append");
    const block = answer.message.blocks[0];
    assert.ok(block?.type === "text");
    const offered = JSON.parse(block.text) as string[];
    assert.equal(offered.includes("memory_list"), false, "a disabled group offers nothing");
    assert.deepEqual(offered.sort(), [
      "ask_user",
      "bash",
      "edit",
      "list",
      "note_set",
      "read",
      "write",
    ]);
    await handle.close(trace, 1_000);
    await assert.rejects(readFile(globalMemoryFile(dir), "utf8"), /ENOENT/);
  } finally {
    await bench.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
