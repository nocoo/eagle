// Regressions for the stage-3 review: the four reporting channels must produce one
// record and one event, a lost watch must hand the subscriber a fresh baseline, and
// progress must be attributed to the send that caused it.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { spawnScript } from "../support/daemon.ts";
import {
  armedFailureStorage,
  createBench,
  requestId,
  text,
  trace,
  waitFor,
} from "../support/pi.ts";

const of = <T extends RuntimeEvent["type"]>(events: readonly RuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

test("a session failure inside submit logs one origin record and no log error", async () => {
  const storage = armedFailureStorage((path: string) => openNodeSqliteStorage(path));
  const bench = await createBench({ storage: storage.factory });
  try {
    const handle = await bench.runtime.open(bench.spec());
    storage.arm();
    const refused = await handle
      .submit({ requestId, text: "提交时存储就坏了", whenBusy: "followUp", trace })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    await waitFor(
      () => bench.records.some((record) => record.level === "error"),
      "the origin record",
    );
    assert.ok(refused instanceof ClassifiedFailure, "the adapter classifies it for the caller");
    assert.equal(refused.failure.kind, "storage_failed");
    const errors = bench.records.filter((record) => record.level === "error");
    assert.equal(errors.length, 1, "exactly one error record, on the layer that reported first");
    assert.equal(errors[0]?.layer, refused.failure.layer, "the identity names that layer");
    assert.equal(errors[0]?.err?.failure, refused.failure.id, "the caller sees the same identity");
    assert.equal(errors[0]?.err?.origin, true);
    for (const record of bench.records.filter((item) => item.level === "warn")) {
      const failure = record.err?.failure;
      if (failure === undefined) continue;
      assert.equal(failure, errors[0]?.err?.failure, "a propagation carries the same identity");
      assert.equal(
        record.evt.startsWith(`${record.layer}.`),
        true,
        `${record.evt} matches its layer`,
      );
      assert.notEqual(record.err?.origin, true, "only the minting layer claims origin");
    }
  } finally {
    await bench.cleanup();
  }
});

test("a sink that throws gets a fresh baseline and the subscription keeps working", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    let thrown = false;
    await handle.subscribe(trace, (event) => {
      events.push(event);
      // One bad delivery is a lost watch: pi reports listener_error and ends the stream.
      if (!thrown && event.type === "append" && event.message.role === "user") {
        thrown = true;
        throw new Error("the sink threw");
      }
    });
    bench.faux.setResponses([text("第一次的答案。")]);
    await handle.submit({ requestId: "r_throw_1", text: "第一次", whenBusy: "followUp", trace });
    await waitFor(
      () => of(events, "snapshot").length > 0,
      "the reattached watch to hand over a baseline",
      10_000,
    );
    const baselineIndex = events.findIndex((event) => event.type === "snapshot");
    const baseline = of(events, "snapshot")[0];
    assert.deepEqual(
      baseline?.value.messages[0]?.role,
      "user",
      "the baseline is the transcript at reattach time, not a fragment",
    );
    // It is not allowed to be older than what the subscriber already applied: every
    // message delivered before it must still be inside it (RUNTIME.md, baseline order).
    const appliedBefore = new Set(
      events
        .slice(0, baselineIndex)
        .flatMap((event) => (event.type === "append" ? [event.message.id] : [])),
    );
    const inBaseline = new Set(baseline?.value.messages.map((message) => message.id) ?? []);
    for (const id of appliedBefore) {
      assert.ok(
        inBaseline.has(id) || id.startsWith("p_a"),
        `the baseline must not be older than ${id}`,
      );
    }
    assert.ok(
      bench.records.some(
        (record) =>
          record.evt === "runtime.watch.end.ok" && record.detail?.reason === "listener_error",
      ),
      "the lost watch is logged, and no failure id was minted for one listener error",
    );
    assert.equal(
      bench.records.filter((record) => record.level === "error").length,
      0,
      "one listener error is recoverable",
    );
    // The subscription still delivers: the next turn arrives without a new subscribe call.
    bench.faux.setResponses([text("第二次的答案。")]);
    const before = events.length;
    await handle.submit({ requestId: "r_throw_2", text: "第二次", whenBusy: "followUp", trace });
    await waitFor(
      () =>
        of(events.slice(before), "append").some(
          (event) => event.message.role === "assistant" && event.message.state === "complete",
        ),
      "the reattached stream to deliver the next answer",
      10_000,
    );
    assert.equal(await handle.close(trace, 10_000), "closed");
  } finally {
    await bench.cleanup();
  }
});

test("three listener faults escalate to one internal error, with one origin record", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    let throws = 0;
    await handle.subscribe(trace, (event) => {
      events.push(event);
      if ((event.type === "append" || event.type === "delta") && throws < 3) {
        throws += 1;
        throw new Error("the sink threw again");
      }
    });
    for (const [index, answer] of ["一。", "二。", "三。"].entries()) {
      bench.faux.setResponses([text(answer)]);
      await handle
        .submit({
          requestId: `r_listener_${index}`,
          text: `第 ${index} 个`,
          whenBusy: "followUp",
          trace,
        })
        .catch(() => undefined);
      await waitFor(() => throws > index, `fault ${index + 1}`, 10_000);
    }
    await waitFor(() => of(events, "error").length > 0, "the third fault to escalate", 10_000);
    const escalated = of(events, "error");
    assert.equal(escalated.length, 1, "one error event for the escalation");
    assert.equal(escalated[0]?.failure.kind, "internal");
    assert.equal(escalated[0]?.failure.layer, "runtime", "the adapter owns a lost watch");
    const errors = bench.records.filter((record) => record.level === "error");
    assert.equal(errors.length, 1, "and exactly one error record");
    assert.equal(errors[0]?.err?.failure, escalated[0]?.failure.id, "with the same identity");
    assert.equal(errors[0]?.err?.origin, true);
    assert.equal(errors[0]?.layer, "runtime", "on the layer that owns it");
    await handle.close(trace, 10_000);
  } finally {
    await bench.cleanup();
  }
});

test("a queued follow-up keeps its own trace and does not take the running one", async () => {
  const bench = await createBench({
    provider: { tokensPerSecond: 20, tokenSize: { min: 2, max: 3 } },
  });
  try {
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe("tr_connection_probe", (event) => events.push(event));
    bench.faux.setResponses([
      text("第一个回答，慢一点，让第二个问题排队进来。"),
      text("第二个回答。"),
    ]);
    await handle.submit({
      requestId: "r_trace_a",
      text: "第一个问题",
      whenBusy: "followUp",
      trace: "tr_send_a",
    });
    await handle.submit({
      requestId: "r_trace_b",
      text: "第二个问题",
      whenBusy: "followUp",
      trace: "tr_send_b",
    });
    await waitFor(
      () => of(events, "submission").filter((event) => event.record.status === "done").length === 2,
      "both turns to settle",
      15_000,
    );
    const answerTraces = of(events, "append")
      .filter((event) => event.message.role === "assistant" && event.message.id.startsWith("e_"))
      .map((event) => event.trace);
    assert.deepEqual(
      answerTraces.slice(0, 2),
      ["tr_send_a", "tr_send_b"],
      "each answer belongs to the send that asked for it",
    );
    const settlements = of(events, "submission")
      .filter((event) => event.record.status === "done")
      .map((event) => [event.record.requestId, event.trace]);
    assert.deepEqual(settlements, [
      ["r_trace_a", "tr_send_a"],
      ["r_trace_b", "tr_send_b"],
    ]);
    await handle.close(trace, 10_000);
  } finally {
    await bench.cleanup();
  }
});

test("progress events carry the trace of the send that caused them", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe("tr_connection_probe", (event) => events.push(event));
    bench.faux.setResponses([text("回答。")]);
    await handle.submit({
      requestId,
      text: "问题",
      whenBusy: "followUp",
      trace: "tr_send_probe",
    });
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the turn to settle",
    );
    const traced = events.filter((event) => event.type === "append" || event.type === "submission");
    assert.ok(traced.length > 0);
    assert.deepEqual(
      [...new Set(traced.map((event) => event.trace))],
      ["tr_send_probe"],
      "a run's progress belongs to the send, not to the connection that watches it",
    );
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("failure identities stay unique across bots in one process", async () => {
  const storage = armedFailureStorage((path: string) => openNodeSqliteStorage(path));
  const benches = await Promise.all([
    createBench({ storage: storage.factory }),
    createBench({ storage: storage.factory }),
  ]);
  try {
    const handles = [];
    for (const bench of benches) handles.push(await bench.runtime.open(bench.spec()));
    storage.arm();
    for (const [index, handle] of handles.entries()) {
      await handle
        .submit({
          requestId: `r_bot_${index}`,
          text: "同一个进程里的第二个 bot",
          whenBusy: "followUp",
          trace,
        })
        .catch(() => undefined);
    }
    await waitFor(
      () =>
        benches.every((bench) =>
          bench.records.some((record) => record.err?.kind === "storage_failed"),
        ),
      "both bots to classify their failure",
    );
    const ids = benches.map(
      (bench) =>
        bench.records.find((record) => record.err?.kind === "storage_failed")?.err?.failure,
    );
    assert.equal(new Set(ids).size, 2, "two harnesses never share a failure id");
  } finally {
    for (const bench of benches) await bench.cleanup();
  }
});

test("a killed run is pending in the next snapshot, and leaves it once settled", async () => {
  const bench = await createBench();
  try {
    const dir = join(bench.dir, "b_runtime");
    await mkdir(dir, { recursive: true });
    const child = spawnScript({
      script: "test/runtime/support/interrupt-child.ts",
      args: [dir, "r_interrupt_1"],
    });
    await child.waitForMarker("streaming", 20_000);
    await child.stop();

    bench.faux.setResponses([text("恢复之后的答案。")]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    const subscription = await handle.subscribe(trace, (event) => events.push(event));
    assert.deepEqual(
      subscription.snapshot.pending.map((record) => [record.requestId, record.status]),
      [["r_interrupt_1", "placed"]],
      "the interrupted input is in the baseline, not missing",
    );
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the resumed run to settle",
      10_000,
    );
    const reconnected = await handle.subscribe(trace, () => undefined);
    assert.deepEqual(reconnected.snapshot.pending, [], "a settled input leaves pending");
    // The ledger is built from the recovered record, so the interrupted input is readable
    // by request id before this process ever submitted anything.
    const recovered = await handle.submission({ requestId: "r_interrupt_1" });
    assert.equal(recovered?.status, "done");
    assert.equal(recovered?.requestId, "r_interrupt_1");
    await handle.close(trace, 10_000);
  } finally {
    await bench.cleanup();
  }
});

test("history reports hasMore from the messages it can actually show", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    await handle.subscribe(trace, () => undefined);
    bench.faux.setResponses([text("回答。")]);
    await handle.submit({ requestId, text: "问题", whenBusy: "followUp", trace });
    await waitFor(async () => (await handle.busy()).run === false, "the turn to settle");
    const one = await handle.history({ limit: 1 });
    assert.deepEqual(
      one.messages.map((message) => message.role),
      ["assistant"],
      "the newest message first page is the answer",
    );
    assert.equal(one.hasMore, true, "the user message is still there to fetch");
    const older = await handle.history({ beforeEntryId: one.messages[0]?.id as string, limit: 1 });
    assert.deepEqual(
      older.messages.map((message) => message.role),
      ["user"],
    );
    assert.equal(older.hasMore, false);
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});
