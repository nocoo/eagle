// Ladder rows 33-35: the failure channels, and recovery after a real SIGKILL.
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

/** Starts the child, waits until its input is admitted, then kills it outright. */
const killMidAnswer = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  const child = spawnScript({
    script: "test/runtime/support/interrupt-child.ts",
    args: [dir, "r_interrupt_1"],
  });
  await child.waitForMarker("ready", 10_000);
  await child.waitForMarker("streaming", 20_000);
  await child.stop();
};

test("a parked task surfaces as task_parked from onReport, once", async () => {
  const bench = await createBench({ settings: { restartLimit: 1 } });
  try {
    await killMidAnswer(join(bench.dir, "b_runtime"));
    bench.faux.setResponses([text("重新开始之后才回答。")]);
    const handle = await bench.runtime.open(bench.spec());
    // F15: `open()` counts the cut-off task, the restart limit parks it, and the report
    // reaches the host even though no handle existed when it fired.
    await waitFor(
      () => bench.records.some((record) => record.err?.kind === "task_parked"),
      "the parked task to surface",
      10_000,
    );
    const parked = bench.records.filter((record) => record.err?.kind === "task_parked");
    const origins = parked.filter((record) => record.level === "error");
    assert.equal(origins.length, 1, "one report, one origin record: the channel never mints twice");
    assert.equal(origins[0]?.evt, "pi.report");
    assert.equal(origins[0]?.err?.origin, true);
    assert.ok(origins[0]?.err?.failure.startsWith("f_"), "the identity is minted once");
    assert.deepEqual(
      parked.map((record) => record.err?.failure),
      [origins[0]?.err?.failure, origins[0]?.err?.failure],
      "the adapter records the classification of the same failure id",
    );
    assert.deepEqual(
      parked.map((record) => [record.level, record.evt]),
      [
        ["error", "pi.report"],
        ["info", "runtime.failure.classify"],
      ],
    );

    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    // The park was reported before anyone was listening, so the first subscriber gets it
    // after its baseline instead of the daemon having to replay a log line.
    await waitFor(
      () => of(events, "error").some((event) => event.failure.kind === "task_parked"),
      "the parked failure to reach the first subscriber",
    );
    assert.equal(
      of(events, "error").filter((event) => event.failure.kind === "task_parked").length,
      1,
      "once, with the identity the log recorded",
    );
    await handle.recover(trace);
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "recover to retry the parked task",
      10_000,
    );
    const history = await handle.history({ limit: 10 });
    assert.deepEqual(
      history.messages.map((message) => [message.role, message.state]),
      [
        ["user", "complete"],
        ["assistant", "aborted"],
        ["assistant", "complete"],
      ],
      "the interrupted attempt stays visible and the retried run answers",
    );
    await handle.close(trace, 10_000);
  } finally {
    await bench.cleanup();
  }
});

test("a storage failure closes the harness and classifies storage_failed", async () => {
  const storage = armedFailureStorage((path: string) => openNodeSqliteStorage(path));
  const bench = await createBench({ storage: storage.factory });
  try {
    bench.faux.setResponses([text("一个答案。")]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    storage.arm();
    const refused = await handle
      .submit({ requestId, text: "会撞上存储故障的问题", whenBusy: "followUp", trace })
      .then(
        () => "admitted",
        (cause: unknown) => cause,
      );
    assert.ok(
      refused === "admitted" || refused instanceof ClassifiedFailure,
      "a rejection is classified for the caller, never a bare error",
    );
    await waitFor(
      () => bench.records.some((record) => record.err?.kind === "storage_failed"),
      "the storage failure to classify",
      10_000,
    );
    const classified = bench.records.filter((record) => record.err?.kind === "storage_failed");
    const identities = new Set(classified.map((record) => record.err?.failure));
    assert.equal(identities.size, 1, "one session episode gets one identity");
    const errors = classified.filter((record) => record.level === "error");
    assert.equal(errors.length, 1, "exactly one error record, whichever channel reported first");
    assert.ok(
      errors[0]?.evt === "pi.report" || errors[0]?.evt === "runtime.submit.fail",
      "the error record belongs to whichever channel reported the episode first",
    );
    assert.equal(
      errors[0]?.layer,
      errors[0]?.evt === "pi.report" ? "pi" : "runtime",
      "and to that channel's layer",
    );
    assert.equal(errors[0]?.err?.origin, true);
    assert.ok(
      classified.some((record) => record.level === "warn" && record.detail?.propagated === true),
      "the second channel propagates the same identity instead of minting",
    );
    const broadcast = of(events, "error").filter(
      (event) => event.failure.kind === "storage_failed",
    );
    assert.equal(broadcast.length, 1, "the subscriber is told exactly once");
    assert.equal(broadcast[0]?.failure.id, [...identities][0], "with the logged identity");
    assert.equal(storage.state.failed > 0, true);
  } finally {
    await bench.cleanup();
  }
});

test("open resumes a run interrupted by close", async () => {
  const bench = await createBench();
  try {
    await killMidAnswer(join(bench.dir, "b_runtime"));
    bench.faux.setResponses([text("恢复之后的答案。")]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the resumed run to settle",
      10_000,
    );
    const history = await handle.history({ limit: 10 });
    assert.deepEqual(
      history.messages.map((message) => [message.role, message.state]),
      [
        ["user", "complete"],
        ["assistant", "aborted"],
        ["assistant", "complete"],
      ],
      "F22: one admission, one interrupted attempt, one answer — nothing lost or duplicated",
    );
    assert.deepEqual(history.messages.at(-1)?.blocks, [{ type: "text", text: "恢复之后的答案。" }]);
    const settled = of(events, "submission").at(-1)?.record;
    assert.equal(settled?.status, "done");
    assert.equal(settled?.requestId, "r_interrupt_1");
    await handle.close(trace, 10_000);
  } finally {
    await bench.cleanup();
  }
});
