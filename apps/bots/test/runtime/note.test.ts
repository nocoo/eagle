// The line a settled run leaves behind (docs/bots/PROTOCOL.md, "The bot's own note"): the
// value the bot gave note_set during that run, else the first sentence of its answer.
import assert from "node:assert/strict";
import test from "node:test";
import { ClassifiedFailure, type Failure } from "../../src/core/domain.ts";
import type { RuntimeBotSpec, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import {
  assistant,
  type Bench,
  createBench,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

type NoteBench = {
  readonly bench: Bench;
  /** Every value the daemon wrote, in order: the tool's own writes and the run's settle. */
  readonly writes: string[];
  open(): Promise<RuntimeHandle>;
  turn(handle: RuntimeHandle, body: string, responses: unknown[]): Promise<void>;
  cleanup(): Promise<void>;
};

/** The identity a real catalog write mints before it hands the failure to its caller. */
const writeFailure: Failure = { id: "f_note_write", kind: "storage_failed", layer: "core" };

const noteBench = async (options: { readonly fail?: boolean } = {}): Promise<NoteBench> => {
  const writes: string[] = [];
  const bench = await createBench({
    note: (spec: RuntimeBotSpec) => ({
      botId: spec.id,
      async set(value) {
        if (options.fail === true) throw new ClassifiedFailure(writeFailure, "unknown", "busy");
        writes.push(value);
        return value.length === 0 ? {} : { note: value };
      },
      current: () => (writes.length === 0 ? {} : { note: writes.at(-1) ?? "" }),
    }),
  });
  return {
    bench,
    writes,
    async open() {
      const handle = await bench.runtime.open(bench.spec());
      await handle.subscribe(trace, () => undefined);
      return handle;
    },
    async turn(handle, body, responses) {
      bench.faux.setResponses(responses as never);
      await handle.submit({
        requestId: `r_${body}`,
        text: body,
        whenBusy: "followUp",
        trace,
      });
    },
    cleanup: () => bench.cleanup(),
  };
};

test("a run that never called note_set writes its answer's first sentence", async () => {
  const notes = await noteBench();
  try {
    const handle = await notes.open();
    await notes.turn(handle, "第一轮", [text("已提交 PR。等待审核。")]);
    await waitFor(() => notes.writes.length === 1, "the settled line");
    assert.deepEqual(notes.writes, ["已提交 PR。"], "the first sentence, and only it");
  } finally {
    await notes.cleanup();
  }
});

test("a run that called note_set keeps that value instead of deriving one", async () => {
  const notes = await noteBench();
  try {
    const handle = await notes.open();
    await notes.turn(handle, "第一轮", [
      assistant([toolCall("note_set", { text: "在等 PR 审核" })], { stopReason: "toolUse" }),
      text("已提交 PR。等待审核。"),
    ]);
    await waitFor(() => notes.writes.length === 2, "the settled line after the tool's own");
    assert.equal(notes.writes.at(-1), "在等 PR 审核", "the Bot's line wins");
    assert.equal(notes.writes.includes("已提交 PR。"), false, "nothing was derived over it");
  } finally {
    await notes.cleanup();
  }
});

test("note_set with an empty text clears the line and the run derives nothing", async () => {
  const notes = await noteBench();
  try {
    const handle = await notes.open();
    await notes.turn(handle, "第一轮", [
      assistant([toolCall("note_set", { text: "" })], { stopReason: "toolUse" }),
      text("已提交 PR。等待审核。"),
    ]);
    await waitFor(() => notes.writes.length === 2, "the settled line after the tool's own");
    assert.deepEqual(notes.writes, ["", ""], "cleared by the tool, and cleared by the settle");
  } finally {
    await notes.cleanup();
  }
});

test("a run that stopped writing its own line is replaced by the next derived one", async () => {
  const notes = await noteBench();
  try {
    const handle = await notes.open();
    await notes.turn(handle, "第一轮", [
      assistant([toolCall("note_set", { text: "在等 PR 审核" })], { stopReason: "toolUse" }),
      text("已提交 PR。"),
    ]);
    await waitFor(() => notes.writes.length === 2, "the first run's line");

    await notes.turn(handle, "第二轮", [text("合并了。下一件事。")]);
    await waitFor(() => notes.writes.length === 3, "the second run's line");
    assert.deepEqual(
      notes.writes.slice(1),
      ["在等 PR 审核", "合并了。"],
      "the next run owns the next line",
    );
  } finally {
    await notes.cleanup();
  }
});

test("two subscribers watching one run still write its line once", async () => {
  const notes = await noteBench();
  try {
    const handle = await notes.open();
    await handle.subscribe("tr_runtime_2", () => undefined);
    await notes.turn(handle, "第一轮", [text("已提交 PR。等待审核。")]);
    await waitFor(() => notes.writes.length >= 1, "the settled line");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(notes.writes, ["已提交 PR。"], "one run owns one line");
  } finally {
    await notes.cleanup();
  }
});

test("a failed write is one warn record and the run still settles", async () => {
  const notes = await noteBench({ fail: true });
  try {
    const handle = await notes.open();
    await notes.turn(handle, "第一轮", [text("已提交 PR。")]);
    await waitFor(
      () =>
        notes.bench.records.some(
          (entry) => entry.level === "warn" && entry.evt === "core.catalog.write.fail",
        ),
      "the failed write to be recorded",
    );
    const warned = notes.bench.records.filter(
      (entry) => entry.level === "warn" && entry.evt === "core.catalog.write.fail",
    );
    assert.deepEqual(
      warned.map((entry) => entry.err?.failure),
      [writeFailure.id],
      "one warn, carrying the identity the write already had",
    );
    assert.deepEqual(await handle.busy(), { run: false, tasks: false }, "the run is not failed");
    assert.deepEqual(notes.writes, [], "nothing pretended to be written");
  } finally {
    await notes.cleanup();
  }
});
