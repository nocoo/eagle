import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { StorageRequestError } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";

const noteHost = (botId: string) => ({
  botId,
  current: () => ({}),
  set: async (note: string) => ({ note }),
});

test("reflection stops a successful tool loop without withholding the original answer", async () => {
  let requests = 0;
  const bench = await createBench({ note: (spec) => noteHost(spec.id) });
  const handle = await bench.runtime.open(bench.spec());
  const events: RuntimeEvent[] = [];
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    const loop = () => {
      requests += 1;
      return assistant([toolCall("note_set", { text: "Still reflecting" })], {
        stopReason: "toolUse",
      });
    };
    bench.faux.setResponses([
      text("Original answer."),
      loop,
      loop,
      loop,
      loop,
      loop,
      text("Checked."),
    ]);
    await handle.submit({ requestId: "r_loop", text: "Question", whenBusy: "followUp", trace });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the original answer to settle",
    );
    assert.ok(requests <= 2, `reflection issued ${requests} requests`);
    assert.ok(bench.records.some((record) => record.evt === "runtime.reflection.fail"));
    assert.equal((await handle.busy()).tasks, false, "no reflection task remains live");
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a stalled reflection is cancelled within its total deadline", async () => {
  const bench = await createBench({ note: (spec) => noteHost(spec.id) });
  const handle = await bench.runtime.open(bench.spec());
  const events: RuntimeEvent[] = [];
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("Original answer."),
      (_context, options) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      text("Next answer."),
      text("Checked."),
    ]);
    await handle.submit({ requestId: "r_stall", text: "First", whenBusy: "followUp", trace });
    await handle.submit({ requestId: "r_after_stall", text: "Next", whenBusy: "followUp", trace });
    await waitFor(
      () =>
        events.filter((event) => event.type === "submission" && event.record.status === "done")
          .length === 2,
      "both original answers to settle after reflection timeout",
      18_000,
    );
    assert.equal((await handle.busy()).tasks, false);
    assert.ok(bench.records.some((record) => record.evt === "runtime.reflection.fail"));
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a failed reflection recovery closes the already-open storage", async () => {
  let opens = 0;
  let closes = 0;
  let fail = false;
  const bench = await createBench({
    storage: async (path) => {
      opens += 1;
      const storage = await openNodeSqliteStorage(path);
      return new Proxy(storage, {
        get(target, property, receiver) {
          if (property === "close") {
            return async () => {
              closes += 1;
              await target.close(BACKGROUND_CONTEXT);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
    note: (spec) => ({
      ...noteHost(spec.id),
      current: () => {
        if (fail) throw new Error("catalog recovery unavailable");
        return {};
      },
    }),
  });
  const first = await bench.runtime.open(bench.spec());
  const events: RuntimeEvent[] = [];
  try {
    await first.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([text("Answer."), text("Checked.")]);
    await first.submit({ requestId: "r_recover", text: "Question", whenBusy: "followUp", trace });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the first answer",
    );
    await first.close(trace, 1_000);
    fail = true;
    await assert.rejects(bench.runtime.open(bench.spec()));
    assert.equal(closes, opens, "a failed open must release the Harness it acquired");
    fail = false;
    const again = await bench.runtime.open(bench.spec());
    await again.close(trace, 1_000);
    assert.equal(closes, opens);
  } finally {
    await first.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a failed reflection decision write never drops a committed settlement", async () => {
  let failures = 0;
  const bench = await createBench({
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      return new Proxy(storage, {
        get(target, property, receiver) {
          if (property === "commit") {
            return async (...args: Parameters<typeof target.commit>) => {
              if (JSON.stringify(args).includes("pendingNote")) {
                failures += 1;
                throw new StorageRequestError("reflection decision write refused");
              }
              return target.commit(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
    note: (spec) => noteHost(spec.id),
  });
  const handle = await bench.runtime.open(bench.spec());
  const events: RuntimeEvent[] = [];
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([text("Original answer."), text("Checked.")]);
    await handle.submit({ requestId: "r_decision", text: "Question", whenBusy: "followUp", trace });
    await waitFor(() => failures > 0, "the auxiliary write to fail");
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the committed original settlement to be delivered",
      1_000,
    );
    assert.equal(
      bench.records.some((record) => record.detail?.reason === "listener_error"),
      false,
    );
    assert.ok(bench.records.some((record) => record.evt === "runtime.reflection.fail"));
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});
